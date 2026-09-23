import { capabilities } from '../capabilities/registry.ts'
import { FRONTEND_SIGNALS, type ProjectScan, type Signal } from '../detection/project.ts'
import type { Capability, Recommendation } from '../types.ts'
export type { Recommendation }

/**
 * Deterministic rules: signal -> capability (CLAUDE.md §11).
 *
 * Rules are data. They stay boring on purpose, a judge should be able to read
 * this file and predict exactly what the app will recommend. Optional AI may
 * later narrate a reason, but must never decide one.
 */

export type Rule = {
  capabilityId: string
  /** Recommend when ANY of these signals is present. */
  anyOf: string[]
  /** Explanation template; {evidence} is replaced by the matching signal's evidence. */
  because: string
}

export const RULES: Rule[] = [
  {
    capabilityId: 'github',
    anyOf: ['git', 'github-env', 'ci'],
    because: 'Repository tooling is useful here, {evidence}.',
  },
  {
    capabilityId: 'playwright',
    anyOf: [...FRONTEND_SIGNALS, 'cypress', 'playwright-installed'],
    because: 'A frontend was detected, so browser and E2E tooling helps, {evidence}.',
  },
  {
    capabilityId: 'filesystem',
    anyOf: ['node', 'python', 'git', 'go', 'rust', 'java', 'ruby', 'php', 'dotnet'],
    because: 'Scoped file access for this project, {evidence}.',
  },
  {
    capabilityId: 'supabase',
    anyOf: ['supabase'],
    because: 'Supabase is part of this stack, {evidence}.',
  },
  {
    capabilityId: 'context7',
    // Any project built on a framework benefits from version-correct docs.
    anyOf: [...FRONTEND_SIGNALS, 'nestjs', 'express', 'fastify', 'hono', 'trpc',
      'django', 'fastapi', 'flask', 'prisma', 'drizzle', 'tailwind'],
    because: 'Version-accurate docs for the libraries in this stack, {evidence}.',
  },
  {
    capabilityId: 'git',
    anyOf: ['git'],
    because: 'Local repository operations, status, diffs and history, {evidence}.',
  },
  {
    // One server speaks Postgres, MySQL, MariaDB, SQLite and SQL Server, so a
    // single rule covers every SQL signal the detector knows about.
    capabilityId: 'dbhub',
    anyOf: ['postgres', 'mysql', 'sqlite', 'prisma', 'drizzle'],
    because: 'A SQL database is part of this stack, {evidence}.',
  },
  {
    capabilityId: 'mongodb',
    anyOf: ['mongodb'],
    because: 'MongoDB is part of this stack, {evidence}.',
  },
  {
    capabilityId: 'redis',
    anyOf: ['redis'],
    because: 'Redis is part of this stack, {evidence}.',
  },
  {
    capabilityId: 'prisma',
    anyOf: ['prisma'],
    because: 'Prisma schema and migration tooling, {evidence}.',
  },
  {
    capabilityId: 'expo',
    anyOf: ['react-native'],
    because: 'A React Native app was detected, {evidence}.',
  },
  {
    capabilityId: 'netlify',
    anyOf: ['netlify'],
    because: 'This project deploys to Netlify, {evidence}.',
  },
  {
    capabilityId: 'chrome-devtools',
    anyOf: [...FRONTEND_SIGNALS],
    because: 'Inspect the running page, performance, console and network, {evidence}.',
  },
]


export function recommend(scan: ProjectScan): Recommendation[] {
  const known = new Map(capabilities().map((c) => [c.id, c]))
  const out: Recommendation[] = []

  for (const rule of RULES) {
    const capability = known.get(rule.capabilityId)
    // A rule may name a capability the registry does not carry (yet). Skip it
    // silently rather than recommending something we cannot install.
    if (!capability) continue

    const matched = scan.signals.filter((s) => rule.anyOf.includes(s.id))
    if (!matched.length) continue

    out.push({
      capability,
      reason: rule.because.replace('{evidence}', matched[0].evidence),
      matched,
    })
  }

  return out
}

/** Capabilities in the registry that nothing recommended, offered as opt-in extras. */
export function alsoAvailable(recs: Recommendation[]): Capability[] {
  const taken = new Set(recs.map((r) => r.capability.id))
  return capabilities().filter((c) => !taken.has(c.id))
}
