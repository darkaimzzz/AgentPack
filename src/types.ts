// The renderer shares the engine's vocabulary rather than mirroring it.
//
// These are type-only imports, erased at build time, so no engine code reaches
// the renderer bundle — but the shapes can no longer drift apart, which they
// had already begun to do (HealthResult had ten fields here and twenty there).
export type {
  AgentKey,
  Analysis,
  Capability,
  CapabilityActivationTrigger,
  CapabilityContextCost,
  CapabilityProfile,
  CapabilityReport,
  CapabilityRuntimeState,
  ClmRow,
  ClmSummary,
  ClmView,
  DetectedAgent,
  HealthResult,
  InstallReport,
  InstallResult,
  Pack,
  ProfileResult,
  ProgressEvent,
  ProjectScan,
  Recommendation,
  RuntimeMutationResult,
  Signal,
  TriggerDefinition,
  TriggerEvent,
} from '../electron/core/types.ts'

import type {
  AgentKey, Analysis, Capability, CapabilityProfile, ClmView, DetectedAgent,
  InstallReport, Pack, ProfileResult, ProgressEvent, RuntimeMutationResult,
  TriggerDefinition, TriggerEvent,
} from '../electron/core/types.ts'

/** Everything the preload exposes. The renderer can do nothing else. */
export type AgentPackApi = {
  info(): Promise<{ demo: boolean; projectDir: string | null }>
  // --- install flow ---
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

  // --- capability load manager ---
  clmView(): Promise<ClmView>
  clmProfiles(): Promise<CapabilityProfile[]>
  clmApplyProfile(profileId: string): Promise<ProfileResult>
  clmMeasure(projectDir?: string): Promise<number>
  clmSetState(req: {
    capabilityId: string
    agent: AgentKey
    state: 'active' | 'dormant'
  }): Promise<RuntimeMutationResult>
  clmLog(): Promise<unknown[]>
  clmTriggers(): Promise<TriggerDefinition[]>
  clmStartWatch(projectDir: string): Promise<{ watching: string }>
  clmStopWatch(): Promise<null>
  clmWatchStatus(): Promise<{ watching: string; error?: string } | null>
  onWatchChanged(cb: (e: { watching: string; error?: string } | null) => void): () => void
  onTrigger(cb: (e: TriggerEvent) => void): () => void
}

declare global {
  interface Window {
    agentpack: AgentPackApi
  }
}
