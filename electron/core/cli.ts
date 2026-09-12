// Headless driver for the engine. The UI is just another caller of this.
//
//   node electron/core/cli.ts detect
//   node electron/core/cli.ts list
//   node electron/core/cli.ts install playwright filesystem
//   node electron/core/cli.ts install --pack fullstack
//   node electron/core/cli.ts rollback
import { detectAgents, adapters } from './agents/index.ts'
import { capabilities, packs, getPack } from './capabilities/registry.ts'
import { install, rollback } from './installer/install.ts'
import type { AgentKey, ProgressEvent } from './types.ts'

const green = (s: string) => `\x1b[32m${s}\x1b[0m`
const red = (s: string) => `\x1b[31m${s}\x1b[0m`
const dim = (s: string) => `\x1b[2m${s}\x1b[0m`
const ok = (s: string) => `${green('✓')} ${s}`
const bad = (s: string) => `${red('✗')} ${s}`

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

  // Secrets come from the environment here; the UI will prompt for them.
  const secrets: Record<string, string> = {}
  for (const c of capabilities()) {
    for (const s of c.secrets ?? []) if (process.env[s.key]) secrets[s.key] = process.env[s.key]!
  }

  const onProgress = (e: ProgressEvent) => {
    if (e.kind === 'stage') console.log(dim(`[${e.stage}]${e.detail ? ` ${e.detail}` : ''}`))
    else if (e.kind === 'agent') {
      const label = `${adapters[e.agent].name.padEnd(13)} ${e.detail ?? ''}`
      console.log(e.status === 'failed' ? bad(label) : ok(`${label} ${dim(e.status)}`))
    }
  }

  console.log(`Installing ${ids.join(', ')} into ${agents.length} agents\n`)
  const report = await install({ capabilityIds: ids, agents, projectDir: process.cwd(), secrets, onProgress })

  console.log('\nHealth report')
  let allOk = true
  for (const c of report.capabilities) {
    const h = c.health
    const needsCreds = Boolean(c.capability.secrets?.length)
    if (h.reachable) {
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
      console.log(r.status === 'failed' ? red(line) : line)
      if (r.status === 'failed') allOk = false
    }
  }
  console.log(`\nrollback with: node electron/core/cli.ts rollback ${report.ledgerId}`)
  process.exit(allOk ? 0 : 1)
} else if (cmd === 'rollback') {
  const result = rollback(rest[0])
  if (!result) {
    console.log('nothing to roll back')
    process.exit(1)
  }
  console.log(ok(`rolled back ${result.entryId}`))
  for (const p of result.restored) console.log(`  restored ${p}`)
} else {
  console.error(`unknown command: ${cmd}`)
  process.exit(2)
}
