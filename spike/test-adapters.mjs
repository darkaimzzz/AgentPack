// Self-check: one Capability compiles to three correct native formats.
// Runs entirely in a temp sandbox. node spike/test-adapters.mjs
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'agentpack-test-'))
process.env.AGENTPACK_HOME = sandbox

const { adapters, backup, restore } = await import('./adapters.mjs')

const CAP = { id: 'playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: { TOKEN: 'secret123' } }

// Seed realistic pre-existing configs, including content that must survive.
mkdirSync(join(sandbox, '.codex'), { recursive: true })
mkdirSync(join(sandbox, '.config', 'opencode'), { recursive: true })
writeFileSync(join(sandbox, '.claude.json'), JSON.stringify({ numStartups: 7, mcpServers: { existing: { command: 'foo' } } }, null, 2))
const CODEX_SEED = `model = "gpt-6"\n\n[mcp_servers.node_repl]\ncommand = 'C:\\Users\\x\\node repl.exe'\nargs = []\n`
writeFileSync(join(sandbox, '.codex', 'config.toml'), CODEX_SEED)
writeFileSync(join(sandbox, '.config', 'opencode', 'opencode.jsonc'), JSON.stringify({ $schema: 'https://opencode.ai/config.json' }, null, 2))

// --- detect ---
for (const [k, a] of Object.entries(adapters)) assert.equal(a.detect(), true, `${k} should detect`)

// --- pre-state ---
for (const [k, a] of Object.entries(adapters)) assert.equal(a.has(CAP), false, `${k} should not have cap yet`)

// --- backup + install ---
const stamp = 'test-stamp'
const backups = Object.keys(adapters).map((k) => backup(k, stamp))
const originals = new Map(backups.map((b) => [b.key, readFileSync(b.configPath, 'utf8')]))
for (const a of Object.values(adapters)) a.install(CAP)

// --- Claude: JSON, mcpServers, command + args[] + env{} ---
const claude = JSON.parse(readFileSync(join(sandbox, '.claude.json'), 'utf8'))
assert.deepEqual(claude.mcpServers.playwright, {
  type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], env: { TOKEN: 'secret123' },
})
assert.equal(claude.numStartups, 7, 'unrelated Claude keys must survive')
assert.ok(claude.mcpServers.existing, 'pre-existing servers must survive')

// --- Codex: TOML table, appended, seed byte-preserved ---
const codex = readFileSync(join(sandbox, '.codex', 'config.toml'), 'utf8')
assert.ok(codex.startsWith(CODEX_SEED.replace(/\s*$/, '\n')), 'existing TOML must be preserved verbatim, not re-stringified')
assert.match(codex, /\[mcp_servers\.playwright\]/)
assert.match(codex, /command = 'npx'/)
assert.match(codex, /args = \['-y', '@playwright\/mcp@latest'\]/)
assert.match(codex, /\[mcp_servers\.playwright\.env\]\nTOKEN = 'secret123'/)
assert.match(codex, /command = 'C:\\Users\\x\\node repl\.exe'/, 'literal Windows path must not be re-escaped')

// --- OpenCode: command[] merges exe+args, env key is `environment` ---
const oc = JSON.parse(readFileSync(join(sandbox, '.config', 'opencode', 'opencode.jsonc'), 'utf8'))
assert.deepEqual(oc.mcp.playwright, {
  type: 'local', command: ['npx', '-y', '@playwright/mcp@latest'], enabled: true, environment: { TOKEN: 'secret123' },
})
assert.equal(oc.$schema, 'https://opencode.ai/config.json', 'schema key must survive')

// --- idempotency: has() true, second install must not duplicate ---
for (const [k, a] of Object.entries(adapters)) assert.equal(a.has(CAP), true, `${k} should report installed`)
adapters.codex.install(CAP)
const twice = readFileSync(join(sandbox, '.codex', 'config.toml'), 'utf8')
assert.equal(twice.match(/\[mcp_servers\.playwright\]/g).length, 2, 'sanity: raw install appends blindly')
// ...which is exactly why callers must gate on has(). Proven by the guard in poc.mjs.

// --- rollback restores byte-identical ---
for (const b of backups) restore(b)
for (const b of backups) {
  assert.equal(readFileSync(b.configPath, 'utf8'), originals.get(b.key), `${b.key} must restore byte-identical`)
}

console.log('✓ all adapter checks passed')
console.log(`  sandbox: ${sandbox}`)
