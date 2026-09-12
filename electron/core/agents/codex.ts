import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { home } from '../paths.ts'
import type { AgentAdapter, ConfigEntry } from './adapter.ts'
import type { Capability } from '../types.ts'

// Shape verified against a real ~/.codex/config.toml:
//   [mcp_servers.<id>]
//   command = '...'
//   args = [...]
//   [mcp_servers.<id>.env]
//   KEY = '...'

/**
 * Encode a TOML string.
 *
 * A literal string keeps Windows paths readable (no doubled backslashes), but
 * it has no escape mechanism at all — so an apostrophe, as in
 * `C:\Projects\O'Brien App`, would terminate it early and emit invalid TOML.
 * Fall back to a basic string in that case.
 */
export const tomlString = (s: string): string => {
  if (!/['\n\r]/.test(s)) return `'${s}'`
  const escaped = s
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)
  return `"${escaped}"`
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** Bare keys are unquoted; anything else needs quoting in a table header. */
const tableKey = (id: string) => (/^[A-Za-z0-9_-]+$/.test(id) ? id : tomlString(id))

const read = (p: string) => (existsSync(p) ? readFileSync(p, 'utf8') : '')

type Servers = Record<string, { command?: string; args?: string[]; env?: Record<string, string> }>

const servers = (p: string): Servers => {
  const raw = read(p)
  if (!raw) return {}
  try {
    return ((parseToml(raw) as { mcp_servers?: Servers }).mcp_servers ?? {}) as Servers
  } catch {
    return {} // a config we cannot parse is treated as having no entries
  }
}

/**
 * Find the line range of a `[mcp_servers.<id>]` table and its sub-tables,
 * so removal touches nothing else in the file.
 */
function tableRange(text: string, id: string): [number, number] | null {
  const lines = text.split('\n')
  const head = new RegExp(`^\\s*\\[mcp_servers\\.(${escapeRe(id)}|${escapeRe(tomlString(id))})\\]`)
  const sub = new RegExp(`^\\s*\\[mcp_servers\\.(${escapeRe(id)}|${escapeRe(tomlString(id))})\\.`)
  const start = lines.findIndex((l) => head.test(l))
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length) {
    const l = lines[end]
    if (/^\s*\[/.test(l) && !sub.test(l)) break
    end++
  }
  // Absorb one leading blank line so removal does not leave a gap behind.
  const from = start > 0 && lines[start - 1].trim() === '' ? start - 1 : start
  return [from, end]
}

export const codex: AgentAdapter = {
  key: 'codex',
  name: 'Codex',

  configPath: () => join(home(), '.codex', 'config.toml'),

  detect() {
    const configPath = this.configPath()
    const dir = join(home(), '.codex')
    const hasDir = existsSync(dir)
    return {
      key: 'codex',
      name: this.name,
      detected: hasDir,
      configPath,
      note: hasDir && !existsSync(configPath) ? 'config.toml not created yet; it will be created on install' : undefined,
    }
  },

  read(cap: Capability): ConfigEntry | null {
    const e = servers(this.configPath())[cap.id]
    if (!e) return null
    return { command: e.command ?? '', args: e.args ?? [], env: e.env ?? {} }
  },

  write(cap: Capability, env: Record<string, string>) {
    const p = this.configPath()
    const key = tableKey(cap.id)
    const lines = [
      '',
      `[mcp_servers.${key}]`,
      `command = ${tomlString(cap.install.command)}`,
      `args = [${cap.install.args.map(tomlString).join(', ')}]`,
    ]
    if (Object.keys(env).length) {
      lines.push('', `[mcp_servers.${key}.env]`)
      for (const [k, v] of Object.entries(env)) lines.push(`${tableKey(k)} = ${tomlString(v)}`)
    }
    mkdirSync(dirname(p), { recursive: true })
    const prev = read(p)
    // Append, never rewrite: the real config stores Windows paths as literal
    // strings that re-serialising would re-escape across sections we were
    // never asked to touch.
    const next = prev.replace(/\s*$/, prev ? '\n' : '') + lines.join('\n') + '\n'
    // Refuse to commit a document we just broke.
    try {
      parseToml(next)
    } catch (e) {
      throw new Error(`refusing to write invalid TOML for ${cap.id}: ${(e as Error).message}`)
    }
    writeFileSync(p, next)
  },

  remove(cap: Capability) {
    const p = this.configPath()
    const text = read(p)
    if (!text) return
    const range = tableRange(text, cap.id)
    if (!range) return
    const lines = text.split('\n')
    lines.splice(range[0], range[1] - range[0])
    writeFileSync(p, lines.join('\n'))
  },

  isEmpty() {
    return Object.keys(servers(this.configPath())).length === 0
  },
}
