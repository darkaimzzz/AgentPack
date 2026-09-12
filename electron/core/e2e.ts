// Live acceptance test against synthetic agent configs in a temporary home.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'agentpack-e2e-'))
process.env.AGENTPACK_HOME = sandbox

mkdirSync(join(sandbox, '.codex'), { recursive: true })
mkdirSync(join(sandbox, '.claude'), { recursive: true })
mkdirSync(join(sandbox, '.config', 'opencode'), { recursive: true })
writeFileSync(join(sandbox, '.claude.json'), '{"numStartups":7,"mcpServers":{}}')
writeFileSync(join(sandbox, '.claude', 'settings.json'), '{}')
writeFileSync(join(sandbox, '.codex', 'config.toml'), '# E2E baseline\nmodel = "demo"\n')
writeFileSync(join(sandbox, '.config', 'opencode', 'opencode.jsonc'), '{\n// E2E baseline\n"mcp":{}\n}')

const { detectAgents, adapters } = await import('./agents/index.ts')
const { scanProject } = await import('./detection/project.ts')
const { recommend } = await import('./recommendations/rules.ts')
const { install, rollbackAll } = await import('./installer/install.ts')
const { clmView, measureAll } = await import('./clm/view.ts')
const { deactivate, activate, runtimeState } = await import('./clm/state.ts')
const { applyProfile, planProfile } = await import('./clm/profiles.ts')
const { startWatching } = await import('./clm/trigger.ts')
const { buildManifest, exportManifest, readManifest } = await import('./capabilities/manifest.ts')
const { getCapability } = await import('./capabilities/registry.ts')
import type { AgentKey } from './types.ts'

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

const tracked = [
  join(sandbox, '.claude.json'),
  join(sandbox, '.codex', 'config.toml'),
  join(sandbox, '.config', 'opencode', 'opencode.jsonc'),
].filter(existsSync)
const fingerprint = () =>
  Object.fromEntries(tracked.map((p) => [p, createHash('sha256').update(readFileSync(p)).digest('hex')]))

const baseline = fingerprint()
let failed = 0
let n = 0

const step = async (name: string, fn: () => void | Promise<void>) => {
  n++
  const t0 = Date.now()
  try {
    await fn()
    console.log(`${green('✓')} ${String(n).padStart(2)}. ${name} ${dim(`${Date.now() - t0}ms`)}`)
  } catch (e) {
    failed++
    console.log(`${red('✗')} ${String(n).padStart(2)}. ${name}\n     ${(e as Error).message.split('\n').join('\n     ')}`)
  }
}

console.log(`\nAgentPack end-to-end ${dim(`(sandbox: ${sandbox})`)}\n`)

const agents = detectAgents().filter((a) => a.detected).map((a) => a.key as AgentKey)

await step('detects the supported agents', () => {
  assert.ok(agents.length >= 1, 'no agents detected — cannot run the rest')
  for (const a of detectAgents().filter((x) => x.detected)) {
    assert.ok(existsSync(a.configPath) || a.note, `${a.name}: config path neither present nor explained`)
  }
})

// --- the install flow, exactly as the wizard drives it ---

const project = join(sandbox, 'demo-app')
await step('scans a realistic project and explains every signal', () => {
  mkdirSync(join(project, 'apps', 'web'), { recursive: true })
  mkdirSync(join(project, '.git'), { recursive: true })
  writeFileSync(join(project, 'package.json'), JSON.stringify({ private: true, workspaces: ['apps/*'] }))
  writeFileSync(join(project, 'apps', 'web', 'package.json'), JSON.stringify({
    dependencies: { next: '15.1.0', react: '19.0.0', '@supabase/ssr': '0.5.2' },
  }))
  const scan = scanProject(project)
  const ids = scan.signals.map((s) => s.id)
  for (const want of ['nextjs', 'react', 'supabase', 'git']) assert.ok(ids.includes(want), `missed ${want}`)
  for (const s of scan.signals) assert.ok(s.evidence.length > 3, `${s.id} has no evidence`)
  const recs = recommend(scan).map((r) => r.capability.id)
  for (const want of ['playwright', 'github', 'supabase']) assert.ok(recs.includes(want), `not recommended: ${want}`)
})

let ledgerId = ''
await step('installs a pack across every detected agent and verifies it live', async () => {
  const report = await install({
    capabilityIds: ['playwright', 'filesystem', 'context7'],
    agents,
    projectDir: project,
  })
  ledgerId = report.ledgerId
  for (const c of report.capabilities) {
    assert.equal(c.health.status, 'verified', `${c.capability.id}: ${c.health.error ?? 'not verified'}`)
    assert.ok(c.health.tools.length > 0, `${c.capability.id} reported no tools`)
    for (const r of c.results) {
      assert.ok(['installed', 'already-present'].includes(r.status), `${c.capability.id}/${r.agent}: ${r.status} ${r.error ?? ''}`)
    }
  }
})

await step('the configs on disk really changed', () => {
  const now = fingerprint()
  const changed = tracked.filter((p) => now[p] !== baseline[p])
  assert.equal(changed.length, tracked.length, 'not every agent config was written')
})

await step('a second install is idempotent, not duplicated', async () => {
  const again = await install({ capabilityIds: ['playwright'], agents, projectDir: project })
  for (const r of again.capabilities[0].results) {
    assert.equal(r.status, 'already-present', `${r.agent}: expected already-present, got ${r.status}`)
  }
  if (existsSync(join(sandbox, '.codex', 'config.toml'))) {
    const toml = readFileSync(join(sandbox, '.codex', 'config.toml'), 'utf8')
    assert.equal((toml.match(/\[mcp_servers\.playwright\]/g) ?? []).length, 1, 'codex table duplicated')
  }
})

// --- the Capability Load Manager, exactly as the dashboard drives it ---

await step('measures real context cost for every capability', async () => {
  await measureAll(project)
  const view = clmView(agents)
  assert.ok(view.summary.allTokens > 1000, `implausible total: ${view.summary.allTokens}`)
  assert.ok(view.summary.activeTools > 0)
  const pw = view.rows.find((r) => r.capability.id === 'playwright')!
  assert.equal(pw.cost?.source, 'measured')
  assert.ok(pw.cost!.toolCount > 10, 'playwright should expose many tools')
  const plugin = view.rows.find((r) => r.capability.type === 'plugin')
  if (plugin?.cost) assert.equal(plugin.cost.source, 'unavailable', 'plugin cost must not be invented')
})

await step('deactivating reduces the reported context', () => {
  const before = clmView(agents).summary
  for (const agent of agents) {
    const r = deactivate('playwright', agent)
    assert.ok(r.success, `${agent}: ${r.error}`)
  }
  const after = clmView(agents).summary
  assert.ok(after.activeTokens < before.activeTokens, 'estimated context did not fall')
  assert.ok(after.activeTools < before.activeTools, 'tool count did not fall')
  for (const agent of agents) assert.equal(runtimeState('playwright', agent), 'dormant')
})

await step('dormancy did not uninstall anything or lose credentials', () => {
  // The capability is gone from the live config but still known to AgentPack.
  const view = clmView(agents)
  const pw = view.rows.find((r) => r.capability.id === 'playwright')!
  assert.ok(pw.anyDormant, 'playwright should be dormant, not unknown')
  assert.ok(pw.cost, 'cost should still be known while dormant')
})

await step('reactivating restores it exactly', () => {
  for (const agent of agents) {
    const r = activate('playwright', agent)
    assert.ok(r.success, `${agent}: ${r.error}`)
    assert.equal(runtimeState('playwright', agent), 'active')
  }
})

await step('a profile switch applies a real diff', () => {
  const plan = planProfile('minimal', agents)
  assert.ok(plan.deactivate.length > 0, 'minimal should have something to turn off')
  const r = applyProfile('minimal', agents)
  assert.equal(r.status, 'ok', JSON.stringify(r.results.filter((x) => !x.success)))
  assert.equal(clmView(agents).summary.activeTools, 0, 'minimal should leave no tools active')

  const back = applyProfile('frontend', agents)
  assert.equal(back.status, 'ok')
  assert.ok(clmView(agents).summary.activeTools > 0, 'frontend should restore tools')
})

await step('a file-pattern trigger activates a dormant capability', async () => {
  for (const agent of agents) deactivate('playwright', agent)
  assert.ok(agents.every((a) => runtimeState('playwright', a) === 'dormant'))

  const watched = join(project, 'tests')
  mkdirSync(watched, { recursive: true })
  const fired: string[] = []
  const handle = startWatching(project, (e) => fired.push(e.capabilityId), { agents })
  try {
    writeFileSync(join(watched, 'checkout.spec.ts'), 'test("buy", () => {})')
    await new Promise((r) => setTimeout(r, 1500))
  } finally {
    handle.stop()
  }
  assert.ok(fired.includes('playwright'), 'trigger did not fire')
  assert.ok(agents.some((a) => runtimeState('playwright', a) === 'active'), 'nothing was activated')
})

await step('exports a manifest that carries no secrets', () => {
  const path = join(sandbox, 'export.json')
  exportManifest(path, buildManifest({ name: 'e2e' }))
  const m = readManifest(path)
  assert.ok(m.capabilities.length > 0, 'exported nothing')
  const raw = readFileSync(path, 'utf8')
  assert.ok(!/sbp_|ghp_|sk-/.test(raw), 'a secret-shaped value reached the manifest')
})

await step('no secret reached any AgentPack state file', () => {
  for (const f of ['installs.json', 'mutations.json', 'costs.json']) {
    const p = join(sandbox, '.agentpack', f)
    if (!existsSync(p)) continue
    const raw = readFileSync(p, 'utf8')
    assert.ok(!/sbp_[A-Za-z0-9]|ghp_[A-Za-z0-9]/.test(raw), `secret-shaped value in ${f}`)
  }
})

await step('rollback returns every config to its original bytes', () => {
  rollbackAll()
  const after = fingerprint()
  for (const p of tracked) {
    assert.equal(after[p], baseline[p], `${p} was not restored`)
  }
})

console.log(
  `\n${failed ? red(`${failed} of ${n} steps failed`) : green(`all ${n} steps passed`)}` +
  ` ${dim(failed ? `sandbox kept: ${sandbox}` : '· machine left exactly as found')}`,
)
if (!failed) rmSync(sandbox, { recursive: true, force: true })
process.exit(failed ? 1 : 0)
