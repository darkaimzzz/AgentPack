import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { home } from '../paths.ts'
import { readJsonc, editJsonc } from './json-config.ts'
import type { AgentAdapter, ConfigEntry } from './adapter.ts'
import type { Capability } from '../types.ts'

// Shape verified against the published schema at https://opencode.ai/config.json:
//   mcp.<id> = { type: "local", command: string[], environment: {}, enabled: bool }
//
// Note the two real differences from the others — `command` is a SINGLE array
// merging executable and args, and the env key is `environment`, not `env`.
// This is why the adapter layer is a translation and not a reformat.

type Entry = { type?: string; command?: string[]; environment?: Record<string, string>; enabled?: boolean }
type OpenCodeConfig = { mcp?: Record<string, Entry> } & Record<string, unknown>

const dir = () => join(home(), '.config', 'opencode')

/** Both filenames are valid; prefer whichever already exists. */
const FILENAMES = ['opencode.jsonc', 'opencode.json']

const load = (p: string): OpenCodeConfig => (existsSync(p) ? readJsonc<OpenCodeConfig>(p) : {})

export const opencode: AgentAdapter = {
  key: 'opencode',
  name: 'OpenCode',

  configPath() {
    const found = FILENAMES.map((f) => join(dir(), f)).find((p) => existsSync(p))
    return found ?? join(dir(), FILENAMES[0])
  },

  detect() {
    const configPath = this.configPath()
    return {
      key: 'opencode',
      name: this.name,
      detected: existsSync(dir()),
      configPath,
      note: existsSync(dir()) && !existsSync(configPath)
        ? 'config file not created yet; it will be created on install'
        : undefined,
    }
  },

  read(cap: Capability): ConfigEntry | null {
    const e = load(this.configPath()).mcp?.[cap.id]
    if (!e) return null
    const [command = '', ...args] = e.command ?? []
    return { command, args, env: e.environment ?? {}, enabled: e.enabled }
  },

  write(cap: Capability, env: Record<string, string>) {
    // Edit in place so comments and formatting elsewhere in the file survive.
    editJsonc(this.configPath(), ['mcp', cap.id], {
      type: 'local',
      command: [cap.install!.command, ...cap.install!.args], // single merged array
      enabled: true,
      ...(Object.keys(env).length ? { environment: env } : {}),
    })
  },

  remove(cap: Capability) {
    const p = this.configPath()
    if (!existsSync(p)) return
    if (!load(p).mcp?.[cap.id]) return
    editJsonc(p, ['mcp', cap.id], undefined)
  },

  isEmpty() {
    const p = this.configPath()
    if (!existsSync(p)) return true
    return Object.keys(load(p).mcp ?? {}).length === 0
  },

  validate() {
    const p = this.configPath()
    if (!existsSync(p)) return { ok: true }
    try {
      readJsonc(p)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: (e as Error).message }
    }
  },
}
