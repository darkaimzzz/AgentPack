import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { install, rollback } from './installer/install.ts'
import { getCapability } from './capabilities/registry.ts'
import { entries } from './installer/ledger.ts'
import { readManifest } from './capabilities/manifest.ts'
import { deactivate, activate } from './clm/state.ts'

const root = mkdtempSync(join(tmpdir(), 'agentpack-hardening-'))
const server = join(root, 'server.mjs')
writeFileSync(server, `import readline from 'node:readline'; readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id)console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:{tools:[{name:'fixture',inputSchema:{type:'object'}}]}}))})`)
const cap = getCapability('sequential-thinking')
cap.install = { command: process.execPath, args: [server] }
let index = 0
function setup(claude = '{}') {
  const home = join(root, String(++index))
  process.env.AGENTPACK_HOME = home
  mkdirSync(join(home, '.codex'), { recursive: true })
  writeFileSync(join(home, '.claude.json'), claude)
  return { home, file: join(home, '.claude.json'), req: { capabilityIds: [cap.id], agents: ['claude'] as ['claude'], projectDir: home } }
}

test('rollback never removes a pre-existing capability after an unrelated edit', async () => {
  const seed = { mcpServers: { [cap.id]: { command: cap.install!.command, args: cap.install!.args, type:'stdio' } } }
  const {file, req} = setup(JSON.stringify(seed))
  const report = await install(req)
  writeFileSync(file, JSON.stringify({...seed, theme:'light'}))
  rollback(report.ledgerId)
  assert.deepEqual(JSON.parse(readFileSync(file,'utf8')).mcpServers, seed.mcpServers)
})

test('rollback of a new config preserves unrelated user settings', async () => {
  const {home, req} = setup()
  const file=join(home,'.codex','config.toml')
  const report=await install({...req, agents:['codex']})
  writeFileSync(file, readFileSync(file,'utf8')+'\n[user]\ntheme = "light"\n')
  rollback(report.ledgerId)
  assert.ok(existsSync(file))
  assert.match(readFileSync(file,'utf8'), /theme/)
  assert.doesNotMatch(readFileSync(file,'utf8'), /mcp_servers/)
})

test('rollback refuses a later edit to an installed capability and preserves the ledger', async () => {
  const {file,req}=setup()
  const report=await install(req)
  const cfg=JSON.parse(readFileSync(file,'utf8'));cfg.mcpServers[cap.id].command='user-edited';writeFileSync(file,JSON.stringify(cfg))
  assert.throws(()=>rollback(report.ledgerId), /changed|conflict/i)
  assert.equal(JSON.parse(readFileSync(file,'utf8')).mcpServers[cap.id].command,'user-edited')
  assert.ok(!entries().find(e=>e.id===report.ledgerId)?.rolledBackAt)
})

test('rollback is idempotent by explicit run id',async()=>{
  const {req}=setup();const report=await install(req);rollback(report.ledgerId)
  assert.equal(rollback(report.ledgerId),null)
})

test('engine discards undeclared inputs and credentials before persistence',async()=>{
  const {home,req}=setup();await install({...req,inputs:{GITHUB_PERSONAL_ACCESS_TOKEN:'FAKE_UNDECLARED_SECRET'},secrets:{OTHER:'FAKE_OTHER_SECRET'}})
  assert.doesNotMatch(readFileSync(join(home,'.agentpack','installs.json'),'utf8'),/FAKE_|GITHUB_PERSONAL/)
})

test('empty agent selection is rejected before writing a ledger',async()=>{
  const {home,req}=setup();await assert.rejects(install({...req,agents:[]}),/agent/i)
  assert.ok(!existsSync(join(home,'.agentpack','installs.json')))
})

test('manifest validates targets and derives required credentials from registry',()=>{
  const {home}=setup();const path=join(home,'pack.json')
  writeFileSync(path,JSON.stringify({agentpack:1,name:'bad',capabilities:['github'],targets:['made-up']}))
  assert.throws(()=>readManifest(path),/target|agent/i)
  writeFileSync(path,JSON.stringify({agentpack:1,name:'valid',capabilities:['github'],targets:['claude']}))
  assert.ok(readManifest(path).requiredSecrets?.includes('GITHUB_PERSONAL_ACCESS_TOKEN'))
})

test('rollback removes a dormant Claude entry from its credential store', async () => {
  const {req} = setup()
  const report = await install(req)
  assert.equal(deactivate(cap.id, 'claude').success, true)
  rollback(report.ledgerId)
  assert.equal(activate(cap.id, 'claude').success, false, 'undone install must not be resurrected')
})

test('rollback preserves a marketplace required by a plugin added later', async () => {
  const {home,req} = setup()
  const report = await install({...req, capabilityIds:['superpowers']})
  const path = join(home,'.claude','settings.json')
  const cfg = JSON.parse(readFileSync(path,'utf8'))
  cfg.enabledPlugins['another-plugin@claude-plugins-official'] = true
  writeFileSync(path, JSON.stringify(cfg))
  rollback(report.ledgerId)
  const after = JSON.parse(readFileSync(path,'utf8'))
  assert.ok(after.extraKnownMarketplaces['claude-plugins-official'])
  assert.ok(after.enabledPlugins['another-plugin@claude-plugins-official'])
  assert.ok(!after.enabledPlugins['superpowers@claude-plugins-official'])
})

test('later capability writes cannot absorb a user edit into rollback ownership', async () => {
  const {home,req} = setup()
  const path = join(home,'.claude','settings.json')
  let edited = false
  const report = await install({...req, capabilityIds:['superpowers','claude-mem'], onProgress:event=>{
    if (!edited && event.kind === 'stage' && event.stage === 'validate' && existsSync(path)) {
      const cfg = JSON.parse(readFileSync(path,'utf8'))
      cfg.permissions = {allow:['USER_EDIT_MUST_SURVIVE']}
      writeFileSync(path, JSON.stringify(cfg)); edited = true
    }
  }})
  assert.ok(edited)
  rollback(report.ledgerId)
  assert.deepEqual(JSON.parse(readFileSync(path,'utf8')).permissions, {allow:['USER_EDIT_MUST_SURVIVE']})
})
