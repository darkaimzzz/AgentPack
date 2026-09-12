import { listRuntime, reconcile } from './state.ts'
import { cachedCost, measureCost, totalCost } from './cost.ts'
import { currentProfile } from './profiles.ts'
import { adapters } from '../agents/index.ts'
import * as dormant from './dormant.ts'
import type { Capability } from '../types.ts'
import type { AgentKey, ClmRow, ClmView } from '../types.ts'

/**
 * Build everything the CLM screen needs in one call.
 *
 * Assembled in main rather than the renderer so the UI never has to correlate
 * runtime state with cost data itself, and so reconciliation against the live
 * config happens before anything is displayed (PRD §15).
 */


function measurementEntry(capability: Capability, agents: AgentKey[]) {
  for (const agent of agents) {
    const entry = adapters[agent].read(capability) ?? dormant.get(capability.id, agent)?.entry
    if (entry?.command) return { capability: { ...capability, install: { command: entry.command, args: entry.args } }, env: entry.env }
  }
  return null
}

export function clmView(agents?: AgentKey[]): ClmView {
  // Live config is the source of truth; drop any stale stash before reading.
  const reconciled = reconcile().length

  const records = listRuntime(agents)
  const byCapability = new Map<string, typeof records>()
  for (const r of records) {
    byCapability.set(r.capability.id, [...(byCapability.get(r.capability.id) ?? []), r])
  }

  const rows: ClmRow[] = []
  for (const [, recs] of byCapability) {
    const capability = recs[0].capability
    rows.push({
      capability,
      agents: recs.map((r) => ({ agent: r.agent, agentName: adapters[r.agent].name, state: r.state })),
      cost: capability.type === 'mcp' ? (() => { const entry = measurementEntry(capability, recs.filter((r) => r.state !== 'unknown').map((r) => r.agent)); return entry ? cachedCost(entry.capability) : null })() : cachedCost(capability),
      anyActive: recs.some((r) => r.state === 'active'),
      anyDormant: recs.some((r) => r.state === 'dormant'),
      manageable: capability.type === 'mcp',
    })
  }
  rows.sort((a, b) => Number(b.anyActive) - Number(a.anyActive) || a.capability.name.localeCompare(b.capability.name))

  // Cost is per capability, not per agent: the same server loaded into two
  // agents costs each of them that much, but the figure we show is the schema
  // size, which does not change.
  const withCost = rows.filter((r) => r.cost && (r.anyActive || r.anyDormant))
  const all = totalCost(withCost.map((r) => r.cost!))
  const active = totalCost(withCost.filter((r) => r.anyActive).map((r) => r.cost!))

  return {
    rows,
    summary: {
      installedCount: rows.filter((r) => r.anyActive || r.anyDormant).length,
      activeCount: rows.filter((r) => r.anyActive).length,
      activeTools: active.toolCount,
      allTools: all.toolCount,
      activeTokens: active.estimatedTokens,
      allTokens: all.estimatedTokens,
      unmeasurable: all.unmeasurable,
    },
    currentProfileId: currentProfile(agents)?.id ?? null,
    reconciled,
  }
}

/** Measure anything not yet cached. Slow (~4s per server), so it is explicit. */
export async function measureAll(projectDir: string, force = false): Promise<number> {
  const rows = clmView().rows
  let measured = 0
  for (const row of rows) {
    if ((!row.anyActive && !row.anyDormant) || row.capability.type !== 'mcp' || (!force && row.cost?.source === 'measured')) continue
    const entry = measurementEntry(row.capability, row.agents.filter((a) => a.state !== 'unknown').map((a) => a.agent))
    if (!entry) continue
    await measureCost(entry.capability, { projectDir, secrets: entry.env, force })
    measured++
  }
  return measured
}
