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
  install: { command: string; args: string[] }
  /** Env vars the user must supply. Values never live in the registry. */
  secrets?: Array<{ key: string; label: string; help?: string }>
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
  status: 'installed' | 'already-present' | 'failed'
  configPath: string
  backupPath: string | null
  error?: string
}

export type HealthResult = {
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
  existed: boolean
}

export type ProgressEvent =
  | { kind: 'stage'; stage: string; detail?: string }
  | { kind: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { kind: 'agent'; agent: AgentKey; status: InstallResult['status']; detail?: string }
