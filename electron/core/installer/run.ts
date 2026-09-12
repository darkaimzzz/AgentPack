import { spawn, type SpawnOptions } from 'node:child_process'

export type RunResult = {
  command: string
  code: number | null
  stdout: string
  stderr: string
  durationMs: number
}

/**
 * Windows: npx/npm/pnpm/yarn are .cmd shims, and since the CVE-2024-27980 fix
 * Node refuses to spawn a .cmd without a shell (EINVAL). Most MCP servers are
 * npx-based, so this resolution is load-bearing on Windows.
 *
 * With shell:true we pass one pre-quoted command line rather than an args array,
 * because the array form concatenates without escaping (Node DEP0190).
 */
export function resolveCommand(command: string, args: string[]) {
  const isWin = process.platform === 'win32'
  const bin = isWin && /^(npx|npm|pnpm|yarn)$/.test(command) ? `${command}.cmd` : command
  const useShell = isWin && /\.(cmd|bat)$/i.test(bin)
  const quote = (a: string) => (/[\s"^&|<>]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)
  return useShell
    ? { file: [bin, ...args].map(quote).join(' '), args: [] as string[], shell: true }
    : { file: bin, args, shell: false }
}

/**
 * Redact secret values from a string. Registry values are never secret; only
 * user-supplied ones are, so callers pass the live values to scrub.
 * Single choke point: every log line leaves the main process through here.
 */
export function redact(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const s of secrets) {
    if (s && s.length >= 4) out = out.split(s).join('••••redacted••••')
  }
  return out
}

export type RunOptions = {
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
  /** Values to scrub from captured output before it leaves this process. */
  secretValues?: string[]
  onLine?: (stream: 'stdout' | 'stderr', line: string) => void
}

export function run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const { file, args: spawnArgs, shell } = resolveCommand(command, args)
  const secrets = opts.secretValues ?? []
  const started = Date.now()

  const spawnOpts: SpawnOptions = {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    shell,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }

  return new Promise((resolve) => {
    const child = spawn(file, spawnArgs, spawnOpts)
    let stdout = ''
    let stderr = ''

    const pipe = (stream: 'stdout' | 'stderr') => (chunk: Buffer) => {
      const text = redact(String(chunk), secrets)
      if (stream === 'stdout') stdout += text
      else stderr += text
      if (opts.onLine) for (const line of text.split('\n')) if (line.trim()) opts.onLine(stream, line)
    }

    child.stdout?.on('data', pipe('stdout'))
    child.stderr?.on('data', pipe('stderr'))

    const done = (code: number | null, err?: string) =>
      resolve({
        command: redact(`${command} ${args.join(' ')}`, secrets),
        code,
        stdout,
        stderr: err ? `${stderr}${err}` : stderr,
        durationMs: Date.now() - started,
      })

    const timer = opts.timeoutMs
      ? setTimeout(() => {
          child.kill()
          done(null, `\nagentpack: timed out after ${opts.timeoutMs}ms`)
        }, opts.timeoutMs)
      : null

    child.on('error', (e) => {
      if (timer) clearTimeout(timer)
      done(null, `\nagentpack: spawn failed: ${redact(e.message, secrets)}`)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      done(code)
    })
  })
}
