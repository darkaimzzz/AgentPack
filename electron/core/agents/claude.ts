import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { home } from '../paths.ts'
import { readJson, writeJson } from './json-config.ts'
import type { AgentAdapter, ConfigEntry } from './adapter.ts'
import type { Capability } from '../types.ts'

// Shape verified empirically against `claude mcp add` output:
//   mcpServers.<id> = { type: "stdio", command, args[], env{} }

type Entry = { type?: string; command?: string; args?: string[]; env?: Record<string, string> }
type ClaudeConfig = { mcpServers?: Record<string, Entry> } & Record<string, unknown>

const load = (p: string): ClaudeConfig => (existsSync(p) ? readJson<ClaudeConfig>(p) : {})

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

  read(cap: Capability): ConfigEntry | null {
    const p = this.configPath()
    if (!existsSync(p)) return null
    const e = load(p).mcpServers?.[cap.id]
    if (!e) return null
    return { command: e.command ?? '', args: e.args ?? [], env: e.env ?? {} }
  },

  write(cap: Capability, env: Record<string, string>) {
    const p = this.configPath()
    const cfg = load(p)
    cfg.mcpServers ??= {}
    cfg.mcpServers[cap.id] = {
      type: 'stdio',
      command: cap.install.command,
      args: cap.install.args,
      ...(Object.keys(env).length ? { env } : {}),
    }
    writeJson(p, cfg)
  },

  remove(cap: Capability) {
    const p = this.configPath()
    if (!existsSync(p)) return
    const cfg = load(p)
    if (!cfg.mcpServers?.[cap.id]) return
    delete cfg.mcpServers[cap.id]
    writeJson(p, cfg)
  },

  isEmpty() {
    const p = this.configPath()
    if (!existsSync(p)) return true
    return Object.keys(load(p).mcpServers ?? {}).length === 0
  },
}
