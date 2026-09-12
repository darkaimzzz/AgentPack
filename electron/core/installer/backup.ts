import { existsSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, basename } from 'node:path'
import { backupRoot } from '../paths.ts'
import type { AgentKey, BackupToken } from '../types.ts'
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml'
import { removeTomlTable } from '../agents/codex.ts'
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

/**
 * Record what the config looks like now that we have written to it.
 *
 * The hash is taken FIRST and the copy is allowed to fail. The copy is an
 * optimisation that lets rollback merge around later edits; the hash alone is
 * enough to prove "untouched since we wrote it", which is what rollback needs
 * in the common case. Letting a failed copy throw used to lose both — the
 * write had already happened, so the change became unattributable and rollback
 * silently did nothing while still reporting the run undone.
 */
export function captureAfter(token: BackupToken, runId: string): void {
  token.written = true
  try {
    token.postHash = hashFile(token.configPath)
  } catch {
    token.postHash = null
  }
  try {
    const path = join(backupRoot(), runId, token.agent, `${basename(token.configPath)}.after`)
    mkdirSync(dirname(path), { recursive: true })
    copyFileSync(token.configPath, path)
    token.afterPath = path
  } catch {
    // No after-image: rollback falls back to the hash comparison above.
    token.afterPath = undefined
  }
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
    const current = hashFile(token.configPath)
    if (token.postHash && current === token.postHash) {
      return token.existed ? { kind:'restored', apply:()=>restoreFile(token) } : { kind:'removed', apply:()=>deleteFile(token.configPath) }
    }
    // Old ledgers cannot prove ownership after an intervening edit.
    if (token.postHash) throw new Error(`Config changed since this older run: ${token.configPath}. Restore its backup manually.`)
    // Nothing was ever written through this token — an already-present
    // capability, or an agent that could not host it. There is nothing to undo.
    if (!token.written) return null
    // Written, but with no post-image of any kind. If the file still matches the
    // backup the write left no trace; otherwise we cannot prove what this run
    // did, and reporting the run undone while leaving the change in place would
    // be worse than refusing.
    if (current === (token.existed && token.backupPath ? hashFile(token.backupPath) : null)) return null
    throw new Error(
      `Cannot prove what this run wrote to ${token.configPath}: the post-install snapshot is missing. ` +
      `Its backup is at ${token.backupPath ?? '(none — the file did not exist)'}; restore it by hand if the change should be undone.`,
    )
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
  // Putting the old bytes back is right when the file still holds exactly what
  // we wrote. In a format that carries comments, though, semantic equality is
  // not enough: a comment added afterwards parses to the same value, and a
  // wholesale restore would silently delete it. So for those formats demand
  // byte equality and otherwise fall through to the per-entry path, which edits
  // in place. Plain JSON has no comments, so semantic equality is sufficient —
  // and insisting on bytes there would needlessly reformat a file our own
  // dormancy round-trip had rewritten.
  const carriesComments = /\.(toml|jsonc)$/i.test(token.configPath)
  if (isDeepStrictEqual(current, after) && (!carriesComments || currentText === afterText)) {
    return token.existed ? { kind:'restored', apply:()=>atomicWrite(token.configPath,beforeText) } : { kind:'removed', apply:()=>deleteFile(token.configPath) }
  }
  let text = currentText
  const isToml = token.configPath.endsWith('.toml')
  // TOML is edited by splicing lines rather than re-serialising the parsed
  // document, so comments and layout survive. Re-serialising is kept only for
  // the rare case of restoring a previous value, which line editing cannot do.
  let tomlSpliced = isToml
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
      if (!isToml) {
        text=applyEdits(text,modify(text,[section,key],oldValue,{formattingOptions:{insertSpaces:true,tabSize:2}}))
      } else if (oldValue === undefined) {
        const spliced = removeTomlTable(text, section, key)
        if (spliced === null) tomlSpliced = false // inline table: fall back below
        else text = spliced
      } else {
        tomlSpliced = false // putting a previous value back needs the serialiser
      }
    }
    if (current[section] && !Object.keys(current[section]).length && before[section] === undefined) {
      delete current[section]
      if (!isToml) text=applyEdits(text,modify(text,[section],undefined,{}))
    }
  }
  if (isToml && !tomlSpliced) text=stringifyToml(current)
  return { kind:'merged', apply:()=>atomicWrite(token.configPath,text) }
}
