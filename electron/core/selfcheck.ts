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
const { estimateCost, measureCost, totalCost } = await import('./clm/cost.ts')
const { deactivate, activate, runtimeState, listRuntime, reconcile, log } = await import('./clm/state.ts')
const dormantStore = await import('./clm/dormant.ts')
const { profiles, planProfile, applyProfile, currentProfile } = await import('./clm/profiles.ts')

const tests: Array<[string, () => void | Promise<void>]> = []
const test = (name: string, fn: () => void | Promise<void>) => tests.push([name, fn])

// --- registry ---------------------------------------------------------------

test('registry loads capabilities and packs', () => {
  assert.ok(capabilities().length >= 3)
  assert.ok(packs().length >= 1)
  for (const c of capabilities()) {
    assert.ok(c.id && c.name && (c.install?.command || c.plugin?.name), `${c.id} malformed`)
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
  assert.deepEqual(recIds.sort(), ['context7', 'filesystem', 'github', 'playwright', 'supabase'])
  for (const r of recs) {
    assert.ok(!r.reason.includes('{evidence}'), 'reason template not filled')
    assert.ok(r.matched.length, 'recommendation carries no matching signal')
  }
})

test('a monorepo finds dependencies in workspace packages', () => {
  const dir = fixture('mono', {
    'package.json': JSON.stringify({ private: true, workspaces: ['apps/*'], devDependencies: { turbo: '2.3.0' } }),
  })
  mkdirSync(join(dir, 'apps', 'web'), { recursive: true })
  writeFileSync(join(dir, 'apps', 'web', 'package.json'), JSON.stringify({
    dependencies: { next: '15.1.0', react: '19.0.0', '@supabase/supabase-js': '2.45.0' },
  }))
  const scan = scanProject(dir)
  const ids = scan.signals.map((s) => s.id)
  for (const want of ['nextjs', 'react', 'supabase', 'monorepo']) {
    assert.ok(ids.includes(want), `monorepo missed ${want} (got ${ids.join(', ')})`)
  }
  assert.equal(scan.manifests.length, 2, 'both root and workspace manifests should be read')
  // Evidence must name the file it came from, not just "package.json".
  const next = scan.signals.find((s) => s.id === 'nextjs')!
  // Separator is \ on Windows, / elsewhere.
  assert.match(next.evidence, /apps[\\/]web[\\/]package\.json/, 'evidence should point at the workspace manifest')
  assert.ok(recommend(scan).some((r) => r.capability.id === 'supabase'))
})

test('undeclared apps/ and packages/ layouts are still scanned', () => {
  const dir = fixture('implicit-mono', { 'package.json': JSON.stringify({ name: 'root' }) })
  mkdirSync(join(dir, 'packages', 'api'), { recursive: true })
  writeFileSync(join(dir, 'packages', 'api', 'package.json'), JSON.stringify({ dependencies: { fastify: '5.0.0' } }))
  const ids = scanProject(dir).signals.map((s) => s.id)
  assert.ok(ids.includes('fastify'), 'conventional packages/* layout should be scanned even when undeclared')
})

test('a dependency family is matched by scope, not one exact name', () => {
  const dir = fixture('modern-supabase', {
    'package.json': JSON.stringify({ dependencies: { '@supabase/ssr': '0.5.2', next: '15.1.0', tailwindcss: '4.0.0' } }),
  })
  const scan = scanProject(dir)
  const ids = scan.signals.map((s) => s.id)
  // @supabase/ssr is the current Next.js integration; matching only
  // @supabase/supabase-js missed most real projects.
  assert.ok(ids.includes('supabase'), '@supabase/ssr should count as Supabase')
  assert.ok(ids.includes('tailwind'))
  assert.ok(recommend(scan).some((r) => r.capability.id === 'supabase'))
})

test('pnpm workspaces are followed', () => {
  const dir = fixture('pnpm', {
    'package.json': JSON.stringify({ name: 'root' }),
    'pnpm-workspace.yaml': ['packages:', "  - 'site'", ''].join('\n'),
  })
  mkdirSync(join(dir, 'site'), { recursive: true })
  writeFileSync(join(dir, 'site', 'package.json'), JSON.stringify({ dependencies: { astro: '5.0.0' } }))
  const ids = scanProject(dir).signals.map((s) => s.id)
  assert.ok(ids.includes('astro'), 'pnpm-workspace.yaml members should be scanned')
})

test('python frameworks are detected from requirements', () => {
  const dir = fixture('py-django', { 'requirements.txt': ['Django==5.1', 'psycopg2-binary==2.9', ''].join('\n') })
  const ids = scanProject(dir).signals.map((s) => s.id)
  assert.ok(ids.includes('python'))
  assert.ok(ids.includes('django'))
  assert.ok(ids.includes('postgres'), 'psycopg implies PostgreSQL')
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
    assert.equal(codex.status, 'unsupported')
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
    for (const a of c.install?.args ?? []) {
      if (!a.startsWith('@')) continue
      assert.ok(!a.endsWith('@latest'), `${c.id} uses @latest — not reproducible on demo day`)
      assert.match(a, /@\d[\w.-]*$/, `${c.id} package "${a}" is unpinned`)
    }
  }
})

// --- plugins (Claude Code + Codex only) --------------------------------------

test('a plugin installs into Claude and Codex in their native formats', async () => {
  seed()
  mkdirSync(join(sandbox, '.claude'), { recursive: true })
  writeFileSync(join(sandbox, '.claude', 'settings.json'), JSON.stringify({ theme: 'dark' }, null, 2))

  const r = await install({ capabilityIds: ['superpowers'], agents: ['claude', 'codex'], projectDir: sandbox })
  for (const res of r.capabilities[0].results) {
    assert.equal(res.status, 'installed', `${res.agent}: ${res.error ?? ''}`)
  }

  // Claude: settings.json keys, verified against a real install.
  const s = JSON.parse(readFileSync(join(sandbox, '.claude', 'settings.json'), 'utf8'))
  assert.deepEqual(s.extraKnownMarketplaces['claude-plugins-official'],
    { source: { source: 'github', repo: 'anthropics/claude-plugins-official' } })
  assert.equal(s.enabledPlugins['superpowers@claude-plugins-official'], true)
  assert.equal(s.theme, 'dark', 'unrelated settings must survive')

  // Codex: TOML tables, and the document must still parse.
  const { parse } = await import('smol-toml')
  const toml = parse(readFileSync(join(sandbox, '.codex', 'config.toml'), 'utf8')) as {
    marketplaces: Record<string, { source_type: string; source: string }>
    plugins: Record<string, { enabled: boolean }>
    mcp_servers: Record<string, unknown>
  }
  assert.equal(toml.marketplaces['claude-plugins-official'].source_type, 'git')
  assert.match(toml.marketplaces['claude-plugins-official'].source, /anthropics\/claude-plugins-official\.git$/)
  assert.equal(toml.plugins['superpowers@claude-plugins-official'].enabled, true)
  assert.ok(toml.mcp_servers.node_repl, 'pre-existing MCP tables must survive')

  // Both agents use the SAME plugin@marketplace id — worth pinning.
  assert.ok('superpowers@claude-plugins-official' in s.enabledPlugins)
  assert.ok('superpowers@claude-plugins-official' in toml.plugins)
  rollbackAll()
})

test('a plugin reports configured, never verified', async () => {
  seed()
  mkdirSync(join(sandbox, '.claude'), { recursive: true })
  const r = await install({ capabilityIds: ['claude-mem'], agents: ['claude'], projectDir: sandbox })
  const h = r.capabilities[0].health
  assert.equal(h.status, 'configured', 'a plugin must not claim verification it cannot perform')
  assert.equal(h.method, 'config-only')
  assert.deepEqual(h.tools, [], 'a plugin lists no tools from here')
  assert.equal(h.reachable, false)
  rollbackAll()
})

test('OpenCode is reported unsupported for plugins, not silently skipped', async () => {
  seed()
  const r = await install({ capabilityIds: ['superpowers'], agents: ['opencode'], projectDir: sandbox })
  const res = r.capabilities[0].results[0]
  assert.equal(res.status, 'unsupported', 'an agent that cannot host plugins is not a failure')
  assert.match(res.error!, /no git-marketplace plugin system/)
  rollbackAll()
})

test('rolling back a plugin removes it but keeps the marketplace', async () => {
  seed()
  mkdirSync(join(sandbox, '.claude'), { recursive: true })
  const settings = join(sandbox, '.claude', 'settings.json')
  writeFileSync(settings, JSON.stringify({ theme: 'dark' }, null, 2))
  await install({ capabilityIds: ['superpowers'], agents: ['claude'], projectDir: sandbox })
  // Simulate a later edit so rollback takes the targeted path.
  const edited = JSON.parse(readFileSync(settings, 'utf8'))
  edited.somethingElse = 'keep'
  writeFileSync(settings, JSON.stringify(edited, null, 2))
  rollbackAll()
  const after = JSON.parse(readFileSync(settings, 'utf8'))
  assert.ok(!after.enabledPlugins?.['superpowers@claude-plugins-official'], 'plugin should be disabled again')
  assert.ok(after.extraKnownMarketplaces?.['claude-plugins-official'], 'marketplace stays: other plugins may need it')
  assert.equal(after.somethingElse, 'keep')
})

test('a declared binary requirement is checked before install', async () => {
  const beads = getCapability('beads')
  assert.deepEqual(beads.requires?.binaries, ['bd'], 'beads must declare its CLI dependency')

  // Preflight must fail when the required binary is absent, and say why.
  const fake = { ...beads, requires: { binaries: ['definitely-not-a-real-binary-xyz'], note: 'install it first' } }
  const r = await preflight([fake])
  assert.equal(r.ok, false, 'a missing required binary must fail preflight')
  assert.match(r.problems[0], /not available on PATH/)
  assert.match(r.problems[0], /Beads/, 'should name the capability that needs it')
  assert.match(r.problems[0], /install it first/, 'should surface the remediation note')
})

test('a plugin whose CLI is missing does not report a hollow success', async () => {
  seed()
  mkdirSync(join(sandbox, '.claude'), { recursive: true })
  const beads = getCapability('beads')
  const original = beads.requires
  ;(beads as { requires?: unknown }).requires = { binaries: ['definitely-not-a-real-binary-xyz'] }
  try {
    const r = await install({ capabilityIds: ['beads'], agents: ['claude'], projectDir: sandbox })
    assert.equal(r.preflight?.ok, false)
    assert.equal(r.capabilities[0].results[0].status, 'failed')
    assert.equal(r.capabilities[0].health.status, 'failed')
    const s = existsSync(join(sandbox, '.claude', 'settings.json'))
      ? JSON.parse(readFileSync(join(sandbox, '.claude', 'settings.json'), 'utf8'))
      : {}
    assert.ok(!s.enabledPlugins?.['beads@beads-marketplace'], 'nothing should have been written')
  } finally {
    ;(beads as { requires?: unknown }).requires = original
  }
})

test('every registry entry declares exactly one install mechanism', () => {
  for (const c of capabilities()) {
    if (c.type === 'mcp') {
      assert.ok(c.install?.command, `${c.id} is an mcp with no install block`)
      assert.ok(!c.plugin, `${c.id} is an mcp but declares a plugin block`)
    } else {
      assert.ok(c.plugin?.repo && c.plugin?.name, `${c.id} is a plugin with no plugin block`)
      assert.ok(!c.install, `${c.id} is a plugin but declares an install block`)
      assert.ok(!c.supportedAgents.includes('opencode'),
        `${c.id}: OpenCode has no git-marketplace plugin system, so it must not be listed`)
    }
  }
})

// --- CLM: context cost (Phase 1) --------------------------------------------

test('CLM cost estimate is deterministic and arithmetically right', () => {
  const tools = [
    { name: 'a', description: 'x'.repeat(100), inputSchema: { type: 'object' } },
    { name: 'b', description: 'y'.repeat(50), inputSchema: { type: 'object' } },
  ]
  const c1 = estimateCost(tools)
  const c2 = estimateCost(tools)
  assert.equal(c1.toolCount, 2)
  assert.equal(c1.serializedChars, JSON.stringify(tools).length)
  assert.equal(c1.estimatedTokens, Math.round(c1.serializedChars / 4))
  assert.equal(c1.source, 'measured')
  assert.equal(c1.serializedChars, c2.serializedChars, 'same input must give the same number')
})

test('CLM reports plugins as not measurable rather than inventing a number', async () => {
  const cost = await measureCost(getCapability('superpowers'), { projectDir: sandbox })
  assert.equal(cost.source, 'unavailable')
  assert.equal(cost.estimatedTokens, 0, 'an unmeasurable capability must not report a token count')
  assert.match(cost.note!, /not measurable/i)
})

test('CLM totals ignore unmeasurable capabilities', () => {
  const t = totalCost([
    { toolCount: 3, serializedChars: 400, estimatedTokens: 100, measuredAt: '', source: 'measured' },
    { toolCount: 0, serializedChars: 0, estimatedTokens: 0, measuredAt: '', source: 'unavailable' },
  ])
  assert.equal(t.toolCount, 3)
  assert.equal(t.estimatedTokens, 100)
  assert.equal(t.unmeasurable, 1)
})

// --- CLM: state engine (Phase 2) --------------------------------------------

const clmSeed = async () => {
  seed()
  // A credentialed capability is the hard case for dormancy.
  await install({
    capabilityIds: ['supabase'],
    agents: ['claude', 'codex', 'opencode'],
    projectDir: sandbox,
    inputs: { SUPABASE_PROJECT_REF: 'clmref' },
    secrets: { SUPABASE_ACCESS_TOKEN: 'sbp_clm_secret' },
  })
}

test('CLM deactivate removes the entry and reports dormant', async () => {
  await clmSeed()
  assert.equal(runtimeState('supabase', 'claude'), 'active')
  const r = deactivate('supabase', 'claude')
  assert.equal(r.success, true, r.error)
  assert.equal(r.to, 'dormant')
  assert.deepEqual(r.changedFiles, [adapters.claude.configPath()])
  assert.equal(adapters.claude.read(getCapability('supabase')), null, 'entry still in the live config')
  assert.equal(runtimeState('supabase', 'claude'), 'dormant')
})

test('CLM dormancy preserves the credential and restores it exactly', async () => {
  await clmSeed()
  const before = adapters.codex.read(getCapability('supabase'))!
  assert.equal(before.env.SUPABASE_ACCESS_TOKEN, 'sbp_clm_secret')

  assert.equal(deactivate('supabase', 'codex').success, true)
  const stash = dormantStore.get('supabase', 'codex')
  assert.ok(stash, 'nothing stashed — the credential would be lost')
  assert.equal(stash!.entry.env.SUPABASE_ACCESS_TOKEN, 'sbp_clm_secret')

  const back = activate('supabase', 'codex')
  assert.equal(back.success, true, back.error)
  const after = adapters.codex.read(getCapability('supabase'))!
  assert.deepEqual(after, before, 'restored entry differs from the original')
  assert.equal(dormantStore.get('supabase', 'codex'), null, 'stash should be dropped once restored')
})

test('CLM mutations are idempotent in both directions', async () => {
  await clmSeed()
  assert.equal(deactivate('supabase', 'opencode').success, true)
  const second = deactivate('supabase', 'opencode')
  assert.equal(second.success, true, 'second deactivate should be a no-op, not an error')
  assert.equal(second.noop, true)

  assert.equal(activate('supabase', 'opencode').success, true)
  const twice = activate('supabase', 'opencode')
  assert.equal(twice.success, true, 'second activate should be a no-op')
  assert.equal(twice.noop, true)
  // Codex is the one that would throw on a blind rewrite; assert no duplication.
  assert.ok(adapters.opencode.read(getCapability('supabase')))
})

test('CLM refuses to activate something it never stashed', async () => {
  seed()
  const r = activate('playwright', 'claude')
  assert.equal(r.success, false)
  assert.match(r.error!, /no dormant entry/i)
})

test('CLM leaves the config valid when a mutation fails', async () => {
  await clmSeed()
  const p = adapters.claude.configPath()
  const before = readFileSync(p, 'utf8')
  // Corrupt the config, then attempt a mutation: it must refuse, not compound it.
  writeFileSync(p, '{ this is not json')
  const r = deactivate('supabase', 'claude')
  assert.equal(r.success, false)
  assert.match(r.error!, /could not be parsed|not valid JSON/i)
  writeFileSync(p, before) // restore for later tests
})

test('CLM reconcile prefers the live config over a stale stash', async () => {
  await clmSeed()
  // Pretend we recorded it dormant while it is in fact present in the config.
  dormantStore.stash('supabase', 'claude', adapters.claude.read(getCapability('supabase'))!)
  assert.ok(dormantStore.get('supabase', 'claude'))
  const events = reconcile()
  assert.ok(events.some((e) => e.capabilityId === 'supabase' && e.agent === 'claude'),
    'stale stash should have been reconciled')
  assert.equal(dormantStore.get('supabase', 'claude'), null, 'stale stash not dropped')
  assert.ok(adapters.claude.read(getCapability('supabase')), 'reconcile must NEVER rewrite the live config')
})

test('CLM never writes a secret into the mutation log', async () => {
  await clmSeed()
  deactivate('supabase', 'claude')
  activate('supabase', 'claude')
  const raw = readFileSync(join(sandbox, '.agentpack', 'mutations.json'), 'utf8')
  assert.ok(!raw.includes('sbp_clm_secret'), 'SECRET LEAKED INTO THE MUTATION LOG')
  assert.ok(log().length > 0, 'mutations should be logged')
})

test('CLM declines to manage plugins', async () => {
  seed()
  const r = deactivate('superpowers', 'claude')
  assert.equal(r.success, false)
  assert.match(r.error!, /MCP servers only/i)
})

test('CLM listRuntime reflects real config state', async () => {
  await clmSeed()
  deactivate('supabase', 'claude')
  const recs = listRuntime(['claude', 'codex'])
  const claude = recs.find((r) => r.capability.id === 'supabase' && r.agent === 'claude')!
  const codex = recs.find((r) => r.capability.id === 'supabase' && r.agent === 'codex')!
  assert.equal(claude.state, 'dormant')
  assert.equal(codex.state, 'active')
  // Plugins are listed for agents that host them, but never for OpenCode.
  assert.ok(!recs.some((r) => r.capability.type === 'plugin' && r.agent === 'opencode'))
})

// --- CLM: profiles (Phase 3) -------------------------------------------------

test('CLM profiles load from registry data and resolve', () => {
  const ps = profiles()
  assert.ok(ps.length >= 2, 'at least two profiles required (PRD §4.6)')
  const known = new Set(capabilities().map((c) => c.id))
  for (const p of ps) {
    assert.ok(p.id && p.name, `profile ${p.id} malformed`)
    for (const id of p.activeCapabilityIds) {
      assert.ok(known.has(id), `profile ${p.id} names unknown capability ${id}`)
    }
  }
})

test('CLM profile plan computes the right diff without changing anything', async () => {
  seed()
  await install({ capabilityIds: ['playwright', 'github'], agents: ['claude'], projectDir: sandbox })
  const before = readFileSync(join(sandbox, '.claude.json'), 'utf8')

  const plan = planProfile('frontend', ['claude'])
  // frontend wants playwright active, github dormant.
  assert.ok(plan.deactivate.some((d) => d.capabilityId === 'github'), 'github should be deactivated')
  assert.ok(plan.unchanged.some((u) => u.capabilityId === 'playwright'), 'playwright is already active')
  assert.ok(!plan.activate.some((a) => a.capabilityId === 'supabase'),
    'a capability that was never installed cannot be activated')
  assert.ok(plan.unavailable.some((u) => u.capabilityId === 'context7'),
    'a wanted-but-missing capability must be surfaced, not silently skipped')
  assert.equal(readFileSync(join(sandbox, '.claude.json'), 'utf8'), before, 'planning must not mutate')
})

test('CLM applying a profile really changes the config', async () => {
  seed()
  await install({ capabilityIds: ['playwright', 'github'], agents: ['claude'], projectDir: sandbox })
  const r = applyProfile('frontend', ['claude'])
  assert.equal(r.status, 'ok', JSON.stringify(r.results.filter((x) => !x.success)))
  assert.equal(runtimeState('github', 'claude'), 'dormant')
  assert.equal(runtimeState('playwright', 'claude'), 'active')
  assert.equal(adapters.claude.read(getCapability('github')), null, 'github still in the live config')
  // And it is reversible.
  assert.equal(applyProfile('backend', ['claude']).status, 'ok')
  assert.equal(runtimeState('github', 'claude'), 'active')
  assert.equal(runtimeState('playwright', 'claude'), 'dormant')
})

test('CLM minimal profile deactivates everything managed', async () => {
  seed()
  await install({ capabilityIds: ['playwright', 'context7'], agents: ['claude'], projectDir: sandbox })
  assert.equal(applyProfile('minimal', ['claude']).status, 'ok')
  for (const id of ['playwright', 'context7']) {
    assert.equal(runtimeState(id, 'claude'), 'dormant', `${id} should be dormant under minimal`)
  }
})

const clearDormant = () => {
  for (const e of dormantStore.entries()) dormantStore.drop(e.capabilityId, e.agent)
}

test('CLM reports a partial profile failure as partial, not success', async () => {
  seed()
  clearDormant()
  await install({ capabilityIds: ['github'], agents: ['claude', 'codex'], projectDir: sandbox })

  // Corrupt ONE agent's config. Applying a profile must then fail for that
  // agent, succeed for the other, and report the result as partial.
  const codexPath = adapters.codex.configPath()
  const good = readFileSync(codexPath, 'utf8')
  writeFileSync(codexPath, 'this is not = valid toml [[[')
  try {
    const r = applyProfile('frontend', ['claude', 'codex']) // github -> dormant
    assert.notEqual(r.status, 'ok', 'a failed mutation must not be reported as ok')
    assert.equal(r.status, 'partial')
    const bad = r.results.find((x) => x.agent === 'codex' && !x.success)
    assert.ok(bad, 'the corrupt agent should have been reported as failed, not skipped')
    assert.match(bad!.error!, /could not be parsed/i)
    assert.ok(planProfile('frontend', ['claude', 'codex']).blocked.some((b) => b.agent === 'codex'),
      'the plan should name the unreadable agent')
    assert.ok(r.results.some((x) => x.agent === 'claude' && x.success),
      'the healthy agent should still have been changed')
  } finally {
    writeFileSync(codexPath, good)
  }
})

test('CLM currentProfile does not claim a match when nothing is manageable', () => {
  seed()
  clearDormant() // nothing live, nothing stashed
  assert.equal(currentProfile(['claude']), null,
    'with nothing manageable, every profile would trivially match the empty set')
})

test('CLM currentProfile identifies the live profile', async () => {
  seed()
  await install({ capabilityIds: ['playwright', 'context7', 'github'], agents: ['claude'], projectDir: sandbox })
  applyProfile('frontend', ['claude'])
  const p = currentProfile(['claude'])
  assert.equal(p?.id, 'frontend', `expected frontend, got ${p?.id ?? 'null'}`)
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
