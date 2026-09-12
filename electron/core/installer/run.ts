import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'

export type RunResult = { command: string; code: number | null; stdout: string; stderr: string; durationMs: number }

/** Invoke npm's JS entry point directly; user paths never pass through cmd.exe. */
export function resolveCommand(command: string, args: string[]) {
  if (process.platform === 'win32' && /^(npx|npm)(\.cmd)?$/i.test(command)) {
    const name = command.replace(/\.cmd$/i, '').toLowerCase()
    for (const dir of (process.env.PATH ?? '').split(delimiter)) {
      const script = join(dir, 'node_modules', 'npm', 'bin', `${name}-cli.js`)
      const node = join(dir, 'node.exe')
      if (existsSync(script) && existsSync(node)) return { file: node, args: [script, ...args], shell: false }
    }
    throw new Error('Node.js and npm were not found on PATH. Install Node.js 22.17 or newer and restart AgentPack.')
  }
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command)) {
    throw new Error('Batch launchers are not supported. Use the executable or its Node.js entry point.')
  }
  return { file: command, args, shell: false }
}

export function redact(text: string, secrets: Iterable<string>): string {
  let out = text
  for (const secret of [...secrets].filter(Boolean).sort((a,b)=>b.length-a.length)) out=out.split(secret).join('[redacted]')
  return out
}

export function stopProcess(child: ChildProcess): void {
  child.stdin?.end()
  if (!child.pid || child.exitCode !== null) return
  if (process.platform === 'win32') {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
    killer.on('error',()=>child.kill())
    killer.on('exit',code=>{ if(code !== 0 && child.exitCode === null) child.kill() })
    killer.unref()
  } else child.kill()
}

export type RunOptions = {
  env?: Record<string,string>; cwd?: string; timeoutMs?: number; secretValues?: string[]
  onLine?: (stream:'stdout'|'stderr',line:string)=>void
}

export async function run(command: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const started=Date.now(), secrets=opts.secretValues??[]
  return new Promise(resolve=>{
    const raw={stdout:'',stderr:''}, pending={stdout:'',stderr:''}
    let settled=false
    let child:ChildProcess
    let timer:ReturnType<typeof setTimeout>
    const done=(code:number|null,error='')=>{
      if(settled)return
      settled=true;clearTimeout(timer)
      for(const stream of ['stdout','stderr'] as const) if(pending[stream]) opts.onLine?.(stream,redact(pending[stream],secrets))
      resolve({command:redact([command,...args].join(' '),secrets),code,stdout:redact(raw.stdout,secrets),stderr:redact(raw.stderr+error,secrets),durationMs:Date.now()-started})
    }
    try {
      const resolved=resolveCommand(command,args)
      child=spawn(resolved.file,resolved.args,{cwd:opts.cwd,env:{...process.env,...opts.env},shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']})
    } catch(e) {done(null,(e as Error).message);return}
    for(const stream of ['stdout','stderr'] as const) child[stream]?.on('data',(chunk:Buffer)=>{
      raw[stream]+=chunk;pending[stream]+=chunk
      if(raw[stream].length>1_000_000){stopProcess(child);done(null,'Process output exceeded 1 MB');return}
      let i:number
      while((i=pending[stream].indexOf('\n'))!==-1){const line=pending[stream].slice(0,i);pending[stream]=pending[stream].slice(i+1);opts.onLine?.(stream,redact(line,secrets))}
    })
    timer=setTimeout(()=>{stopProcess(child);done(null,`Timed out after ${opts.timeoutMs??30_000}ms`)},opts.timeoutMs??30_000)
    child.on('error',e=>done(null,e.message))
    child.on('close',code=>done(code))
  })
}
