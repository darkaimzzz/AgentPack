import type { AgentKey, Capability, DetectedAgent } from '../types.ts'

/** A capability entry as it exists in an agent's config, normalised across formats. */
export type ConfigEntry = {
  command: string
  args: string[]
  env: Record<string, string>
  enabled?: boolean
  /** Full native entry for lossless dormancy restoration. Never sent to renderer. */
  native?: Record<string, unknown>
}

/**
 * How an existing config entry relates to the one we intend to write.
 * `different` must never be reported as installed, a stale command or scope
 * that no longer works would otherwise pass as healthy.
 */
export type MatchState = 'absent' | 'same' | 'different'

/**
 * The contract each supported agent implements.
 *
 * Deliberately smaller than CLAUDE.md §9 sketches: backup/rollback are shared
 * file operations, not per-agent behaviour. Adding an agent is ~60 lines.
 */
export type AgentAdapter = {
  key: AgentKey
  name: string
  /** Where this agent stores MCP configuration. */
  configPath(): string
  detect(): DetectedAgent
  /** Read back what is actually configured, normalised. Null when absent. */
  read(cap: Capability): ConfigEntry | null
  /** Write the capability in this agent's native format. */
  write(cap: Capability, env: Record<string, string>): void
  restoreEntry?(cap: Capability, entry: ConfigEntry): void
  /** Remove the capability's entry, leaving everything else untouched. */
  remove(cap: Capability): void
  /** True when the config holds no capability entries at all. */
  isEmpty(): boolean
  /**
   * Does the config file parse?
   *
   * Separate from isEmpty() on purpose: the readers deliberately swallow parse
   * errors so a corrupt file cannot crash a listing, which means "no entries"
   * and "unreadable" look identical to everything else. This one does not
   * swallow, so callers can tell a broken config from an empty one.
   */
  validate(): { ok: boolean; error?: string }
  /**
   * Disable a capability in place, keeping its entry and credentials.
   *
   * Only for formats with a native flag, OpenCode's `enabled`. Where this
   * exists, dormancy never removes anything and never needs the credential
   * stash, which is strictly safer. Agents without it fall back to
   * remove-and-stash.
   */
  setEnabled?(cap: Capability, enabled: boolean): void

  /**
   * Plugin support. Only agents with a git-marketplace model implement these,
   * Claude Code and Codex. OpenCode's `plugin` array is npm-based and is NOT
   * an equivalent, so it deliberately leaves these undefined.
   */
  /** Extra file a plugin install writes, if different from configPath(). */
  pluginConfigPath?(): string
  readPlugin?(cap: Capability): { enabled: boolean } | null
  writePlugin?(cap: Capability): void
  removePlugin?(cap: Capability): void
}

/** Does this adapter support the capability's type at all? */
export function supportsType(adapter: AgentAdapter, cap: Capability): boolean {
  return cap.type === 'plugin' ? typeof adapter.writePlugin === 'function' : true
}

const sameArgs = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i])

const sameEnv = (a: Record<string, string>, b: Record<string, string>) => {
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
}

/**
 * Compare what is on disk against what we intend to install.
 * Shared by every adapter so the comparison rules cannot drift apart.
 */
export function matchEntry(
  adapter: AgentAdapter,
  cap: Capability,
  env: Record<string, string>,
): MatchState {
  if (cap.type === 'plugin') {
    const p = adapter.readPlugin?.(cap)
    if (!p) return 'absent'
    return p.enabled ? 'same' : 'different'
  }
  const existing = adapter.read(cap)
  if (!existing) return 'absent'
  if (existing.enabled === false) return 'different'
  if (!cap.install) return 'different'
  return existing.command === cap.install.command &&
    sameArgs(existing.args, cap.install.args) &&
    sameEnv(existing.env, env)
    ? 'same'
    : 'different'
}
