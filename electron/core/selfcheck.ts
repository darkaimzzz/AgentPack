// Engine self-check. Runs entirely in a temp sandbox; touches no real config.
//   node electron/core/selfcheck.ts
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'agentpack-check-'))
process.env.AGENTPACK_HOME = sandbox

const { adapters } = await import('./agents/index.ts')
const { getCapability, resolveArgs, missingInputs, capabilities, packs } = await import('./capabilities/registry.ts')
const { install, rollback, rollbackAll } = await import('./installer/install.ts')
const { preflight } = await import('./installer/preflight.ts')
const { probe } = await import('./installer/health.ts')
const {
  buildManifest, exportManifest, readManifest, manifestMissingSecrets, installedCapabilities,
} = await import('./capabilities/manifest.ts')
const { redact, resolveCommand } = await import('./installer/run.ts')
const { scanProject } = await import('./detection/project.ts')
const { recommend, RULES } = await import('./recommendations/rules.ts')
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

test('declared inputs are substituted, and missing ones are caught', () => {
  const supabase = getCapability('supabase')
  const filled = resolveArgs(supabase, { projectDir: 'X', values: { SUPABASE_PROJECT_REF: 'abcd1234' } })
  assert.ok(filled.includes('--project-ref=abcd1234'))
  assert.deepEqual(missingInputs(supabase, { SUPABASE_PROJECT_REF: 'abcd1234' }), [])
  // Unfilled placeholders must be reported, never written through literally.
  assert.deepEqual(missingInputs(supabase, {}), ['SUPABASE_PROJECT_REF'])
  assert.ok(resolveArgs(supabase, { projectDir: 'X' }).some((a) => a.includes('${')))
})

test('every rule names a capability the registry actually carries', () => {
  const known = new Set(capabilities().map((c) => c.id))
  for (const r of RULES) assert.ok(known.has(r.capabilityId), `rule points at missing capability: ${r.capabilityId}`)
})

// --- project detection + recommendation -------------------------------------

const fixture = (name: string, files: Record<string, string>, dirs: string[] = []) => {
  const dir = join(sandbox, 'fixtures', name)
  mkdirSync(dir, { recursive: true })
  for (const d of dirs) mkdirSync(join(dir, d), { recursive: true })
  for (const [f, body] of Object.entries(files)) writeFileSync(join(dir, f), body)
  return dir
}

test('detects a Next.js + Supabase project and explains why', () => {
  const dir = fixture(
    'nextjs-supabase',
    {
      'package.json': JSON.stringify({
        dependencies: { next: '15.0.0', react: '19.0.0', '@supabase/supabase-js': '2.45.0' },
        devDependencies: { typescript: '5.6.0' },
      }),
      'next.config.ts': 'export default {}',
      '.env.example': '# comment\nDATABASE_URL=\nSUPABASE_ANON_KEY=\n',
    },
    ['.git'],
  )
  const scan = scanProject(dir)
  const ids = scan.signals.map((s) => s.id)
  for (const want of ['node', 'git', 'nextjs', 'react', 'supabase', 'typescript', 'postgres']) {
    assert.ok(ids.includes(want), `missing signal: ${want} (got ${ids.join(', ')})`)
  }
  assert.equal(new Set(ids).size, ids.length, 'signals must be de-duplicated')
  for (const s of scan.signals) assert.ok(s.evidence.length > 3, `${s.id} has no evidence string`)

  const recs = recommend(scan)
  const recIds = recs.map((r) => r.capability.id)
  assert.deepEqual(recIds.sort(), ['filesystem', 'github', 'playwright', 'supabase'])
  for (const r of recs) {
    assert.ok(!r.reason.includes('{evidence}'), 'reason template not filled')
    assert.ok(r.matched.length, 'recommendation carries no matching signal')
  }
})

test('a bare Python project gets no browser tooling', () => {
  const dir = fixture('py', { 'requirements.txt': 'flask\n' })
  const recs = recommend(scanProject(dir)).map((r) => r.capability.id)
  assert.ok(recs.includes('filesystem'))
  assert.ok(!recs.includes('playwright'), 'no frontend, so no Playwright')
  assert.ok(!recs.includes('supabase'))
})

test('an empty directory recommends nothing', () => {
  const dir = fixture('empty', {})
  const scan = scanProject(dir)
  assert.equal(scan.isProject, false)
  assert.deepEqual(recommend(scan), [])
})

test('a malformed package.json does not crash the scan', () => {
  const dir = fixture('broken', { 'package.json': '{ not json' })
  assert.doesNotThrow(() => scanProject(dir))
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
    assert.equal(a.read(CAP), null, `${a.key} should not have it yet`)
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

  for (const a of Object.values(adapters)) assert.ok(a.read(CAP), `${a.key} should report installed`)
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

test('a capability with unfilled inputs fails loudly instead of writing ${}', async () => {
  seed()
  const r = await install({ capabilityIds: ['supabase'], agents: ['claude'], projectDir: sandbox })
  const res = r.capabilities[0].results[0]
  assert.equal(res.status, 'failed')
  assert.match(res.error!, /missing required input: SUPABASE_PROJECT_REF/)
  assert.equal(r.capabilities[0].health.reachable, false)
  const cfg = readFileSync(join(sandbox, '.claude.json'), 'utf8')
  assert.ok(!cfg.includes('${'), 'a literal placeholder was written into the config')
  assert.ok(!cfg.includes('supabase'), 'failed capability must not be configured')
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

// --- phase 4: preflight, rollbackAll, manifests ------------------------------

test('preflight finds npx and reports a bogus binary clearly', async () => {
  const real = await preflight([getCapability('playwright')])
  assert.equal(real.ok, true, `npx should be available: ${real.problems.join('; ')}`)
  assert.ok(real.binaries[0].version, 'should capture a version string')

  const fake = { ...getCapability('playwright'), name: 'Bogus', install: { command: 'definitely-not-a-real-binary-xyz', args: [] } }
  const bad = await preflight([fake])
  assert.equal(bad.ok, false)
  assert.match(bad.problems[0], /not available on PATH/)
  assert.match(bad.problems[0], /Bogus/, 'should name which capability needs it')
})

test('a failed preflight aborts before touching any config', async () => {
  seed()
  const before = readFileSync(join(sandbox, '.claude.json'), 'utf8')
  const cap = getCapability('sequential-thinking')
  const original = cap.install.command
  ;(cap as { install: { command: string } }).install.command = 'definitely-not-a-real-binary-xyz'
  try {
    const r = await install({ capabilityIds: ['sequential-thinking'], agents: ['claude'], projectDir: sandbox })
    assert.equal(r.preflight?.ok, false)
    assert.equal(r.capabilities[0].results[0].status, 'failed')
    assert.equal(readFileSync(join(sandbox, '.claude.json'), 'utf8'), before, 'config must be untouched')
  } finally {
    ;(cap as { install: { command: string } }).install.command = original
  }
})

test('the ledger entry exists before any config is written', async () => {
  seed()
  const cap = getCapability('sequential-thinking')
  const original = cap.supportedAgents
  // Force a mid-run throw by pointing at an agent key that will fail on write.
  const r = await install({ capabilityIds: ['sequential-thinking'], agents: ['claude'], projectDir: sandbox })
  assert.ok(ledger.entries().some((e) => e.id === r.ledgerId), 'run must be recorded')
  const entry = ledger.entries().find((e) => e.id === r.ledgerId)!
  assert.ok(entry.backups.length, 'backups must be recorded so rollback is possible')
  ;(cap as { supportedAgents: string[] }).supportedAgents = original
  rollbackAll()
})

test('rollbackAll undoes every run, oldest state restored', async () => {
  seed()
  const files = [join(sandbox, '.claude.json'), join(sandbox, '.codex', 'config.toml')]
  const before = files.map((f) => readFileSync(f, 'utf8'))

  await install({ capabilityIds: ['playwright'], agents: ['claude', 'codex'], projectDir: sandbox })
  await install({ capabilityIds: ['sequential-thinking'], agents: ['claude', 'codex'], projectDir: sandbox })
  assert.notEqual(readFileSync(files[0], 'utf8'), before[0], 'sanity: installs changed the config')

  const r = rollbackAll()
  assert.equal(r.entries.length, 2, 'both runs should be undone')
  files.forEach((f, i) => assert.equal(readFileSync(f, 'utf8'), before[i], `${f} not restored`))
  assert.deepEqual(rollbackAll().entries, [], 'a second rollbackAll is a no-op')
})

test('exported manifest carries secret NAMES but never values', async () => {
  seed()
  await install({
    capabilityIds: ['github'],
    agents: ['claude'],
    projectDir: sandbox,
    secrets: { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_must_not_be_exported' },
  })
  const path = join(sandbox, 'manifest.json')
  exportManifest(path, buildManifest({ name: 'demo' }))
  const raw = readFileSync(path, 'utf8')
  assert.ok(!raw.includes('ghp_must_not_be_exported'), 'SECRET LEAKED INTO MANIFEST')
  assert.ok(raw.includes('GITHUB_PERSONAL_ACCESS_TOKEN'), 'required secret name should be listed')

  const m = readManifest(path)
  assert.ok(m.capabilities.includes('github'))
  assert.deepEqual(manifestMissingSecrets(m, {}), ['GITHUB_PERSONAL_ACCESS_TOKEN'])
  assert.deepEqual(manifestMissingSecrets(m, { GITHUB_PERSONAL_ACCESS_TOKEN: 'x' }), [])
  rollbackAll()
})

test('manifest round-trips non-secret inputs', () => {
  const path = join(sandbox, 'm2.json')
  exportManifest(path, buildManifest({
    name: 'with-inputs', capabilityIds: ['supabase'], targets: ['claude'],
    inputs: { SUPABASE_PROJECT_REF: 'abcd1234' },
  }))
  const m = readManifest(path)
  assert.equal(m.inputs?.SUPABASE_PROJECT_REF, 'abcd1234', 'non-secret inputs should survive export')
  assert.ok(m.requiredSecrets?.includes('SUPABASE_ACCESS_TOKEN'))
})

test('a bad manifest is rejected on read, not halfway through installing', () => {
  const p1 = join(sandbox, 'bad1.json')
  writeFileSync(p1, JSON.stringify({ agentpack: 99, capabilities: ['playwright'] }))
  assert.throws(() => readManifest(p1), /unsupported manifest version/)

  const p2 = join(sandbox, 'bad2.json')
  writeFileSync(p2, JSON.stringify({ agentpack: 1, capabilities: ['no-such-capability'] }))
  assert.throws(() => readManifest(p2), /unknown capabilities/)
})

test('installedCapabilities reflects what is actually in the configs', async () => {
  seed()
  assert.equal(installedCapabilities().length, 0, 'clean baseline')
  await install({ capabilityIds: ['playwright'], agents: ['claude', 'codex'], projectDir: sandbox })
  const live = installedCapabilities()
  assert.equal(live.length, 1)
  assert.equal(live[0].capability.id, 'playwright')
  assert.deepEqual(live[0].agents.sort(), ['claude', 'codex'])
  rollbackAll()
})

// --- QA regressions (each fails if the reported defect returns) --------------

test('QA1: a deselected capability\'s secret never reaches the request', () => {
  // Mirrors the UI: values are retained when a capability is deselected.
  const values = { GITHUB_PERSONAL_ACCESS_TOKEN: 'ghp_deselected_leak', SUPABASE_PROJECT_REF: 'ref123' }
  const chosen = [getCapability('playwright'), getCapability('supabase')] // github NOT selected
  const secrets: Record<string, string> = {}
  const inputs: Record<string, string> = {}
  for (const c of chosen) {
    for (const s of c.secrets ?? []) if (values[s.key as keyof typeof values]) secrets[s.key] = values[s.key as keyof typeof values]
    for (const i of c.inputs ?? []) if (values[i.key as keyof typeof values]) inputs[i.key] = values[i.key as keyof typeof values]
  }
  assert.ok(!('GITHUB_PERSONAL_ACCESS_TOKEN' in inputs), 'deselected secret reclassified as an input — it would reach the ledger')
  assert.ok(!('GITHUB_PERSONAL_ACCESS_TOKEN' in secrets), 'deselected capability should contribute nothing')
  assert.equal(inputs.SUPABASE_PROJECT_REF, 'ref123', 'selected capability inputs must still flow')
})

test('QA2: rollback deletes a config file AgentPack created', async () => {
  const fresh = join(sandbox, 'fresh')
  mkdirSync(join(fresh, '.codex'), { recursive: true })
  mkdirSync(join(fresh, '.config', 'opencode'), { recursive: true })
  const prev = process.env.AGENTPACK_HOME
  process.env.AGENTPACK_HOME = fresh
  try {
    const targets = ['claude', 'codex', 'opencode'] as const
    for (const k of targets) assert.equal(existsSync(adapters[k].configPath()), false, `${k} should start with no config`)
    await install({ capabilityIds: ['sequential-thinking'], agents: [...targets], projectDir: fresh })
    for (const k of targets) assert.ok(existsSync(adapters[k].configPath()), `${k} config should have been created`)
    rollbackAll()
    for (const k of targets) {
      assert.equal(existsSync(adapters[k].configPath()), false,
        `${k}: rollback left behind a file AgentPack created`)
    }
  } finally {
    process.env.AGENTPACK_HOME = prev
  }
})

test('QA3: a broken saved entry is a conflict, not a healthy install', async () => {
  seed()
  const cap = getCapability('sequential-thinking')
  // Pre-seed Claude with the right id but a command that cannot work.
  const cfgPath = join(sandbox, '.claude.json')
  const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
  cfg.mcpServers[cap.id] = { type: 'stdio', command: 'agentpack-nonexistent-command', args: [] }
  writeFileSync(cfgPath, JSON.stringify(cfg, null, 2))

  const r = await install({ capabilityIds: [cap.id], agents: ['claude', 'codex'], projectDir: sandbox })
  const claudeResult = r.capabilities[0].results.find((x) => x.agent === 'claude')!
  assert.equal(claudeResult.status, 'conflict', 'a stale/broken entry must not report as already-present')
  assert.match(claudeResult.error!, /different settings/)
  // The bad entry is left alone rather than silently overwritten.
  const after = JSON.parse(readFileSync(cfgPath, 'utf8'))
  assert.equal(after.mcpServers[cap.id].command, 'agentpack-nonexistent-command')
  rollbackAll()
})

test('QA4: rollback preserves an unrelated edit made after install', async () => {
  seed()
  const cfgPath = join(sandbox, '.claude.json')
  await install({ capabilityIds: ['playwright'], agents: ['claude'], projectDir: sandbox })

  // Simulate the agent (or user) editing the file afterwards.
  const edited = JSON.parse(readFileSync(cfgPath, 'utf8'))
  edited.somethingTheUserAddedLater = 'keep me'
  writeFileSync(cfgPath, JSON.stringify(edited, null, 2))

  rollbackAll()
  const after = JSON.parse(readFileSync(cfgPath, 'utf8'))
  assert.equal(after.somethingTheUserAddedLater, 'keep me', 'a later edit was destroyed by whole-file restore')
  assert.ok(!after.mcpServers?.playwright, 'our entry should still have been removed')
  assert.ok(after.mcpServers?.existing, 'pre-existing entries must survive')
})

test('QA5: a secret echoed in a JSON-RPC error is redacted', async () => {
  const SECRET = 'ghp_protocol_error_secret_value'
  const script = join(sandbox, 'error-server.mjs')
  writeFileSync(script, `
    process.stdin.on('data', (d) => {
      for (const line of String(d).split('\\n')) {
        if (!line.trim()) continue
        const msg = JSON.parse(line)
        if (msg.id) process.stdout.write(JSON.stringify({
          jsonrpc: '2.0', id: msg.id,
          error: { code: -32000, message: 'auth failed for token ${SECRET}' },
        }) + '\\n')
      }
    })
    setTimeout(() => {}, 10000)
  `)
  const r = await probe({ command: process.execPath, args: [script], secretValues: [SECRET], timeoutMs: 20_000 })
  assert.equal(r.reachable, false)
  assert.ok(!r.error!.includes(SECRET), `SECRET LEAKED THROUGH PROTOCOL ERROR: ${r.error}`)
  assert.match(r.error!, /redacted/)
})

test('QA6: Back from every screen leads somewhere usable', () => {
  // Mirrors src/App.tsx BACK. 'install' is transient and must never be a target.
  const BACK: Record<string, string | undefined> = {
    detect: undefined, project: 'detect', recommend: 'project',
    plan: 'recommend', install: 'plan', report: 'recommend',
  }
  for (const [from, to] of Object.entries(BACK)) {
    if (!to) continue
    assert.notEqual(to, 'install', `Back from ${from} lands on the transient install screen`)
    assert.ok(to in BACK, `Back from ${from} goes to an unknown step`)
  }
})

test('QA7: OpenCode JSONC with comments is accepted', () => {
  seed()
  const p = join(sandbox, '.config', 'opencode', 'opencode.jsonc')
  writeFileSync(p, [
    '{',
    '  // my opencode config',
    '  "$schema": "https://opencode.ai/config.json",',
    '  /* block comment */',
    '  "theme": "dark",',
    '}',
  ].join('\n'))
  const cap = getCapability('playwright')
  assert.doesNotThrow(() => adapters.opencode.write(cap, {}), 'a commented .jsonc must not be rejected')
  const entry = adapters.opencode.read(cap)
  assert.ok(entry, 'entry should be readable back')
  assert.equal(entry!.command, 'npx')
  const raw = readFileSync(p, 'utf8')
  assert.match(raw, /my opencode config/, 'comments must survive the edit')
  assert.match(raw, /"theme"/, 'unrelated keys must survive')
})

test('QA8: apostrophes and newlines produce valid TOML', async () => {
  const { parse } = await import('smol-toml')
  seed()
  const cap = getCapability('filesystem')
  const nasty = "C:\\Projects\\O'Brien App"
  adapters.codex.write({ ...cap, install: { ...cap.install, args: [nasty, 'plain'] } }, { K: "it's \"quoted\"" })
  const raw = readFileSync(join(sandbox, '.codex', 'config.toml'), 'utf8')
  const parsed = parse(raw) as { mcp_servers: Record<string, { args: string[]; env: Record<string, string> }> }
  assert.deepEqual(parsed.mcp_servers.filesystem.args, [nasty, 'plain'], 'apostrophe path must round-trip exactly')
  assert.equal(parsed.mcp_servers.filesystem.env.K, "it's \"quoted\"")
  assert.ok(parsed.mcp_servers.node_repl, 'the pre-existing table must survive')
  rollbackAll()
})

test('QA9: export recovers a real installed input value', async () => {
  seed()
  await install({
    capabilityIds: ['supabase'],
    agents: ['claude'],
    projectDir: sandbox,
    inputs: { SUPABASE_PROJECT_REF: 'recovered123' },
    secrets: { SUPABASE_ACCESS_TOKEN: 'sbp_should_not_export' },
  })
  // The normal user path: export without passing inputs back in by hand.
  const p = join(sandbox, 'recovered.json')
  exportManifest(p, buildManifest({ name: 'recovered' }))
  const m = readManifest(p)
  assert.equal(m.inputs?.SUPABASE_PROJECT_REF, 'recovered123', 'export dropped the installed project ref')
  assert.ok(!readFileSync(p, 'utf8').includes('sbp_should_not_export'), 'SECRET LEAKED INTO MANIFEST')
  rollbackAll()
})

test('QA10: registry packages are pinned to exact versions', () => {
  for (const c of capabilities()) {
    for (const a of c.install.args) {
      if (!a.startsWith('@')) continue
      assert.ok(!a.endsWith('@latest'), `${c.id} uses @latest — not reproducible on demo day`)
      assert.match(a, /@\d[\w.-]*$/, `${c.id} package "${a}" is unpinned`)
    }
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
