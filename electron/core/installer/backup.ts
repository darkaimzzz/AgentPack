import { existsSync, copyFileSync, mkdirSync } from 'node:fs'
import { join, dirname, basename } from 'node:path'
import { backupRoot } from '../paths.ts'
import type { AgentKey, BackupToken } from '../types.ts'

/** Copy a config aside before mutating it. CLAUDE.md §15: rollback is P0. */
export function backup(agent: AgentKey, configPath: string, stamp: string): BackupToken {
  if (!existsSync(configPath)) return { agent, configPath, backupPath: null, existed: false }
  const backupPath = join(backupRoot(), stamp, agent, basename(configPath))
  mkdirSync(dirname(backupPath), { recursive: true })
  copyFileSync(configPath, backupPath)
  return { agent, configPath, backupPath, existed: true }
}

/**
 * Restore a config from its backup.
 * If there was no file to begin with we leave what is there rather than
 * deleting: never destroy something we did not create.
 */
export function restore(token: BackupToken): void {
  if (!token.existed || !token.backupPath) return
  copyFileSync(token.backupPath, token.configPath)
}
