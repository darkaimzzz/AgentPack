import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { stateDir } from '../paths.ts'
import { atomicWrite } from '../files.ts'
import type { AgentKey } from '../types.ts'
import type { ConfigEntry } from '../agents/adapter.ts'

/**
 * Where a dormant capability's config entry is kept while it is not exposed to
 * an agent.
 *
 * ⚠️ THIS FILE CONTAINS CREDENTIALS.
 *
 * Making a capability dormant removes its entry from the agent config, and that
 * entry carries its env — including any token. Dropping them would mean
 * "dormant" quietly destroyed the user's credentials, which PRD §20 forbids, so
 * the whole entry is stashed here verbatim.
 *
 * This is deliberately NOT the install ledger. The ledger records secret names
 * only and a test pins that; this store is a separate, clearly-named file whose
 * exposure is identical to the agent config the values came from — they were
 * already sitting in ~/.claude.json in plaintext.
 */

export type DormantRecord = {
  capabilityId: string
  agent: AgentKey
  /** The exact entry removed from the agent config, env included. */
  entry: ConfigEntry
  storedAt: string
}

type Store = { version: 1; entries: DormantRecord[] }

const dormantPath = () => join(stateDir(), 'dormant.json')

const read = (): Store => {
  const p = dormantPath()
  if (!existsSync(p)) return { version: 1, entries: [] }
  try {
    const s = JSON.parse(readFileSync(p, 'utf8')) as Store
    if (s.version !== 1 || !Array.isArray(s.entries) || s.entries.some((e) =>
      !e || typeof e.capabilityId !== 'string' || !['claude', 'codex', 'opencode'].includes(e.agent) ||
      !e.entry || typeof e.entry.command !== 'string' || !Array.isArray(e.entry.args) ||
      !e.entry.env || typeof e.entry.env !== 'object')) throw new Error('invalid schema')
    return s
  } catch {
    throw new Error('Dormant credential store is unreadable. Restore its backup before making changes: ' + p)
  }
}

const write = (s: Store) => {
  mkdirSync(stateDir(), { recursive: true })
  atomicWrite(dormantPath(), JSON.stringify(s, null, 2) + '\n')
}

export const entries = (): DormantRecord[] => read().entries

export function get(capabilityId: string, agent: AgentKey): DormantRecord | null {
  return read().entries.find((e) => e.capabilityId === capabilityId && e.agent === agent) ?? null
}

/** Stash an entry. Re-stashing the same pair replaces it rather than duplicating. */
export function stash(capabilityId: string, agent: AgentKey, entry: ConfigEntry): void {
  const s = read()
  s.entries = [
    ...s.entries.filter((e) => !(e.capabilityId === capabilityId && e.agent === agent)),
    { capabilityId, agent, entry, storedAt: new Date().toISOString() },
  ]
  write(s)
}

/** Remove a stash. Called once its entry is back in the live config. */
export function drop(capabilityId: string, agent: AgentKey): void {
  const s = read()
  const before = s.entries.length
  s.entries = s.entries.filter((e) => !(e.capabilityId === capabilityId && e.agent === agent))
  if (s.entries.length !== before) write(s)
}
