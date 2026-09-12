import type { AgentKey, Capability, DetectedAgent } from '../types.ts'

/**
 * The contract each supported agent implements.
 *
 * Deliberately smaller than CLAUDE.md §9 sketches: backup/rollback are shared
 * file operations, not per-agent behaviour, and validation is agent-independent
 * (we start the server ourselves). Adding an agent is ~50 lines of this.
 */
export type AgentAdapter = {
  key: AgentKey
  name: string
  /** Where this agent stores MCP configuration. */
  configPath(): string
  detect(): DetectedAgent
  /** Is this capability already configured? Gates writes — installs must be idempotent. */
  has(cap: Capability): boolean
  /** Write the capability in this agent's native format. Callers must check has() first. */
  write(cap: Capability, env: Record<string, string>): void
}
