// CLM Phase 0 gate (PRD §21 Step 2): prove one capability can be made dormant
// and restored, safely and idempotently, BEFORE any CLM code or UI is written.
//
//   node spike/clm-phase0.mjs
//
// Asserts, per agent:
//   - the entry can be read back in full, credentials included
//   - deactivate removes it and leaves the rest of the config untouched
//   - reactivate restores an entry deep-equal to the original
//   - double deactivate / double activate are no-ops
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'

const sandbox = mkdtempSync(join(tmpdir(), 'clm-phase0-'))
process.env.AGENTPACK_HOME = sandbox

const { adapters } = await import('../electron/core/agents/index.ts')
const { matchEntry } = await import('../electron/core/agents/adapter.ts')
const { getCapability, resolveArgs } = await import('../electron/core/capabilities/registry.ts')

const green = (s) => `\x1b[32m${s}\x1b[0m`
const red = (s) => `\x1b[31m${s}\x1b[0m`
const dim = (s) => `\x1b[2m${s}\x1b[0m`

// Mirror the real configs so we are testing against realistic content.
const real = homedir()
mkdirSync(join(sandbox, '.codex'), { recursive: true })
mkdirSync(join(sandbox, '.claude'), { recursive: true })
mkdirSync(join(sandbox, '.config', 'opencode'), { recursive: true })
for (const [from, to] of [
  [join(real, '.claude.json'), join(sandbox, '.claude.json')],
  [join(real, '.codex', 'config.toml'), join(sandbox, '.codex', 'config.toml')],
  [join(real, '.config', 'opencode', 'opencode.jsonc'), join(sandbox, '.config', 'opencode', 'opencode.jsonc')],
]) if (existsSync(from)) cpSync(from, to)

const hash = (p) => (existsSync(p) ? createHash('sha256').update(readFileSync(p)).digest('hex').slice(0, 12) : null)

// A credentialed capability is the hard case: removing it deletes the token.
const CAP = getCapability('supabase')
const ENV = { SUPABASE_ACCESS_TOKEN: 'sbp_phase0_secret_value' }
const resolved = {
  ...CAP,
  install: { ...CAP.install, args: resolveArgs(CAP, { projectDir: sandbox, values: { SUPABASE_PROJECT_REF: 'phase0ref' } }) },
}

let failures = 0
const check = (name, fn) => {
  try {
    fn()
    console.log(green('  ✓') + ' ' + name)
  } catch (e) {
    failures++
    console.log(red('  ✗') + ' ' + name + '\n      ' + e.message.split('\n').join('\n      '))
  }
}

console.log(`\nCLM Phase 0 — dormancy round-trip ${dim(`(sandbox: ${sandbox})`)}\n`)

for (const key of ['claude', 'opencode', 'codex']) {
  const a = adapters[key]
  console.log(`${a.name}  ${dim(a.configPath())}`)

  // Baseline: install the capability so there is something to deactivate.
  a.write(resolved, ENV)
  const original = a.read(resolved)
  const fileAfterInstall = hash(a.configPath())

  check('entry is readable in full, credentials included', () => {
    assert.ok(original, 'entry not readable')
    assert.equal(original.command, resolved.install.command)
    assert.deepEqual(original.args, resolved.install.args)
    assert.equal(original.env.SUPABASE_ACCESS_TOKEN, ENV.SUPABASE_ACCESS_TOKEN,
      'credential must be readable back, or dormancy cannot restore it')
  })

  // --- the dormant stash: capture exactly what we are about to remove ---
  const stashed = JSON.parse(JSON.stringify(original))

  // Snapshot an unrelated part of the config to prove we do not disturb it.
  const unrelatedBefore = key === 'codex'
    ? readFileSync(a.configPath(), 'utf8').includes('[mcp_servers.node_repl]')
    : JSON.stringify(JSON.parse(readFileSync(a.configPath(), 'utf8')).mcpServers?.existing ?? null)

  check('deactivate removes the entry', () => {
    a.remove(resolved)
    assert.equal(a.read(resolved), null, 'entry still present after deactivate')
  })

  check('deactivate leaves unrelated config untouched', () => {
    const after = key === 'codex'
      ? readFileSync(a.configPath(), 'utf8').includes('[mcp_servers.node_repl]')
      : JSON.stringify(JSON.parse(readFileSync(a.configPath(), 'utf8')).mcpServers?.existing ?? null)
    assert.deepEqual(after, unrelatedBefore, 'unrelated config changed during deactivate')
  })

  check('deactivate twice is a no-op, not a corruption', () => {
    a.remove(resolved)
    assert.equal(a.read(resolved), null)
    assert.doesNotThrow(() => a.read(resolved))
  })

  check('reactivate restores an entry deep-equal to the original', () => {
    const restoreCap = { ...resolved, install: { command: stashed.command, args: stashed.args } }
    a.write(restoreCap, stashed.env)
    const now = a.read(resolved)
    assert.ok(now, 'entry missing after reactivate')
    assert.equal(now.command, stashed.command)
    assert.deepEqual(now.args, stashed.args)
    assert.deepEqual(now.env, stashed.env, 'CREDENTIALS LOST across the dormancy cycle')
  })

  check('activate twice is a no-op when gated on matchEntry', () => {
    const restoreCap = { ...resolved, install: { command: stashed.command, args: stashed.args } }
    const before = a.read(resolved)

    // This is the contract CLM.activate() must implement: check first, then
    // write. Raw write() is deliberately NOT idempotent — Codex's parse-verify
    // guard throws rather than redefine a TOML table, which is the safe
    // behaviour, but it means the gate belongs in the caller.
    const state = matchEntry(a, restoreCap, stashed.env)
    assert.equal(state, 'same', 'a freshly restored entry should compare equal')
    if (state !== 'same') a.write(restoreCap, stashed.env)

    assert.deepEqual(a.read(resolved), before, 'gated activate changed the entry')
    if (key === 'codex') {
      const count = (readFileSync(a.configPath(), 'utf8').match(/\[mcp_servers\.supabase\]/g) ?? []).length
      assert.equal(count, 1, `codex table duplicated (${count} copies)`)
    }
  })

  check('raw double-write is refused rather than corrupting (Codex)', () => {
    if (key !== 'codex') return
    const restoreCap = { ...resolved, install: { command: stashed.command, args: stashed.args } }
    assert.throws(() => a.write(restoreCap, stashed.env), /already defined|invalid TOML/i,
      'Codex must refuse to redefine a table instead of writing a duplicate')
    // and the file must still be intact afterwards
    assert.ok(a.read(resolved), 'config damaged by the refused write')
  })

  const fileAfterCycle = hash(a.configPath())
  console.log(dim(`      file hash after install ${fileAfterInstall} → after cycle ${fileAfterCycle}` +
    (fileAfterInstall === fileAfterCycle ? ' (byte-identical)' : ' (differs — key/table order)')))
  console.log()
}

console.log(failures ? red(`${failures} check(s) failed`) : green('Phase 0 gate: PASSED'))
console.log(dim(`sandbox: ${sandbox}`))
process.exit(failures ? 1 : 0)
