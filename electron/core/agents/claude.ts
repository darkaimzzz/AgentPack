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

  // Plugins live in ~/.claude/settings.json, verified against a real install:
  //   extraKnownMarketplaces: { <market>: { source: { source: "github", repo } } }
  //   enabledPlugins:         { "<plugin>@<market>": true }
  settingsPath: () => join(home(), '.claude', 'settings.json'),
  pluginConfigPath: () => join(home(), '.claude', 'settings.json'),

  readPlugin(cap: Capability) {
    const p = (this as unknown as { settingsPath(): string }).settingsPath()
    if (!existsSync(p)) return null
    const s = readJson<{ enabledPlugins?: Record<string, boolean> }>(p)
    const id = `${cap.plugin!.name}@${cap.plugin!.marketplace}`
    if (!(id in (s.enabledPlugins ?? {}))) return null
    return { enabled: s.enabledPlugins![id] === true }
  },

  writePlugin(cap: Capability) {
    const p = (this as unknown as { settingsPath(): string }).settingsPath()
    const s = existsSync(p)
      ? readJson<Record<string, unknown>>(p)
      : ({} as Record<string, unknown>)
    const markets = (s.extraKnownMarketplaces ?? {}) as Record<string, unknown>
    markets[cap.plugin!.marketplace] ??= { source: { source: 'github', repo: cap.plugin!.repo } }
    s.extraKnownMarketplaces = markets
    const enabled = (s.enabledPlugins ?? {}) as Record<string, boolean>
    enabled[`${cap.plugin!.name}@${cap.plugin!.marketplace}`] = true
    s.enabledPlugins = enabled
    writeJson(p, s)
  },

  removePlugin(cap: Capability) {
    const p = (this as unknown as { settingsPath(): string }).settingsPath()
    if (!existsSync(p)) return
    const s = readJson<Record<string, unknown>>(p)
    const enabled = (s.enabledPlugins ?? {}) as Record<string, boolean>
    delete enabled[`${cap.plugin!.name}@${cap.plugin!.marketplace}`]
    s.enabledPlugins = enabled
    // The marketplace is left registered: other plugins may rely on it, and a
    // stale marketplace entry is harmless where a missing one breaks them.
    writeJson(p, s)
  },

  write(cap: Capability, env: Record<string, string>) {
    const p = this.configPath()
    const cfg = load(p)
    cfg.mcpServers ??= {}
    cfg.mcpServers[cap.id] = {
      type: 'stdio',
      command: cap.install!.command,
      args: cap.install!.args,
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
