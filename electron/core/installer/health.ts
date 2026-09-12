import { spawn } from 'node:child_process'
import { resolveCommand, redact } from './run.ts'
import type { ToolDefinition } from '../types.ts'

/**
 * What a probe learned. Deliberately its own type rather than a slice of
 * HealthResult: it carries the full tool definitions, which the context-cost
 * estimator needs but an install report must not drag through IPC.
 */
export type ProbeResult = {
  reachable: boolean
  tools: string[]
  /** Complete tool objects, including description and inputSchema. */
  toolDefinitions: ToolDefinition[]
  server?: { name?: string; version?: string }
  durationMs: number
  error?: string
}

const PROTOCOL = '2024-11-05' // widest server support; capable servers negotiate up

/**
 * Start an MCP server over stdio and ask what it can do:
 * initialize -> notifications/initialized -> tools/list.
 *
 * This is the health check that matters. "The config entry exists" only proves
 * we wrote a file; this proves the capability actually works (CLAUDE.md §16).
 * Raw JSON-RPC on purpose — no SDK dependency for ~80 lines.
 */
export function probe(opts: {
  command: string
  args?: string[]
  env?: Record<string, string>
  timeoutMs?: number
  secretValues?: string[]
}): Promise<ProbeResult> {
  const { command, args = [], env = {}, timeoutMs = 120_000, secretValues = [] } = opts
  const { file, args: spawnArgs, shell } = resolveCommand(command, args)
  const started = Date.now()

  return new Promise((resolve) => {
    const child = spawn(file, spawnArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
      shell,
      windowsHide: true,
    })

    const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>()
    let buf = ''
    let stderr = ''
    let settled = false

    const finish = (r: ProbeResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      child.kill()
      resolve(r)
    }

    const failAll = (msg: string) => {
      const tail = stderr.trim().split('\n').slice(-4).join(' | ')
      const err = redact(tail ? `${msg} — ${tail}` : msg, secretValues)
      for (const p of pending.values()) p.fail(new Error(err))
      pending.clear()
    }

    child.stdout.on('data', (chunk) => {
      buf += chunk
      let nl: number
      // NDJSON: one JSON-RPC message per line.
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let msg: any
        try {
          msg = JSON.parse(line)
        } catch {
          continue // some servers print human logs to stdout
        }
        const waiter = msg.id != null ? pending.get(msg.id) : undefined
        if (!waiter) continue
        pending.delete(msg.id)
        // A server can echo a supplied credential back inside a protocol error.
        // Redact here too — stderr redaction covers a different path entirely.
        if (msg.error) waiter.fail(new Error(redact(msg.error.message ?? JSON.stringify(msg.error), secretValues)))
        else waiter.ok(msg.result)
      }
    })

    child.stderr.on('data', (c) => {
      stderr += c
    })

    let nextId = 1
    const send = (method: string, params: unknown) => {
      const id = nextId++
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
      return new Promise<any>((ok, fail) => pending.set(id, { ok, fail }))
    }

    const timer = setTimeout(() => failAll(`timed out after ${timeoutMs}ms`), timeoutMs)
    child.on('error', (e) => failAll(`spawn failed: ${e.message}`))
    child.on('exit', (code) => failAll(`server exited early (code ${code})`))

    ;(async () => {
      try {
        const init = await send('initialize', {
          protocolVersion: PROTOCOL,
          capabilities: {},
          clientInfo: { name: 'agentpack', version: '0.1.0' },
        })
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }) + '\n')
        const res = await send('tools/list', {})
        const defs: ToolDefinition[] = res?.tools ?? []
        finish({
          reachable: true,
          tools: defs.map((t) => t.name),
          toolDefinitions: defs,
          server: init?.serverInfo ?? {},
          durationMs: Date.now() - started,
        })
      } catch (e) {
        finish({
          reachable: false,
          tools: [],
          toolDefinitions: [],
          durationMs: Date.now() - started,
          // Belt and braces: every error leaving this function is scrubbed,
          // whatever path produced it.
          error: redact((e as Error).message, secretValues),
        })
      }
    })()
  })
}
