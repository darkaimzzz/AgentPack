import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { registryRoot } from '../capabilities/registry.ts'
import { listRuntime, setState, validateConfig } from './state.ts'
import { adapters } from '../agents/index.ts'
import type { AgentKey, CapabilityProfile, ProfileResult, RuntimeMutationResult } from '../types.ts'

/**
 * Profiles (PRD §11): a named set of capabilities that should be active.
 *
 * Stored as data in registry/profiles/*.json, matching how capabilities and
 * packs are stored, a profile is never hard-coded into a component.
 */

let cache: CapabilityProfile[] | null = null

export function profiles(): CapabilityProfile[] {
  if (cache) return cache
  const dir = join(registryRoot(), 'profiles')
  if (!existsSync(dir)) return (cache = [])
  return (cache = readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')) as CapabilityProfile)
    .sort((a, b) => a.name.localeCompare(b.name)))
}

function getProfile(id: string): CapabilityProfile {
  const p = profiles().find((x) => x.id === id)
  if (!p) throw new Error(`unknown profile: ${id}`)
  return p
}

export type ProfilePlan = {
  profile: CapabilityProfile
  activate: Array<{ capabilityId: string; agent: AgentKey }>
  deactivate: Array<{ capabilityId: string; agent: AgentKey }>
  /** Already in the desired state, shown so the diff is honest about doing nothing. */
  unchanged: Array<{ capabilityId: string; agent: AgentKey }>
  /**
   * Wanted by the profile but not installed for that agent, so it cannot be
   * activated from here. Surfaced rather than silently skipped, so the UI can
   * say "GitHub is not installed" instead of quietly doing nothing (§11).
   */
  unavailable: Array<{ capabilityId: string; agent: AgentKey }>
  /**
   * Agents whose config cannot be parsed. Their capabilities all read as
   * "unknown", which the diff would otherwise skip silently, leaving the user
   * with a profile that appears applied and an agent that never changed.
   */
  blocked: Array<{ agent: AgentKey; error: string }>
}

/**
 * Work out what applying a profile would change, without changing anything.
 *
 * Only capabilities CLM can actually manage are considered: a profile naming a
 * plugin, or one that was never installed, cannot be activated from here and is
 * left out of the plan rather than silently "succeeding".
 */
export function planProfile(profileId: string, agents?: AgentKey[]): ProfilePlan {
  const profile = getProfile(profileId)
  const want = new Set(profile.activeCapabilityIds)
  const plan: ProfilePlan = { profile, activate: [], deactivate: [], unchanged: [], unavailable: [], blocked: [] }

  const records = listRuntime(agents)
  for (const agent of new Set(records.map((r) => r.agent))) {
    const v = validateConfig(adapters[agent])
    if (!v.ok) plan.blocked.push({ agent, error: v.error ?? 'config could not be parsed' })
  }
  const blockedAgents = new Set(plan.blocked.map((b) => b.agent))

  for (const rec of records) {
    if (blockedAgents.has(rec.agent)) continue // nothing can be decided for it
    // CLM manages MCP servers only; plugins are not part of a profile diff.
    if (rec.capability.type !== 'mcp') continue
    const target = want.has(rec.capability.id) ? 'active' : 'dormant'
    const entry = { capabilityId: rec.capability.id, agent: rec.agent }

    if (rec.state === target) { plan.unchanged.push(entry); continue }
    // 'unknown' means not installed for this agent. We can make an installed
    // capability dormant, but we cannot activate one that was never installed.
    if (rec.state === 'unknown') {
      // Not installed for this agent. Only worth reporting when the profile
      // actually wanted it active; nothing to do when it wanted it off.
      if (target === 'active') plan.unavailable.push(entry)
      continue
    }
    ;(target === 'active' ? plan.activate : plan.deactivate).push(entry)
  }

  return plan
}

/**
 * Apply a profile.
 *
 * Deactivations run first so context is freed before anything new is loaded,
 * and so a failure part-way leaves fewer tools active rather than more.
 * A partial failure is reported as partial, never a green tick over a config
 * that is not what the user asked for (§11).
 */
export function applyProfile(profileId: string, agents?: AgentKey[]): ProfileResult {
  const plan = planProfile(profileId, agents)
  const results: RuntimeMutationResult[] = []

  for (const { capabilityId, agent } of plan.deactivate) {
    results.push(setState(capabilityId, agent, 'dormant', { source: 'profile' }))
  }
  for (const { capabilityId, agent } of plan.activate) {
    results.push(setState(capabilityId, agent, 'active', { source: 'profile' }))
  }

  // An agent we could not read is a failure of this profile switch, not a
  // silent no-op: the user asked for a state that agent is not now in.
  for (const b of plan.blocked) {
    results.push({
      success: false, capabilityId: '(all)', agent: b.agent,
      from: 'unknown', to: 'unknown', changedFiles: [],
      error: `${adapters[b.agent].name} config could not be parsed: ${b.error}. No changes were applied to it.`,
    })
  }

  for (const { capabilityId, agent } of plan.unavailable) {
    results.push({ success: false, capabilityId, agent, from: 'unknown', to: 'unknown',
      changedFiles: [], error: 'Required by this profile but not installed; install it first.' })
  }
  const failed = results.filter((r) => !r.success)
  return {
    profile: plan.profile,
    results,
    status: !failed.length ? 'ok' : failed.length === results.length ? 'failed' : 'partial',
  }
}

/**
 * Which profile, if any, the current live state already matches.
 * Used to show the selected profile honestly rather than remembering a click.
 */
export function currentProfile(agents?: AgentKey[]): CapabilityProfile | null {
  const records = listRuntime(agents).filter((r) => r.capability.type === 'mcp')
  if (!records.some((r) => r.state !== 'unknown')) return null
  if (records.some((r) => !validateConfig(adapters[r.agent]).ok)) return null
  return profiles().find((p) => {
    const want = new Set(p.activeCapabilityIds)
    return records.every((r) => want.has(r.capability.id)
      ? r.state === 'active'
      : r.state !== 'active')
  }) ?? null
}
