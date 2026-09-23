import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { adapters } from '../agents/index.ts'
import { matchEntry, supportsType, type AgentAdapter } from '../agents/adapter.ts'
import { getCapability, capabilities, resolveArgs } from '../capabilities/registry.ts'
import { backup, captureAfter, prepareRestore } from '../installer/backup.ts'
import { stateDir, stamp } from '../paths.ts'
import { atomicWrite } from '../files.ts'
import { isDeepStrictEqual } from 'node:util'
import { randomUUID } from 'node:crypto'
import * as dormant from './dormant.ts'
import type {
  AgentKey, Capability, CapabilityRuntimeState, RuntimeMutationResult,
} from '../types.ts'

/**
 * The CLM state engine (PRD §10).
 *
 * The live agent config is the source of truth for whether a capability is
 * active, never our stored state (§14). Every mutation follows §4.9:
 * read -> validate -> backup -> mutate -> validate -> restore on failure.
 */

// --- mutation log (§16) ------------------------------------------------------

export type MutationLogEntry = {
  at: string
  capabilityId: string
  agent: AgentKey
  from: CapabilityRuntimeState
  to: CapabilityRuntimeState
  success: boolean
  reason?: string
  /** Set when a profile or trigger drove the change rather than a click. */
  source?: 'manual' | 'profile' | 'trigger'
  error?: string
}

const logPath = () => join(stateDir(), 'mutations.json')

export function log(): MutationLogEntry[] {
  if (!existsSync(logPath())) return []
  try {
    return JSON.parse(readFileSync(logPath(), 'utf8')) as MutationLogEntry[]
  } catch {
    return []
  }
}

function appendLog(e: MutationLogEntry) {
  // Diagnostics must never undo a successfully restored credential entry.
  try {
    const all = [...log(), e].slice(-500)
    atomicWrite(logPath(), JSON.stringify(all, null, 2) + '\n')
  } catch { /* The live config and credential store remain authoritative. */ }
}

// --- validation --------------------------------------------------------------

/**
 * Does this agent's config still parse?
 * Delegates to the adapter's validate(), which does not swallow parse errors,
 * unlike the readers, where "unreadable" and "empty" look the same.
 */
export function validateConfig(adapter: AgentAdapter): { ok: boolean; error?: string } {
  try {
    return adapter.validate()
  } catch (e) {
    return { ok: false, error: (e as Error).message }
  }
}

// --- state -------------------------------------------------------------------

/** Resolve a capability for comparison against what is on disk. */
function resolveFor(cap: Capability, agent: AgentKey): Capability {
  if (cap.type === 'plugin' || !cap.install) return cap
  const stashed = dormant.get(cap.id, agent)
  // Compare against the args actually installed, when we know them: a Supabase
  // entry carries a project ref that the registry template does not.
  const live = adapters[agent].read(cap)
  const args = live?.args ?? stashed?.entry.args ?? resolveArgs(cap, { projectDir: process.cwd() })
  return { ...cap, install: { ...cap.install, args } }
}

/**
 * What state is this capability actually in, according to the live config?
 * `unknown` means neither live nor stashed, i.e. not installed at all.
 */
export function runtimeState(capabilityId: string, agent: AgentKey): CapabilityRuntimeState {
  const cap = getCapability(capabilityId)
  const adapter = adapters[agent]
  if (!supportsType(adapter, cap) || !cap.supportedAgents.includes(agent)) return 'unknown'
  try {
    if (!validateConfig(adapter).ok) return 'unknown'
    if (cap.type === 'plugin') {
      const p = adapter.readPlugin?.(cap)
      if (p) return p.enabled ? 'active' : 'dormant'
    } else {
      const live = adapter.read(resolveFor(cap, agent))
      // A present entry with enabled:false is installed but NOT exposed to the
      // agent, that is exactly dormancy, expressed natively.
      if (live) return live.enabled === false ? 'dormant' : 'active'
    }
  } catch {
    return 'unknown' // an unreadable config is not a claim either way
  }
  return dormant.get(capabilityId, agent) ? 'dormant' : 'unknown'
}

export type RuntimeRecord = {
  capability: Capability
  agent: AgentKey
  state: CapabilityRuntimeState
}

/** Every (capability, agent) pair CLM can manage, with its real current state. */
export function listRuntime(agentKeys?: AgentKey[]): RuntimeRecord[] {
  const keys = agentKeys ?? (Object.keys(adapters) as AgentKey[]).filter((k) => adapters[k].detect().detected)
  const out: RuntimeRecord[] = []
  for (const capability of capabilities()) {
    for (const agent of keys) {
      if (!capability.supportedAgents.includes(agent)) continue
      if (!supportsType(adapters[agent], capability)) continue
      out.push({ capability, agent, state: runtimeState(capability.id, agent) })
    }
  }
  return out
}

// --- mutations ---------------------------------------------------------------

type MutateOpts = { source?: MutationLogEntry['source'] }

function fail(
  capabilityId: string, agent: AgentKey, from: CapabilityRuntimeState,
  to: CapabilityRuntimeState, error: string, opts: MutateOpts, backupPath?: string,
): RuntimeMutationResult {
  appendLog({ at: new Date().toISOString(), capabilityId, agent, from, to, success: false, error, source: opts.source ?? 'manual' })
  return { success: false, capabilityId, agent, from, to: from, changedFiles: [], backupPath, error }
}

/**
 * ACTIVE -> DORMANT.
 * Stash the entry (credentials included) then remove it from the live config.
 * Nothing is uninstalled and no credential is destroyed (§20).
 */
export function deactivate(capabilityId: string, agent: AgentKey, opts: MutateOpts = {}): RuntimeMutationResult {
  const cap = getCapability(capabilityId)
  const adapter = adapters[agent]

  if (cap.type === 'plugin') {
    return fail(capabilityId, agent, 'unknown', 'dormant',
      'CLM manages MCP servers only; plugin context cost is not measurable from here', opts)
  }

  // Validity first. runtimeState() reports 'unknown' for an unreadable config,
  // which would otherwise surface as "not configured" and send the user looking
  // in the wrong place (PRD §17).
  const pre = validateConfig(adapter)
  if (!pre.ok) {
    return fail(capabilityId, agent, 'unknown', 'dormant',
      `${adapter.name} config could not be parsed: ${pre.error}. No changes were applied.`, opts)
  }

  const from = runtimeState(capabilityId, agent)
  if (from === 'dormant') {
    // Idempotent: already where the caller wants it.
    return { success: true, capabilityId, agent, from, to: 'dormant', changedFiles: [], noop: true }
  }
  if (from === 'unknown') {
    return fail(capabilityId, agent, from, 'dormant', `${cap.name} is not configured in ${adapter.name}`, opts)
  }

  const resolved = resolveFor(cap, agent)
  const entry = adapter.read(resolved)
  if (!entry) return fail(capabilityId, agent, from, 'dormant', 'entry vanished between read and write', opts)

  const token = backup(agent, adapter.configPath(), `clm-${stamp()}-${randomUUID()}`)
  const native = typeof adapter.setEnabled === 'function'
  try {
    if (native) {
      // Non-destructive: the entry and its credentials stay in the config.
      // Nothing to stash, so nothing to lose.
      adapter.setEnabled!(resolved, false)
    } else {
      // Stash BEFORE mutating: if the write fails we must not have lost the entry.
      dormant.stash(capabilityId, agent, entry)
      adapter.remove(resolved)
    }

    captureAfter(token, `clm-after-${randomUUID()}`)
    const post = validateConfig(adapter)
    if (!post.ok) throw new Error(`config invalid after ${native ? 'disable' : 'removal'}: ${post.error}`)
    if (runtimeState(capabilityId, agent) !== 'dormant') {
      throw new Error(`capability is still active after ${native ? 'disable' : 'removal'}`)
    }

    appendLog({ at: new Date().toISOString(), capabilityId, agent, from, to: 'dormant', success: true, source: opts.source ?? 'manual' })
    return {
      success: true, capabilityId, agent, from, to: 'dormant',
      changedFiles: [adapter.configPath()], backupPath: token.backupPath ?? undefined,
    }
  } catch (e) {
    try { prepareRestore(token)?.apply() } catch (rollbackError) {
      return fail(capabilityId, agent, from, from, `Change failed; rollback needs attention: ${(rollbackError as Error).message}`, opts, token.backupPath ?? undefined)
    }
    // Drop the stash ONLY once the live entry is demonstrably back. If the
    // restore did not take, that stash is the only surviving copy of the
    // entry and its credentials, discarding it here would turn a failed
    // deactivation into real data loss.
    if (!native) {
      const restored = adapter.read(resolved) !== null
      if (restored) dormant.drop(capabilityId, agent)
      else {
        return fail(
          capabilityId, agent, from, from,
          `${(e as Error).message}. The entry was not restored to the live config, so its saved copy has been kept, ` +
          'reactivate it from Manage, or restore the backup by hand.',
          opts, token.backupPath ?? undefined,
        )
      }
    }
    return fail(capabilityId, agent, from, 'dormant', (e as Error).message, opts, token.backupPath ?? undefined)
  }
}

/**
 * DORMANT -> ACTIVE.
 * Restore the stashed entry verbatim, credentials included.
 */
export function activate(capabilityId: string, agent: AgentKey, opts: MutateOpts = {}): RuntimeMutationResult {
  const cap = getCapability(capabilityId)
  const adapter = adapters[agent]

  if (cap.type === 'plugin') {
    return fail(capabilityId, agent, 'unknown', 'active', 'CLM manages MCP servers only', opts)
  }

  // Validity before state, for the same reason as deactivate().
  const preCheck = validateConfig(adapter)
  if (!preCheck.ok) {
    return fail(capabilityId, agent, 'unknown', 'active',
      `${adapter.name} config could not be parsed: ${preCheck.error}. No changes were applied.`, opts)
  }

  const from = runtimeState(capabilityId, agent)
  const stashed = dormant.get(capabilityId, agent)

  if (from === 'active') {
    // Idempotent, and the reason raw write() cannot be trusted here: Codex
    // refuses to redefine an existing table rather than duplicating it.
    const resolved = resolveFor(cap, agent)
    if (matchEntry(adapter, resolved, stashed?.entry.env ?? adapter.read(resolved)?.env ?? {}) !== 'absent') {
      dormant.drop(capabilityId, agent)
      return { success: true, capabilityId, agent, from, to: 'active', changedFiles: [], noop: true }
    }
  }
  // With a native flag the entry never left, so there is nothing to restore,
  // just switch it back on.
  if (typeof adapter.setEnabled === 'function' && !stashed) {
    const resolvedNative = resolveFor(cap, agent)
    if (!adapter.read(resolvedNative)) {
      return fail(capabilityId, agent, from, 'active', `${cap.name} is not configured in ${adapter.name}`, opts)
    }
    const t = backup(agent, adapter.configPath(), `clm-${stamp()}`)
    try {
      adapter.setEnabled(resolvedNative, true)
      captureAfter(t, `clm-after-${randomUUID()}`)
      const v = validateConfig(adapter)
      if (!v.ok) throw new Error(`config invalid after enable: ${v.error}`)
      if (runtimeState(capabilityId, agent) !== 'active') throw new Error('capability is still dormant after enable')
      appendLog({ at: new Date().toISOString(), capabilityId, agent, from, to: 'active', success: true, source: opts.source ?? 'manual' })
      return {
        success: true, capabilityId, agent, from, to: 'active',
        changedFiles: [adapter.configPath()], backupPath: t.backupPath ?? undefined,
      }
    } catch (e) {
      try { prepareRestore(t)?.apply() } catch (rollbackError) {
        return fail(capabilityId, agent, from, from, `Change failed; rollback needs attention: ${(rollbackError as Error).message}`, opts, t.backupPath ?? undefined)
      }
      return fail(capabilityId, agent, from, 'active', (e as Error).message, opts, t.backupPath ?? undefined)
    }
  }

  if (!stashed) {
    return fail(capabilityId, agent, from, 'active',
      `no dormant entry stored for ${cap.name} in ${adapter.name}; install it first`, opts)
  }

  const token = backup(agent, adapter.configPath(), `clm-${stamp()}`)
  try {
    const restoreCap: Capability = {
      ...cap,
      install: { command: stashed.entry.command, args: stashed.entry.args },
    }
    if (adapter.restoreEntry) adapter.restoreEntry(restoreCap, stashed.entry)
    else adapter.write(restoreCap, stashed.entry.env)
    captureAfter(token, `clm-after-${randomUUID()}`)

    const post = validateConfig(adapter)
    if (!post.ok) throw new Error(`config invalid after restore: ${post.error}`)
    const now = adapter.read(restoreCap)
    if (!now) throw new Error('entry missing after restore')
    if (now.command !== stashed.entry.command) throw new Error('restored entry does not match what was stashed')
    if (stashed.entry.native && !isDeepStrictEqual(now.native, stashed.entry.native)) {
      throw new Error('restored native entry does not match what was stashed')
    }

    dormant.drop(capabilityId, agent)
    appendLog({ at: new Date().toISOString(), capabilityId, agent, from, to: 'active', success: true, source: opts.source ?? 'manual' })
    return {
      success: true, capabilityId, agent, from, to: 'active',
      changedFiles: [adapter.configPath()], backupPath: token.backupPath ?? undefined,
    }
  } catch (e) {
    try { prepareRestore(token)?.apply() } catch (rollbackError) {
      return fail(capabilityId, agent, from, from, `Change failed; rollback needs attention: ${(rollbackError as Error).message}`, opts, token.backupPath ?? undefined)
    }
    return fail(capabilityId, agent, from, 'active', (e as Error).message, opts, token.backupPath ?? undefined)
  }
}

export function setState(
  capabilityId: string, agent: AgentKey, state: 'active' | 'dormant', opts: MutateOpts = {},
): RuntimeMutationResult {
  return state === 'active' ? activate(capabilityId, agent, opts) : deactivate(capabilityId, agent, opts)
}

// --- reconciliation (§15) ----------------------------------------------------

export type ReconcileEvent = {
  capabilityId: string
  agent: AgentKey
  was: string
  now: CapabilityRuntimeState
  action: string
}

/**
 * Bring stored state in line with reality at startup.
 *
 * The live config always wins. If a capability is active but we still hold a
 * dormant stash for it, the stash is stale, someone re-added it by hand, or an
 * install ran. Drop the stash; never rewrite the config to match our cache.
 */
export function reconcile(): ReconcileEvent[] {
  const events: ReconcileEvent[] = []
  for (const rec of dormant.entries()) {
    const state = runtimeState(rec.capabilityId, rec.agent)
    if (state === 'active') {
      dormant.drop(rec.capabilityId, rec.agent)
      events.push({
        capabilityId: rec.capabilityId, agent: rec.agent,
        was: 'dormant (stored)', now: 'active',
        action: 'dropped stale dormant stash; live config wins',
      })
    }
  }
  return events
}
