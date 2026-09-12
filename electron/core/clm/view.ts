import { listRuntime, reconcile } from './state.ts'
import { cachedCost, measureCost, totalCost } from './cost.ts'
import { currentProfile } from './profiles.ts'
import { adapters } from '../agents/index.ts'
import type { AgentKey, Capability, CapabilityContextCost, CapabilityRuntimeState } from '../types.ts'

/**
 * Build everything the CLM screen needs in one call.
 *
 * Assembled in main rather than the renderer so the UI never has to correlate
 * runtime state with cost data itself, and so reconciliation against the live
 * config happens before anything is displayed (PRD §15).
 */

export type ClmRow = {
  capability: Capability
  agents: Array<{ agent: AgentKey; agentName: string; state: CapabilityRuntimeState }>
  cost: CapabilityContextCost | null
  anyActive: boolean
  anyDormant: boolean
  /** False for plugins: CLM manages MCP servers only. */
  manageable: boolean
}

export type ClmView = {
  rows: ClmRow[]
  summary: {
    installedCount: number
    activeCount: number
    activeTools: number
    allTools: number
    activeTokens: number
    allTokens: number
    unmeasurable: number
  }
  currentProfileId: string | null
  reconciled: number
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
      cost: cachedCost(capability),
      anyActive: recs.some((r) => r.state === 'active'),
      anyDormant: recs.some((r) => r.state === 'dormant'),
      manageable: capability.type === 'mcp',
    })
  }
  rows.sort((a, b) => Number(b.anyActive) - Number(a.anyActive) || a.capability.name.localeCompare(b.capability.name))

  // Cost is per capability, not per agent: the same server loaded into two
  // agents costs each of them that much, but the figure we show is the schema
  // size, which does not change.
  const withCost = rows.filter((r) => r.cost)
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
export async function measureAll(projectDir: string): Promise<number> {
  const rows = clmView().rows
  let measured = 0
  for (const row of rows) {
    if (row.cost) continue
    await measureCost(row.capability, { projectDir })
    measured++
  }
  return measured
}
