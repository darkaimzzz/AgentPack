import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Capability, Pack } from '../types.ts'

// Registry lives on disk as data, never hard-coded into components (CLAUDE.md §17).
// Curated + allow-listed: no open marketplace (§21).
//
// Walk up looking for the registry rather than counting "../" levels: this file
// runs both as source (electron/core/capabilities/) and bundled into out/main/,
// which sit at different depths.
function findRegistry(): string {
  if (process.env.AGENTPACK_REGISTRY) return process.env.AGENTPACK_REGISTRY
  let dir = dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, 'registry')
    if (existsSync(join(candidate, 'capabilities'))) return candidate
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  throw new Error('could not locate the registry directory; set AGENTPACK_REGISTRY')
}

let rootCache: string | null = null
const root = () => (rootCache ??= findRegistry())

const loadDir = <T>(sub: string): T[] =>
  readdirSync(join(root(), sub))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(root(), sub, f), 'utf8')) as T)

let capCache: Capability[] | null = null
let packCache: Pack[] | null = null

export const capabilities = (): Capability[] => (capCache ??= loadDir<Capability>('capabilities'))
export const packs = (): Pack[] => (packCache ??= loadDir<Pack>('packs'))

export const getCapability = (id: string): Capability => {
  const c = capabilities().find((x) => x.id === id)
  if (!c) throw new Error(`unknown capability: ${id}`)
  return c
}

export const getPack = (id: string): Pack => {
  const p = packs().find((x) => x.id === id)
  if (!p) throw new Error(`unknown pack: ${id}`)
  return p
}

/**
 * Resolve ${...} placeholders in install args.
 *
 * ${projectDir} is built in — servers like filesystem are useless without a
 * path, and baking an absolute path into shared registry data is not portable.
 * Everything else comes from the capability's declared `inputs`.
 */
export function resolveArgs(
  cap: Capability,
  ctx: { projectDir: string; values?: Record<string, string> },
): string[] {
  const table: Record<string, string> = { projectDir: ctx.projectDir, ...ctx.values }
  return cap.install.args.map((a) => a.replace(/\$\{(\w+)\}/g, (whole, key: string) => table[key] ?? whole))
}

/** Placeholders an arg list still needs before it can be installed. */
export function missingInputs(cap: Capability, values: Record<string, string> = {}): string[] {
  return (cap.inputs ?? []).filter((i) => !values[i.key]).map((i) => i.key)
}
