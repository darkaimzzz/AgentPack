import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * Read a JSON config.
 *
 * We refuse rather than guess on parse failure. Naive comment-stripping would
 * corrupt any string containing "//" — and OpenCode's own config ships with
 * "https://opencode.ai/config.json" in it.
 * ponytail: JSON only; add jsonc-parser if a real commented config turns up.
 */
export function readJson<T = Record<string, unknown>>(path: string): T {
  const raw = readFileSync(path, 'utf8')
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    throw new Error(`${path} is not plain JSON (comments?): ${(e as Error).message}`)
  }
}

export function writeJson(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n')
}
