import { useCallback, useEffect, useState } from 'react'
import type { AgentKey, ClmView, ClmRow, CapabilityProfile } from '../types.ts'

type UiState = 'loading' | 'ready' | 'mutating' | 'partial_failure' | 'error'

/**
 * Capability Load Manager.
 *
 * Installed ≠ loaded. Every active MCP server carries its tool schemas in the
 * agent's context every session; this screen shows what that costs and lets the
 * user keep capabilities installed but dormant.
 */
export default function Dashboard() {
  const [view, setView] = useState<ClmView | null>(null)
  const [profiles, setProfiles] = useState<CapabilityProfile[]>([])
  const [ui, setUi] = useState<UiState>('loading')
  const [busyId, setBusyId] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [measuring, setMeasuring] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const [v, p] = await Promise.all([window.agentpack.clmView(), window.agentpack.clmProfiles()])
      setView(v)
      setProfiles(p)
      setUi((s) => (s === 'partial_failure' ? s : 'ready'))
    } catch (e) {
      setMessage(`Could not read capability state: ${(e as Error).message}`)
      setUi('error')
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])

  async function toggle(row: ClmRow, agent: AgentKey, to: 'active' | 'dormant') {
    setBusyId(`${row.capability.id}:${agent}`)
    setUi('mutating')
    setMessage(null)
    try {
      const r = await window.agentpack.clmSetState({ capabilityId: row.capability.id, agent, state: to })
      if (!r.success) {
        setMessage(r.error ?? 'The change could not be applied.')
        setUi('partial_failure')
      } else {
        setUi('ready')
      }
      await refresh()
    } catch (e) {
      setMessage(`${row.capability.name}: ${(e as Error).message}`)
      setUi('error')
    } finally {
      setBusyId(null)
    }
  }

  async function useProfile(id: string) {
    setUi('mutating')
    setMessage(null)
    setBusyId(`profile:${id}`)
    try {
      const r = await window.agentpack.clmApplyProfile(id)
      const failures = r.results.filter((x) => !x.success)
      if (r.status === 'ok') {
        const changed = r.results.length
        setMessage(changed ? `Applied ${r.profile.name} — ${changed} change${changed === 1 ? '' : 's'}.` : `Already on ${r.profile.name}.`)
        setUi('ready')
      } else {
        // Never a green tick over a config that is not what was asked for.
        setMessage(`${r.profile.name} applied partially. ${failures.map((f) => `${f.capabilityId}/${f.agent}: ${f.error}`).join(' · ')}`)
        setUi('partial_failure')
      }
      await refresh()
    } catch (e) {
      setMessage((e as Error).message)
      setUi('error')
    } finally {
      setBusyId(null)
    }
  }

  async function measure() {
    setMeasuring(true)
    setMessage(null)
    try {
      await window.agentpack.clmMeasure()
      await refresh()
    } catch (e) {
      setMessage(`Measuring failed: ${(e as Error).message}`)
      setUi('error')
    } finally {
      setMeasuring(false)
    }
  }

  if (!view) {
    return (
      <div className="wrap">
        <h2>Capability Load Manager</h2>
        <p className="sub">{ui === 'error' ? message : 'Reading your agent configuration…'}</p>
      </div>
    )
  }

  const { summary } = view
  const pct = summary.allTokens > 0 ? Math.round((1 - summary.activeTokens / summary.allTokens) * 100) : 0
  const unmeasured = view.rows.filter((r) => !r.cost).length

  return (
    <div className="wrap">
      <h2>Capability Load Manager</h2>
      <p className="sub">Installed doesn't have to mean loaded. Dormant capabilities stay on your machine but leave the agent's context.</p>

      {message && (
        <div className={`banner ${ui === 'partial_failure' || ui === 'error' ? 'bad' : ''}`}>
          <div className="h">{ui === 'partial_failure' ? 'Partly applied' : ui === 'error' ? 'Something went wrong' : 'Done'}</div>
          <div className="meta">{message}</div>
        </div>
      )}

      {/* --- summary ------------------------------------------------------- */}
      <div className="card clm-summary">
        <div className="stat">
          <div className="k">Active tools</div>
          <div className="v">{summary.activeTools}<span className="of"> / {summary.allTools}</span></div>
        </div>
        <div className="stat">
          <div className="k">Estimated context</div>
          <div className="v">
            {summary.activeTokens.toLocaleString()}<span className="of"> / {summary.allTokens.toLocaleString()}</span>
          </div>
        </div>
        <div className="stat">
          <div className="k">Estimated reduction</div>
          <div className="v accent">{pct}%</div>
        </div>
        <div className="bar-track" aria-hidden>
          <div className="bar-fill" style={{ width: `${summary.allTokens ? (summary.activeTokens / summary.allTokens) * 100 : 0}%` }} />
        </div>
        <div className="meta clm-caveat">
          Estimated from serialized tool schemas (characters ÷ 4). Not billed API tokens.
          {unmeasured > 0 && (
            <> {unmeasured} capabilit{unmeasured === 1 ? 'y is' : 'ies are'} unmeasured — <button className="linkish" onClick={measure} disabled={measuring}>{measuring ? 'measuring…' : 'measure now'}</button></>
          )}
        </div>
      </div>

      {/* --- profiles ------------------------------------------------------ */}
      <div className="section-label">Profiles</div>
      <div className="tabs">
        {profiles.map((p) => (
          <button
            key={p.id}
            className={`tab ${view.currentProfileId === p.id ? 'on mcp' : ''}`}
            disabled={ui === 'mutating'}
            onClick={() => useProfile(p.id)}
            title={p.description}
          >
            {p.name}
            {busyId === `profile:${p.id}` && <span className="spinner" style={{ marginLeft: 6 }} />}
          </button>
        ))}
      </div>
      <p className="meta" style={{ marginTop: -4 }}>
        {view.currentProfileId
          ? `Current state matches the ${profiles.find((p) => p.id === view.currentProfileId)?.name} profile.`
          : 'Current state does not match any profile.'}
      </p>

      {/* --- capabilities -------------------------------------------------- */}
      <div className="section-label">Capabilities</div>
      {view.rows.map((row) => (
        <div key={row.capability.id} className={`card clm-row ${row.anyActive ? '' : 'dim'}`}>
          <div className="grow">
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <span className={`pill ${row.anyActive ? 'on' : ''}`}>{row.anyActive ? 'ACTIVE' : row.anyDormant ? 'DORMANT' : '—'}</span>
              <span className="title">{row.capability.name}</span>
              {row.capability.type === 'plugin' && <span className="tag">PLUGIN</span>}
            </div>
            <div className="meta" style={{ marginTop: 4 }}>
              {row.cost?.source === 'measured'
                ? `${row.cost.toolCount} tools · ~${row.cost.estimatedTokens.toLocaleString()} est. tokens`
                : row.cost?.source === 'unavailable'
                  ? <span className="caveat">{row.cost.note}</span>
                  : 'cost not measured yet'}
            </div>
            <div className="meta clm-agents">
              {row.agents.map((a) => (
                <span key={a.agent} className={`agentchip ${a.state}`}>
                  {a.agentName}: {a.state}
                </span>
              ))}
            </div>
          </div>

          {row.manageable && (
            <div className="clm-actions">
              {row.agents.filter((a) => a.state !== 'unknown').map((a) => (
                <button
                  key={a.agent}
                  className="btn small"
                  disabled={ui === 'mutating'}
                  onClick={() => toggle(row, a.agent, a.state === 'active' ? 'dormant' : 'active')}
                >
                  {busyId === `${row.capability.id}:${a.agent}`
                    ? (a.state === 'active' ? 'Deactivating…' : 'Activating…')
                    : `${a.state === 'active' ? 'Deactivate' : 'Activate'} · ${a.agentName}`}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}

      <p className="meta" style={{ marginTop: 16 }}>
        Changes are written to the live agent configuration and backed up first.
        <strong> Restart the agent for them to take effect</strong> — a running session
        keeps the tools it started with.
      </p>
    </div>
  )
}
