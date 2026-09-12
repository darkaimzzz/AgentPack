import { existsSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, basename } from 'node:path'
import { backupRoot } from '../paths.ts'
import type { AgentKey, BackupToken } from '../types.ts'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { parse as parseJsonc, modify, applyEdits, type ParseError } from 'jsonc-parser'
import { isDeepStrictEqual } from 'node:util'
import { atomicWrite } from '../files.ts'

export const hashFile = (p: string): string | null => {
  if (!existsSync(p)) return null
  return createHash('sha256').update(readFileSync(p)).digest('hex')
}

/** Copy a config aside before mutating it. CLAUDE.md §15: rollback is P0. */
export function backup(agent: AgentKey, configPath: string, stamp: string): BackupToken {
  if (!existsSync(configPath)) {
    // Record that WE are about to create this file, so rollback can remove it.
    return { agent, configPath, backupPath: null, existed: false }
  }
  const backupPath = join(backupRoot(), stamp, agent, basename(configPath))
  mkdirSync(dirname(backupPath), { recursive: true })
  copyFileSync(configPath, backupPath)
  return { agent, configPath, backupPath, existed: true }
}

/** Whole-file restore. Only safe when the file has not changed since we wrote it. */
export function restoreFile(token: BackupToken): void {
  if (!token.existed || !token.backupPath) return
  copyFileSync(token.backupPath, token.configPath)
}

/** Delete a config file that AgentPack created. */
export function deleteFile(path: string): void {
  rmSync(path, { force: true })
}

export function captureAfter(token: BackupToken, runId: string): void {
  const path = join(backupRoot(), runId, token.agent, `${basename(token.configPath)}.after`)
  mkdirSync(dirname(path), { recursive: true })
  copyFileSync(token.configPath, path)
  token.afterPath = path
  token.postHash = hashFile(token.configPath)
}

function parseConfig(path: string, text: string): Record<string, any> {
  if (!text.trim()) return {}
  if (path.endsWith('.toml')) return parseToml(text)
  const errors: ParseError[] = []
  const value = parseJsonc(text, errors, { allowTrailingComma: true })
  if (errors.length || !value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Cannot roll back invalid config: ${path}`)
  }
  return value
}

export function addedEntries(token: BackupToken, section: string): Array<[string, unknown]> {
  if (!token.afterPath) return []
  const before = token.existed ? parseConfig(token.configPath, readFileSync(token.backupPath!, 'utf8')) : {}
  const after = parseConfig(token.configPath, readFileSync(token.afterPath, 'utf8'))
  return Object.entries(after[section] ?? {}).filter(([key]) => before[section]?.[key] === undefined)
}

/** Prepare every file before applying an undo, so conflicts cause no partial rollback. */
export function prepareRestore(token: BackupToken): { kind: 'restored' | 'removed' | 'merged'; apply: () => void } | null {
  if (!token.afterPath) {
    if (token.postHash && hashFile(token.configPath) === token.postHash) {
      return token.existed ? { kind:'restored', apply:()=>restoreFile(token) } : { kind:'removed', apply:()=>deleteFile(token.configPath) }
    }
    // Old ledgers cannot prove ownership after an intervening edit.
    if (token.postHash) throw new Error(`Config changed since this older run: ${token.configPath}. Restore its backup manually.`)
    return null
  }
  const beforeText = token.existed ? readFileSync(token.backupPath!, 'utf8') : ''
  const afterText = readFileSync(token.afterPath, 'utf8')
  const before = parseConfig(token.configPath, beforeText)
  const after = parseConfig(token.configPath, afterText)
  if (isDeepStrictEqual(before, after)) return null
  if (!existsSync(token.configPath)) throw new Error(`Config changed since install (file removed): ${token.configPath}`)
  const currentText = readFileSync(token.configPath, 'utf8')
  const current = parseConfig(token.configPath, currentText)
  if (isDeepStrictEqual(current, before)) return null
  if (isDeepStrictEqual(current, after)) {
    return token.existed ? { kind:'restored', apply:()=>atomicWrite(token.configPath,beforeText) } : { kind:'removed', apply:()=>deleteFile(token.configPath) }
  }
  let text = currentText
  // Capability entries are atomic units: preserve later edits to the same entry.
  for (const section of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (isDeepStrictEqual(before[section],after[section])) continue
    const keys = new Set([...Object.keys(before[section] ?? {}),...Object.keys(after[section] ?? {})])
    for (const key of keys) {
      const oldValue=before[section]?.[key], ourValue=after[section]?.[key], liveValue=current[section]?.[key]
      if (isDeepStrictEqual(oldValue,ourValue) || isDeepStrictEqual(liveValue,oldValue)) continue
      if (oldValue === undefined && ['marketplaces','extraKnownMarketplaces'].includes(section)) {
        const plugins = section === 'marketplaces' ? 'plugins' : 'enabledPlugins'
        const stillReferenced = Object.keys(current[plugins] ?? {}).some(id => id.endsWith(`@${key}`) &&
          !(before[plugins]?.[id] === undefined && isDeepStrictEqual(current[plugins][id], after[plugins]?.[id])))
        if (stillReferenced) continue
      }
      if (!isDeepStrictEqual(liveValue,ourValue)) throw new Error(`Rollback conflict: ${section}.${key} changed since install in ${token.configPath}`)
      if (oldValue === undefined) delete current[section][key]
      else (current[section] ??= {})[key]=oldValue
      if (!token.configPath.endsWith('.toml')) text=applyEdits(text,modify(text,[section,key],oldValue,{formattingOptions:{insertSpaces:true,tabSize:2}}))
    }
    if (current[section] && !Object.keys(current[section]).length && before[section] === undefined) {
      delete current[section]
      if (!token.configPath.endsWith('.toml')) text=applyEdits(text,modify(text,[section],undefined,{}))
    }
  }
  if (token.configPath.endsWith('.toml')) text=stringifyToml(current)
  return { kind:'merged', apply:()=>atomicWrite(token.configPath,text) }
}
