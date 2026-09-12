import { adapters } from '../agents/index.ts'
import { matchEntry, supportsType } from '../agents/adapter.ts'
import { getCapability, resolveArgs, missingInputs } from '../capabilities/registry.ts'
import { backup, restoreFile, deleteFile, hashFile } from './backup.ts'
import { preflight, type PreflightResult } from './preflight.ts'
import { probe } from './health.ts'
import * as ledger from './ledger.ts'
import { stamp } from '../paths.ts'
import type { AgentKey, Capability, HealthResult, InstallResult, ProgressEvent } from '../types.ts'

export type InstallRequest = {
  capabilityIds: string[]
  agents: AgentKey[]
  projectDir: string
  /** Live secret values, in memory only. Never written to the ledger (CLAUDE.md §14). */
  secrets?: Record<string, string>
  /** Non-secret values substituted into args as ${KEY}. Safe to record. */
  inputs?: Record<string, string>
  onProgress?: (e: ProgressEvent) => void
}

export type CapabilityReport = {
  capability: Capability
  results: InstallResult[]
  health: HealthResult
}

export type InstallReport = {
  id: string
  capabilities: CapabilityReport[]
  /** Pass this to rollback() to undo the whole run. */
  ledgerId: string
  preflight?: PreflightResult
}

export async function install(req: InstallRequest): Promise<InstallReport> {
  const { capabilityIds, agents, projectDir, secrets = {}, inputs = {}, onProgress = () => {} } = req
  const runId = stamp()
  const secretValues = Object.values(secrets)
  const caps = capabilityIds.map(getCapability)

  // Preflight before any mutation: a missing runtime is one clear message here
  // rather than three cryptic spawn failures later (CLAUDE.md §12).
  onProgress({ kind: 'stage', stage: 'preflight' })
  // Every capability, plugins included: a plugin has no launcher command, but it
  // may still declare a CLI it cannot work without.
  const pre = await preflight(caps)
  for (const b of pre.binaries) {
    onProgress({
      kind: 'stage',
      stage: 'preflight',
      detail: b.found ? `${b.name} ${b.version ?? ''}`.trim() : `${b.name} NOT FOUND`,
    })
  }
  if (!pre.ok) {
    const error = pre.problems.join('; ')
    return {
      id: runId,
      ledgerId: runId,
      preflight: pre,
      capabilities: caps.map((capability) => ({
        capability,
        results: agents.map((key) => ({
          agent: key,
          status: 'failed' as const,
          configPath: adapters[key].configPath(),
          backupPath: null,
          error,
        })),
        health: { status: 'failed' as const, method: 'config-only' as const, configured: false, reachable: false, tools: [], durationMs: 0, error },
      })),
    }
  }

  // One backup per agent per run, taken before any mutation. Backing up per
  // capability would create redundant copies and muddle what "undo" means.
  onProgress({ kind: 'stage', stage: 'backup' })
  const hasPlugin = caps.some((c) => c.type === 'plugin')
  const backups = agents.flatMap((key) => {
    const a = adapters[key]
    // A plugin install can write a SECOND file (Claude keeps plugins in
    // settings.json, not .claude.json). Back up everything the run may touch,
    // or rollback silently cannot undo it.
    const paths = new Set([a.configPath()])
    if (hasPlugin && a.pluginConfigPath) paths.add(a.pluginConfigPath())
    return [...paths].map((path) => {
      const token = backup(key, path, runId)
      onProgress({ kind: 'stage', stage: 'backup', detail: `${a.name}: ${token.existed ? token.backupPath! : `${path} (new)`}` })
      return token
    })
  })

  // Record the ledger entry NOW, before a single byte is written. If anything
  // below throws, the backups are still reachable and rollback still works —
  // which is precisely the moment it matters.
  ledger.record({
    id: runId,
    at: new Date().toISOString(),
    projectDir,
    capabilities: capabilityIds,
    secretKeys: Object.keys(secrets), // names only
    inputs, // non-secret by contract, so recorded in full for reproducibility
    backups,
  })

  const reports: CapabilityReport[] = []

  for (const cap of caps) {
    const args = resolveArgs(cap, { projectDir, values: inputs })
    // Only MCP capabilities carry an install block; do not fabricate one for a
    // plugin, or `install` would exist with no command.
    const resolved: Capability = cap.install
      ? { ...cap, install: { ...cap.install, args } }
      : cap
    const env = Object.fromEntries(
      (cap.secrets ?? []).map((s) => [s.key, secrets[s.key] ?? '']).filter(([, v]) => v),
    )

    // Refuse rather than write a config containing a literal ${PLACEHOLDER},
    // which would look installed and fail later inside the agent.
    const missing = missingInputs(cap, inputs)
    if (missing.length) {
      const error = `missing required input: ${missing.join(', ')}`
      onProgress({ kind: 'stage', stage: 'configure', detail: `${cap.name}: ${error}` })
      reports.push({
        capability: cap,
        results: agents.map((key) => ({
          agent: key,
          status: 'failed' as const,
          configPath: adapters[key].configPath(),
          backupPath: backups.find((b) => b.agent === key)!.backupPath,
          error,
        })),
        health: { status: 'failed' as const, method: 'config-only' as const, configured: false, reachable: false, tools: [], durationMs: 0, error },
      })
      continue
    }

    onProgress({ kind: 'stage', stage: 'configure', detail: cap.name })
    const results: InstallResult[] = agents.map((key) => {
      const adapter = adapters[key]
      const token = backups.find((b) => b.agent === key && b.configPath === adapter.configPath())!
      const base = { agent: key, configPath: adapter.configPath(), backupPath: token.backupPath }
      try {
        if (!cap.supportedAgents.includes(key) || !supportsType(adapter, cap)) {
          // Not a failure — this agent simply cannot host this kind of
          // capability. Reporting it as failed would make a correct outcome
          // look broken.
          const why = cap.type === 'plugin' && !supportsType(adapter, cap)
            ? `${adapter.name} has no git-marketplace plugin system`
            : `${cap.name} does not support ${adapter.name}`
          onProgress({ kind: 'agent', agent: key, status: 'unsupported', detail: cap.name })
          return { ...base, status: 'unsupported' as const, error: why }
        }
        // Compare what is actually on disk, not merely whether the id exists.
        // An entry with a stale command, a changed scope, or enabled:false would
        // otherwise be reported as a healthy install.
        const state = matchEntry(adapter, resolved, env)
        if (state === 'same') {
          onProgress({ kind: 'agent', agent: key, status: 'already-present', detail: cap.name })
          return { ...base, status: 'already-present' as const }
        }
        if (state === 'different') {
          const existing = adapter.read(resolved)
          const error =
            `${cap.name} is already configured in ${adapter.name} with different settings ` +
            `(${existing?.enabled === false ? 'disabled' : `${existing?.command} ${existing?.args.join(' ')}`}). ` +
            'Left untouched — remove it there, or roll back, to replace it.'
          onProgress({ kind: 'agent', agent: key, status: 'conflict', detail: `${cap.name}: differs` })
          return { ...base, status: 'conflict' as const, error }
        }
        if (cap.type === 'plugin') adapter.writePlugin!(resolved)
        else adapter.write(resolved, env)
        onProgress({ kind: 'agent', agent: key, status: 'installed', detail: cap.name })
        return { ...base, status: 'installed' as const }
      } catch (e) {
        const error = (e as Error).message
        onProgress({ kind: 'agent', agent: key, status: 'failed', detail: `${cap.name}: ${error}` })
        return { ...base, status: 'failed' as const, error }
      }
    })

    onProgress({ kind: 'stage', stage: 'validate', detail: cap.name })
    const configured = results.some((r) => r.status === 'installed' || r.status === 'already-present')

    let health: HealthResult
    if (cap.type === 'plugin') {
      // A plugin has no server to start — its skills and commands load inside
      // the agent process. We can confirm the config is correct and nothing
      // more, so we say exactly that rather than implying verification.
      health = {
        status: configured ? 'configured' : 'failed',
        method: 'config-only',
        configured,
        reachable: false,
        tools: [],
        durationMs: 0,
        error: configured ? undefined : 'not written to any agent',
      }
    } else {
      // Validate by starting the server ourselves. Agent-independent on purpose:
      // it proves the capability works rather than that a file parsed.
      const p = await probe({ command: resolved.install!.command, args, env, secretValues })
      health = { status: p.reachable ? 'verified' : 'failed', method: 'tools-list', configured, ...p }
    }

    onProgress({
      kind: 'stage',
      stage: 'validate',
      detail: health.status === 'verified' ? `${cap.name}: ${health.tools.length} tools`
        : health.status === 'configured' ? `${cap.name}: configured (loads inside the agent)`
        : `${cap.name}: FAILED — ${health.error}`,
    })

    reports.push({ capability: cap, results, health })
  }

  // Record what the files look like now, so rollback can tell "untouched since
  // we wrote it" from "the user or the agent edited it afterwards".
  ledger.amend(runId, {
    backups: backups.map((b) => ({ ...b, postHash: hashFile(b.configPath) })),
  })

  onProgress({ kind: 'stage', stage: 'done' })
  return { id: runId, capabilities: reports, ledgerId: runId, preflight: pre }
}

/**
 * Undo a run by restoring the configs we backed up.
 * We restore configuration only — we do not claim to undo npm/npx caches
 * or machine state (CLAUDE.md §15).
 */
export type RollbackOutcome = {
  entryId: string
  restored: string[]
  /** Files we created and have now deleted. */
  removed: string[]
  /** Files edited since install: we removed only our own entries. */
  merged: string[]
}

/**
 * Undo one run.
 *
 * Whole-file restore is only safe when nothing has touched the file since we
 * wrote it — and something often has, because Claude Code rewrites
 * ~/.claude.json continuously. When the file has changed we remove just our own
 * entries instead, so a later edit is never silently destroyed.
 */
export function rollback(ledgerId?: string): RollbackOutcome | null {
  const entry = ledgerId ? ledger.entries().find((e) => e.id === ledgerId) : ledger.latestUndoable()
  if (!entry) return null
  const outcome = undoEntry(entry)
  ledger.markRolledBack(entry.id)
  return outcome
}

function undoEntry(entry: ledger.LedgerEntry): RollbackOutcome {
  const restored: string[] = []
  const removed: string[] = []
  const merged: string[] = []
  const caps = entry.capabilities.map((id) => {
    try {
      return getCapability(id)
    } catch {
      return null
    }
  }).filter((c): c is Capability => c !== null)

  for (const token of entry.backups) {
    const adapter = adapters[token.agent]
    const current = hashFile(token.configPath)
    if (current === null) continue // already gone; nothing to undo

    const untouched = token.postHash != null && current === token.postHash

    const undo = (c: Capability) => (c.type === 'plugin' ? adapter.removePlugin?.(c) : adapter.remove(c))
    if (!token.existed) {
      // We created this file. Delete it if it is still ours alone; otherwise
      // strip our entries and keep whatever else arrived.
      if (untouched) {
        deleteFile(token.configPath)
        removed.push(token.configPath)
      } else {
        for (const cap of caps) undo(cap)
        if (adapter.isEmpty()) {
          deleteFile(token.configPath)
          removed.push(token.configPath)
        } else {
          merged.push(token.configPath)
        }
      }
      continue
    }

    if (untouched) {
      restoreFile(token)
      restored.push(token.configPath)
    } else {
      for (const cap of caps) undo(cap)
      merged.push(token.configPath)
    }
  }

  return { entryId: entry.id, restored, removed, merged }
}

/**
 * Undo every run that has not been rolled back, newest first.
 *
 * Order matters: restoring the oldest backup last leaves the configs exactly as
 * they were before the first install. Used between demo runs so the machine is
 * reset without manual repair (CLAUDE.md §24).
 */
export function rollbackAll(): { entries: string[]; restored: string[]; removed: string[]; merged: string[] } {
  const undone: string[] = []
  const restored = new Set<string>()
  const removed = new Set<string>()
  const merged = new Set<string>()
  for (const entry of [...ledger.entries()].filter((e) => !e.rolledBackAt).reverse()) {
    const o = undoEntry(entry)
    o.restored.forEach((p) => restored.add(p))
    o.removed.forEach((p) => removed.add(p))
    o.merged.forEach((p) => merged.add(p))
    ledger.markRolledBack(entry.id)
    undone.push(entry.id)
  }
  return { entries: undone, restored: [...restored], removed: [...removed], merged: [...merged] }
}
