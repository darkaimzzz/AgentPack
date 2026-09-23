import { run } from './run.ts'
import type { Capability, PreflightResult } from '../types.ts'
export type { PreflightResult }

/**
 * Step 1 of the install sequence (CLAUDE.md §12): check what a capability needs
 * before touching anything. A missing runtime should be one clear sentence up
 * front, not a cryptic spawn failure three stages in.
 */

const versionCache = new Map<string, { found: boolean; version?: string }>()

async function checkBinary(name: string) {
  const cached = versionCache.get(name)
  if (cached) return cached
  const r = await run(name, ['--version'], { timeoutMs: 30_000 })
  const found = r.code === 0
  const result = { found, version: found ? r.stdout.trim().split('\n')[0] : undefined }
  versionCache.set(name, result)
  return result
}

export async function preflight(caps: Capability[]): Promise<PreflightResult> {
  // Launcher commands for MCP servers, plus any binary a capability declares.
  const needed = [...new Set([
    ...caps.filter((c) => c.install).map((c) => c.install!.command),
    ...caps.flatMap((c) => c.requires?.binaries ?? []),
  ])]
  const binaries = await Promise.all(
    needed.map(async (name) => ({ name, ...(await checkBinary(name)) })),
  )
  const problems = binaries
    .filter((b) => !b.found)
    .map((b) => {
      const needs = caps.filter(
        (c) => c.install?.command === b.name || c.requires?.binaries?.includes(b.name),
      )
      const note = needs.map((c) => c.requires?.note).find(Boolean)
      return `${b.name} is not available on PATH, required by ${needs.map((c) => c.name).join(', ')}${note ? `. ${note}` : ''}`
    })
  return { ok: problems.length === 0, binaries, problems }
}
