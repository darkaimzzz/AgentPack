// Mirrors electron/core/types.ts across the IPC boundary.
export type AgentKey = 'claude' | 'codex' | 'opencode'

export type DetectedAgent = {
  key: AgentKey
  name: string
  detected: boolean
  configPath: string
  note?: string
}

export type Capability = {
  id: string
  name: string
  type: 'mcp' | 'plugin'
  description: string
  source: string
  install?: { command: string; args: string[] }
  requires?: { binaries?: string[]; note?: string }
  plugin?: { marketplace: string; repo: string; name: string }
  secrets?: Array<{ key: string; label: string; help?: string }>
  inputs?: Array<{ key: string; label: string; help?: string }>
  supportedAgents: AgentKey[]
}

export type Pack = { id: string; name: string; description: string; capabilities: string[] }

export type Signal = { id: string; label: string; evidence: string }
export type ProjectScan = { dir: string; signals: Signal[]; isProject: boolean }
export type Recommendation = { capability: Capability; reason: string; matched: Signal[] }

export type Analysis = {
  scan: ProjectScan
  recommendations: Recommendation[]
  extras: Capability[]
}

export type InstallResult = {
  agent: AgentKey
  status: 'installed' | 'already-present' | 'conflict' | 'unsupported' | 'failed'
  configPath: string
  backupPath: string | null
  error?: string
}

export type HealthResult = {
  status: 'verified' | 'configured' | 'failed'
  method: 'tools-list' | 'config-only'
  configured: boolean
  reachable: boolean
  tools: string[]
  server?: { name?: string; version?: string }
  durationMs: number
  error?: string
}

export type CapabilityReport = {
  capability: Capability
  results: InstallResult[]
  health: HealthResult
}

export type InstallReport = { id: string; capabilities: CapabilityReport[]; ledgerId: string }

export type ProgressEvent =
  | { kind: 'stage'; stage: string; detail?: string }
  | { kind: 'log'; stream: 'stdout' | 'stderr'; line: string }
  | { kind: 'agent'; agent: AgentKey; status: InstallResult['status']; detail?: string }

export type CapabilityRuntimeState = 'active' | 'dormant' | 'unknown'

export type CapabilityContextCost = {
  toolCount: number
  serializedChars: number
  estimatedTokens: number
  measuredAt: string
  source: 'measured' | 'unavailable'
  note?: string
}

export type CapabilityProfile = {
  id: string
  name: string
  description?: string
  activeCapabilityIds: string[]
}

export type ClmRow = {
  capability: Capability
  agents: Array<{ agent: AgentKey; agentName: string; state: CapabilityRuntimeState }>
  cost: CapabilityContextCost | null
  anyActive: boolean
  anyDormant: boolean
  manageable: boolean
}

export type ClmView = {
  rows: ClmRow[]
  summary: {
    installedCount: number
    activeCount: number
    activeTools: number
    allTools: number
    activeTokens: number
    allTokens: number
    unmeasurable: number
  }
  currentProfileId: string | null
  reconciled: number
}

export type RuntimeMutationResult = {
  success: boolean
  capabilityId: string
  agent: AgentKey
  from: CapabilityRuntimeState
  to: CapabilityRuntimeState
  changedFiles: string[]
  backupPath?: string
  noop?: boolean
  error?: string
}

export type ProfileResult = {
  profile: CapabilityProfile
  results: RuntimeMutationResult[]
  status: 'ok' | 'partial' | 'failed'
}

export type AgentPackApi = {
  clmView(): Promise<ClmView>
  clmProfiles(): Promise<CapabilityProfile[]>
  clmApplyProfile(profileId: string): Promise<ProfileResult>
  clmMeasure(projectDir?: string): Promise<number>
  clmSetState(req: { capabilityId: string; agent: AgentKey; state: 'active' | 'dormant' }): Promise<RuntimeMutationResult>
  clmLog(): Promise<unknown[]>
  detectAgents(): Promise<DetectedAgent[]>
  listRegistry(): Promise<{ capabilities: Capability[]; packs: Pack[] }>
  analyze(dir: string): Promise<Analysis>
  pickDirectory(): Promise<string | null>
  install(req: {
    capabilityIds: string[]
    agents: AgentKey[]
    projectDir: string
    secrets?: Record<string, string>
    inputs?: Record<string, string>
  }): Promise<InstallReport>
  rollback(ledgerId?: string): Promise<{ restored: string[]; entryId: string } | null>
  reveal(path: string): Promise<void>
  onProgress(cb: (e: ProgressEvent) => void): () => void
}

declare global {
  interface Window {
    agentpack: AgentPackApi
  }
}
