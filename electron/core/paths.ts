import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * AGENTPACK_HOME redirects every agent config path into a sandbox.
 * Dev and demo rehearsal use it so we never race the live Claude Code session
 * for ~/.claude.json, which that process owns and rewrites.
 */
export const home = () => process.env.AGENTPACK_HOME || homedir()

export const stateDir = () => join(home(), '.agentpack')
export const backupRoot = () => join(stateDir(), 'backups')
export const ledgerPath = () => join(stateDir(), 'installs.json')

export const stamp = () => new Date().toISOString().replace(/[:.]/g, '-')
