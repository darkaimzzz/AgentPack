import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

/**
 * Deterministic project stack detection (CLAUDE.md §11).
 * File and dependency checks only — no LLM in the golden path. Every signal
 * carries the evidence that produced it, so the UI can always answer "why?".
 */

export type Signal = {
  id: string
  label: string
  /** Human-readable reason, shown verbatim on the Recommendations screen. */
  evidence: string
}

export type ProjectScan = {
  dir: string
  signals: Signal[]
  /** True when this looks like a software project at all. */
  isProject: boolean
}

type Pkg = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

const readPkg = (dir: string): Pkg | null => {
  const p = join(dir, 'package.json')
  if (!existsSync(p)) return null
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as Pkg
  } catch {
    return null // a malformed package.json is not a crash
  }
}

/** Any file in dir matching a prefix, e.g. "next.config" -> next.config.ts */
const hasPrefixed = (dir: string, prefix: string): string | null => {
  try {
    return readdirSync(dir).find((f) => f.startsWith(prefix)) ?? null
  } catch {
    return null
  }
}

export function scanProject(dir: string): ProjectScan {
  const signals: Signal[] = []
  const add = (id: string, label: string, evidence: string) => {
    if (!signals.some((s) => s.id === id)) signals.push({ id, label, evidence })
  }

  const pkg = readPkg(dir)
  const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
  const dep = (name: string) => (name in deps ? `package.json depends on ${name}` : null)

  if (pkg) add('node', 'Node.js', 'package.json present')
  if (existsSync(join(dir, '.git'))) add('git', 'Git repository', '.git directory present')

  // --- frontend ---
  const nextCfg = hasPrefixed(dir, 'next.config')
  if (dep('next') || nextCfg) add('nextjs', 'Next.js', dep('next') ?? `${nextCfg} present`)
  const viteCfg = hasPrefixed(dir, 'vite.config')
  if (dep('vite') || viteCfg) add('vite', 'Vite', dep('vite') ?? `${viteCfg} present`)
  if (dep('react')) add('react', 'React', dep('react')!)
  if (dep('svelte')) add('svelte', 'Svelte', dep('svelte')!)
  if (dep('vue')) add('vue', 'Vue', dep('vue')!)

  // --- data ---
  if (dep('@supabase/supabase-js') || existsSync(join(dir, 'supabase'))) {
    add('supabase', 'Supabase', dep('@supabase/supabase-js') ?? 'supabase/ directory present')
  }
  if (dep('prisma') || dep('@prisma/client') || existsSync(join(dir, 'prisma'))) {
    add('prisma', 'Prisma', dep('prisma') ?? dep('@prisma/client') ?? 'prisma/ directory present')
  }
  if (dep('pg') || dep('postgres')) add('postgres', 'PostgreSQL', dep('pg') ?? dep('postgres')!)

  // --- runtime / tooling ---
  if (existsSync(join(dir, 'requirements.txt'))) add('python', 'Python', 'requirements.txt present')
  if (existsSync(join(dir, 'pyproject.toml'))) add('python', 'Python', 'pyproject.toml present')
  if (existsSync(join(dir, 'Dockerfile'))) add('docker', 'Docker', 'Dockerfile present')
  if (dep('typescript')) add('typescript', 'TypeScript', dep('typescript')!)
  if (dep('@playwright/test') || dep('playwright')) {
    add('playwright-installed', 'Playwright (already in project)', dep('@playwright/test') ?? dep('playwright')!)
  }

  // .env.example names the variables a project expects without leaking values.
  const envExample = join(dir, '.env.example')
  if (existsSync(envExample)) {
    const keys = readFileSync(envExample, 'utf8')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('=')[0].trim())
    if (keys.some((k) => /^DATABASE_URL$/i.test(k))) add('postgres', 'PostgreSQL', '.env.example declares DATABASE_URL')
    if (keys.some((k) => /SUPABASE/i.test(k))) add('supabase', 'Supabase', '.env.example declares a SUPABASE_* variable')
    if (keys.some((k) => /^GITHUB_/i.test(k))) add('github-env', 'GitHub credentials', '.env.example declares a GITHUB_* variable')
  }

  return { dir, signals, isProject: signals.length > 0 }
}
