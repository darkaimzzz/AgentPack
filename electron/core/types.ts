// Shared vocabulary. Kept deliberately small — this grows only when a real
// caller needs a field.

export type AgentKey = 'claude' | 'codex' | 'opencode'

export type Capability = {
  id: string
  name: string
  type: 'mcp' | 'plugin'
  description: string
  /** Publisher shown before install (CLAUDE.md §21 trust info). */
  source: string
  /** MCP servers only: how to launch the server. */
  install?: { command: string; args: string[] }
  /**
   * Plugins only: which marketplace to register and which plugin to enable.
   * Claude Code and Codex share this model — and even the "plugin@marketplace"
   * id syntax. OpenCode's `plugin` array is a different, npm-based concept and
   * is deliberately not treated as equivalent.
   */
  plugin?: { marketplace: string; repo: string; name: string }
  /** Env vars the user must supply. Values never live in the registry, or the ledger. */
  secrets?: Array<{ key: string; label: string; help?: string }>
  /**
   * Non-secret values the user supplies, substituted into args as ${KEY}.
   * Separate from secrets on purpose: these are safe to record and to export
   * in a shareable pack manifest, secrets are not.
   */
  inputs?: Array<{ key: string; label: string; help?: string }>
  supportedAgents: AgentKey[]
}

export type Pack = {
  id: string
  name: string
  description: string
  capabilities: string[]
}

export type DetectedAgent = {
  key: AgentKey
  name: string
  detected: boolean
  configPath: string
  /** Set when the agent is found somewhere we did not expect (CLAUDE.md §10). */
  note?: string
}

/** Result of writing one capability into one agent. */
export type InstallResult = {
  agent: AgentKey
  status: 'installed' | 'already-present' | 'conflict' | 'failed'
  configPath: string
  backupPath: string | null
  error?: string
}

export type HealthResult = {
  /**
   * How far validation actually got. Never call something "verified" that we
   * only wrote to a file (CLAUDE.md §16).
   *   verified   - the server started and listed its tools
   *   configured - written correctly, but this type cannot be probed from here
   *   failed     - could not be validated
   */
  status: 'verified' | 'configured' | 'failed'
  /** How the check was performed, for display. */
  method: 'tools-list' | 'config-only'
  /** Weak signal: the config entry exists and parses. */
  configured: boolean
  /** Strong signal: the server started and answered tools/list. */
  reachable: boolean
  tools: string[]
  server?: { name?: string; version?: string }
  durationMs: number
  error?: string
}

export type BackupToken = {
  agent: AgentKey
  configPath: string
  backupPath: string | null
  /** False when AgentPack created this file, so rollback may remove it. */
  existed: boolean
  /** Hash of the file immediately after install, to detect later edits. */
  postHash?: string | null
}

export type ProgressEvent =
  | { kind: 'stage'; stage: string; detail?: string }
  | { kind: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { kind: 'agent'; agent: AgentKey; status: InstallResult['status']; detail?: string }
