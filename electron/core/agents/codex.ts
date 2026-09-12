import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { home } from '../paths.ts'
import type { AgentAdapter } from './adapter.ts'
import type { Capability } from '../types.ts'

// Shape verified against a real ~/.codex/config.toml:
//   [mcp_servers.<id>]
//   command = '...'
//   args = [...]
//   [mcp_servers.<id>.env]
//   KEY = '...'

/** TOML literal string: no escape processing, so Windows paths stay readable. */
const lit = (s: string) => `'${s}'`

const tableRe = (id: string) => new RegExp(`^\\s*\\[mcp_servers\\.${escapeRe(id)}\\]`, 'm')
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

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

  has(cap: Capability) {
    const p = this.configPath()
    if (!existsSync(p)) return false
    // Read with a regex, never a parse-and-re-stringify round trip: the real
    // config stores Windows paths as TOML literal strings that re-serialising
    // would re-escape across sections we were never asked to touch.
    return tableRe(cap.id).test(readFileSync(p, 'utf8'))
  },

  write(cap: Capability, env: Record<string, string>) {
    const p = this.configPath()
    const lines = [
      '',
      `[mcp_servers.${cap.id}]`,
      `command = ${lit(cap.install.command)}`,
      `args = [${cap.install.args.map(lit).join(', ')}]`,
    ]
    if (Object.keys(env).length) {
      lines.push('', `[mcp_servers.${cap.id}.env]`)
      for (const [k, v] of Object.entries(env)) lines.push(`${k} = ${lit(v)}`)
    }
    mkdirSync(dirname(p), { recursive: true })
    const prev = existsSync(p) ? readFileSync(p, 'utf8') : ''
    // Append only. Rollback restores the whole file, so removal never needs to
    // be surgical and we never rewrite a byte the user wrote.
    writeFileSync(p, prev.replace(/\s*$/, prev ? '\n' : '') + lines.join('\n') + '\n')
  },
}
