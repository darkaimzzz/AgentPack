import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { scanProject } from './project.ts'

const sandbox = mkdtempSync(join(tmpdir(), 'agentpack-detection-'))

const fixture = (name: string, files: Record<string, string>) => {
  const root = join(sandbox, name)
  mkdirSync(root, { recursive: true })
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath)
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, contents)
  }
  return root
}

const ids = (root: string) => scanProject(root).signals.map((signal) => signal.id)

const tests: Array<[string, () => void]> = [
  ['finds Next.js and Supabase in a nested app without a root manifest', () => {
    const root = fixture('nested-app', {
      'source/web/package.json': JSON.stringify({ dependencies: { next: '15.2.0', '@supabase/ssr': '0.6.0' } }),
      'source/web/next.config.mjs': 'export default {}',
      'source/web/supabase/config.toml': 'project_id = "local"',
    })
    assert.ok(ids(root).includes('nextjs'))
    assert.ok(ids(root).includes('supabase'))
    assert.match(scanProject(root).signals.find((signal) => signal.id === 'nextjs')!.evidence, /source[\\/]web/)
  }],
  ['expands nested workspace globs while ignoring generated dependency trees', () => {
    const root = fixture('workspace-glob', {
      'package.json': JSON.stringify({ workspaces: ['products/*/apps/*'] }),
      'products/store/apps/web/package.json': JSON.stringify({ dependencies: { next: '15.2.0' } }),
      'node_modules/vendor/package.json': JSON.stringify({ dependencies: { '@supabase/supabase-js': '2.0.0' } }),
      '.next/package.json': JSON.stringify({ dependencies: { '@supabase/supabase-js': '2.0.0' } }),
    })
    const scan = scanProject(root)
    assert.ok(scan.signals.some((signal) => signal.id === 'nextjs'))
    assert.ok(!scan.signals.some((signal) => signal.id === 'supabase'))
    assert.equal(scan.manifests.length, 2)
  }],
  ['uses Supabase config and environment variable names without exposing values', () => {
    const secret = 'sbp_do_not_expose_123'
    const root = fixture('supabase-markers', {
      'apps/site/.env.local': `NEXT_PUBLIC_SUPABASE_URL=https://example.invalid\nSUPABASE_ACCESS_TOKEN=${secret}\n`,
      'apps/site/supabase/config.toml': 'project_id = "demo"',
    })
    const scan = scanProject(root)
    const signal = scan.signals.find((candidate) => candidate.id === 'supabase')
    assert.ok(signal)
    assert.ok(!JSON.stringify(scan).includes(secret))
    assert.match(signal.evidence, /apps[\\/]site/)
  }],
  ['does not infer PostgreSQL from DATABASE_URL alone', () => {
    const root = fixture('generic-database-url', { '.env.example': 'DATABASE_URL=mysql://localhost/demo\n' })
    assert.ok(!ids(root).includes('postgres'))
  }],
  ['ignores workspace paths outside the scan root and symlinked vendor trees', () => {
    const outside = fixture('outside', { 'package.json': JSON.stringify({ dependencies: { next: '15.2.0' } }) })
    const root = fixture('safe-root', { 'package.json': JSON.stringify({ workspaces: ['../outside'] }) })
    try {
      symlinkSync(outside, join(root, 'vendor-link'), 'junction')
    } catch {
      // Junction creation may be disabled by Windows policy; traversal protection
      // is still exercised by the escaping workspace declaration above.
    }
    assert.ok(!ids(root).includes('nextjs'))
    assert.deepEqual(scanProject(root).manifests, ['package.json'])
  }],
  ['returns safely for malformed and inaccessible-looking inputs', () => {
    const root = fixture('malformed', {
      'package.json': '{',
      'apps/web/package.json': '{ also broken',
      'apps/web/.env': '\u0000BROKEN\nSUPABASE_URL',
    })
    assert.doesNotThrow(() => scanProject(root))
    assert.doesNotThrow(() => scanProject(join(root, 'missing')))
  }],
]

let failures = 0
for (const [name, run] of tests) {
  try {
    run()
    console.log(`\u001b[32m✓\u001b[0m ${name}`)
  } catch (error) {
    failures++
    console.error(`\u001b[31m✗\u001b[0m ${name}\n  ${(error as Error).message}`)
  }
}

process.exitCode = failures ? 1 : 0
