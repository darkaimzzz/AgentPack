// Engine self-check. Runs entirely in a temp sandbox; touches no real config.
//   node electron/core/selfcheck.ts
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'agentpack-check-'))
process.env.AGENTPACK_HOME = sandbox

const { adapters } = await import('./agents/index.ts')
const { getCapability, resolveArgs, capabilities, packs } = await import('./capabilities/registry.ts')
const { install, rollback } = await import('./installer/install.ts')
const { redact, resolveCommand } = await import('./installer/run.ts')
const ledger = await import('./installer/ledger.ts')

const tests: Array<[string, () => void | Promise<void>]> = []
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn])

// --- registry ---------------------------------------------------------------

test('registry loads capabilities and packs', () => {
  assert.ok(capabilities().length >= 3)
  assert.ok(packs().length >= 1)
  for (const c of capabilities()) {
    assert.ok(c.id && c.name && c.install.command, `${c.id} malformed`)
    assert.ok(c.supportedAgents.length, `${c.id} lists no agents`)
  }
})

test('pack capability ids all resolve', () => {
  for (const p of packs()) for (const id of p.capabilities) getCapability(id)
})

test('${projectDir} is substituted in args', () => {
  const args = resolveArgs(getCapability('filesystem'), { projectDir: 'C:\\demo' })
  assert.ok(args.includes('C:\\demo'), 'projectDir placeholder not substituted')
  assert.ok(!args.some((a) => a.includes('${')), 'unsubstituted placeholder left behind')
})

// --- secret redaction -------------------------------------------------------

test('secrets are redacted from output', () => {
  const out = redact('token=ghp_supersecret123 in use', ['ghp_supersecret123'])
  assert.ok(!out.includes('ghp_supersecret123'), 'secret leaked')
  assert.match(out, /redacted/)
})

test('redaction ignores trivially short values', () => {
  // Redacting "a" would blank out half of every log line.
  assert.equal(redact('a path', ['a']), 'a path')
})

// --- windows command resolution --------------------------------------------

test('npx resolves to a shell invocation on Windows', () => {
  const r = resolveCommand('npx', ['-y', 'pkg with space'])
  if (process.platform === 'win32') {
    assert.equal(r.shell, true, 'must use shell for .cmd (CVE-2024-27980 / EINVAL)')
    assert.match(r.file, /^npx\.cmd /)
    assert.match(r.file, /"pkg with space"/, 'args with spaces must be quoted')
    assert.deepEqual(r.args, [], 'args array must be empty under shell (DEP0190)')
  } else {
    assert.equal(r.shell, false)
  }
})

test('non-shim commands are spawned directly', () => {
  const r = resolveCommand('node', ['x.js'])
  assert.equal(r.shell, false)
  assert.deepEqual(r.args, ['x.js'])
})

// --- adapter translation ----------------------------------------------------

const CAP = getCapability('playwright')
const SEED_TOML = `model = "gpt-6"\n\n[mcp_servers.node_repl]\ncommand = 'C:\\Users\\x\\node repl.exe'\nargs = []\n`

const seed = () => {
  mkdirSync(join(sandbox, '.codex'), { recursive: true })
  mkdirSync(join(sandbox, '.config', 'opencode'), { recursive: true })
  writeFileSync(join(sandbox, '.claude.json'), JSON.stringify({ numStartups: 7, mcpServers: { existing: { command: 'foo' } } }, null, 2))
  writeFileSync(join(sandbox, '.codex', 'config.toml'), SEED_TOML)
  writeFileSync(join(sandbox, '.config', 'opencode', 'opencode.jsonc'), JSON.stringify({ $schema: 'https://opencode.ai/config.json' }, null, 2))
}

test('all three agents detect from a seeded home', () => {
  seed()
  for (const a of Object.values(adapters)) assert.equal(a.detect().detected, true, `${a.key} not detected`)
})

test('one capability compiles to three native formats', () => {
  for (const a of Object.values(adapters)) {
    assert.equal(a.has(CAP), false, `${a.key} should not have it yet`)
    a.write(CAP, { TOKEN: 'secret123' })
  }

  const claude = JSON.parse(readFileSync(join(sandbox, '.claude.json'), 'utf8'))
  assert.deepEqual(claude.mcpServers.playwright, {
    type: 'stdio', command: 'npx', args: CAP.install.args, env: { TOKEN: 'secret123' },
  })
  assert.equal(claude.numStartups, 7, 'unrelated keys must survive')
  assert.ok(claude.mcpServers.existing, 'pre-existing servers must survive')

  const codex = readFileSync(join(sandbox, '.codex', 'config.toml'), 'utf8')
  assert.ok(codex.startsWith(SEED_TOML), 'existing TOML must be byte-preserved, not re-stringified')
  assert.match(codex, /\[mcp_servers\.playwright\]/)
  assert.match(codex, /\[mcp_servers\.playwright\.env\]\nTOKEN = 'secret123'/)
  assert.match(codex, /command = 'C:\\Users\\x\\node repl\.exe'/, 'literal Windows path must not be re-escaped')

  const oc = JSON.parse(readFileSync(join(sandbox, '.config', 'opencode', 'opencode.jsonc'), 'utf8'))
  assert.deepEqual(oc.mcp.playwright, {
    type: 'local',
    command: ['npx', ...CAP.install.args], // exe + args merged into one array
    enabled: true,
    environment: { TOKEN: 'secret123' }, // note: `environment`, not `env`
  })
  assert.equal(oc.$schema, 'https://opencode.ai/config.json', 'schema key must survive')

  for (const a of Object.values(adapters)) assert.equal(a.has(CAP), true, `${a.key} should report installed`)
})

// --- install orchestration --------------------------------------------------

test('install is idempotent and rolls back byte-identical', async () => {
  seed() // reset
  const files = [
    join(sandbox, '.claude.json'),
    join(sandbox, '.codex', 'config.toml'),
    join(sandbox, '.config', 'opencode', 'opencode.jsonc'),
  ]
  const before = files.map((f) => readFileSync(f, 'utf8'))

  const agents = ['claude', 'codex', 'opencode'] as const
  const req = {
    capabilityIds: ['sequential-thinking'],
    agents: [...agents],
    projectDir: sandbox,
  }

  const first = await install(req)
  assert.equal(first.capabilities.length, 1)
  for (const r of first.capabilities[0].results) assert.equal(r.status, 'installed', `${r.agent}: ${r.error ?? ''}`)
  assert.equal(first.capabilities[0].health.reachable, true, `probe failed: ${first.capabilities[0].health.error}`)
  assert.ok(first.capabilities[0].health.tools.length > 0)

  // Second run must detect and skip, not duplicate.
  const second = await install(req)
  for (const r of second.capabilities[0].results) assert.equal(r.status, 'already-present', `${r.agent} duplicated`)
  const toml = readFileSync(join(sandbox, '.codex', 'config.toml'), 'utf8')
  assert.equal(toml.match(/\[mcp_servers\.sequential-thinking\]/g)!.length, 1, 'TOML table duplicated')

  // Roll back both runs, newest first.
  assert.ok(rollback(second.ledgerId))
  assert.ok(rollback(first.ledgerId))
  files.forEach((f, i) => assert.equal(readFileSync(f, 'utf8'), before[i], `${f} not restored byte-identical`))
})

test('ledger records secret names but never values', async () => {
  seed()
  await install({
    capabilityIds: ['playwright'],
    agents: ['claude'],
    projectDir: sandbox,
    secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_must_not_appear' },
  })
  const raw = readFileSync(join(sandbox, '.agentpack', 'installs.json'), 'utf8')
  assert.ok(!raw.includes('ghp_must_not_appear'), 'SECRET LEAKED INTO LEDGER')
  assert.ok(raw.includes('GITHUB_PERSONAL_ACCESS_TOKEN'), 'secret name should be recorded')
  rollback()
})

test('rollback with nothing left to undo returns null', () => {
  while (ledger.latestUndoable()) rollback()
  assert.equal(rollback(), null)
})

test('unsupported agent is reported, not silently skipped', async () => {
  seed()
  const cap = getCapability('playwright')
  const original = cap.supportedAgents
  ;(cap as { supportedAgents: string[] }).supportedAgents = ['claude']
  try {
    const r = await install({ capabilityIds: ['playwright'], agents: ['claude', 'codex'], projectDir: sandbox })
    const codex = r.capabilities[0].results.find((x) => x.agent === 'codex')!
    assert.equal(codex.status, 'failed')
    assert.match(codex.error!, /does not support/)
    rollback()
  } finally {
    ;(cap as { supportedAgents: string[] }).supportedAgents = original
  }
})

// --- run --------------------------------------------------------------------

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`\x1b[32m✓\x1b[0m ${name}`)
  } catch (e) {
    failed++
    console.log(`\x1b[31m✗\x1b[0m ${name}\n  ${(e as Error).message.split('\n').join('\n  ')}`)
  }
}

console.log(`\n${failed ? `\x1b[31m${failed} failed\x1b[0m` : '\x1b[32mall passed\x1b[0m'}  \x1b[2m(sandbox: ${sandbox})\x1b[0m`)
assert.ok(existsSync(sandbox))
process.exit(failed ? 1 : 0)
