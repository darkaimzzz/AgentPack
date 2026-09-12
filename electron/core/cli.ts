// Headless driver for the engine. The UI is just another caller of this.
//
//   node electron/core/cli.ts detect
//   node electron/core/cli.ts list
//   node electron/core/cli.ts scan [dir]
//   node electron/core/cli.ts install playwright filesystem
//   node electron/core/cli.ts install --pack fullstack
//   node electron/core/cli.ts rollback [id | --all]
//   node electron/core/cli.ts prewarm            # warm the npx cache before a demo
//   node electron/core/cli.ts status             # what is configured right now
//   node electron/core/cli.ts export [path]      # reusable manifest (no secrets)
//   node electron/core/cli.ts import <path>
//   node electron/core/cli.ts clm                       # runtime states + context cost
//   node electron/core/cli.ts clm measure [--force]     # probe + cache costs
//   node electron/core/cli.ts clm on|off <capability> [agent]
//   node electron/core/cli.ts clm log
//   node electron/core/cli.ts clm profiles
//   node electron/core/cli.ts clm use <profile> [--dry]
import { detectAgents, adapters } from './agents/index.ts'
import { capabilities, packs, getPack } from './capabilities/registry.ts'
import { scanProject } from './detection/project.ts'
import { recommend, alsoAvailable } from './recommendations/rules.ts'
import { install, rollback, rollbackAll } from './installer/install.ts'
import { prewarm } from './installer/prewarm.ts'
import {
  buildManifest, exportManifest, readManifest, installedCapabilities, manifestMissingSecrets,
} from './capabilities/manifest.ts'
import { listRuntime, setState, reconcile, log as mutationLog } from './clm/state.ts'
import { measureCost, cachedCost, totalCost } from './clm/cost.ts'
import { profiles, planProfile, applyProfile, currentProfile } from './clm/profiles.ts'
import type { AgentKey, ProgressEvent } from './types.ts'

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const ok = (s: string) => `${green('✓')} ${s}`
const bad = (s: string) => `${red('✗')} ${s}`
const bad_ = bad

const [, , cmd = 'detect', ...rest] = process.argv

if (process.env.AGENTPACK_HOME) console.log(dim(`sandbox: ${process.env.AGENTPACK_HOME}\n`))

if (cmd === 'detect') {
  for (const a of detectAgents()) {
    console.log(a.detected ? ok(`${a.name.padEnd(13)} ${dim(a.configPath)}`) : bad(`${a.name.padEnd(13)} not found`))
    if (a.note) console.log(`  ${dim(a.note)}`)
  }
} else if (cmd === 'list') {
  console.log('Capabilities')
  for (const c of capabilities()) {
    const secrets = c.secrets?.length ? ` ${dim(`needs ${c.secrets.map((s) => s.key).join(', ')}`)}` : ''
    console.log(`  ${c.id.padEnd(20)} ${c.type.padEnd(7)} ${c.description}${secrets}`)
  }
  console.log('\nPacks')
  for (const p of packs()) console.log(`  ${p.id.padEnd(20)} ${p.capabilities.join(', ')}`)
} else if (cmd === 'scan') {
  const dir = rest[0] ?? process.cwd()
  const scan = scanProject(dir)
  console.log(`Detected Project ${dim(scan.dir)}\n`)
  if (!scan.isProject) console.log(dim('  no recognised project signals'))
  for (const s of scan.signals) console.log(`  ${s.label.padEnd(28)} ${dim(s.evidence)}`)

  const recs = recommend(scan)
  console.log('\nRecommended')
  if (!recs.length) console.log(dim('  nothing — no rule matched'))
  for (const r of recs) {
    const needs = [
      ...(r.capability.inputs ?? []).map((i) => i.key),
      ...(r.capability.secrets ?? []).map((s) => s.key),
    ]
    console.log(`  ${green('✓')} ${r.capability.name.padEnd(20)} ${r.reason}`)
    if (needs.length) console.log(`    ${dim(`requires ${needs.join(', ')}`)}`)
  }

  const extra = alsoAvailable(recs)
  if (extra.length) console.log(`\nAlso available ${dim(extra.map((c) => c.id).join(', '))}`)
} else if (cmd === 'install') {
  const packIdx = rest.indexOf('--pack')
  const ids = packIdx >= 0 ? getPack(rest[packIdx + 1]).capabilities : rest.filter((r) => !r.startsWith('--'))
  if (!ids.length) {
    console.error('usage: cli.ts install <capability...> | --pack <id>')
    process.exit(2)
  }
  const agents = detectAgents().filter((a) => a.detected).map((a) => a.key as AgentKey)
  if (!agents.length) {
    console.error('no supported agents detected')
    process.exit(1)
  }

  // Secrets and inputs come from the environment here; the UI will prompt.
  const secrets: Record<string, string> = {}
  const inputs: Record<string, string> = {}
  for (const c of capabilities()) {
    for (const s of c.secrets ?? []) if (process.env[s.key]) secrets[s.key] = process.env[s.key]!
    for (const i of c.inputs ?? []) if (process.env[i.key]) inputs[i.key] = process.env[i.key]!
  }

  const onProgress = (e: ProgressEvent) => {
    if (e.kind === 'stage') console.log(dim(`[${e.stage}]${e.detail ? ` ${e.detail}` : ''}`))
    else if (e.kind === 'agent') {
      const label = `${adapters[e.agent].name.padEnd(13)} ${e.detail ?? ''}`
      console.log(e.status === 'failed' ? bad(label) : ok(`${label} ${dim(e.status)}`))
    }
  }

  console.log(`Installing ${ids.join(', ')} into ${agents.length} agents\n`)
  const report = await install({ capabilityIds: ids, agents, projectDir: process.cwd(), secrets, inputs, onProgress })

  console.log('\nHealth report')
  let allOk = true
  for (const c of report.capabilities) {
    const h = c.health
    const needsCreds = Boolean(c.capability.secrets?.length)
    if (h.status === 'configured') {
      console.log(ok(`${c.capability.name.padEnd(20)} ${dim('configured — plugin loads inside the agent, not verifiable from here')}`))
    } else if (h.reachable) {
      console.log(ok(`${c.capability.name.padEnd(20)} ${h.tools.length} tools ${dim(`${h.server?.name ?? ''} ${h.server?.version ?? ''} · ${h.durationMs}ms`)}`))
      // Honest about the limit of this check: tools/list answers before most
      // servers ever verify a credential.
      if (needsCreds) console.log(`  ${dim('server reachable; credential not verified by tools/list')}`)
    } else {
      allOk = false
      console.log(bad(`${c.capability.name.padEnd(20)} ${h.error}`))
    }
    for (const r of c.results) {
      const line = `  ${adapters[r.agent].name.padEnd(13)} ${r.status}${r.error ? ` — ${r.error}` : ''}`
      console.log(r.status === 'failed' ? red(line) : r.status === 'unsupported' ? dim(line) : line)
      if (r.status === 'failed' || r.status === 'conflict') allOk = false
    }
  }
  console.log(`\nrollback with: node electron/core/cli.ts rollback ${report.ledgerId}`)
  process.exit(allOk ? 0 : 1)
} else if (cmd === 'rollback') {
  if (rest[0] === '--all') {
    const r = rollbackAll()
    if (!r.entries.length) {
      console.log('nothing to roll back')
      process.exit(1)
    }
    console.log(ok(`rolled back ${r.entries.length} run(s)`))
    for (const p of r.restored) console.log(`  restored  ${p}`)
    for (const p of r.removed) console.log(`  removed   ${p} ${dim('(created by agentpack)')}`)
    for (const p of r.merged) console.log(`  unpicked  ${p} ${dim('(edited since install; removed only our entries)')}`)
  } else {
    const result = rollback(rest[0])
    if (!result) {
      console.log('nothing to roll back')
      process.exit(1)
    }
    console.log(ok(`rolled back ${result.entryId}`))
    for (const p of result.restored) console.log(`  restored  ${p}`)
    for (const p of result.removed) console.log(`  removed   ${p} ${dim('(created by agentpack)')}`)
    for (const p of result.merged) console.log(`  unpicked  ${p} ${dim('(edited since install; removed only our entries)')}`)
  }
} else if (cmd === 'prewarm') {
  console.log('Warming the npx cache so the demo does not fetch from the network.\n')
  const results = await prewarm(rest.filter((r) => !r.startsWith('--')), (r) => {
    const line = `${r.capability.name.padEnd(22)} ${r.durationMs}ms`
    console.log(r.ok ? ok(`${line} ${dim(`${r.tools} tools`)}`) : bad(`${line} ${r.error}`))
  })
  const failed = results.filter((r) => !r.ok)
  console.log(`\n${failed.length ? bad(`${failed.length} failed`) : ok('all cached')}`)
  process.exit(failed.length ? 1 : 0)
} else if (cmd === 'status') {
  const live = installedCapabilities()
  if (!live.length) console.log(dim('no registry capabilities are configured in any detected agent'))
  for (const { capability, agents } of live) {
    console.log(ok(`${capability.name.padEnd(22)} ${dim(agents.join(', '))}`))
  }
} else if (cmd === 'export') {
  const path = rest[0] ?? 'agentpack.json'
  const manifest = buildManifest({ name: rest[1] })
  exportManifest(path, manifest)
  console.log(ok(`exported ${manifest.capabilities.length} capabilities to ${path}`))
  if (manifest.requiredSecrets?.length) {
    console.log(dim(`  recipient must supply: ${manifest.requiredSecrets.join(', ')}`))
  }
} else if (cmd === 'import') {
  const path = rest[0]
  if (!path) {
    console.error('usage: cli.ts import <manifest.json>')
    process.exit(2)
  }
  const manifest = readManifest(path)
  const secrets: Record<string, string> = {}
  const inputs: Record<string, string> = { ...manifest.inputs }
  for (const c of capabilities()) {
    for (const s of c.secrets ?? []) if (process.env[s.key]) secrets[s.key] = process.env[s.key]!
    for (const i of c.inputs ?? []) if (process.env[i.key]) inputs[i.key] = process.env[i.key]!
  }
  const missing = manifestMissingSecrets(manifest, secrets)
  if (missing.length) {
    console.error(bad(`manifest needs these in the environment: ${missing.join(', ')}`))
    process.exit(1)
  }
  const agents = detectAgents().filter((a) => a.detected).map((a) => a.key as AgentKey)
  console.log(`Importing "${manifest.name}" — ${manifest.capabilities.join(', ')}\n`)
  const report = await install({
    capabilityIds: manifest.capabilities,
    agents,
    projectDir: process.cwd(),
    secrets,
    inputs,
  })
  let importOk = true
  for (const c of report.capabilities) {
    console.log(c.health.reachable
      ? ok(`${c.capability.name.padEnd(22)} ${c.health.tools.length} tools`)
      : bad(`${c.capability.name.padEnd(22)} ${c.health.error}`))
    if (!c.health.reachable) importOk = false
    for (const r of c.results.filter((x) => x.status === 'failed' || x.status === 'conflict')) {
      console.log(red(`    ${adapters[r.agent].name.padEnd(13)} ${r.status} — ${r.error}`))
      importOk = false
    }
  }
  process.exit(importOk ? 0 : 1)
} else if (cmd === 'clm') {
  const sub = rest[0] ?? 'list'

  if (sub === 'measure') {
    const force = rest.includes('--force')
    console.log('Measuring context cost (probes each server once, then caches)\n')
    for (const c of capabilities()) {
      const cost = await measureCost(c, { projectDir: process.cwd(), force })
      console.log(cost.source === 'measured'
        ? ok(`${c.name.padEnd(22)} ${String(cost.toolCount).padStart(2)} tools  ~${cost.estimatedTokens.toLocaleString()} tokens ${dim(`(${cost.serializedChars.toLocaleString()} chars)`)}`)
        : `  ${c.name.padEnd(22)} ${dim(cost.note ?? 'not measurable')}`)
    }
  } else if (sub === 'on' || sub === 'off') {
    const capId = rest[1]
    if (!capId) {
      console.error('usage: cli.ts clm on|off <capability> [agent]')
      process.exit(2)
    }
    const agentArg = rest[2] as AgentKey | undefined
    const targets = agentArg
      ? [agentArg]
      : detectAgents().filter((a) => a.detected).map((a) => a.key as AgentKey)
    let bad = 0
    for (const agent of targets) {
      const r = setState(capId, agent, sub === 'on' ? 'active' : 'dormant')
      const label = `${adapters[agent].name.padEnd(13)} ${r.from} → ${r.to}`
      if (r.success) console.log(ok(`${label}${r.noop ? dim(' (already)') : ''}`))
      else { bad++; console.log(bad_(`${label} — ${r.error}`)) }
    }
    process.exit(bad ? 1 : 0)
  } else if (sub === 'profiles') {
    const active = currentProfile()
    for (const p of profiles()) {
      const mark = active?.id === p.id ? green('●') : ' '
      console.log(`${mark} ${p.id.padEnd(12)} ${p.activeCapabilityIds.join(', ') || dim('(nothing active)')}`)
      if (p.description) console.log(`  ${dim(p.description)}`)
    }
    if (!active) console.log(dim('\ncurrent state matches no profile'))
  } else if (sub === 'use') {
    const id = rest[1]
    if (!id) { console.error('usage: cli.ts clm use <profile> [--dry]'); process.exit(2) }
    const plan = planProfile(id)
    console.log(`Profile: ${plan.profile.name}\n`)
    for (const a of plan.activate) console.log(green(`  + ${a.capabilityId} ${dim('→ ' + a.agent)}`))
    for (const d of plan.deactivate) console.log(`  - ${d.capabilityId} ${dim('→ ' + d.agent)}`)
    for (const u of plan.unavailable) console.log(dim(`  ! ${u.capabilityId} → ${u.agent} (not installed — cannot activate)`))
    for (const b of plan.blocked) console.log(bad_(`${b.agent}: config unreadable — ${b.error}`))
    if (!plan.activate.length && !plan.deactivate.length) console.log(dim('  nothing to change'))
    if (rest.includes('--dry')) process.exit(0)

    const r = applyProfile(id)
    console.log()
    for (const m of r.results.filter((x) => !x.success)) {
      console.log(bad_(`${m.capabilityId} / ${m.agent}: ${m.error}`))
    }
    console.log(r.status === 'ok' ? ok(`applied ${r.results.length} change(s)`)
      : r.status === 'partial' ? `${red('partial')} — some changes failed; see above`
      : bad_('no changes applied'))
    process.exit(r.status === 'ok' ? 0 : 1)
  } else if (sub === 'log') {
    for (const e of mutationLog().slice(-25)) {
      console.log(`${dim(e.at.slice(11, 19))}  ${e.capabilityId.padEnd(20)} ${e.agent.padEnd(9)} ${e.from} → ${e.to} ${e.success ? green('ok') : red('failed: ' + e.error)}`)
    }
  } else {
    const events = reconcile()
    for (const e of events) console.log(dim(`reconciled ${e.capabilityId}/${e.agent}: ${e.action}`))

    const records = listRuntime()
    const byCap = new Map<string, typeof records>()
    for (const r of records) byCap.set(r.capability.id, [...(byCap.get(r.capability.id) ?? []), r])

    const activeCosts = []
    const allCosts = []
    console.log('Capability Load Manager\n')
    for (const [id, recs] of byCap) {
      const cap = recs[0].capability
      const cost = cachedCost(cap)
      const active = recs.filter((r) => r.state === 'active').map((r) => r.agent)
      const dorm = recs.filter((r) => r.state === 'dormant').map((r) => r.agent)
      if (cost) {
        allCosts.push(cost)
        if (active.length) activeCosts.push(cost)
      }
      const costLabel = !cost ? dim('cost unknown — run: clm measure')
        : cost.source === 'measured' ? `${cost.toolCount} tools · ~${cost.estimatedTokens.toLocaleString()} tokens`
        : dim('not measurable')
      const state = active.length ? green('ACTIVE ') : dorm.length ? '[2mDORMANT[0m' : dim('—      ')
      console.log(`  ${state} ${cap.name.padEnd(22)} ${costLabel}`)
      if (active.length) console.log(`          ${dim('active in: ' + active.join(', '))}`)
      if (dorm.length) console.log(`          ${dim('dormant in: ' + dorm.join(', '))}`)
    }

    const all = totalCost(allCosts)
    const now = totalCost(activeCosts)
    if (all.estimatedTokens) {
      const pct = Math.round((1 - now.estimatedTokens / all.estimatedTokens) * 100)
      console.log(`\nActive tools        ${now.toolCount} / ${all.toolCount}`)
      console.log(`Estimated context   ~${now.estimatedTokens.toLocaleString()} / ~${all.estimatedTokens.toLocaleString()} tokens`)
      console.log(`Estimated reduction ${pct}%  ${dim('(estimate: serialized schema chars / 4, not billed tokens)')}`)
    }
  }
} else {
  console.error(`unknown command: ${cmd}`)
  process.exit(2)
}
