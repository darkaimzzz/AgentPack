// One Capability -> three native config formats.
// This file is the product thesis: the same three facts (command, args, env)
// encoded three incompatible ways.
import { existsSync, readFileSync, writeFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

// AGENTPACK_HOME redirects every config path into a sandbox, so the spike can be
// exercised against copies instead of the live agent configs.
const home = process.env.AGENTPACK_HOME || homedir()
export const BACKUP_ROOT = join(home, '.agentpack', 'backups')

/** @typedef {{id:string, command:string, args:string[], env:Record<string,string>}} Capability */

const readJson = (p) => {
  const raw = readFileSync(p, 'utf8')
  try {
    return JSON.parse(raw)
  } catch (e) {
    // Naive comment-stripping corrupts URLs ("https://..."), so we refuse rather
    // than silently mangle the user's config.
    // ponytail: JSON-only; swap in jsonc-parser if a real .jsonc with comments shows up.
    throw new Error(`${p} is not plain JSON (comments?): ${e.message}`)
  }
}

const writeJson = (p, obj) => {
  mkdirSync(dirname(p), { recursive: true })
  writeFileSync(p, JSON.stringify(obj, null, 2) + '\n')
}

export const adapters = {
  // --- Claude Code: JSON, mcpServers, command + args[] + env{} ---------------
  claude: {
    name: 'Claude Code',
    configPath: join(home, '.claude.json'),
    detect() {
      return existsSync(this.configPath) || existsSync(join(home, '.claude'))
    },
    has(cap) {
      if (!existsSync(this.configPath)) return false
      return Boolean(readJson(this.configPath).mcpServers?.[cap.id])
    },
    install(cap) {
      const cfg = existsSync(this.configPath) ? readJson(this.configPath) : {}
      cfg.mcpServers ??= {}
      cfg.mcpServers[cap.id] = {
        type: 'stdio',
        command: cap.command,
        args: cap.args,
        ...(Object.keys(cap.env).length ? { env: cap.env } : {}),
      }
      writeJson(this.configPath, cfg)
    },
  },

  // --- Codex: TOML, [mcp_servers.x], env as a nested subtable ---------------
  codex: {
    name: 'Codex',
    configPath: join(home, '.codex', 'config.toml'),
    detect() {
      return existsSync(join(home, '.codex'))
    },
    has(cap) {
      if (!existsSync(this.configPath)) return false
      // Read-only regex check. Reading with a real parser is fine, but we never
      // re-stringify: that would reformat the user's literal-quoted Windows paths.
      return new RegExp(`^\\s*\\[mcp_servers\\.${cap.id}\\]`, 'm').test(readFileSync(this.configPath, 'utf8'))
    },
    install(cap) {
      const t = (s) => `'${s}'` // TOML literal string: no escaping, safe for C:\paths
      const lines = [
        '',
        `[mcp_servers.${cap.id}]`,
        `command = ${t(cap.command)}`,
        `args = [${cap.args.map(t).join(', ')}]`,
      ]
      if (Object.keys(cap.env).length) {
        lines.push('', `[mcp_servers.${cap.id}.env]`)
        for (const [k, v] of Object.entries(cap.env)) lines.push(`${k} = ${t(v)}`)
      }
      mkdirSync(dirname(this.configPath), { recursive: true })
      const prev = existsSync(this.configPath) ? readFileSync(this.configPath, 'utf8') : ''
      // Append, never rewrite. Rollback restores the whole file, so removal
      // never needs to be surgical.
      writeFileSync(this.configPath, prev.replace(/\s*$/, '\n') + lines.join('\n') + '\n')
    },
  },

  // --- OpenCode: JSON, mcp, command[] merges exe+args, env key is `environment` ---
  opencode: {
    name: 'OpenCode',
    configPath: join(home, '.config', 'opencode', 'opencode.jsonc'),
    detect() {
      return existsSync(dirname(this.configPath))
    },
    has(cap) {
      if (!existsSync(this.configPath)) return false
      return Boolean(readJson(this.configPath).mcp?.[cap.id])
    },
    install(cap) {
      const cfg = existsSync(this.configPath) ? readJson(this.configPath) : {}
      cfg.mcp ??= {}
      cfg.mcp[cap.id] = {
        type: 'local',
        command: [cap.command, ...cap.args], // note: single merged array
        enabled: true,
        ...(Object.keys(cap.env).length ? { environment: cap.env } : {}),
      }
      writeJson(this.configPath, cfg)
    },
  },
}

// --- backup / rollback -------------------------------------------------------

/** Copy a config aside. Returns a restore token, or null if there was no file. */
export function backup(key, stamp) {
  const { configPath } = adapters[key]
  if (!existsSync(configPath)) return { key, configPath, backupPath: null, existed: false }
  const backupPath = join(BACKUP_ROOT, stamp, key, configPath.split(/[\\/]/).pop())
  mkdirSync(dirname(backupPath), { recursive: true })
  copyFileSync(configPath, backupPath)
  return { key, configPath, backupPath, existed: true }
}

export function restore({ configPath, backupPath, existed }) {
  if (!existed) return // nothing to restore to; leaving the file is safer than deleting
  copyFileSync(backupPath, configPath)
}
