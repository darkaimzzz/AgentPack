import { getCapability, resolveArgs } from '../capabilities/registry.ts'
import { statSync } from 'node:fs'
import { resolve } from 'node:path'
import { probe } from './health.ts'
import type { Capability } from '../types.ts'

/** Warm the credential-free demo servers against a real project directory. */
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
  projectDir = process.cwd(),
): Promise<PrewarmResult[]> {
  const dir = resolve(projectDir)
  if (!statSync(dir).isDirectory()) throw new Error('Prewarm project path must be a directory: ' + dir)
  const selected = ids?.length ? ids : ['playwright', 'filesystem', 'sequential-thinking']
  // Validate all requests before starting any process or download.
  const plans = [...new Set(selected)].map((id) => {
    const capability = getCapability(id)
    if (!capability.install) throw new Error('Prewarm requires a stdio MCP capability: ' + id)
    const keys = [...(capability.inputs ?? []), ...(capability.secrets ?? [])].map((field) => field.key)
    const missing = keys.filter((key) => !process.env[key]?.trim())
    if (missing.length) throw new Error(`${id} requires real environment values for: ${missing.join(', ')}`)
    const env = Object.fromEntries((capability.secrets ?? []).map(({ key }) => [key, process.env[key]!]))
    const values = Object.fromEntries((capability.inputs ?? []).map(({ key }) => [key, process.env[key]!]))
    const args = resolveArgs(capability, { projectDir: dir, values })
    if (args.some((arg) => /\$\{\w+\}/.test(arg))) throw new Error('Unresolved prewarm inputs for ' + id)
    return { capability, args, env }
  })
  const out: PrewarmResult[] = []
  for (const { capability, args, env } of plans) {
    const r = await probe({ command: capability.install!.command, args, env, secretValues: Object.values(env), timeoutMs: 300_000 })
    const result: PrewarmResult = { capability, ok: r.reachable, tools: r.tools.length, durationMs: r.durationMs, error: r.error }
    out.push(result)
    onEach?.(result)
  }
  return out
}
