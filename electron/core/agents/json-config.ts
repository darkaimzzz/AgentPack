import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { parse as parseJsonc, applyEdits, modify, type ParseError } from 'jsonc-parser'

/** Strict JSON read. Used where the format really is plain JSON. */
export function readJson<T = Record<string, unknown>>(path: string): T {
  const raw = readFileSync(path, 'utf8')
  try {
    return JSON.parse(raw) as T
  } catch (e) {
    throw new Error(`${path} is not valid JSON: ${(e as Error).message}`)
  }
}

export function writeJson(path: string, obj: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(obj, null, 2) + '\n')
}

/**
 * Read JSON with comments and trailing commas — the `.jsonc` OpenCode ships.
 * Rejecting a comment would refuse a file the agent itself considers valid.
 */
export function readJsonc<T = Record<string, unknown>>(path: string): T {
  const raw = readFileSync(path, 'utf8')
  const errors: ParseError[] = []
  const value = parseJsonc(raw, errors, { allowTrailingComma: true }) as T
  if (errors.length) throw new Error(`${path} could not be parsed as JSONC (${errors.length} error(s))`)
  return value ?? ({} as T)
}

/**
 * Edit one path in a JSONC document in place, preserving comments and
 * formatting everywhere else. Passing `undefined` removes the key.
 */
export function editJsonc(path: string, jsonPath: Array<string | number>, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  let raw = ''
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    raw = '{}\n'
  }
  const edits = modify(raw, jsonPath, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  writeFileSync(path, applyEdits(raw, edits))
}
