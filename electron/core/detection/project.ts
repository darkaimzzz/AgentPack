import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

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
  /** Every package.json we read, relative to the scanned directory. */
  manifests: string[]
}

type Pkg = {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
  workspaces?: string[] | { packages?: string[] }
}

const readJsonFile = <T>(p: string): T | null => {
  try {
    return JSON.parse(readFileSync(p, 'utf8')) as T
  } catch {
    return null // a malformed manifest is not a crash
  }
}

const isDir = (p: string) => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const listDirs = (p: string) => {
  try {
    return readdirSync(p).filter((d) => !d.startsWith('.') && isDir(join(p, d)))
  } catch {
    return []
  }
}

/**
 * Find every package.json worth reading: the root, plus workspace members.
 *
 * A monorepo keeps its real dependencies in apps/web or packages/*, so reading
 * only the root manifest finds a name and nothing else — which was exactly the
 * failure this function exists to fix.
 */
function collectManifests(root: string): Array<{ rel: string; pkg: Pkg }> {
  const out: Array<{ rel: string; pkg: Pkg }> = []
  const seen = new Set<string>()

  const add = (dir: string) => {
    const file = join(dir, 'package.json')
    if (seen.has(file) || !existsSync(file)) return
    seen.add(file)
    const pkg = readJsonFile<Pkg>(file)
    if (pkg) out.push({ rel: relative(root, file) || 'package.json', pkg })
  }

  add(root)

  // Workspace patterns, from package.json or pnpm-workspace.yaml.
  const rootPkg = out[0]?.pkg
  const declared = Array.isArray(rootPkg?.workspaces)
    ? rootPkg.workspaces
    : rootPkg?.workspaces?.packages ?? []

  const pnpmFile = join(root, 'pnpm-workspace.yaml')
  const fromPnpm = existsSync(pnpmFile)
    // Small, predictable YAML: a `packages:` list of quoted globs. Matching the
    // globs directly avoids taking on a YAML parser for two lines of config.
    ? [...readFileSync(pnpmFile, 'utf8').matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?/gm)].map((m) => m[1].trim())
    : []

  // Plus the conventional layout, which many repos use without declaring it.
  const patterns = [...new Set([...declared, ...fromPnpm, 'apps/*', 'packages/*', 'services/*'])]

  for (const pattern of patterns) {
    if (pattern.endsWith('/*')) {
      const base = join(root, pattern.slice(0, -2))
      for (const child of listDirs(base)) add(join(base, child))
    } else {
      add(join(root, pattern))
    }
  }

  return out
}

/** A dependency rule: exact names, or scope prefixes like "@supabase/". */
type DepRule = { id: string; label: string; deps?: string[]; prefixes?: string[] }

const DEP_RULES: DepRule[] = [
  // frameworks
  { id: 'nextjs', label: 'Next.js', deps: ['next'] },
  { id: 'nuxt', label: 'Nuxt', deps: ['nuxt'] },
  { id: 'astro', label: 'Astro', deps: ['astro'] },
  { id: 'remix', label: 'Remix', deps: ['@remix-run/react', '@remix-run/node'] },
  { id: 'sveltekit', label: 'SvelteKit', deps: ['@sveltejs/kit'] },
  { id: 'angular', label: 'Angular', prefixes: ['@angular/'] },
  { id: 'react', label: 'React', deps: ['react'] },
  { id: 'vue', label: 'Vue', deps: ['vue'] },
  { id: 'svelte', label: 'Svelte', deps: ['svelte'] },
  { id: 'solid', label: 'Solid', deps: ['solid-js'] },
  { id: 'react-native', label: 'React Native', deps: ['react-native', 'expo'] },
  { id: 'vite', label: 'Vite', deps: ['vite'] },
  { id: 'electron', label: 'Electron', deps: ['electron'] },
  // styling
  { id: 'tailwind', label: 'Tailwind CSS', deps: ['tailwindcss'] },
  // data
  { id: 'supabase', label: 'Supabase', prefixes: ['@supabase/'], deps: ['supabase'] },
  { id: 'prisma', label: 'Prisma', deps: ['prisma', '@prisma/client'] },
  { id: 'drizzle', label: 'Drizzle ORM', deps: ['drizzle-orm'] },
  { id: 'postgres', label: 'PostgreSQL', deps: ['pg', 'postgres', 'postgres.js'] },
  { id: 'mysql', label: 'MySQL', deps: ['mysql', 'mysql2'] },
  { id: 'mongodb', label: 'MongoDB', deps: ['mongodb', 'mongoose'] },
  { id: 'redis', label: 'Redis', deps: ['redis', 'ioredis'] },
  { id: 'sqlite', label: 'SQLite', deps: ['better-sqlite3', 'sqlite3'] },
  // backend
  { id: 'express', label: 'Express', deps: ['express'] },
  { id: 'fastify', label: 'Fastify', deps: ['fastify'] },
  { id: 'hono', label: 'Hono', deps: ['hono'] },
  { id: 'nestjs', label: 'NestJS', prefixes: ['@nestjs/'] },
  { id: 'trpc', label: 'tRPC', prefixes: ['@trpc/'] },
  { id: 'graphql', label: 'GraphQL', deps: ['graphql', 'apollo-server', '@apollo/client'] },
  // testing
  { id: 'playwright-installed', label: 'Playwright (already in project)', deps: ['@playwright/test', 'playwright'] },
  { id: 'cypress', label: 'Cypress', deps: ['cypress'] },
  { id: 'vitest', label: 'Vitest', deps: ['vitest'] },
  { id: 'jest', label: 'Jest', deps: ['jest'] },
  // tooling
  { id: 'typescript', label: 'TypeScript', deps: ['typescript'] },
  { id: 'monorepo', label: 'Monorepo tooling', deps: ['turbo', 'nx', 'lerna'] },
]

/** A file or directory whose presence is itself a signal. */
const FILE_RULES: Array<{ id: string; label: string; paths: string[]; note?: string }> = [
  { id: 'git', label: 'Git repository', paths: ['.git'] },
  { id: 'docker', label: 'Docker', paths: ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yaml'] },
  { id: 'ci', label: 'GitHub Actions', paths: ['.github/workflows'] },
  { id: 'supabase', label: 'Supabase', paths: ['supabase'] },
  { id: 'prisma', label: 'Prisma', paths: ['prisma'] },
  { id: 'vercel', label: 'Vercel', paths: ['vercel.json', '.vercel'] },
  { id: 'netlify', label: 'Netlify', paths: ['netlify.toml'] },
  { id: 'go', label: 'Go', paths: ['go.mod'] },
  { id: 'rust', label: 'Rust', paths: ['Cargo.toml'] },
  { id: 'java', label: 'Java', paths: ['pom.xml', 'build.gradle', 'build.gradle.kts'] },
  { id: 'ruby', label: 'Ruby', paths: ['Gemfile'] },
  { id: 'php', label: 'PHP', paths: ['composer.json'] },
  { id: 'dotnet', label: '.NET', paths: ['global.json'] },
  { id: 'monorepo', label: 'Monorepo tooling', paths: ['turbo.json', 'nx.json', 'pnpm-workspace.yaml'] },
  { id: 'nextjs', label: 'Next.js', paths: ['next.config.js', 'next.config.ts', 'next.config.mjs'] },
  { id: 'vite', label: 'Vite', paths: ['vite.config.js', 'vite.config.ts', 'vite.config.mjs'] },
]

/** Python requirements, matched against requirements.txt / pyproject.toml text. */
const PY_RULES: Array<{ id: string; label: string; names: string[] }> = [
  { id: 'django', label: 'Django', names: ['django'] },
  { id: 'fastapi', label: 'FastAPI', names: ['fastapi'] },
  { id: 'flask', label: 'Flask', names: ['flask'] },
  { id: 'pandas', label: 'pandas', names: ['pandas'] },
  { id: 'postgres', label: 'PostgreSQL', names: ['psycopg', 'psycopg2', 'asyncpg'] },
  { id: 'supabase', label: 'Supabase', names: ['supabase'] },
]

export function scanProject(dir: string): ProjectScan {
  const signals: Signal[] = []
  const add = (id: string, label: string, evidence: string) => {
    if (!signals.some((s) => s.id === id)) signals.push({ id, label, evidence })
  }

  // --- dependencies, across every workspace manifest ---
  const manifests = collectManifests(dir)
  if (manifests.length) add('node', 'Node.js', `${manifests.length} package.json file(s)`)

  for (const { rel, pkg } of manifests) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies }
    const names = Object.keys(deps)
    if (!names.length) continue
    for (const rule of DEP_RULES) {
      const hit =
        rule.deps?.find((d) => d in deps) ??
        (rule.prefixes ? names.find((n) => rule.prefixes!.some((p) => n.startsWith(p))) : undefined)
      if (hit) add(rule.id, rule.label, `${rel} depends on ${hit}`)
    }
  }

  // --- marker files ---
  for (const rule of FILE_RULES) {
    const hit = rule.paths.find((p) => existsSync(join(dir, p)))
    if (hit) add(rule.id, rule.label, `${hit} present`)
  }

  // --- python ---
  for (const file of ['requirements.txt', 'pyproject.toml']) {
    const p = join(dir, file)
    if (!existsSync(p)) continue
    add('python', 'Python', `${file} present`)
    // Reduce each line to its bare package name first, then match. Scanning the
    // raw text instead misses real distributions whose name merely starts with
    // the library: psycopg2-binary, django-rest-framework, flask-cors.
    const declared = readFileSync(p, 'utf8')
      .split('\n')
      .map((l) => l.split('#')[0].trim().replace(/^[-\s"']+/, ''))
      .map((l) => l.split(/[=<>~!;[\s,]/)[0].trim().toLowerCase())
      .filter(Boolean)
    for (const rule of PY_RULES) {
      const hit = declared.find((d) => rule.names.some((n) => d === n || d.startsWith(`${n}-`) || d.startsWith(n)))
      if (hit) add(rule.id, rule.label, `${file} requires ${hit}`)
    }
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

  return { dir, signals, isProject: signals.length > 0, manifests: manifests.map((m) => m.rel) }
}

/** Frontend frameworks — anything here means browser tooling is worth offering. */
export const FRONTEND_SIGNALS = [
  'nextjs', 'nuxt', 'astro', 'remix', 'sveltekit', 'angular',
  'react', 'vue', 'svelte', 'solid', 'vite',
]
