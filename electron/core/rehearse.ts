// Demo rehearsal harness. Runs the full golden path N times against COPIES of
// the real agent configs and asserts the machine ends up exactly where it
// started every single time (CLAUDE.md §24: repeatable without manual repair).
//
//   node electron/core/rehearse.ts [runs]
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const RUNS = Number(process.argv[2] ?? 3)
const real = homedir()

// Mirror the real configs into a sandbox so rehearsal never touches them.
const sandbox = mkdtempSync(join(tmpdir(), 'agentpack-rehearse-'))
process.env.AGENTPACK_HOME = sandbox

const SOURCES: Array<[string, string]> = [
  [join(real, '.claude.json'), join(sandbox, '.claude.json')],
  [join(real, '.codex', 'config.toml'), join(sandbox, '.codex', 'config.toml')],
  [join(real, '.config', 'opencode', 'opencode.jsonc'), join(sandbox, '.config', 'opencode', 'opencode.jsonc')],
]

mkdirSync(join(sandbox, '.codex'), { recursive: true })
mkdirSync(join(sandbox, '.config', 'opencode'), { recursive: true })
const tracked: string[] = []
for (const [from, to] of SOURCES) {
  if (!existsSync(from)) continue
  cpSync(from, to)
  tracked.push(to)
}

const { detectAgents, adapters } = await import('./agents/index.ts')
const { getCapability } = await import('./capabilities/registry.ts')
const { scanProject } = await import('./detection/project.ts')
const { recommend } = await import('./recommendations/rules.ts')
const { install, rollbackAll } = await import('./installer/install.ts')
const { buildManifest, readManifest, exportManifest } = await import('./capabilities/manifest.ts')

const hash = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 16)
const fingerprint = () => Object.fromEntries(tracked.map((p) => [p, hash(p)]))
const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`

const baseline = fingerprint()
const agents = detectAgents().filter((a) => a.detected).map((a) => a.key)
console.log(`Rehearsing ${RUNS} runs against ${agents.length} agents ${dim(`(sandbox: ${sandbox})`)}\n`)

let failures = 0
const timings: number[] = []

for (let i = 1; i <= RUNS; i++) {
  const t0 = Date.now()
  const problems: string[] = []

  // 1. scan + recommend, exactly as the UI does
  const scan = scanProject(process.cwd())
  const recs = recommend(scan)
  // Only capabilities that need no user input — a rehearsal must be unattended.
  const candidates = recs.map((r) => r.capability).filter((c) => !(c.inputs?.length || c.secrets?.length))
  if (!candidates.length) problems.push('no credential-free capabilities were recommended')

  // A rehearsal must start from a clean baseline, or the idempotency guard
  // correctly skips every write and proves nothing.
  const dirty = candidates.filter((c) => agents.every((k) => adapters[k].has(c)))
  if (dirty.length === candidates.length && candidates.length) {
    problems.push(
      `baseline is not clean — ${dirty.map((c) => c.id).join(', ')} already configured in every agent. ` +
      'Roll your real configs back first: node electron/core/cli.ts rollback --all',
    )
  }
  const ids = candidates.map((c) => c.id)

  // 2. install
  const report = await install({ capabilityIds: ids, agents, projectDir: process.cwd() })
  for (const c of report.capabilities) {
    if (!c.health.reachable) problems.push(`${c.capability.id} health failed: ${c.health.error}`)
    for (const r of c.results) {
      if (r.status === 'failed') problems.push(`${c.capability.id}/${r.agent}: ${r.error}`)
    }
  }

  // 3. something must actually have been written this run, not just skipped
  const installed = report.capabilities.flatMap((c) => c.results).filter((r) => r.status === 'installed')
  if (!installed.length && !problems.length) problems.push('nothing was installed — every write was skipped')
  const during = fingerprint()
  const changed = tracked.filter((p) => during[p] !== baseline[p])
  if (!changed.length && !problems.length) problems.push('no config changed on disk despite reporting installs')

  // 4. export a manifest and read it back
  const manifestPath = join(sandbox, `run-${i}.json`)
  exportManifest(manifestPath, buildManifest({ name: `rehearsal-${i}` }))
  const round = readManifest(manifestPath)
  if (!round.capabilities.length) problems.push('exported manifest lists nothing')

  // 5. roll everything back and compare against the baseline
  rollbackAll()
  const after = fingerprint()
  for (const p of tracked) {
    if (after[p] !== baseline[p]) problems.push(`${p} not restored byte-identical`)
  }

  const ms = Date.now() - t0
  timings.push(ms)
  if (problems.length) {
    failures++
    console.log(red(`✗ run ${i}  ${ms}ms`))
    for (const p of problems) console.log(`    ${p}`)
  } else {
    console.log(green(`✓ run ${i}  ${ms}ms`) + dim(`  ${ids.length} capabilities · ${changed.length} configs touched · restored clean`))
  }
}

const avg = Math.round(timings.reduce((a, b) => a + b, 0) / timings.length)
console.log(`\n${failures ? red(`${failures}/${RUNS} runs failed`) : green(`${RUNS}/${RUNS} runs clean`)} ${dim(`· avg ${avg}ms`)}`)
if (!failures) rmSync(sandbox, { recursive: true, force: true })
else console.log(dim(`sandbox kept for inspection: ${sandbox}`))
process.exit(failures ? 1 : 0)
