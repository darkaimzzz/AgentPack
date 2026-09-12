// Raw stdio MCP handshake: initialize -> initialized -> tools/list.
// No SDK. This is the health check that proves a server actually runs,
// as opposed to "we wrote a config file and it parsed".
import { spawn } from 'node:child_process'

const PROTOCOL = '2024-11-05' // widest server support; negotiated up by servers that can

/** Spawn an MCP server over stdio and return its advertised tool names. */
export async function probe({ command, args = [], env = {}, timeoutMs = 120_000 }) {
  // Windows: npx/npm/etc are .cmd shims, and since the CVE-2024-27980 fix Node
  // refuses to spawn a .cmd without a shell (EINVAL). Nearly every MCP server is
  // npx-based, so this branch is the difference between working and not on Windows.
  const isWin = process.platform === 'win32'
  const needsCmd = isWin && /^(npx|npm|pnpm|yarn)$/.test(command)
  const bin = needsCmd ? `${command}.cmd` : command
  const useShell = isWin && /\.(cmd|bat)$/i.test(bin)
  const quote = (a) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)

  // With shell:true, pass one pre-quoted command line rather than an args array:
  // the array form concatenates without escaping (Node DEP0190).
  const child = useShell
    ? spawn([bin, ...args].map(quote).join(' '), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
        shell: true,
        windowsHide: true,
      })
    : spawn(bin, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, ...env },
        windowsHide: true,
      })

  const pending = new Map() // id -> {resolve, reject}
  let buf = ''
  let stderr = ''

  child.stdout.on('data', (chunk) => {
    buf += chunk
    // NDJSON: one JSON-RPC message per line.
    let nl
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line) continue
      let msg
      try { msg = JSON.parse(line) } catch { continue } // servers sometimes log to stdout
      const waiter = msg.id != null && pending.get(msg.id)
      if (!waiter) continue
      pending.delete(msg.id)
      msg.error ? waiter.reject(new Error(msg.error.message ?? JSON.stringify(msg.error))) : waiter.resolve(msg.result)
    }
  })

  child.stderr.on('data', (c) => { stderr += c })

  let nextId = 1
  const send = (method, params) => {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
  }
  const notify = (method, params) =>
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')

  const fail = (msg) => new Error(`${msg}${stderr ? `\n  stderr: ${stderr.trim().split('\n').slice(-4).join('\n  ')}` : ''}`)

  const timer = setTimeout(() => {
    for (const { reject } of pending.values()) reject(fail(`timed out after ${timeoutMs}ms`))
    pending.clear()
  }, timeoutMs)

  child.on('error', (e) => {
    for (const { reject } of pending.values()) reject(fail(`spawn failed: ${e.message}`))
    pending.clear()
  })
  child.on('exit', (code) => {
    for (const { reject } of pending.values()) reject(fail(`server exited early (code ${code})`))
    pending.clear()
  })

  try {
    const init = await send('initialize', {
      protocolVersion: PROTOCOL,
      capabilities: {},
      clientInfo: { name: 'agentpack', version: '0.0.0' },
    })
    notify('notifications/initialized', {})
    const { tools = [] } = await send('tools/list', {})
    return {
      ok: true,
      server: init.serverInfo ?? {},
      tools: tools.map((t) => t.name),
    }
  } catch (e) {
    return { ok: false, error: e.message, tools: [] }
  } finally {
    clearTimeout(timer)
    child.kill()
  }
}
