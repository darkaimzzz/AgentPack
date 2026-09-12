// Regressions for the v1.6.0 independent review. One test per confirmed
// defect, each reproducing the original failure rather than asserting the fix.
//
// The watcher defect (an errored watcher staying open and activating after
// Stop) is not here: it needs a real Electron window, preload and IPC to
// reproduce honestly, and lives in the review's own harness.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { backup, captureAfter, prepareRestore } from './installer/backup.ts'
import { install, rollback } from './installer/install.ts'
import { getCapability } from './capabilities/registry.ts'
import { adapters } from './agents/index.ts'
import { readJsonc } from './agents/json-config.ts'

const root = mkdtempSync(join(tmpdir(), 'agentpack-review-'))
let index = 0
const sandbox = () => {
  const home = join(root, String(++index))
  process.env.AGENTPACK_HOME = home
  mkdirSync(join(home, '.codex'), { recursive: true })
  mkdirSync(join(home, '.config', 'opencode'), { recursive: true })
  return home
}

test('a config written but never snapshotted is still rolled back', () => {
  const home = sandbox()
  const file = join(home, '.claude.json')
  writeFileSync(file, '{"mcpServers":{}}')
  const token = backup('claude', file, 'run-1')

  writeFileSync(file, '{"mcpServers":{"x":{"command":"node"}}}')
  // Block the snapshot destination so the copy cannot succeed. The write has
  // already happened, so the change must stay attributable regardless.
  const blocked = join(home, '.agentpack', 'backups', 'run-2', 'claude')
  mkdirSync(join(home, '.agentpack', 'backups', 'run-2'), { recursive: true })
  writeFileSync(blocked, 'not a directory')

  captureAfter(token, 'run-2')
  assert.equal(token.afterPath, undefined, 'the copy was expected to fail')
  assert.ok(token.postHash, 'the hash must survive a failed copy')
  assert.equal(token.written, true)

  const action = prepareRestore(token)
  assert.ok(action, 'rollback must still have something to do')
  action.apply()
  assert.equal(readFileSync(file, 'utf8'), '{"mcpServers":{}}')
})

test('a token that never wrote anything has nothing to undo', () => {
  const home = sandbox()
  const file = join(home, '.claude.json')
  writeFileSync(file, '{"mcpServers":{}}')
  const token = backup('claude', file, 'run-1')
  // An already-present capability writes nothing, then the user edits the file.
  writeFileSync(file, '{"mcpServers":{},"theme":"light"}')
  assert.equal(prepareRestore(token), null, 'must not claim ownership of a user edit')
})

test('a TOML parse error carries no source lines from the existing config', async () => {
  const home = sandbox()
  const SENTINEL = 'FAKE_PREEXISTING_SECRET'
  writeFileSync(join(home, '.codex', 'config.toml'), `[mcp_servers.old.env]\nTOKEN = "${SENTINEL}\n`)

  const progress: string[] = []
  const report = await install({
    capabilityIds: ['superpowers'], agents: ['codex'], projectDir: home,
    onProgress: (e) => progress.push(JSON.stringify(e)),
  })

  assert.equal(report.capabilities[0].results[0].status, 'failed')
  assert.ok(!JSON.stringify(report).includes(SENTINEL), 'credential reached the install report')
  assert.ok(!progress.join('\n').includes(SENTINEL), 'credential reached the progress stream')
  // The diagnostic itself must survive; only the excerpt is dropped.
  assert.match(String(report.capabilities[0].results[0].error), /Invalid TOML document/)
})

test('a duplicated JSONC section is refused rather than silently half-written', async () => {
  const home = sandbox()
  const file = join(home, '.config', 'opencode', 'opencode.jsonc')
  writeFileSync(file, '{"mcp":{},"mcp":{}}')

  assert.throws(() => readJsonc(file), /more than once/)

  const report = await install({ capabilityIds: ['memory'], agents: ['opencode'], projectDir: home })
  const result = report.capabilities[0]
  assert.equal(result.results[0].status, 'failed')
  assert.notEqual(result.health.status, 'verified', 'must not verify an unreachable entry')
})

test('an existing marketplace is recognised however its TOML key is quoted', async () => {
  const home = sandbox()
  writeFileSync(
    join(home, '.codex', 'config.toml'),
    '[marketplaces."claude-plugins-official"]\nsource_type="git"\n' +
    'source="https://github.com/anthropics/claude-plugins-official.git"\n',
  )
  assert.equal(adapters.codex.validate().ok, true, 'fixture must start valid')

  const report = await install({ capabilityIds: ['superpowers'], agents: ['codex'], projectDir: home })
  assert.equal(report.capabilities[0].results[0].status, 'installed')
})

test('rollback keeps a comment added after installation', async () => {
  const home = sandbox()
  const file = join(home, '.codex', 'config.toml')
  writeFileSync(file, '# baseline\n')

  const report = await install({ capabilityIds: ['superpowers'], agents: ['codex'], projectDir: home })
  assert.equal(report.capabilities[0].results[0].status, 'installed')

  appendFileSync(file, '\n# USER COMMENT ADDED AFTER INSTALL\n')
  rollback(report.ledgerId)

  const after = readFileSync(file, 'utf8')
  assert.match(after, /USER COMMENT ADDED AFTER INSTALL/, 'later annotation was deleted')
  assert.match(after, /# baseline/)
  assert.doesNotMatch(after, /\[plugins\./, 'the installed entry should be gone')
})

test('the capability registry still resolves after these edits', () => {
  assert.ok(getCapability('superpowers').plugin)
  assert.ok(getCapability('memory').install)
})
