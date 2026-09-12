import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { home } from '../paths.ts'
import { readJson, writeJson } from './json-config.ts'
import type { AgentAdapter } from './adapter.ts'
import type { Capability } from '../types.ts'

// Shape verified empirically against `claude mcp add` output:
//   mcpServers.<id> = { type: "stdio", command, args[], env{} }

type ClaudeConfig = { mcpServers?: Record<string, unknown> } & Record<string, unknown>

export const claude: AgentAdapter = {
  key: 'claude',
  name: 'Claude Code',

  configPath: () => join(home(), '.claude.json'),

  detect() {
    const configPath = this.configPath()
    const dir = join(home(), '.claude')
    const hasDir = existsSync(dir)
    const hasFile = existsSync(configPath)
    return {
      key: 'claude',
      name: this.name,
      detected: hasFile || hasDir,
      configPath,
      note: hasDir && !hasFile ? 'config directory found but ~/.claude.json is missing' : undefined,
    }
  },

  has(cap: Capability) {
    const p = this.configPath()
    if (!existsSync(p)) return false
    return Boolean(readJson<ClaudeConfig>(p).mcpServers?.[cap.id])
  },

  write(cap: Capability, env: Record<string, string>) {
    const p = this.configPath()
    const cfg: ClaudeConfig = existsSync(p) ? readJson<ClaudeConfig>(p) : {}
    cfg.mcpServers ??= {}
    cfg.mcpServers[cap.id] = {
      type: 'stdio',
      command: cap.install.command,
      args: cap.install.args,
      ...(Object.keys(env).length ? { env } : {}),
    }
    writeJson(p, cfg)
  },
}
