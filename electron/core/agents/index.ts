import { claude } from './claude.ts'
import { codex } from './codex.ts'
import { opencode } from './opencode.ts'
import type { AgentAdapter } from './adapter.ts'
import type { AgentKey } from '../types.ts'

export const adapters: Record<AgentKey, AgentAdapter> = { claude, codex, opencode }


/** CLAUDE.md §10 — detection is limited to supported clients, no guessing. */
export const detectAgents = () => Object.values(adapters).map((a) => a.detect())

export type { AgentAdapter }
