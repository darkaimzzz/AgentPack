import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { atomicWrite } from '../files.ts'
import { parse as parseJsonc, applyEdits, modify, type ParseError } from 'jsonc-parser'

/** Strict JSON read. Used where the format really is plain JSON. */
export function readJson<T = Record<string, unknown>>(path: string): T {
  const raw = readFileSync(path, 'utf8')
  try {
    const value = JSON.parse(raw)
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an object')
    for (const key of ['mcpServers', 'mcp', 'enabledPlugins', 'extraKnownMarketplaces']) {
      if (value[key] !== undefined && (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key]))) throw new Error('Invalid config section')
    }
    return value as T
  } catch (e) {
    throw new Error(`${path} is not valid JSON`)
  }
}

/**
 * Write JSON back, matching the file's existing formatting.
 *
 * The agent owns this file; we are a guest in it. Imposing our own indentation
 * or trailing newline shows up as spurious churn in the user's diffs, and it
 * was enough on its own to stop a rollback being byte-identical.
 */
export function writeJson(path: string, obj: unknown): void {
  let indent: string | number = 2
  let trailingNewline = true

  try {
    const existing = readFileSync(path, 'utf8')
    // Indentation of the first nested line, if the file has one.
    const m = existing.match(/^\{\r?\n([ \t]+)/)
    if (m) indent = m[1].includes('\t') ? '\t' : m[1].length
    trailingNewline = /\n$/.test(existing)
  } catch {
    // New file: our defaults are as good as any.
  }

  mkdirSync(dirname(path), { recursive: true })
  atomicWrite(path, JSON.stringify(obj, null, indent) + (trailingNewline ? '\n' : ''))
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
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(path + ' must contain a config object')
  const doc = value as Record<string, unknown>
  if (doc.mcp !== undefined && (!doc.mcp || typeof doc.mcp !== 'object' || Array.isArray(doc.mcp))) throw new Error(path + ' has an invalid MCP section')
  return value
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
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e
    raw = '{}\n'
  }
  const edits = modify(raw, jsonPath, value, {
    formattingOptions: { insertSpaces: true, tabSize: 2 },
  })
  atomicWrite(path, applyEdits(raw, edits))
}
