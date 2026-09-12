import { useEffect, useMemo, useRef, useState } from 'react'
import type {
  AgentKey, Analysis, Capability, DetectedAgent, InstallReport, ProgressEvent,
} from './types.ts'

type Step = 'detect' | 'project' | 'recommend' | 'plan' | 'install' | 'report'
const STEPS: Array<[Step, string]> = [
  ['detect', 'Detect'], ['project', 'Project'], ['recommend', 'Recommend'],
  ['plan', 'Plan'], ['install', 'Install'], ['report', 'Report'],
]

/**
 * Explicit back transitions. Stepping backwards through STEPS would land on
 * 'install' — a transient state with no controls — and strand the user.
 */
const BACK: Partial<Record<Step, Step>> = {
  project: 'detect',
  recommend: 'project',
  plan: 'recommend',
  install: 'plan', // only reachable when an install is not running
  report: 'recommend',
}

export default function App() {
  const [step, setStep] = useState<Step>('detect')
  const [agents, setAgents] = useState<DetectedAgent[]>([])
  const [dir, setDir] = useState('')
  const [analysis, setAnalysis] = useState<Analysis | null>(null)
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [values, setValues] = useState<Record<string, string>>({})
  const [events, setEvents] = useState<ProgressEvent[]>([])
  const [report, setReport] = useState<InstallReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [rolledBack, setRolledBack] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    window.agentpack.detectAgents().then(setAgents)
  }, [])

  useEffect(() => window.agentpack.onProgress((e) => setEvents((prev) => [...prev, e])), [])

  const targets = agents.filter((a) => a.detected)
  const chosen = useMemo(
    () => (analysis ? [...analysis.recommendations.map((r) => r.capability), ...analysis.extras] : [])
      .filter((c) => selected.has(c.id)),
    [analysis, selected],
  )

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })

  async function analyze(path: string) {
    setBusy(true)
    setError(null)
    try {
      const a = await window.agentpack.analyze(path)
      setDir(path)
      setAnalysis(a)
      setSelected(new Set(a.recommendations.map((r) => r.capability.id)))
      setStep('project')
    } catch (e) {
      setError(`Could not analyse that folder: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  async function runInstall() {
    setEvents([])
    setReport(null)
    setRolledBack(false)
    setError(null)
    setStep('install')
    setBusy(true)
    // Build the request from the SELECTED capabilities' declared fields only.
    // Iterating retained `values` instead would reclassify a deselected
    // capability's secret as an ordinary input — and inputs are persisted to the
    // ledger. Never let selection state decide what counts as a secret.
    const secrets: Record<string, string> = {}
    const inputs: Record<string, string> = {}
    for (const c of chosen) {
      for (const s of c.secrets ?? []) if (values[s.key]) secrets[s.key] = values[s.key]
      for (const i of c.inputs ?? []) if (values[i.key]) inputs[i.key] = values[i.key]
    }
    try {
      const r = await window.agentpack.install({
        capabilityIds: chosen.map((c) => c.id),
        agents: targets.map((a) => a.key as AgentKey),
        projectDir: dir,
        secrets,
        inputs,
      })
      setReport(r)
      setStep('report')
    } catch (e) {
      // Leave the user on the install screen WITH a message and a way back,
      // rather than on a silent dead end.
      setError(`Install failed: ${(e as Error).message}`)
    } finally {
      setBusy(false)
    }
  }

  const stepIndex = STEPS.findIndex(([s]) => s === step)

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Agent<span>Pack</span></div>
        <div className="tagline">cross-agent package manager</div>
        <nav className="steps">
          {STEPS.map(([s, label], i) => (
            <div key={s} className={`step ${s === step ? 'active' : i < stepIndex ? 'done' : ''}`}>
              {i < stepIndex ? '✓ ' : ''}{label}
            </div>
          ))}
        </nav>
      </header>

      <main>
        <div className="wrap">
          {error && (
            <div className="banner bad">
              <div className="h">Something went wrong</div>
              <div className="meta">{error}</div>
            </div>
          )}
          {step === 'detect' && <Detect agents={agents} />}
          {step === 'project' && analysis && <Project analysis={analysis} />}
          {step === 'recommend' && analysis && (
            <Recommend analysis={analysis} selected={selected} toggle={toggle} targets={targets} />
          )}
          {step === 'plan' && (
            <Plan chosen={chosen} targets={targets} dir={dir} values={values} setValues={setValues} />
          )}
          {step === 'install' && <Progress events={events} chosen={chosen} busy={busy} />}
          {step === 'report' && report && (
            <Report report={report} targets={targets} rolledBack={rolledBack} events={events} />
          )}
        </div>
      </main>

      <Footer
        step={step} setStep={setStep} busy={busy} targets={targets} analysis={analysis}
        chosen={chosen} values={values} dir={dir} report={report} rolledBack={rolledBack}
        onScan={async () => {
          const picked = await window.agentpack.pickDirectory()
          if (picked) analyze(picked)
        }}
        onInstall={runInstall}
        onRollback={async () => {
          if (!report) return
          setBusy(true)
          setError(null)
          try {
            const r = await window.agentpack.rollback(report.ledgerId)
            // A null result means nothing was undone — do not claim success.
            if (r) setRolledBack(true)
            else setError('Nothing to roll back: this run was already undone.')
          } catch (e) {
            setError(`Rollback failed: ${(e as Error).message}`)
          } finally {
            setBusy(false)
          }
        }}
      />
    </div>
  )
}

/* ---------------------------------------------------------------- screen 1 */

function Detect({ agents }: { agents: DetectedAgent[] }) {
  const found = agents.filter((a) => a.detected).length
  return (
    <>
      <h2>Detected agents</h2>
      <p className="sub">
        {found
          ? `${found} supported coding ${found === 1 ? 'agent' : 'agents'} found on this machine.`
          : 'Looking for supported coding agents…'}
      </p>
      {agents.map((a) => (
        <div key={a.key} className={`card row ${a.detected ? '' : 'dim'}`}>
          <div className={`dot ${a.detected ? 'ok' : 'idle'}`} />
          <div className="grow">
            <div className="title">{a.name}</div>
            <div className="meta mono">{a.configPath}</div>
            {a.note && <div className="meta" style={{ color: 'var(--warn)' }}>{a.note}</div>}
          </div>
          <div className="tag">{a.detected ? 'detected' : 'not found'}</div>
        </div>
      ))}
    </>
  )
}

/* ---------------------------------------------------------------- screen 2 */

function Project({ analysis }: { analysis: Analysis }) {
  const { scan } = analysis
  return (
    <>
      <h2>Project analysis</h2>
      <p className="sub mono">{scan.dir}</p>
      {!scan.isProject && <div className="card meta">No recognised project signals in this folder.</div>}
      {scan.signals.map((s) => (
        <div key={s.id + s.label} className="card row">
          <div className="dot ok" />
          <div className="grow">
            <div className="title">{s.label}</div>
            <div className="meta">{s.evidence}</div>
          </div>
        </div>
      ))}
    </>
  )
}

/* ---------------------------------------------------------------- screen 3 */

/** MCP servers and plugins are different mechanisms — the UI says so. */
const KIND = {
  mcp: {
    label: 'MCP servers',
    blurb: 'Separate processes AgentPack launches and verifies. Work across all three agents.',
    cls: 'mcp',
  },
  plugin: {
    label: 'Plugins',
    blurb: 'Skills and commands loaded from a git marketplace, inside the agent itself. Claude Code and Codex only — OpenCode has no marketplace system.',
    cls: 'plugin',
  },
} as const

function CapabilityCard({
  c, on, toggle, reason, targets,
}: {
  c: Capability
  on: boolean
  toggle: (id: string) => void
  reason?: string
  targets: DetectedAgent[]
}) {
  const needs = [...(c.inputs ?? []).map((i) => i.key), ...(c.secrets ?? []).map((s) => s.key)]
  const cannot = targets.filter((t) => !c.supportedAgents.includes(t.key))
  return (
    <div
      className={`card pick ${KIND[c.type].cls} ${on ? 'on' : ''}`}
      role="checkbox"
      aria-checked={on}
      tabIndex={0}
      onClick={() => toggle(c.id)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); toggle(c.id) }
      }}
    >
      <div style={{ display: 'flex', gap: 12 }}>
        <div className={`check ${on ? 'on' : ''}`}>{on ? '✓' : ''}</div>
        <div className="grow">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 3, flexWrap: 'wrap' }}>
            <span className="title">{c.name}</span>
            {needs.map((n) => <span key={n} className="tag need">{n}</span>)}
            {c.requires?.binaries?.map((b) => (
              <span key={b} className="tag need">needs {b} CLI</span>
            ))}
          </div>
          <div className="meta">{c.description}</div>
          {reason && <div className="meta why">{reason}</div>}
          <div className="meta" style={{ marginTop: 5 }}>
            {c.source}
            {cannot.length > 0 && ` · not available on ${cannot.map((u) => u.name).join(', ')}`}
          </div>
        </div>
      </div>
    </div>
  )
}

function Recommend({
  analysis, selected, toggle, targets,
}: {
  analysis: Analysis
  selected: Set<string>
  toggle: (id: string) => void
  targets: DetectedAgent[]
}) {
  const [tab, setTab] = useState<'mcp' | 'plugin'>('mcp')

  const recommended = analysis.recommendations.filter((r) => r.capability.type === tab)
  const extras = analysis.extras.filter((c) => c.type === tab)
  const count = (t: 'mcp' | 'plugin') =>
    analysis.recommendations.filter((r) => r.capability.type === t).length +
    analysis.extras.filter((c) => c.type === t).length
  const chosenIn = (t: 'mcp' | 'plugin') =>
    [...analysis.recommendations.map((r) => r.capability), ...analysis.extras]
      .filter((c) => c.type === t && selected.has(c.id)).length

  return (
    <>
      <h2>Choose capabilities</h2>
      <p className="sub">Recommendations come from deterministic rules — every one says why.</p>

      <div className="tabs" role="tablist">
        {(['mcp', 'plugin'] as const).map((t) => (
          <button
            key={t}
            role="tab"
            aria-selected={tab === t}
            className={`tab ${t} ${tab === t ? 'on' : ''}`}
            onClick={() => setTab(t)}
          >
            {KIND[t].label}
            <span className="count">{chosenIn(t)}/{count(t)}</span>
          </button>
        ))}
      </div>

      <p className="sub kindblurb">{KIND[tab].blurb}</p>

      {recommended.length > 0 && <div className="section-label">Recommended for this project</div>}
      {recommended.map((r) => (
        <CapabilityCard key={r.capability.id} c={r.capability} on={selected.has(r.capability.id)}
          toggle={toggle} reason={r.reason} targets={targets} />
      ))}

      {extras.length > 0 && <div className="section-label">Also available</div>}
      {extras.map((c) => (
        <CapabilityCard key={c.id} c={c} on={selected.has(c.id)} toggle={toggle} targets={targets} />
      ))}

      {recommended.length + extras.length === 0 && (
        <div className="card meta">Nothing of this kind in the registry yet.</div>
      )}
    </>
  )
}

/* ---------------------------------------------------------------- screen 4 */

function Plan({
  chosen, targets, dir, values, setValues,
}: {
  chosen: Capability[]
  targets: DetectedAgent[]
  dir: string
  values: Record<string, string>
  setValues: (v: Record<string, string>) => void
}) {
  const fields = chosen.flatMap((c) => [
    ...(c.inputs ?? []).map((i) => ({ ...i, secret: false, cap: c.name })),
    ...(c.secrets ?? []).map((s) => ({ ...s, secret: true, cap: c.name })),
  ])

  return (
    <>
      <h2>Install plan</h2>
      <p className="sub">Exactly what will change before anything runs.</p>

      <div className="section-label">Files to be modified — each backed up first</div>
      {targets.map((t) => (
        <div key={t.key} className="card row">
          <div className="dot idle" />
          <div className="grow">
            <div className="title">{t.name}</div>
            <div className="meta mono">{t.configPath}</div>
          </div>
          <div className="tag">{chosen.filter((c) => c.supportedAgents.includes(t.key)).length} entries</div>
        </div>
      ))}

      {(['mcp', 'plugin'] as const).map((kind) => {
        const group = chosen.filter((c) => c.type === kind)
        if (!group.length) return null
        return (
          <div key={kind}>
            <div className={`kindhead ${kind}`}>
              <span className="dotkind" /> {kind === 'mcp' ? 'MCP servers' : 'Plugins'}
              <span className="meta">
                {kind === 'mcp' ? 'launched as a process' : 'marketplace + enable flag, loaded in-process'}
              </span>
            </div>
            {group.map((c) => (
              <div key={c.id} className={`card ${kind}`}>
                <div className="title">{c.name}</div>
                <div className="meta mono" style={{ marginTop: 4 }}>
                  {c.type === 'mcp'
                    ? `${c.install?.command} ${(c.install?.args ?? []).join(' ').replace('${projectDir}', dir)}`
                    : `${c.plugin?.name}@${c.plugin?.marketplace} — github.com/${c.plugin?.repo}`}
                </div>
                {c.requires?.binaries?.length && (
                  <div className="caveat">requires the {c.requires.binaries.join(', ')} CLI on PATH</div>
                )}
              </div>
            ))}
          </div>
        )
      })}

      {fields.length > 0 && (
        <>
          <div className="section-label">Required values</div>
          <div className="card">
            {fields.map((f) => (
              <label className="field" key={f.key}>
                <span className="lbl">
                  {f.label} <span className="meta">· {f.cap}</span>
                </span>
                <input
                  type={f.secret ? 'password' : 'text'}
                  value={values[f.key] ?? ''}
                  placeholder={f.key}
                  onChange={(e) => setValues({ ...values, [f.key]: e.target.value })}
                />
                {f.help && <span className="help">{f.help}</span>}
              </label>
            ))}
            <div className="meta" style={{ fontSize: 11.5 }}>
              Secrets are held in memory, written only into the agent configs that need them,
              and never recorded in our logs or install ledger.
            </div>
          </div>
        </>
      )}
    </>
  )
}

/* ---------------------------------------------------------------- screen 5 */

const STAGE_LABELS: Record<string, string> = {
  preflight: 'Checking runtimes',
  backup: 'Backing up',
  configure: 'Writing config',
  validate: 'Validating',
  done: 'Done',
}

function Progress({ events, chosen, busy }: { events: ProgressEvent[]; chosen: Capability[]; busy: boolean }) {
  const logRef = useRef<HTMLDivElement>(null)
  const [showLogs, setShowLogs] = useState(false)

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight
  }, [events, showLogs])

  const stages = ['preflight', 'backup', 'configure', 'validate']
  const seen = new Set(events.filter((e) => e.kind === 'stage').map((e) => (e as { stage: string }).stage))
  const done = seen.has('done')

  return (
    <>
      <h2>Installing</h2>
      <p className="sub">{chosen.length} capabilities across your detected agents.</p>

      <div className="card">
        {stages.map((s) => {
          const active = seen.has(s) && !done
          const complete = done || stages.indexOf(s) < [...seen].filter((x) => stages.includes(x)).length - 1
          return (
            <div className="stage" key={s}>
              {complete ? <div className="dot ok" /> : active ? <div className="spinner" /> : <div className="dot idle" />}
              <div className="name">{STAGE_LABELS[s]}</div>
              <div className="meta grow">
                {events.filter((e) => e.kind === 'stage' && (e as { stage: string }).stage === s).slice(-1)[0]?.kind === 'stage'
                  ? (events.filter((e) => e.kind === 'stage' && (e as { stage: string }).stage === s).slice(-1)[0] as { detail?: string }).detail ?? ''
                  : ''}
              </div>
            </div>
          )
        })}
      </div>

      <button className="btn small ghost" onClick={() => setShowLogs((v) => !v)}>
        {showLogs ? 'Hide' : 'Show'} advanced log ({events.length})
      </button>

      {showLogs && (
        <div className="logs" ref={logRef} style={{ marginTop: 10 }}>
          {events.map((e, i) => {
            if (e.kind === 'stage') return <div key={i}><span className="s">[{e.stage}]</span> {e.detail ?? ''}</div>
            if (e.kind === 'agent') {
              return (
                <div key={i} className={e.status === 'failed' ? 'e' : undefined}>
                  {e.agent} · {e.status} · {e.detail ?? ''}
                </div>
              )
            }
            return <div key={i} className={e.stream === 'stderr' ? 'e' : undefined}>{e.line}</div>
          })}
          {busy && <div className="meta">…</div>}
        </div>
      )}
    </>
  )
}

/* ---------------------------------------------------------------- screen 6 */

function Report({
  report, targets, rolledBack, events,
}: {
  report: InstallReport
  targets: DetectedAgent[]
  rolledBack: boolean
  events: ProgressEvent[]
}) {
  const [showLogs, setShowLogs] = useState(false)
  const failed = report.capabilities.filter(
    (c) => c.health.status === 'failed' || c.results.some((r) => r.status === 'failed' || r.status === 'conflict'),
  )
  const totalTools = report.capabilities.reduce((n, c) => n + c.health.tools.length, 0)
  const mcps = report.capabilities.filter((c) => c.capability.type === 'mcp')
  const plugins = report.capabilities.filter((c) => c.capability.type === 'plugin')

  /** Only show agent columns that could actually host this kind of capability. */
  const columnsFor = (kind: 'mcp' | 'plugin') =>
    targets.filter((t) => (kind === 'plugin' ? t.key !== 'opencode' : true))

  const agentCell = (c: typeof report.capabilities[number], key: string) => {
    const r = c.results.find((x) => x.agent === key)
    const cls = !r ? 'skip'
      : r.status === 'failed' ? 'bad'
      : r.status === 'conflict' ? 'warn'
      : r.status === 'unsupported' ? 'skip'
      : r.status === 'already-present' ? 'skip' : 'ok'
    const label = !r ? '—'
      : r.status === 'installed' ? 'Installed'
      : r.status === 'already-present' ? 'Already there'
      : r.status === 'conflict' ? 'Conflict'
      : r.status === 'unsupported' ? 'n/a' : 'Failed'
    return (
      <td key={key}>
        <span className={`cell ${cls}`} title={r?.error ?? ''}>
          {cls === 'ok' ? '✓' : cls === 'bad' ? '✗' : cls === 'warn' ? '!' : '·'} {label}
        </span>
      </td>
    )
  }

  return (
    <>
      <h2>Health report</h2>
      <p className="sub">What was written, and how far we could actually verify it.</p>

      {rolledBack ? (
        <div className="banner">
          <div className="h">Rolled back</div>
          <div className="meta">Every modified config was restored from its backup.</div>
        </div>
      ) : failed.length ? (
        <div className="banner bad">
          <div className="h">{failed.length} of {report.capabilities.length} did not pass</div>
          <div className="meta">Nothing is hidden — see the rows below. You can roll back.</div>
        </div>
      ) : (
        <div className="banner">
          <div className="h">
            {mcps.length} MCP {mcps.length === 1 ? 'server' : 'servers'}
            {plugins.length > 0 && ` · ${plugins.length} ${plugins.length === 1 ? 'plugin' : 'plugins'}`}
            {totalTools > 0 && ` · ${totalTools} tools verified`}
          </div>
          <div className="meta">
            {totalTools > 0 && 'Every MCP server started and answered tools/list. '}
            {plugins.length > 0 && 'Plugins are configured; they load inside the agent.'}
          </div>
        </div>
      )}

      {mcps.length > 0 && (
        <>
          <div className="kindhead mcp">
            <span className="dotkind" /> MCP servers
            <span className="meta">launched and verified by AgentPack</span>
          </div>
          <table className="matrix">
            <thead>
              <tr>
                <th>Capability</th>
                {columnsFor('mcp').map((t) => <th key={t.key}>{t.name}</th>)}
                <th>Health check</th>
              </tr>
            </thead>
            <tbody>
              {mcps.map((c) => (
                <tr key={c.capability.id}>
                  <td>
                    <div className="title">{c.capability.name}</div>
                    {c.health.tools.length > 0 && (
                      <div className="tools">{c.health.tools.slice(0, 6).join(', ')}
                        {c.health.tools.length > 6 && ` +${c.health.tools.length - 6} more`}
                      </div>
                    )}
                  </td>
                  {columnsFor('mcp').map((t) => agentCell(c, t.key))}
                  <td>
                    {c.health.reachable ? (
                      <>
                        <span className="cell ok">✓ {c.health.tools.length} tools discovered</span>
                        <div className="meta" style={{ fontSize: 11 }}>
                          {c.health.server?.name} {c.health.server?.version} · {c.health.durationMs}ms
                        </div>
                        {(c.capability.secrets?.length ?? 0) > 0 && (
                          <div className="caveat">credential not verified by tools/list</div>
                        )}
                      </>
                    ) : (
                      <>
                        <span className="cell bad">✗ failed</span>
                        <div className="meta" style={{ fontSize: 11 }}>{c.health.error}</div>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {plugins.length > 0 && (
        <>
          <div className="kindhead plugin">
            <span className="dotkind" /> Plugins
            <span className="meta">registered in the agent; they load in-process</span>
          </div>
          <table className="matrix">
            <thead>
              <tr>
                <th>Capability</th>
                {columnsFor('plugin').map((t) => <th key={t.key}>{t.name}</th>)}
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {plugins.map((c) => (
                <tr key={c.capability.id}>
                  <td>
                    <div className="title">{c.capability.name}</div>
                    <div className="tools">{c.capability.plugin?.name}@{c.capability.plugin?.marketplace}</div>
                  </td>
                  {columnsFor('plugin').map((t) => agentCell(c, t.key))}
                  <td>
                    {c.health.status === 'configured' ? (
                      <>
                        <span className="cell skip">· Configured</span>
                        <div className="meta" style={{ fontSize: 11 }}>
                          restart the agent to load it
                        </div>
                        <div className="caveat">not verifiable from here</div>
                      </>
                    ) : (
                      <>
                        <span className="cell bad">✗ failed</span>
                        <div className="meta" style={{ fontSize: 11 }}>{c.health.error}</div>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {targets.some((t) => t.key === 'opencode') && (
            <p className="meta" style={{ marginTop: 8 }}>
              OpenCode is not shown: it has no git-marketplace plugin system, so plugins do not apply to it.
            </p>
          )}
        </>
      )}

      <div style={{ marginTop: 18 }}>
        <button className="btn small ghost" onClick={() => setShowLogs((v) => !v)}>
          {showLogs ? 'Hide' : 'Show'} advanced log
        </button>
        {showLogs && (
          <div className="logs" style={{ marginTop: 10 }}>
            {events.map((e, i) => (
              <div key={i}>
                {e.kind === 'stage' ? <><span className="s">[{e.stage}]</span> {e.detail ?? ''}</>
                  : e.kind === 'agent' ? `${e.agent} · ${e.status} · ${e.detail ?? ''}`
                  : e.line}
              </div>
            ))}
          </div>
        )}
      </div>
    </>
  )
}

/* ----------------------------------------------------------------- footer  */

function Footer(props: {
  step: Step
  setStep: (s: Step) => void
  busy: boolean
  targets: DetectedAgent[]
  analysis: Analysis | null
  chosen: Capability[]
  values: Record<string, string>
  dir: string
  report: InstallReport | null
  rolledBack: boolean
  onScan: () => void
  onInstall: () => void
  onRollback: () => void
}) {
  const { step, setStep, busy, targets, chosen, values, report, rolledBack } = props

  const missing = chosen.flatMap((c) => [...(c.inputs ?? []), ...(c.secrets ?? [])])
    .filter((f) => !values[f.key])

  return (
    <div className="bar">
      {BACK[step] && (
        <button className="btn ghost" disabled={busy} onClick={() => setStep(BACK[step]!)}>
          Back
        </button>
      )}

      <div className="grow meta">
        {step === 'detect' && `${targets.length} agents ready`}
        {step === 'recommend' && `${chosen.length} selected`}
        {step === 'plan' && (missing.length
          ? `${missing.length} required ${missing.length === 1 ? 'value' : 'values'} still needed`
          : `${chosen.length} capabilities × ${targets.length} agents`)}
        {step === 'report' && report && !rolledBack && `run ${report.ledgerId}`}
      </div>

      {step === 'detect' && (
        <button className="btn primary" disabled={!targets.length || busy} onClick={props.onScan}>
          {busy ? 'Scanning…' : 'Scan a project…'}
        </button>
      )}
      {step === 'project' && (
        <button className="btn primary" onClick={() => setStep('recommend')}>Continue</button>
      )}
      {step === 'recommend' && (
        <button className="btn primary" disabled={!chosen.length} onClick={() => setStep('plan')}>
          Review plan
        </button>
      )}
      {step === 'plan' && (
        <button className="btn primary" disabled={busy || !!missing.length} onClick={props.onInstall}>
          Install selected
        </button>
      )}
      {step === 'report' && (
        <>
          <button className="btn" disabled={busy || rolledBack} onClick={props.onRollback}>
            {rolledBack ? 'Rolled back' : 'Roll back'}
          </button>
          <button className="btn ghost" onClick={() => setStep('recommend')}>Install more</button>
        </>
      )}
    </div>
  )
}
