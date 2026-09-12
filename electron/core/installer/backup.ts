import { existsSync, copyFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, dirname, basename } from 'node:path'
import { backupRoot } from '../paths.ts'
import type { AgentKey, BackupToken } from '../types.ts'

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
