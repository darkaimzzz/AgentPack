import { readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Capability, Pack } from '../types.ts'

// Registry lives on disk as data, never hard-coded into components (CLAUDE.md §17).
// Curated + allow-listed: no open marketplace (§21).
const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', 'registry')

const loadDir = <T>(sub: string): T[] =>
  readdirSync(join(root, sub))
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(root, sub, f), 'utf8')) as T)

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
 * Resolve registry placeholders in install args.
 * Only ${projectDir} today — servers like filesystem are useless without a path,
 * and baking an absolute path into shared registry data would not be portable.
 */
export function resolveArgs(cap: Capability, ctx: { projectDir: string }): string[] {
  return cap.install.args.map((a) => a.replaceAll('${projectDir}', ctx.projectDir))
}
