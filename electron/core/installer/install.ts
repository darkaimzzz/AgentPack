import { adapters } from '../agents/index.ts'
import { getCapability, resolveArgs, missingInputs } from '../capabilities/registry.ts'
import { backup, restore } from './backup.ts'
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
        health: { configured: false, reachable: false, tools: [], durationMs: 0, error },
      })),
    }
  }

  // One backup per agent per run, taken before any mutation. Backing up per
  // capability would create redundant copies and muddle what "undo" means.
  onProgress({ kind: 'stage', stage: 'backup' })
  const backups = agents.map((key) => {
    const token = backup(key, adapters[key].configPath(), runId)
    onProgress({ kind: 'stage', stage: 'backup', detail: `${adapters[key].name}: ${token.existed ? token.backupPath! : 'no existing config'}` })
    return token
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
    const resolved: Capability = { ...cap, install: { ...cap.install, args } }
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
        health: { configured: false, reachable: false, tools: [], durationMs: 0, error },
      })
      continue
    }

    onProgress({ kind: 'stage', stage: 'configure', detail: cap.name })
    const results: InstallResult[] = agents.map((key) => {
      const adapter = adapters[key]
      const token = backups.find((b) => b.agent === key)!
      const base = { agent: key, configPath: adapter.configPath(), backupPath: token.backupPath }
      try {
        if (!cap.supportedAgents.includes(key)) {
          return { ...base, status: 'failed' as const, error: `${cap.name} does not support ${adapter.name}` }
        }
        // Idempotency guard. Without it a second install duplicates the entry,
        // which is the most likely live-demo failure.
        if (adapter.has(resolved)) {
          onProgress({ kind: 'agent', agent: key, status: 'already-present', detail: cap.name })
          return { ...base, status: 'already-present' as const }
        }
        adapter.write(resolved, env)
        onProgress({ kind: 'agent', agent: key, status: 'installed', detail: cap.name })
        return { ...base, status: 'installed' as const }
      } catch (e) {
        const error = (e as Error).message
        onProgress({ kind: 'agent', agent: key, status: 'failed', detail: `${cap.name}: ${error}` })
        return { ...base, status: 'failed' as const, error }
      }
    })

    // Validate by starting the server ourselves. Agent-independent on purpose:
    // it proves the capability works rather than that a file parsed.
    onProgress({ kind: 'stage', stage: 'validate', detail: cap.name })
    const p = await probe({ command: resolved.install.command, args, env, secretValues })
    const configured = results.some((r) => r.status === 'installed' || r.status === 'already-present')
    const health: HealthResult = { configured, ...p }
    onProgress({
      kind: 'stage',
      stage: 'validate',
      detail: health.reachable ? `${cap.name}: ${health.tools.length} tools` : `${cap.name}: FAILED — ${health.error}`,
    })

    reports.push({ capability: cap, results, health })
  }

  onProgress({ kind: 'stage', stage: 'done' })
  return { id: runId, capabilities: reports, ledgerId: runId, preflight: pre }
}

/**
 * Undo a run by restoring the configs we backed up.
 * We restore configuration only — we do not claim to undo npm/npx caches
 * or machine state (CLAUDE.md §15).
 */
export function rollback(ledgerId?: string): { restored: string[]; entryId: string } | null {
  const entry = ledgerId ? ledger.entries().find((e) => e.id === ledgerId) : ledger.latestUndoable()
  if (!entry) return null
  for (const token of entry.backups) restore(token)
  ledger.markRolledBack(entry.id)
  return { restored: entry.backups.filter((b) => b.existed).map((b) => b.configPath), entryId: entry.id }
}

/**
 * Undo every run that has not been rolled back, newest first.
 *
 * Order matters: restoring the oldest backup last leaves the configs exactly as
 * they were before the first install. Used between demo runs so the machine is
 * reset without manual repair (CLAUDE.md §24).
 */
export function rollbackAll(): { entries: string[]; restored: string[] } {
  const undone: string[] = []
  const restored = new Set<string>()
  for (const entry of [...ledger.entries()].filter((e) => !e.rolledBackAt).reverse()) {
    for (const token of entry.backups) {
      restore(token)
      if (token.existed) restored.add(token.configPath)
    }
    ledger.markRolledBack(entry.id)
    undone.push(entry.id)
  }
  return { entries: undone, restored: [...restored] }
}
