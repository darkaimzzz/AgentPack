import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { stateDir } from '../paths.ts'
import { atomicWrite } from '../files.ts'
import { probe } from '../installer/health.ts'
import { resolveArgs } from '../capabilities/registry.ts'
import type { Capability, CapabilityContextCost, ToolDefinition } from '../types.ts'

/**
 * Estimate what a capability costs in agent context (PRD §9).
 *
 * Every active MCP server's tool definitions, names, descriptions and JSON
 * schemas, are carried in the agent's context each session. We measure that
 * directly: serialize exactly what tools/list returned and divide by four.
 *
 * This is an ESTIMATE of schema size, not billed API tokens, and must be
 * labelled as such everywhere it is shown.
 */

const CHARS_PER_TOKEN = 4

export const costPath = () => join(stateDir(), 'costs.json')

export function estimateCost(tools: ToolDefinition[]): CapabilityContextCost {
  // Stable serialization: key order follows the server's own response, so the
  // same tools always produce the same number.
  const serializedChars = JSON.stringify(tools).length
  return {
    toolCount: tools.length,
    serializedChars,
    estimatedTokens: Math.round(serializedChars / CHARS_PER_TOKEN),
    measuredAt: new Date().toISOString(),
    source: 'measured',
  }
}

/** A capability we cannot measure from outside the agent. */
function unavailableCost(note: string): CapabilityContextCost {
  return {
    toolCount: 0,
    serializedChars: 0,
    estimatedTokens: 0,
    measuredAt: new Date().toISOString(),
    source: 'unavailable',
    note,
  }
}

// --- cache -------------------------------------------------------------------
// Probing costs ~4s per server. The UI must never pay that repeatedly, so
// results are cached against the exact command that produced them: change the
// pinned version and the key changes with it.

type Cache = Record<string, CapabilityContextCost>

const readCache = (): Cache => {
  const p = costPath()
  if (!existsSync(p)) return {}
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Cache
  } catch {
    return {} // a corrupt cache is a cache miss, never an error
  }
}

const writeCache = (c: Cache) => {
  mkdirSync(stateDir(), { recursive: true })
  atomicWrite(costPath(), JSON.stringify(c, null, 2) + '\n')
}

const cacheKey = (cap: Capability) =>
  cap.type === 'plugin'
    ? `plugin:${cap.id}`
    : createHash('sha256').update(JSON.stringify([cap.id, cap.install?.command, cap.install?.args])).digest('hex')

export const cachedCost = (cap: Capability): CapabilityContextCost | null =>
  readCache()[cacheKey(cap)] ?? null

/**
 * Measure a capability's context cost, using the cache unless `force`.
 *
 * Plugins have no tools/list, their skills and commands load inside the agent
 * process, where we cannot see them. Report that honestly rather than inventing
 * a number (PRD §9: "Do not invent precise numbers").
 */
export async function measureCost(
  cap: Capability,
  opts: { projectDir?: string; secrets?: Record<string, string>; inputs?: Record<string, string>; force?: boolean } = {},
): Promise<CapabilityContextCost> {
  const key = cacheKey(cap)
  const cache = readCache()
  if (!opts.force && cache[key]?.source === 'measured') return cache[key]

  if (cap.type === 'plugin' || !cap.install) {
    const cost = unavailableCost('plugins load inside the agent; their context cost is not measurable from here')
    cache[key] = cost
    writeCache({ ...readCache(), [key]: cost })
    return cost
  }

  const args = resolveArgs(cap, { projectDir: opts.projectDir ?? process.cwd(), values: opts.inputs })
  // Use installed credentials when available; placeholder probes may be rejected.
  const env = { ...opts.secrets, ...Object.fromEntries(
    (cap.secrets ?? []).map((s) => [s.key, opts.secrets?.[s.key] ?? 'agentpack-cost-probe']),
  ) }

  const r = await probe({ command: cap.install.command, args, env, secretValues: Object.values(env), timeoutMs: 180_000 })
  const cost = r.reachable
    ? estimateCost(r.toolDefinitions)
    : unavailableCost(`could not start the server: ${r.error ?? 'unknown error'}`)

  cache[key] = cost
  writeCache({ ...readCache(), [key]: cost })
  return cost
}

/** Sum a set of costs, ignoring unmeasurable ones. */
export function totalCost(costs: CapabilityContextCost[]) {
  const measured = costs.filter((c) => c.source === 'measured')
  return {
    toolCount: measured.reduce((n, c) => n + c.toolCount, 0),
    estimatedTokens: measured.reduce((n, c) => n + c.estimatedTokens, 0),
    unmeasurable: costs.length - measured.length,
  }
}
