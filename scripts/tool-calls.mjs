import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join } from 'node:path'
import { getCapability, resolveArgs } from '../electron/core/capabilities/registry.ts'
import { resolveCommand, stopProcess } from '../electron/core/installer/run.ts'

const project = mkdtempSync(join(tmpdir(), 'agentpack-tool-calls-'))
const sentinel = 'AGENTPACK_SYNTHETIC_TOOL_CALL_SENTINEL'
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'agentpack-tool-call-fixture', private: true, sentinel }, null, 2))
const emptyNpmConfig = join(project, '.npmrc')
writeFileSync(emptyNpmConfig, '')
// Pass only runtime paths, never inherited API credentials or npm authentication.
const allowedEnv = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMFILES', 'PROGRAMFILES(X86)', 'HOMEDRIVE', 'HOMEPATH', 'HOME'])
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowedEnv.has(key.toUpperCase())))
env.NPM_CONFIG_USERCONFIG = emptyNpmConfig
const results = []

async function exercise(id, tool, args, verify) {
  const started = Date.now()
  const capability = getCapability(id)
  assert.equal(capability.secrets?.length ?? 0, 0, 'Tool fixture must never request credentials')
  const command = resolveCommand(capability.install.command, resolveArgs(capability, { projectDir: project }))
  const child = spawn(command.file, command.args, { cwd: project, env, shell: command.shell, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
  let sequence = 0
  let buffer = ''
  let stderr = ''
  let fatal = null
  const pending = new Map()
  const fail = (error) => {
    fatal ??= error
    for (const waiter of pending.values()) waiter.reject(error)
    pending.clear()
  }
  child.on('error', (error) => fail(error))
  child.on('exit', (code) => fail(new Error('MCP process exited before completion: ' + code)))
  child.stdin.on('error', (error) => fail(error))
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
  child.stdout.on('data', (chunk) => {
    buffer += chunk
    if (buffer.length > 2_000_000) { fail(new Error('MCP response exceeds 2 MB')); stopProcess(child); return }
    let newline
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      let message
      try { message = JSON.parse(line) } catch { continue }
      const waiter = pending.get(message.id)
      if (!waiter) continue
      pending.delete(message.id)
      if (message.error) waiter.reject(new Error(message.error.message ?? JSON.stringify(message.error)))
      else waiter.resolve(message.result)
    }
  })
  const send = (method, params) => new Promise((resolve, reject) => {
    if (fatal) { reject(fatal); return }
    const id = ++sequence
    pending.set(id, { resolve, reject })
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
  const call = async (name, args) => {
    const result = await send('tools/call', { name, arguments: args })
    assert.ok(result && result.isError !== true, `${name} returned an MCP tool error: ${JSON.stringify(result)}`)
    assert.ok(Array.isArray(result.content), `${name} returned no content array`)
    return result
  }
  const deadline = setTimeout(() => { fail(new Error('Tool exercise exceeded 60 seconds')); stopProcess(child) }, 60_000)
  try {
    const initialized = await send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'agentpack-tool-test', version: '1.0.0' } })
    assert.ok(initialized?.protocolVersion, 'MCP initialize did not negotiate a protocol')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
    const result = await call(tool, args)
    const text = result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
    verify(text)
    let cleanup
    if (id === 'playwright') cleanup = await call('browser_close', {})
    return { capability: id, tool, passed: true, durationMs: Date.now() - started, result, ...(cleanup ? { cleanup } : {}) }
  } catch (error) {
    return { capability: id, tool, passed: false, durationMs: Date.now() - started, error: error.stack, stderr }
  } finally {
    clearTimeout(deadline)
    stopProcess(child)
  }
}

for (const [id, tool, args, verify] of [
  ['filesystem', 'read_file', { path: join(project, 'package.json') }, (text) => assert.ok(text.includes(sentinel), 'Filesystem did not return the fixture sentinel')],
  ['playwright', 'browser_navigate', { url: 'about:blank' }, (text) => assert.match(text, /about:blank/, 'Browser navigation did not report about:blank')],
  ['sequential-thinking', 'sequentialthinking', { thought: 'Verify one bounded reasoning step using a synthetic AgentPack fixture.', nextThoughtNeeded: false, thoughtNumber: 1, totalThoughts: 1 }, (text) => { const result = JSON.parse(text); assert.equal(result.thoughtNumber, 1); assert.equal(result.nextThoughtNeeded, false) }],
]) {
  try { results.push(await exercise(id, tool, args, verify)) }
  catch (error) { results.push({ capability: id, tool, passed: false, error: error.stack }) }
  const last = results.at(-1)
  console.log((last.passed ? 'PASS ' : 'FAIL ') + id + '/' + tool + ' ' + (last.durationMs ?? 0) + 'ms')
  if (!last.passed) console.error(last.error, last.stderr ?? '')
}
const passed = results.length === 3 && results.every((result) => result.passed)
mkdirSync(resolve('.qa'), { recursive: true })
writeFileSync(resolve('.qa/tool-call-results.json'), JSON.stringify({ passed, project, results }, null, 2))
process.exitCode = passed ? 0 : 1
