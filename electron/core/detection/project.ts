import { globSync, lstatSync, readFileSync } from 'node:fs'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'

/**
 * Deterministic project stack detection (CLAUDE.md §11).
 * File and dependency checks only — no LLM in the golden path. Every signal
 * carries the evidence that produced it, so the UI can always answer "why?".
 */

import type { ProjectScan, Signal } from '../types.ts'
export type { ProjectScan, Signal }

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

const readTextFile = (p: string): string | null => {
  try {
    return readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

const isPlainPath = (p: string) => {
  try {
    return !lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

const IGNORED_PARTS = new Set([
  'node_modules', '.next', '.nuxt', '.svelte-kit', '.astro', '.git', '.turbo',
  '.vercel', '.cache', '.parcel-cache', 'dist', 'build', 'out', 'coverage',
  'vendor', 'target', '.qa', '.agentpack', 'release',
])
const MAX_FILES = 256

const isSafeRelative = (path: string) => {
  if (!path || isAbsolute(path)) return false
  const parts = path.replaceAll('\\', '/').split('/').filter(Boolean)
  return !parts.includes('..') && !parts.some((part) => IGNORED_PARTS.has(part))
}

const isInside = (root: string, path: string) => {
  const rel = relative(root, path)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

/** Native globbing keeps wildcard behavior predictable; explicit depths bound IO. */
const findFiles = (root: string, patterns: string[]) => {
  if (!isPlainPath(root)) return []
  try {
    const matches = globSync(patterns, { cwd: root, exclude: [...IGNORED_PARTS].map(p => `**/${p}/**`) })
    return [...new Set(matches)]
      .filter(isSafeRelative)
      .filter((rel) => {
        const absolute = resolve(root, rel)
        if (!isInside(root, absolute) || !isPlainPath(absolute)) return false
        // Do not cross a symlinked parent directory.
        let parent = absolute
        while (parent !== root) {
          parent = resolve(parent, '..')
          if (parent !== root && !isPlainPath(parent)) return false
        }
        return true
      })
      .sort((a, b) => a.split(/[\\/]/).length - b.split(/[\\/]/).length || a.localeCompare(b))
      .slice(0, MAX_FILES)
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
  const rootManifest = join(root, 'package.json')
  const rootPkg = isPlainPath(rootManifest) ? readJsonFile<Pkg>(rootManifest) : null

  // Workspace patterns, from package.json or pnpm-workspace.yaml.
  const declared = Array.isArray(rootPkg?.workspaces)
    ? rootPkg.workspaces
    : rootPkg?.workspaces?.packages ?? []

  const pnpmFile = join(root, 'pnpm-workspace.yaml')
  const pnpmText = isPlainPath(pnpmFile) ? readTextFile(pnpmFile) : null
  const fromPnpm = pnpmText
    // Small, predictable YAML: a `packages:` list of quoted globs. Matching the
    // globs directly avoids taking on a YAML parser for two lines of config.
    ? [...pnpmText.matchAll(/^\s*-\s*['"]?([^'"\n]+)['"]?/gm)].map((m) => m[1].trim())
    : []

  const declaredPatterns = [...(Array.isArray(declared) ? declared : []), ...fromPnpm]
    .filter((pattern): pattern is string => typeof pattern === 'string')
    .map((pattern) => pattern.replaceAll('\\', '/').replace(/\/$/, ''))
    .filter((pattern) => !pattern.startsWith('!') && isSafeRelative(pattern) && !pattern.includes('**'))
    .map((pattern) => `${pattern}/package.json`)
    .slice(0, 64)
  const boundedNested = [
    'package.json', '*/package.json', '*/*/package.json', '*/*/*/package.json', '*/*/*/*/package.json',
  ]

  for (const rel of findFiles(root, [...boundedNested, ...declaredPatterns])) {
    const pkg = readJsonFile<Pkg>(join(root, rel))
    if (pkg) out.push({ rel, pkg })
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
  { id: 'nextjs', label: 'Next.js', paths: ['next.config.js', 'next.config.ts', 'next.config.mjs', 'next.config.cjs'] },
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

  if (!isPlainPath(dir)) return { dir, signals, isProject: false, manifests: [] }

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

  // --- root marker files ---
  for (const rule of FILE_RULES) {
    const hit = rule.paths.find((p) => isPlainPath(join(dir, p)))
    if (hit) add(rule.id, rule.label, `${hit} present`)
  }

  // Framework/service markers commonly live inside a monorepo app. Keep the
  // search at four directory levels and skip generated, vendor and symlinked trees.
  const nestedMarkers = findFiles(dir, [
    '{*,*/*,*/*/*,*/*/*/*}/next.config.{js,ts,mjs,cjs}',
    '{*,*/*,*/*/*,*/*/*/*}/supabase/config.toml',
  ])
  const nextMarker = nestedMarkers.find((path) => /(^|[\\/])next\.config\.(js|ts|mjs|cjs)$/.test(path))
  if (nextMarker) add('nextjs', 'Next.js', `${nextMarker} present`)
  const supabaseMarker = nestedMarkers.find((path) => /(^|[\\/])supabase[\\/]config\.toml$/.test(path))
  if (supabaseMarker) add('supabase', 'Supabase', `${supabaseMarker} present`)

  // --- python ---
  for (const file of ['requirements.txt', 'pyproject.toml']) {
    const p = join(dir, file)
    if (!isPlainPath(p)) continue
    add('python', 'Python', `${file} present`)
    // Reduce each line to its bare package name first, then match. Scanning the
    // raw text instead misses real distributions whose name merely starts with
    // the library: psycopg2-binary, django-rest-framework, flask-cors.
    const text = readTextFile(p)
    if (text === null) continue
    const declared = text
      .split('\n')
      .map((l) => l.split('#')[0].trim().replace(/^[-\s"']+/, ''))
      .map((l) => l.split(/[=<>~!;[\s,]/)[0].trim().toLowerCase())
      .filter(Boolean)
    for (const rule of PY_RULES) {
      const hit = declared.find((d) => rule.names.some((n) => d === n || d.startsWith(`${n}-`) || d.startsWith(n)))
      if (hit) add(rule.id, rule.label, `${file} requires ${hit}`)
    }
  }

  // Read names only from bounded env files. Values never leave this function.
  for (const envFile of findFiles(dir, [
    '.env', '.env.*', '*/.env', '*/.env.*', '*/*/.env', '*/*/.env.*',
    '*/*/*/.env', '*/*/*/.env.*', '*/*/*/*/.env', '*/*/*/*/.env.*',
  ])) {
    const text = readTextFile(join(dir, envFile))
    if (text === null) continue
    const keys = text
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'))
      .map((l) => l.split('=')[0].trim())
    if (keys.some((k) => /^SUPABASE(?:_|$)/i.test(k) || /^(?:NEXT_PUBLIC_|VITE_)?SUPABASE_/i.test(k))) {
      add('supabase', 'Supabase', `${envFile} declares a Supabase variable`)
    }
    if (keys.some((k) => /^GITHUB_/i.test(k))) add('github-env', 'GitHub credentials', `${envFile} declares a GITHUB_* variable`)
  }

  return { dir, signals, isProject: signals.length > 0, manifests: manifests.map((m) => m.rel) }
}

/** Frontend frameworks — anything here means browser tooling is worth offering. */
export const FRONTEND_SIGNALS = [
  'nextjs', 'nuxt', 'astro', 'remix', 'sveltekit', 'angular',
  'react', 'vue', 'svelte', 'solid', 'vite',
]
