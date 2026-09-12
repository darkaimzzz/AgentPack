import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { home } from '../paths.ts'
import { readJson, writeJson } from './json-config.ts'
import type { AgentAdapter } from './adapter.ts'
import type { Capability } from '../types.ts'

// Shape verified against the published schema at https://opencode.ai/config.json:
//   mcp.<id> = { type: "local", command: string[], environment: {}, enabled: bool }
//
// Note the two real differences from the others — `command` is a SINGLE array
// merging executable and args, and the env key is `environment`, not `env`.
// This is why the adapter layer is a translation and not a reformat.

type OpenCodeConfig = { mcp?: Record<string, unknown> } & Record<string, unknown>

export const opencode: AgentAdapter = {
  key: 'opencode',
  name: 'OpenCode',

  configPath: () => join(home(), '.config', 'opencode', 'opencode.jsonc'),

  detect() {
    const configPath = this.configPath()
    return {
      key: 'opencode',
      name: this.name,
      detected: existsSync(dirname(configPath)),
      configPath,
      note: existsSync(dirname(configPath)) && !existsSync(configPath)
        ? 'opencode.jsonc not created yet; it will be created on install'
        : undefined,
    }
  },

  has(cap: Capability) {
    const p = this.configPath()
    if (!existsSync(p)) return false
    return Boolean(readJson<OpenCodeConfig>(p).mcp?.[cap.id])
  },

  write(cap: Capability, env: Record<string, string>) {
    const p = this.configPath()
    const cfg: OpenCodeConfig = existsSync(p) ? readJson<OpenCodeConfig>(p) : {}
    cfg.mcp ??= {}
    cfg.mcp[cap.id] = {
      type: 'local',
      command: [cap.install.command, ...cap.install.args],
      enabled: true,
      ...(Object.keys(env).length ? { environment: env } : {}),
    }
    writeJson(p, cfg)
  },
}
