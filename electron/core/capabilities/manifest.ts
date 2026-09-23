import { writeFileSync, readFileSync } from 'node:fs'
import { getCapability, capabilities } from './registry.ts'
import { adapters } from '../agents/index.ts'
import { entries as ledgerEntries } from '../installer/ledger.ts'
import type { AgentKey, Capability } from '../types.ts'
import { atomicWrite } from '../files.ts'

/**
 * Export what is installed as a reusable manifest, and read one back
 * (CLAUDE.md §19: configure once, reproduce elsewhere).
 *
 * Secret VALUES are never exported, only the names of the variables the
 * recipient must supply. Non-secret `inputs` (a project ref, say) carry over,
 * which is the whole reason those two are separate concepts.
 */

export type Manifest = {
  agentpack: 1
  name: string
  exportedAt: string
  capabilities: string[]
  targets: AgentKey[]
  inputs?: Record<string, string>
  /** Variables the importer must provide. Names only, by design. */
  requiredSecrets?: string[]
}

/** Read the live agent configs and report which registry capabilities are present. */
export function installedCapabilities(): Array<{ capability: Capability; agents: AgentKey[] }> {
  return capabilities()
    .map((capability) => ({
      capability,
      agents: (Object.keys(adapters) as AgentKey[]).filter((key) => {
        const a = adapters[key]
        try {
          if (!a.detect().detected) return false
          return capability.type === 'plugin' ? a.readPlugin?.(capability) != null : a.read(capability) !== null
        } catch {
          return false // an unreadable config is not a crash
        }
      }),
    }))
    .filter((x) => x.agents.length > 0)
}

/**
 * Recover the non-secret input values a capability was installed with.
 *
 * Prefer the live config, an arg like `--project-ref=abc` is the ground truth,
 * and fall back to the install ledger. Without this, exporting a real Supabase
 * install silently drops its project ref and the manifest cannot be replayed.
 */
function recoverInputs(caps: Capability[]): Record<string, string> {
  const recovered: Record<string, string> = {}

  for (const cap of caps) {
    for (const input of cap.inputs ?? []) {
      // Find the registry arg carrying this placeholder, then read the value
      // back out of whatever the agent actually has on disk.
      const idx = (cap.install?.args ?? []).findIndex((a) => a.includes(`\${${input.key}}`))
      if (idx === -1) continue
      const pattern = cap.install!.args[idx]
      for (const key of Object.keys(adapters) as AgentKey[]) {
        try {
          const entry = adapters[key].read(cap)
          const actual = entry?.args[idx]
          if (!actual) continue
          // Turn "--project-ref=${X}" + "--project-ref=abc" into "abc".
          const re = new RegExp('^' + pattern.split(`\${${input.key}}`).map((p) =>
            p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('(.+)') + '$')
          const m = actual.match(re)
          if (m?.[1]) { recovered[input.key] = m[1]; break }
        } catch { /* unreadable config is not fatal to an export */ }
      }
    }
  }

  // Ledger fallback for anything the configs did not yield.
  const allowed = new Set(caps.flatMap(c=>(c.inputs??[]).map(i=>i.key)))
  for (const entry of ledgerEntries().filter((e) => !e.rolledBackAt).reverse()) {
    for (const [k, v] of Object.entries(entry.inputs ?? {})) if(allowed.has(k)) recovered[k] ??= v
  }

  return recovered
}

export function buildManifest(opts: {
  name?: string
  capabilityIds?: string[]
  targets?: AgentKey[]
  inputs?: Record<string, string>
} = {}): Manifest {
  const live = installedCapabilities()
  const ids = opts.capabilityIds ?? live.map((x) => x.capability.id)
  const caps = ids.map(getCapability)
  const requiredSecrets = [...new Set(caps.flatMap((c) => (c.secrets ?? []).map((s) => s.key)))]
  const values = { ...recoverInputs(caps), ...opts.inputs }
  const inputs = Object.fromEntries(caps.flatMap(c=>(c.inputs??[]).map(i=>i.key)).filter(k=>typeof values[k]==='string').map(k=>[k,values[k]]))

  return {
    agentpack: 1,
    name: opts.name ?? 'exported-pack',
    exportedAt: new Date().toISOString(),
    capabilities: ids,
    targets: opts.targets ?? [...new Set(live.flatMap((x) => x.agents))],
    ...(Object.keys(inputs).length ? { inputs } : {}),
    ...(requiredSecrets.length ? { requiredSecrets } : {}),
  }
}

export function exportManifest(path: string, manifest: Manifest): void {
  atomicWrite(path, JSON.stringify(manifest, null, 2) + '\n')
}

export function readManifest(path: string): Manifest {
  const m = JSON.parse(readFileSync(path, 'utf8')) as Manifest
  if (!m || typeof m !== 'object') throw new Error('Invalid manifest')
  if (m.agentpack !== 1) throw new Error(`unsupported manifest version: ${m.agentpack}`)
  if (!Array.isArray(m.capabilities) || !m.capabilities.length) throw new Error('manifest lists no capabilities')
  // Fail on import, not halfway through installing.
  const unknown = m.capabilities.filter((id) => !capabilities().some((c) => c.id === id))
  if (unknown.length) throw new Error(`manifest references unknown capabilities: ${unknown.join(', ')}`)
  if (!Array.isArray(m.targets) || !m.targets.length || m.targets.some(k=>!Object.hasOwn(adapters,k))) throw new Error('Manifest must specify valid target agents')
  if (m.inputs && (typeof m.inputs!=='object' || Array.isArray(m.inputs) || Object.values(m.inputs).some(v=>typeof v!=='string'))) throw new Error('Manifest inputs must be strings')
  const caps=m.capabilities.map(getCapability)
  const allowed=new Set(caps.flatMap(c=>(c.inputs??[]).map(i=>i.key)))
  return {...m,capabilities:[...new Set(m.capabilities)],targets:[...new Set(m.targets)],
    inputs:Object.fromEntries(Object.entries(m.inputs??{}).filter(([k])=>allowed.has(k))),
    requiredSecrets:[...new Set(caps.flatMap(c=>(c.secrets??[]).map(s=>s.key)))]}
}

/** Secret names an importer still needs to supply. */
export function manifestMissingSecrets(m: Manifest, provided: Record<string, string> = {}): string[] {
  return (m.requiredSecrets ?? []).filter((k) => !provided[k])
}
