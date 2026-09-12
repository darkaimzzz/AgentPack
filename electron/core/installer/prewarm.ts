import { capabilities } from '../capabilities/registry.ts'
import { probe } from './health.ts'
import type { Capability } from '../types.ts'

/**
 * Download and start every registry capability once, so the npx cache is warm.
 *
 * This is the single biggest live-demo risk: a cold `npx -y <pkg>` fetches from
 * the network, turning a 4-second validate into a minute or a timeout on venue
 * wi-fi. Run this before the demo, on the demo machine, on a good connection.
 */
export type PrewarmResult = {
  capability: Capability
  ok: boolean
  tools: number
  durationMs: number
  error?: string
}

export async function prewarm(
  ids?: string[],
  onEach?: (r: PrewarmResult) => void,
): Promise<PrewarmResult[]> {
  const caps = capabilities().filter((c) => !ids?.length || ids.includes(c.id))
  const out: PrewarmResult[] = []

  for (const capability of caps) {
    // Placeholders are irrelevant here — we only need the package downloaded and
    // the server to start. A bad project-ref still exercises the network path.
    const args = capability.install.args.map((a) => a.replace(/\$\{(\w+)\}/g, 'prewarm'))
    const env = Object.fromEntries((capability.secrets ?? []).map((s) => [s.key, 'prewarm-placeholder']))
    const r = await probe({ command: capability.install.command, args, env, timeoutMs: 300_000 })
    const result: PrewarmResult = {
      capability,
      ok: r.reachable,
      tools: r.tools.length,
      durationMs: r.durationMs,
      error: r.error,
    }
    out.push(result)
    onEach?.(result)
  }

  return out
}
