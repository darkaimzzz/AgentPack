import { watch, type FSWatcher } from 'node:fs'
import { capabilities } from '../capabilities/registry.ts'
import { listRuntime, setState } from './state.ts'
import type { AgentKey, TriggerDefinition, TriggerEvent } from '../types.ts'

/**
 * One automatic activation mechanism (PRD §12): a file-pattern trigger.
 *
 * Watch the project directory; when a touched file matches a dormant
 * capability's glob, activate it. Deliberately the simplest REAL mechanism,
 * we do not pretend to know which file the editor has open, because AgentPack
 * has no editor integration.
 */

/** Directories never worth watching, noisy, and nothing here is source. */
const IGNORED = /(^|[\\/])(node_modules|\.git|dist|out|release|\.next|build|coverage|\.turbo)([\\/]|$)/

// Translate a glob to a RegExp.
//
//   **/*.spec.ts  →  a .spec.ts file at any depth, including the root
//   src/*.ts      →  one level under src only
//
// Order matters: a double star must be consumed before a single one, or the
// single-star rule eats half of it and the glob stops crossing directories.
// (Written as line comments on purpose: a glob containing */ would close a
// block comment early.)
export function globToRegExp(pattern: string): RegExp {
  const normalized = pattern.replace(/\\/g, '/')
  let re = ''
  for (let i = 0; i < normalized.length; i++) {
    const c = normalized[i]
    if (c === '*') {
      if (normalized[i + 1] === '*') {
        // `**/` matches zero or more directories, so `**/x` also matches `x`.
        if (normalized[i + 2] === '/') { re += '(?:.*/)?'; i += 2 } else { re += '.*'; i += 1 }
      } else {
        re += '[^/]*' // a single star never crosses a directory boundary
      }
    } else if (c === '?') re += '[^/]'
    else if ('\\^$.|+()[]{}'.includes(c)) re += `\\${c}`
    else re += c
  }
  return new RegExp(`^${re}$`, 'i') // case-insensitive: Windows paths are
}

/** Does this path match any of the patterns? Separators are normalised first. */
export function matchesAny(path: string, patterns: string[]): boolean {
  const p = path.replace(/\\/g, '/').replace(/^\.\//, '')
  return patterns.some((pattern) => globToRegExp(pattern).test(p))
}

/** Every capability that declares a trigger, whatever its current state. */
export function triggerDefinitions(): TriggerDefinition[] {
  return capabilities()
    .filter((c) => c.triggers?.length)
    .map((c) => ({ capabilityId: c.id, capabilityName: c.name, triggers: c.triggers! }))
}

export type WatchHandle = { stop: () => void; watching: string; readonly error?: string }

/**
 * Start watching a project directory.
 *
 * Returns a handle; call stop() to release the watcher. Only DORMANT
 * capabilities are activated, a trigger never deactivates anything, and never
 * touches one that is already active.
 */
export function startWatching(
  projectDir: string,
  onFire: (e: TriggerEvent) => void,
  opts: { agents?: AgentKey[]; debounceMs?: number; onError?: (error: string) => void } = {},
): WatchHandle {
  const defs = triggerDefinitions()
  const recent = new Map<string, number>()
  const debounceMs = opts.debounceMs ?? 400
  let watcher: FSWatcher | null = null
  let watchError: string | undefined

  const handle = (_event: string, filename: string | null) => {
    if (!filename) return
    const path = String(filename)
    if (IGNORED.test(path)) return

    for (const def of defs) {
      const patterns = def.triggers.filter((t) => t.type === 'file_glob').map((t) => t.pattern)
      if (!patterns.length || !matchesAny(path, patterns)) continue

      // Editors write a file several times per save; fire once per capability.
      const last = recent.get(def.capabilityId) ?? 0
      if (Date.now() - last < debounceMs) continue
      recent.set(def.capabilityId, Date.now())

      const dormantIn = listRuntime(opts.agents)
        .filter((r) => r.capability.id === def.capabilityId && r.state === 'dormant')
      for (const rec of dormantIn) {
        const result = setState(def.capabilityId, rec.agent, 'active', { source: 'trigger' })
        onFire({
          capabilityId: def.capabilityId,
          capabilityName: def.capabilityName,
          agent: rec.agent,
          pattern: patterns.find((p) => matchesAny(path, [p])) ?? patterns[0],
          path,
          result,
        })
      }
    }
  }

  try {
    watcher = watch(projectDir, { recursive: true }, (event, filename) => {
      try { handle(event, filename) } catch {
        // Close before reporting. A watcher that keeps firing after it has
        // told the caller it failed will go on mutating agent configs behind
        // a UI that says it stopped, and the caller may well have dropped
        // its handle in response to the error.
        watchError = 'Automatic activation failed. Check agent configuration and the dormant store.'
        watcher?.close()
        watcher = null
        opts.onError?.(watchError)
      }
    })
    watcher.on('error', () => {
      watchError = 'Folder watch stopped unexpectedly. Select the folder again to retry.'
      watcher?.close()
      watcher = null
      opts.onError?.(watchError)
    })
  } catch (e) {
    throw new Error(`could not watch ${projectDir}: ${(e as Error).message}`)
  }

  return {
    watching: projectDir,
    get error() { return watchError },
    stop: () => {
      watcher?.close()
      watcher = null
    },
  }
}
