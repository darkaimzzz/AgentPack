import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { ledgerPath, stateDir } from '../paths.ts'
import type { BackupToken } from '../types.ts'
import { atomicWrite } from '../files.ts'

/**
 * What we changed and how to undo it. One JSON file, no database.
 * Secrets never appear here: only their variable names.
 */
export type LedgerEntry = {
  id: string
  at: string
  projectDir: string
  capabilities: string[]
  /** Env var names supplied at install time. Names only, never values. */
  secretKeys: string[]
  /** Non-secret ${...} values. Recorded in full so a run can be reproduced. */
  inputs?: Record<string, string>
  backups: BackupToken[]
  rolledBackAt?: string
}

const read = (): LedgerEntry[] => {
  const p = ledgerPath()
  if (!existsSync(p)) return []
  try {
    const rows = JSON.parse(readFileSync(p, 'utf8')) as LedgerEntry[]
    if (!Array.isArray(rows)) throw new Error('expected an array')
    return rows
  } catch {
    throw new Error(`Install history is unreadable: ${p}. Preserve this file and restore it from backup before installing.`)
  }
}

const write = (entries: LedgerEntry[]) => {
  mkdirSync(stateDir(), { recursive: true })
  atomicWrite(ledgerPath(), JSON.stringify(entries, null, 2) + '\n')
}

export const entries = read

export function record(entry: LedgerEntry): void {
  write([...read(), entry])
}

export function amend(id: string, patch: Partial<LedgerEntry>): void {
  write(read().map((e) => (e.id === id ? { ...e, ...patch } : e)))
}

export function markRolledBack(id: string): void {
  write(read().map((e) => (e.id === id ? { ...e, rolledBackAt: new Date().toISOString() } : e)))
}

/** Most recent entry that has not been rolled back. */
export function latestUndoable(): LedgerEntry | undefined {
  return read().filter((e) => !e.rolledBackAt).pop()
}
