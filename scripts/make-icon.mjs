// Build build/icon.ico from the two SVG sources.
//
// A .ico holds several images and Windows picks the nearest size, so the small
// entries are rendered from icon-small.svg — a deliberately simplified drawing.
// The taskbar shows 24 or 32px depending on DPI, and detail at that size turns
// to mush, which is the whole reason for the second source.
//
// Uses npx rather than devDependencies: this runs when the icon changes, which
// is close to never, and sharp alone is a ~30MB install to carry for that.
//
//   node scripts/make-icon.mjs
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const out = join(root, 'build', 'icon.ico')
// Windows renders the taskbar at 24 or 32; the rest cover Explorer and alt-tab.
const SIZES = [
  { px: 16, src: 'icon-small.svg' },
  { px: 24, src: 'icon-small.svg' },
  { px: 32, src: 'icon-small.svg' },
  { px: 48, src: 'icon.svg' },
  { px: 64, src: 'icon.svg' },
  { px: 128, src: 'icon.svg' },
  { px: 256, src: 'icon.svg' },
]

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx'
const opts = { cwd: root, shell: process.platform === 'win32' }
const run = (args) => execFileSync(npx, ['--yes', ...args], { ...opts, stdio: 'inherit' })

const tmp = mkdtempSync(join(tmpdir(), 'agentpack-icon-'))
try {
  const pngs = []
  for (const { px, src } of SIZES) {
    // sharp-cli treats -o as a filename unless the directory already exists.
    const dir = join(tmp, String(px))
    mkdirSync(dir, { recursive: true })
    run(['sharp-cli', '-i', join(root, 'build', src), '-o', dir, '--format', 'png', 'resize', String(px), String(px)])
    const produced = join(dir, src.replace(/\.svg$/, '.png'))
    if (!existsSync(produced)) throw new Error(`sharp produced nothing for ${px}px: ${produced}`)
    // Rename so the sizes pack in ascending order regardless of source file.
    const named = join(tmp, `icon-${String(px).padStart(3, '0')}.png`)
    writeFileSync(named, readFileSync(produced))
    pngs.push(named)
  }
  // png-to-ico writes the icon to stdout.
  const ico = execFileSync(npx, ['--yes', 'png-to-ico', ...pngs], { ...opts, maxBuffer: 64 * 1024 * 1024 })
  if (ico.length < 1000) throw new Error(`png-to-ico returned ${ico.length} bytes — expected an icon`)
  writeFileSync(out, ico)

  // Report what the file actually contains, not what was offered: png-to-ico
  // keeps the standard Windows set and drops the rest.
  const count = ico.readUInt16LE(4)
  const kept = Array.from({ length: count }, (_, i) => ico[6 + i * 16] || 256).sort((a, b) => a - b)
  if (!kept.includes(16) || !kept.includes(32)) throw new Error(`icon is missing small sizes: ${kept}`)
  console.log(`wrote ${out} — ${ico.length} bytes, sizes: ${kept.join(', ')}`)
} finally {
  rmSync(tmp, { recursive: true, force: true })
}
