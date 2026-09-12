import { writeFileSync, readFileSync } from 'node:fs'
import { getCapability, capabilities } from './registry.ts'
import { adapters } from '../agents/index.ts'
import type { AgentKey, Capability } from '../types.ts'

/**
 * Export what is installed as a reusable manifest, and read one back
 * (CLAUDE.md §19: configure once, reproduce elsewhere).
 *
 * Secret VALUES are never exported — only the names of the variables the
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
          return a.detect().detected && a.has(capability)
        } catch {
          return false // an unreadable config is not a crash
        }
      }),
    }))
    .filter((x) => x.agents.length > 0)
}

export function buildManifest(opts: {
  name?: string
  capabilityIds?: string[]
  targets?: AgentKey[]
  inputs?: Record<string, string>
}): Manifest {
  const live = installedCapabilities()
  const ids = opts.capabilityIds ?? live.map((x) => x.capability.id)
  const caps = ids.map(getCapability)
  const requiredSecrets = [...new Set(caps.flatMap((c) => (c.secrets ?? []).map((s) => s.key)))]

  return {
    agentpack: 1,
    name: opts.name ?? 'exported-pack',
    exportedAt: new Date().toISOString(),
    capabilities: ids,
    targets: opts.targets ?? [...new Set(live.flatMap((x) => x.agents))],
    ...(opts.inputs && Object.keys(opts.inputs).length ? { inputs: opts.inputs } : {}),
    ...(requiredSecrets.length ? { requiredSecrets } : {}),
  }
}

export function exportManifest(path: string, manifest: Manifest): void {
  writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n')
}

export function readManifest(path: string): Manifest {
  const m = JSON.parse(readFileSync(path, 'utf8')) as Manifest
  if (m.agentpack !== 1) throw new Error(`unsupported manifest version: ${m.agentpack}`)
  if (!Array.isArray(m.capabilities) || !m.capabilities.length) throw new Error('manifest lists no capabilities')
  // Fail on import, not halfway through installing.
  const unknown = m.capabilities.filter((id) => !capabilities().some((c) => c.id === id))
  if (unknown.length) throw new Error(`manifest references unknown capabilities: ${unknown.join(', ')}`)
  return m
}

/** Secret names an importer still needs to supply. */
export function manifestMissingSecrets(m: Manifest, provided: Record<string, string> = {}): string[] {
  return (m.requiredSecrets ?? []).filter((k) => !provided[k])
}
