import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { ledgerPath, stateDir } from '../paths.ts'
import type { BackupToken } from '../types.ts'

/**
 * What we changed and how to undo it. One JSON file — no database.
 * Secrets never appear here: only their variable names.
 */
export type LedgerEntry = {
  id: string
  at: string
  projectDir: string
  capabilities: string[]
  /** Env var names supplied at install time. Names only, never values. */
  secretKeys: string[]
  backups: BackupToken[]
  rolledBackAt?: string
}

const read = (): LedgerEntry[] => {
  const p = ledgerPath()
  if (!existsSync(p)) return []
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as LedgerEntry[]
  } catch {
    return [] // a corrupt ledger must never block an install
  }
}

const write = (entries: LedgerEntry[]) => {
  mkdirSync(stateDir(), { recursive: true })
  writeFileSync(ledgerPath(), JSON.stringify(entries, null, 2) + '\n')
}

export const entries = read

export function record(entry: LedgerEntry): void {
  write([...read(), entry])
}

export function markRolledBack(id: string): void {
  write(read().map((e) => (e.id === id ? { ...e, rolledBackAt: new Date().toISOString() } : e)))
}

/** Most recent entry that has not been rolled back. */
export function latestUndoable(): LedgerEntry | undefined {
  return read().filter((e) => !e.rolledBackAt).pop()
}
