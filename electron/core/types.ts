// Shared vocabulary. Kept deliberately small — this grows only when a real
// caller needs a field.

export type AgentKey = 'claude' | 'codex' | 'opencode'

/** One entry from an MCP server's tools/list response. */
export type ToolDefinition = {
  name: string
  description?: string
  inputSchema?: unknown
  [key: string]: unknown
}

/** An automatic activation rule. */
export type CapabilityActivationTrigger = {
  type: 'file_glob' | 'branch_glob'
  pattern: string
}

/** Whether a capability is currently exposed to an agent (CLM). */
export type CapabilityRuntimeState = 'active' | 'dormant' | 'unknown'

/**
 * Estimated context cost. "Estimated" is load-bearing: this is serialized
 * schema size divided by four, not billed API tokens.
 */
export type CapabilityContextCost = {
  toolCount: number
  serializedChars: number
  estimatedTokens: number
  measuredAt: string
  /** measured = probed live; unavailable = nothing to measure (e.g. plugins). */
  source: 'measured' | 'unavailable'
  note?: string
}

/** Result of a CLM state change (PRD §4.9). */
export type RuntimeMutationResult = {
  success: boolean
  capabilityId: string
  agent: AgentKey
  from: CapabilityRuntimeState
  to: CapabilityRuntimeState
  changedFiles: string[]
  backupPath?: string
  /** True when the capability was already in the requested state. */
  noop?: boolean
  error?: string
}

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
  /**
   * External binaries this capability needs in order to actually work.
   * A plugin can install cleanly and still be useless without its CLI, so we
   * check up front rather than reporting a hollow success.
   */
  requires?: { binaries?: string[]; note?: string }
  /** Automatic activation rules (CLM, PRD §12). */
  triggers?: CapabilityActivationTrigger[]
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

/** A named set of capabilities that should be active (CLM, PRD §11). */
export type CapabilityProfile = {
  id: string
  name: string
  description?: string
  activeCapabilityIds: string[]
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
  status: 'installed' | 'already-present' | 'conflict' | 'unsupported' | 'failed'
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
  /** Config snapshot immediately after our last write; kept with the backups. */
  afterPath?: string
}

// --- project detection ------------------------------------------------------

/** One thing we found in a project, with the evidence that proves it. */
export type Signal = { id: string; label: string; evidence: string }

export type ProjectScan = {
  dir: string
  signals: Signal[]
  isProject: boolean
  /** Every package.json read, relative to the scanned directory. */
  manifests: string[]
}

export type Recommendation = { capability: Capability; reason: string; matched: Signal[] }

/** What the UI receives for one scanned folder. */
export type Analysis = {
  scan: ProjectScan
  recommendations: Recommendation[]
  extras: Capability[]
}

// --- install reports --------------------------------------------------------

export type CapabilityReport = {
  capability: Capability
  results: InstallResult[]
  health: HealthResult
}

export type PreflightResult = {
  ok: boolean
  binaries: Array<{ name: string; found: boolean; version?: string }>
  problems: string[]
}

export type InstallReport = {
  id: string
  capabilities: CapabilityReport[]
  /** Pass this to rollback() to undo the whole run. */
  ledgerId: string
  preflight?: PreflightResult
}

// --- capability load manager ------------------------------------------------

/** One row of the Capability Load Manager. */
export type ClmRow = {
  capability: Capability
  agents: Array<{ agent: AgentKey; agentName: string; state: CapabilityRuntimeState }>
  cost: CapabilityContextCost | null
  anyActive: boolean
  anyDormant: boolean
  /** False for plugins: CLM manages MCP servers only. */
  manageable: boolean
}

export type ClmSummary = {
  installedCount: number
  activeCount: number
  activeTools: number
  allTools: number
  activeTokens: number
  allTokens: number
  unmeasurable: number
}

export type ClmView = {
  rows: ClmRow[]
  summary: ClmSummary
  currentProfileId: string | null
  reconciled: number
}

export type TriggerDefinition = {
  capabilityId: string
  capabilityName: string
  triggers: CapabilityActivationTrigger[]
}

export type TriggerEvent = {
  capabilityId: string
  capabilityName: string
  agent: AgentKey
  pattern: string
  path: string
  result: RuntimeMutationResult
}

export type ProfileResult = {
  profile: CapabilityProfile
  results: RuntimeMutationResult[]
  /** ok = everything applied; partial = some failed; failed = nothing applied. */
  status: 'ok' | 'partial' | 'failed'
}

export type ProgressEvent =
  | { kind: 'stage'; stage: string; detail?: string }
  | { kind: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { kind: 'agent'; agent: AgentKey; status: InstallResult['status']; detail?: string }
