// Phase 0 viability spike: install one MCP into all three agents, prove it runs,
// then put everything back exactly as it was.
//
//   node spike/poc.mjs          install -> probe -> restore  (safe, default)
//   node spike/poc.mjs --keep   leave the configs modified
import { readFileSync } from 'node:fs'
import { adapters, backup, restore } from './adapters.mjs'
import { probe } from './mcp-probe.mjs'

const CAP = {
  id: 'playwright',
  command: 'npx',
  args: ['-y', '@playwright/mcp@latest', '--headless'],
  env: {},
}

const keep = process.argv.includes('--keep')
const stamp = new Date().toISOString().replace(/[:.]/g, '-')
const ok = (s) => `\x1b[32m✓\x1b[0m ${s}`
const bad = (s) => `\x1b[31m✗\x1b[0m ${s}`

console.log(`\nAgentPack spike — capability "${CAP.id}" (${CAP.command} ${CAP.args.join(' ')})\n`)

// 1. detect
const targets = Object.entries(adapters).filter(([, a]) => a.detect())
for (const [key, a] of Object.entries(adapters)) {
  console.log(a.detect() ? ok(`${a.name.padEnd(12)} detected  ${a.configPath}`) : bad(`${a.name.padEnd(12)} not found`))
}
if (!targets.length) { console.log('\nNo agents detected. Nothing to do.'); process.exit(1) }

// 2. back up
console.log(`\nBacking up to ~/.agentpack/backups/${stamp}/`)
const backups = targets.map(([key]) => backup(key, stamp))
for (const b of backups) console.log(ok(`${adapters[b.key].name.padEnd(12)} ${b.existed ? 'backed up' : 'no existing config'}`))

// 3. write config
console.log('\nWriting agent-specific config')
const before = new Map(backups.map((b) => [b.key, b.existed ? readFileSync(b.configPath, 'utf8') : null]))
for (const [key, a] of targets) {
  if (a.has(CAP)) { console.log(ok(`${a.name.padEnd(12)} already present (skipped)`)); continue }
  a.install(CAP)
  console.log(ok(`${a.name.padEnd(12)} wrote ${a.configPath.split(/[\\/]/).pop()}`))
}

// 4. read it back through each adapter, then prove the server actually runs
console.log('\nValidating')
for (const [key, a] of targets) {
  console.log(a.has(CAP) ? ok(`${a.name.padEnd(12)} config entry present`) : bad(`${a.name.padEnd(12)} config entry MISSING`))
}

process.stdout.write('\n  starting MCP server (first npx run downloads it, may take a minute)... ')
const t0 = Date.now()
const result = await probe(CAP)
console.log(`${Date.now() - t0}ms`)
if (result.ok) {
  console.log(ok(`handshake  ${result.server.name} ${result.server.version}`))
  console.log(ok(`tools/list returned ${result.tools.length} tools`))
  console.log(`\n  ${result.tools.join(', ')}`)
} else {
  console.log(bad(`handshake failed: ${result.error}`))
}

// 5. restore
if (keep) {
  console.log('\n--keep: leaving configs modified.')
} else {
  console.log('\nRolling back')
  for (const b of backups) {
    restore(b)
    const now = b.existed ? readFileSync(b.configPath, 'utf8') : null
    const clean = now === before.get(b.key)
    console.log(clean ? ok(`${adapters[b.key].name.padEnd(12)} restored byte-identical`) : bad(`${adapters[b.key].name.padEnd(12)} DIFFERS after restore`))
  }
}

const agentsOk = targets.length
console.log(`\n${result.ok && agentsOk >= 2 ? ok('VIABLE') : bad('NOT VIABLE')} — ${agentsOk} agents configured, health check ${result.ok ? 'passed' : 'failed'}\n`)
process.exit(result.ok && agentsOk >= 2 ? 0 : 1)
