import { useCallback, useEffect, useState } from 'react'
import type { AgentKey, ClmView, ClmRow, CapabilityProfile, TriggerEvent } from '../types.ts'

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
  const [watching, setWatching] = useState<string | null>(null)
  const [fired, setFired] = useState<TriggerEvent[]>([])

  const refresh = useCallback(async () => {
    try {
      const [v, p] = await Promise.all([window.agentpack.clmView(), window.agentpack.clmProfiles()])
      setView(v)
      setProfiles(p)
      setUi((s) => (s === 'loading' ? 'ready' : s))
    } catch (e) {
      setMessage(`Could not read capability state: ${(e as Error).message}`)
      setUi('error')
    }
  }, [])

  useEffect(() => { refresh() }, [refresh])
  useEffect(() => window.agentpack.onWatchChanged(status => {
    setWatching(status?.watching || null)
    if (status?.error) { setMessage(status.error); setUi('error') }
  }), [])
  useEffect(() => { window.agentpack.clmWatchStatus().then((s) => setWatching(s?.watching ?? null)).catch((e) => { setMessage(`Could not read watch status: ${(e as Error).message}`); setUi('error') }) }, [])

  // A trigger fires in main; the UI reacts rather than polling.
  useEffect(() => window.agentpack.onTrigger((e) => {
    setFired((prev) => [e, ...prev].slice(0, 5))
    refresh()
  }), [refresh])

  async function toggleWatch() {
    try {
      if (watching) {
        await window.agentpack.clmStopWatch()
        setWatching(null)
      } else {
        const dir = await window.agentpack.pickDirectory()
        if (!dir) return
        const r = await window.agentpack.clmStartWatch(dir)
        setWatching(r.watching)
      }
    } catch (e) {
      setMessage(`Could not watch that folder: ${(e as Error).message}`)
      setUi('error')
    }
  }

  async function toggle(row: ClmRow, agent: AgentKey, to: 'active' | 'dormant') {
    if (busyId) return
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
    if (busyId) return
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
      setUi('ready')
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
        {ui === 'error' && <button className="btn" onClick={() => { setUi('loading'); setMessage(null); refresh() }}>Retry</button>}
      </div>
    )
  }

  const { summary } = view
  const pct = summary.allTokens > 0 ? Math.round((1 - summary.activeTokens / summary.allTokens) * 100) : 0
  const unmeasured = view.rows.filter((r) => r.manageable && (r.anyActive || r.anyDormant) && r.cost?.source !== 'measured').length
  // Nothing measured yet reads as "0 / 0", which looks like an empty machine
  // rather than an unmeasured one. Say which it is.
  const nothingMeasured = summary.allTools === 0 && unmeasured > 0
  const dash = (n: number) => (nothingMeasured ? '—' : n.toLocaleString())

  return (
    <div className="wrap">
      <h2>Capability Load Manager</h2>
      <p className="sub">Choose which installed capabilities are available in the next agent session. Dormant capabilities remain configured or saved locally.</p>

      {message && (
        <div className={`banner ${ui === 'partial_failure' || ui === 'error' ? 'bad' : ''}`}>
          <div className="h">{ui === 'partial_failure' ? 'Partly applied' : ui === 'error' ? 'Something went wrong' : 'Done'}</div>
          <div className="meta">{message}</div>
          {ui === 'error' && <button className="btn small" onClick={() => { setUi('loading'); setMessage(null); refresh() }}>Refresh state</button>}
        </div>
      )}

      {nothingMeasured && (
        <div className="banner">
          <div className="h">Context cost not measured yet</div>
          <div className="meta">
            {unmeasured} installed capabilit{unmeasured === 1 ? 'y has' : 'ies have'} no measurement.
            AgentPack launches each server and reads its real tool list — about four seconds each,
            once per capability.
          </div>
          <button className="btn" onClick={measure} disabled={measuring || busyId !== null}>
            {measuring ? 'Measuring…' : 'Measure context cost'}
          </button>
        </div>
      )}

      {/* --- summary ------------------------------------------------------- */}
      <div className="card clm-summary">
        <div className="stat">
          <div className="k">Active tools</div>
          <div className="v">{dash(summary.activeTools)}<span className="of"> / {dash(summary.allTools)}</span></div>
        </div>
        <div className="stat">
          <div className="k">Estimated context</div>
          <div className="v">
            {dash(summary.activeTokens)}<span className="of"> / {dash(summary.allTokens)}</span>
          </div>
        </div>
        <div className="stat">
          <div className="k">Estimated reduction</div>
          <div className="v accent">{nothingMeasured ? '—' : `${pct}%`}</div>
        </div>
        <div className="bar-track" aria-hidden>
          <div className="bar-fill" style={{ width: `${summary.allTokens ? (summary.activeTokens / summary.allTokens) * 100 : 0}%` }} />
        </div>
        <div className="meta clm-caveat">
          Estimated from measured tool schemas (characters ÷ 4), once per installed capability. Agent sessions may load tools differently; these are not billed tokens.
          {unmeasured > 0 && (
            <> {unmeasured} capabilit{unmeasured === 1 ? 'y has' : 'ies have'} no measurement — <button className="linkish" onClick={measure} disabled={measuring || busyId !== null}>{measuring ? 'measuring…' : 'measure now'}</button></>
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
            disabled={busyId !== null}
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

      {/* --- automatic activation ------------------------------------------ */}
      <div className="section-label">Automatic activation</div>
      <div className="card clm-row">
        <div className="grow">
          <div className="title">{watching ? 'Watching for matching files' : 'Not watching'}</div>
          <div className="meta mono" style={{ marginTop: 4 }}>
            {watching ?? 'pick a project folder to activate capabilities as their files appear'}
          </div>
        </div>
        <button className="btn small" onClick={toggleWatch}>
          {watching ? 'Stop' : 'Watch a project…'}
        </button>
      </div>

      {fired.map((e, i) => (
        <div key={i} className={`banner ${e.result.success ? '' : 'bad'}`}>
          <div className="h">{e.capabilityName}: {e.result.success ? 'enabled for the next agent session' : 'automatic activation failed'}</div>
          <div className="meta">
            {e.path} matched <code>{e.pattern}</code> → {e.agent}
            {!e.result.success && <span className="caveat"> — but the change failed: {e.result.error}</span>}
          </div>
        </div>
      ))}

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
                  : 'schema cost unavailable or not measured'}
            </div>
            {!!row.capability.triggers?.length && (
              <div className="meta" style={{ marginTop: 4 }}>
                <span className="tag">AUTO</span>{' '}
                <span className="mono">{row.capability.triggers.map((t) => t.pattern).join('  ')}</span>
              </div>
            )}
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
