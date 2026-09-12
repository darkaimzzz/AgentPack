import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** Each demo gets fresh agent configs and a nested Next.js + Supabase project. */
export function createDemo() {
  const home = mkdtempSync(join(tmpdir(), 'agentpack-demo-'))
  const project = join(home, 'next-supabase-app')
  const files: Record<string, string> = {
    '.claude.json': '{"mcpServers":{}}\n',
    '.claude/settings.json': '{}\n',
    '.codex/config.toml': '# Demo agent configuration\n',
    '.config/opencode/opencode.jsonc': '{\n  "mcp": {}\n}\n',
    'next-supabase-app/package.json': JSON.stringify({ private: true, workspaces: ['apps/*'] }, null, 2),
    'next-supabase-app/apps/web/package.json': JSON.stringify({ dependencies: { next: '16.0.0', react: '19.0.0', '@supabase/ssr': '0.7.0' } }, null, 2),
    'next-supabase-app/apps/web/next.config.ts': 'export default {}\n',
    'next-supabase-app/apps/web/supabase/config.toml': 'project_id = "demo"\n',
  }
  for (const [relative, text] of Object.entries(files)) {
    const path = join(home, relative)
    mkdirSync(join(path, '..'), { recursive: true })
    writeFileSync(path, text)
  }
  process.env.AGENTPACK_HOME = home
  process.env.AGENTPACK_DEMO = '1'
  process.env.AGENTPACK_DEMO_PROJECT = project
  return { home, project }
}
