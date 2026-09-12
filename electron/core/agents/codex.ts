import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { parse as parseToml } from 'smol-toml'
import { home } from '../paths.ts'
import { atomicWrite } from '../files.ts'
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
  if (!/['\x00-\x1f\x7f]/.test(s)) return `'${s}'`
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

/**
 * A TOML parse error, with the source context stripped.
 *
 * smol-toml appends the offending lines to its message to help a human locate
 * the problem. Those lines can be anything already in the user's config —
 * including credentials from entries we did not write and therefore cannot
 * redact, since redaction only knows the secrets supplied for the current run.
 * Keep the diagnostic, drop the excerpt.
 */
const parseDiagnostic = (e: unknown): string => {
  const first = String((e as Error)?.message ?? e).split('\n')[0].trim()
  return first || 'could not be parsed as TOML'
}

/**
 * Write back a line-edited document, keeping the file's trailing-newline
 * convention. Splicing out a table at the END of the file otherwise swallows
 * the final newline, which is enough on its own to stop a rollback being
 * byte-identical.
 */
const writeLines = (p: string, lines: string[], original: string) => {
  const out = lines.join('\n')
  const endedWithNewline = original.endsWith('\n')
  atomicWrite(p, endedWithNewline && !out.endsWith('\n') ? `${out}\n` : out)
}

type Servers = Record<string, { command?: string; args?: string[]; env?: Record<string, string>; enabled?: boolean }>

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
function tableRange(text: string, id: string, section = 'mcp_servers'): [number, number] | null {
  const lines = text.split('\n')
  const key = `(${escapeRe(id)}|${escapeRe(tomlString(id))}|${escapeRe(`"${id}"`)})`
  const head = new RegExp(`^\\s*\\[${escapeRe(section)}\\.${key}\\]`)
  const sub = new RegExp(`^\\s*\\[${escapeRe(section)}\\.${key}\\.`)
  const start = lines.findIndex((l) => head.test(l))
  if (start === -1) return null
  let end = start + 1
  while (end < lines.length) {
    const l = lines[end]
    if (/^\s*\[/.test(l) && !sub.test(l)) break
    end++
  }
  // Give back trailing blank lines and comments. They sit between this table
  // and whatever follows, so they are as likely to be the user's as ours, and
  // removing a table must never remove text that merely comes after it.
  while (end > start + 1 && /^\s*(#|$)/.test(lines[end - 1])) end--
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
    if (typeof e !== 'object' || Array.isArray(e) || (e.command !== undefined && typeof e.command !== 'string') ||
      (e.args !== undefined && (!Array.isArray(e.args) || e.args.some((v) => typeof v !== 'string'))) ||
      (e.enabled !== undefined && typeof e.enabled !== 'boolean')) throw new Error('Invalid MCP entry: ' + cap.id)
    return { command: e.command ?? '', args: e.args ?? [], env: e.env ?? {}, enabled: e.enabled }
  },

  setEnabled(cap, enabled) {
    const p = this.configPath()
    const text = read(p)
    const range = tableRange(text, cap.id)
    if (!range) throw new Error('Cannot safely edit nonstandard TOML table for ' + cap.id)
    const lines = text.split('\n')
    const start = range[0] + (lines[range[0]].trim() === '' ? 1 : 0)
    let end = start + 1
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++
    const index = lines.findIndex((line, i) => i > start && i < end && /^\s*enabled\s*=/.test(line))
    if (index >= 0) lines[index] = lines[index].replace(/^(\s*enabled\s*=\s*)(true|false)/, '$1' + enabled)
    else lines.splice(start + 1, 0, 'enabled = ' + enabled)
    const next = lines.join('\n')
    try {
      parseToml(next)
    } catch (e) {
      throw new Error(`refusing to write invalid TOML for ${cap.id}: ${parseDiagnostic(e)}`)
    }
    atomicWrite(p, next)
  },

  // Plugins, verified against a real ~/.codex/config.toml:
  //   [marketplaces.<market>]  source_type = "git"  source = "https://github.com/o/r.git"
  //   [plugins."<plugin>@<market>"]  enabled = true
  readPlugin(cap: Capability) {
    const raw = read(this.configPath())
    if (!raw) return null
    let doc: { plugins?: Record<string, { enabled?: boolean }> }
    try {
      doc = parseToml(raw) as typeof doc
    } catch {
      return null
    }
    const id = `${cap.plugin!.name}@${cap.plugin!.marketplace}`
    const e = doc.plugins?.[id]
    if (!e) return null
    return { enabled: e.enabled === true }
  },

  writePlugin(cap: Capability) {
    const p = this.configPath()
    const prev = read(p)
    const { marketplace, repo, name } = cap.plugin!
    const lines: string[] = []
    // Register the marketplace only if it is not already known — re-declaring
    // an existing TOML table is a parse error. Ask the parser rather than
    // matching a bare header: [marketplaces."x"] and [marketplaces.'x'] are
    // equally legal, and a header regex silently misses both, producing a
    // duplicate table that the write then has to refuse.
    let known = false
    try {
      const doc = parseToml(prev || '') as { marketplaces?: Record<string, unknown> }
      known = Boolean(doc.marketplaces && Object.hasOwn(doc.marketplaces, marketplace))
    } catch {
      // Unparseable already; the validity check below refuses the write anyway.
    }
    if (!known) {
      lines.push(
        '',
        `[marketplaces.${tableKey(marketplace)}]`,
        'source_type = "git"',
        `source = ${tomlString(`https://github.com/${repo}.git`)}`,
      )
    }
    lines.push('', `[plugins.${tomlString(`${name}@${marketplace}`)}]`, 'enabled = true')
    mkdirSync(dirname(p), { recursive: true })
    const next = prev.replace(/\s*$/, prev ? '\n' : '') + lines.join('\n') + '\n'
    try {
      parseToml(next)
    } catch (e) {
      throw new Error(`refusing to write invalid TOML for plugin ${cap.id}: ${parseDiagnostic(e)}`)
    }
    atomicWrite(p, next)
  },

  removePlugin(cap: Capability) {
    const p = this.configPath()
    const text = read(p)
    if (!text) return
    const id = `${cap.plugin!.name}@${cap.plugin!.marketplace}`
    const lines = text.split('\n')
    const head = new RegExp(`^\\s*\\[plugins\\.${escapeRe(tomlString(id))}\\]`)
    const start = lines.findIndex((l) => head.test(l))
    if (start === -1) return
    let end = start + 1
    while (end < lines.length && !/^\s*\[/.test(lines[end])) end++
    const from = start > 0 && lines[start - 1].trim() === '' ? start - 1 : start
    lines.splice(from, end - from)
    // Marketplace left registered on purpose: other plugins may depend on it.
    writeLines(p, lines, text)
  },

  write(cap: Capability, env: Record<string, string>) {
    const p = this.configPath()
    const key = tableKey(cap.id)
    const lines = [
      '',
      `[mcp_servers.${key}]`,
      'enabled = true',
      `command = ${tomlString(cap.install!.command)}`,
      `args = [${cap.install!.args.map(tomlString).join(', ')}]`,
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
      throw new Error(`refusing to write invalid TOML for ${cap.id}: ${parseDiagnostic(e)}`)
    }
    atomicWrite(p, next)
  },

  remove(cap: Capability) {
    const p = this.configPath()
    const text = read(p)
    if (!text) return
    const range = tableRange(text, cap.id)
    if (!range) return
    const lines = text.split('\n')
    lines.splice(range[0], range[1] - range[0])
    writeLines(p, lines, text)
  },

  isEmpty() {
    return Object.keys(servers(this.configPath())).length === 0
  },

  validate() {
    const raw = read(this.configPath())
    if (!raw) return { ok: true }
    try {
      parseToml(raw)
      return { ok: true }
    } catch (e) {
      return { ok: false, error: parseDiagnostic(e) }
    }
  },
}

/**
 * Remove `[section.key]` and its sub-tables from a TOML document by splicing
 * lines, leaving every other line — comments included — exactly as it was.
 *
 * Rollback uses this instead of re-serialising the parsed document: a
 * round-trip through the parser is correct about values and destructive about
 * everything else a person may have written in the file.
 *
 * Returns null when the table is not present.
 */
export function removeTomlTable(text: string, section: string, key: string): string | null {
  const range = tableRange(text, key, section)
  if (!range) return null
  const lines = text.split('\n')
  lines.splice(range[0], range[1] - range[0])
  const out = lines.join('\n')
  return text.endsWith('\n') && !out.endsWith('\n') ? `${out}\n` : out
}
