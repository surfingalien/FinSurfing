/**
 * v3 AI Brain — the Dev preview's AI Brain page, rebuilt on the app's own
 * measured record.
 *
 * The loop (what happens to every pick), the graded record with its 95%
 * ranges, calibration by stated confidence, which barrier each pick hit
 * first, the learnings injected into every scan (hide / pin / add your own,
 * saved through the same overrides endpoint the Track record panel uses),
 * the memory's change history with revert, the strategy library and the
 * overnight jobs with their last run. Then v1's Brain Activity feed, so every
 * pick and its reasoning is still one scroll away.
 *
 * Every number comes from the server. With no graded picks yet, the cards say
 * so instead of showing a figure.
 */

import { useState, lazy, Suspense } from 'react'
import { LogIn, ShieldCheck, ShieldAlert, RotateCcw } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { useAuthedJson } from '../data'
import { Card, Badge, Empty, pct } from '../ui'

const BrainActivityView = lazy(() => import('../../components/BrainActivity/BrainActivityView'))

const STEPS = [
  ['Scan', 'The model proposes picks from a numbered evidence dossier'],
  ['Gate', 'EV gate, plan check, price coherence and citation checks run in code'],
  ['Size', 'Half-Kelly from the measured win rate, spread by risk parity'],
  ['Paper trade', 'Fills pay slippage; stale quotes are refused'],
  ['Grade', 'Each pick is graded at its own horizon: target, stop or time first'],
  ['Learn', 'Nightly lessons are re-tested against the record before they reach a scan'],
]

// The jobs that run the Brain's loop, in the order they fire overnight.
const LOOP_JOBS = [
  'brain-learning-cycle', 'brain-evolution', 'strategy-brain', 'agent-desk',
  'pre-market-scan', 'paper-execute', 'paper-manage', 'intraday-focus-hour',
  'vol-forecast-study', 'factor-mining', 'pead-study', 'insider-study',
]

const pctRate = (v, d = 1) => (v == null ? '—' : `${(v * 100).toFixed(d)}%`)
// A learning ends with the stats paths it rests on, e.g. "[calibration.High]".
// Show them quieter, as the evidence note rather than part of the sentence.
function LearningText({ text }) {
  const m = String(text).match(/^(.*?)\s*(\[[^\]]+\])\s*$/)
  if (!m) return <span>{text}</span>
  return <span>{m[1]} <em className="v3-cite">{m[2]}</em></span>
}

const when = (iso) => iso ? new Date(iso).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '—'

function Loop() {
  return (
    <div className="v3-loop">
      {STEPS.map(([n, d], i) => (
        <div key={n} className="v3-step">
          <span className="v3-step-n">{i + 1}</span>
          <b>{n}</b>
          <span>{d}</span>
        </div>
      ))}
    </div>
  )
}

function RecordTiles({ track, scan }) {
  const b = track?.brain
  const h = b?.h30?.nTradeable ? { ...b.h30, days: 30 } : b?.h7?.nTradeable ? { ...b.h7, days: 7 } : null
  const picks = scan?.job?.result?.rankedStocks ?? []
  const declined = picks.filter(p => p.actionable === false).length
  const tiles = [
    ['Graded predictions', b?.totalResolved != null ? b.totalResolved.toLocaleString() : '—', b ? 'resolved against real bars' : 'none graded yet'],
    [h ? `${h.days}-day win rate` : 'Win rate', h ? pctRate(h.winRate) : '—', h ? `95% range ${pctRate(h.winRateLo)}–${pctRate(h.winRateHi)} · n=${h.nTradeable}` : 'appears once picks resolve'],
    ['Average alpha vs benchmark', h?.avgAlpha != null ? pct(h.avgAlpha) : '—', h ? `per ${h.days}-day pick · beat it ${pctRate(h.alphaWinRate, 0)} of the time` : 'SPY for stocks, BTC for crypto'],
    ['Declined in last scan', picks.length ? `${declined} of ${picks.length}` : '—', picks.length ? `scan of ${when(scan.job.finishedAt || scan.job.completedAt)}` : 'no scan yet'],
  ]
  return (
    <div className="v3-tiles">
      {tiles.map(([l, v, s]) => (
        <div key={l} className="v3-card v3-tile">
          <span className="v3-tile-l">{l}</span>
          <b className="v3-num">{v}</b>
          <span className="v3-tile-s">{s}</span>
        </div>
      ))}
    </div>
  )
}

function CalibrationCard({ track }) {
  const b = track?.brain
  const cal = b?.calibration
  const rows = ['Low', 'Medium', 'High'].map(k => [k, cal?.[k]]).filter(([, v]) => v)
  const bar = b?.barriers
  return (
    <Card className="v3-span-6" title="Calibration"
      sub={rows.length ? `Win rate by stated confidence over ${b.segmentHorizon} days, with the 95% range` : 'Does stated confidence predict outcomes?'}>
      {rows.length === 0 ? <Empty text="No graded picks yet. Calibration appears once scan picks reach their horizon." /> : (
        <div className="v3-calib">
          <div className="v3-calib-axis" aria-hidden="true">
            {[90, 70, 50, 30].map(t => <div key={t} className="v3-calib-grid" style={{ bottom: `${t}%` }}><span>{t}%</span></div>)}
          </div>
          {rows.map(([k, s]) => (
            <div key={k} className="v3-calib-col">
              <div className="v3-calib-plot">
                <i className="v3-calib-range" style={{ bottom: `${s.winRateLo * 100}%`, height: `${Math.max(1, (s.winRateHi - s.winRateLo) * 100)}%` }} />
                <i className="v3-calib-bar" style={{ height: `${s.winRate * 100}%` }} />
              </div>
              <b className="v3-num">{pctRate(s.winRate, 0)}</b>
              <span>{k} · n={s.n}</span>
            </div>
          ))}
        </div>
      )}
      <h4 className="v3-h4">Which barrier was hit first</h4>
      {!bar ? <p className="v3-note">Labelled once a pick's own horizon has fully passed.</p> : (
        <>
          <div className="v3-stack">
            <span className="up" style={{ flex: bar.targetFirst }} />
            <span className="down" style={{ flex: bar.stopFirst }} />
            <span className="muted" style={{ flex: bar.neither }} />
          </div>
          <div className="v3-legend v3-legend-dot">
            <span className="up">Target {pctRate(bar.targetFirst, 0)}{bar.avgDaysToTarget != null && ` · ${bar.avgDaysToTarget}d`}</span>
            <span className="down">Stop {pctRate(bar.stopFirst, 0)}{bar.avgDaysToStop != null && ` · ${bar.avgDaysToStop}d`}</span>
            <span className="muted">Time ran out {pctRate(bar.neither, 0)}</span>
            <span>n={bar.n}</span>
          </div>
        </>
      )}
    </Card>
  )
}

function LearningsCard() {
  const { authFetch } = useAuth()
  const lr = useAuthedJson('/api/ai-brain/learnings')
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState(null)
  const d = lr.data
  const ov = d?.overrides ?? { pinned: [], suppressed: [] }
  const norm = s => String(s).trim().toLowerCase()
  const hidden = new Set((ov.suppressed || []).map(norm))
  const pinned = ov.pinned || []
  const pinnedSet = new Set(pinned.map(norm))
  const ai = (d?.keyLearnings ?? []).map(String)

  const save = async (patch, reason) => {
    setBusy(true); setErr(null)
    try {
      const r = await authFetch('/api/ai-brain/learnings/overrides', {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pinned, suppressed: ov.suppressed || [], ...patch, reason }),
      })
      const j = await r.json()
      if (!r.ok || j.error) throw new Error(j.error || `HTTP ${r.status}`)
      await lr.reload()
    } catch (e) { setErr(e.message) } finally { setBusy(false) }
  }
  const toggleHide = (l) => {
    const s = ov.suppressed || []
    save({ suppressed: hidden.has(norm(l)) ? s.filter(x => norm(x) !== norm(l)) : [...s, l] }, hidden.has(norm(l)) ? 'Restored from the AI Brain page' : 'Hidden from the AI Brain page')
  }
  const togglePin = (l) => save({ pinned: pinnedSet.has(norm(l)) ? pinned.filter(x => norm(x) !== norm(l)) : [...pinned, l] }, pinnedSet.has(norm(l)) ? 'Unpinned' : 'Pinned from the AI Brain page')
  const add = (e) => {
    e.preventDefault()
    const t = text.trim()
    if (!t) return
    save({ pinned: [...pinned, t] }, 'Rule added from the AI Brain page').then(() => setText(''))
  }

  const own = pinned.filter(p => !ai.some(a => norm(a) === norm(p)))
  return (
    <Card className="v3-span-6" title="What the Brain has learned"
      sub="Injected into every scan once it passes the re-test. Hide one, pin one, or add your own rule.">
      {!lr.isAuthenticated ? <Empty icon={LogIn} text="Sign in to see the Brain's learnings." /> :
        lr.loading && !d ? <Empty text="Loading learnings…" /> : (
          <>
            {ai.length === 0 && own.length === 0 && (
              <p className="v3-note">{d?.available === false ? 'No nightly learnings written yet. They appear after the first nightly cycle with graded picks.' : 'No learnings survived the re-test.'}</p>
            )}
            <ul className="v3-learn">
              {own.map(l => (
                <li key={`own-${l}`}>
                  <Badge tone="up">You</Badge>
                  <span>{l}</span>
                  <button className="v3-lbtn on" disabled={busy} onClick={() => togglePin(l)}>Remove</button>
                </li>
              ))}
              {ai.map(l => {
                const h = hidden.has(norm(l))
                return (
                  <li key={l} className={h ? 'is-hidden' : ''}>
                    <Badge tone="neutral">AI</Badge>
                    <LearningText text={l} />
                    <button className={`v3-lbtn ${pinnedSet.has(norm(l)) ? 'on' : ''}`} disabled={busy} onClick={() => togglePin(l)}>{pinnedSet.has(norm(l)) ? 'Pinned' : 'Pin'}</button>
                    <button className="v3-lbtn" disabled={busy} onClick={() => toggleHide(l)}>{h ? 'Restore' : 'Hide'}</button>
                  </li>
                )
              })}
            </ul>
            <form className="v3-addrule" onSubmit={add}>
              <input value={text} onChange={e => setText(e.target.value)} maxLength={300}
                placeholder="Add a rule, e.g. avoid biotech before FDA dates" aria-label="Add a rule" />
              <button className="v3-btn" disabled={busy || !text.trim()}>Add</button>
            </form>
            {err && <p className="v3-note warn">{err}</p>}
            {d?.generatedAt && <p className="v3-note">Last nightly rewrite {when(d.generatedAt)}{d.totalResolved != null ? ` · from ${d.totalResolved} graded picks` : ''}</p>}
          </>
        )}
    </Card>
  )
}

function HistoryCard() {
  const { authFetch } = useAuth()
  const h = useAuthedJson('/api/ai-brain/refinements?limit=8')
  const [busy, setBusy] = useState(null)
  const [msg, setMsg] = useState(null)
  const chain = h.data?.chain
  const revert = async (seq) => {
    setBusy(seq); setMsg(null)
    try {
      const r = await authFetch(`/api/ai-brain/refinements/${seq}/revert`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'Reverted from the AI Brain page' }),
      })
      const j = await r.json()
      if (!r.ok || j.ok === false) throw new Error(j.error || j.reason || `HTTP ${r.status}`)
      setMsg(`Reverted #${seq}. The revert is logged too.`)
      await h.reload()
    } catch (e) { setMsg(e.message) } finally { setBusy(null) }
  }
  const rows = h.data?.entries ?? []
  return (
    <Card className="v3-span-7" title="Memory history" sub="Every change to the learnings, with its evidence. Any change can be reverted."
      action={chain && (chain.valid === false
        ? <Badge tone="down"><ShieldAlert className="w-3 h-3 inline -mt-0.5" /> Chain broken at #{chain.firstBreak?.seq}</Badge>
        : <Badge tone="up"><ShieldCheck className="w-3 h-3 inline -mt-0.5" /> Chain verified</Badge>)}>
      {rows.length === 0 ? <Empty text={h.loading ? 'Loading history…' : h.error || 'No changes recorded yet.'} /> : (
        <table className="v3-table v3-table-static">
          <thead><tr><th>#</th><th>By</th><th>Change</th><th>Evidence</th><th /></tr></thead>
          <tbody>
            {rows.map(e => (
              <tr key={e.seq}>
                <td className="v3-num">{e.seq}</td>
                <td>{e.actor === 'ai' ? 'AI' : 'You'}</td>
                <td>{e.summary}<span>{when(e.at)}</span></td>
                <td className="v3-muted">{e.evidence?.reason || (e.evidence?.resolvedPredictions != null ? `${e.evidence.resolvedPredictions} graded picks` : 'none recorded')}</td>
                <td className="r"><button className="v3-lbtn" disabled={busy != null} onClick={() => revert(e.seq)}><RotateCcw className="w-3 h-3" /> {busy === e.seq ? '…' : 'Revert'}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {msg && <p className="v3-note">{msg}</p>}
    </Card>
  )
}

function LibraryCard({ onNavigate }) {
  const s = useAuthedJson('/api/evolution/strategies?limit=6')
  const list = s.data?.strategies ?? []
  const st = s.data?.stats
  const forward = e => (e.validations || []).filter(v => v.forward)
  return (
    <Card className="v3-span-5" title="Strategy library"
      sub={st ? `${st.active} active · ${st.proven} proven on data after discovery · ${st.retired} retired` : 'Strategies must keep working on new data or they retire'}
      action={<button className="v3-btn" onClick={() => onNavigate('strategies')}>All strategies</button>}>
      {list.length === 0 ? <Empty text={s.loading ? 'Loading the library…' : 'No strategies admitted yet. The nightly evolution job adds those that pass out of sample.'} /> : (
        <ul className="v3-list">
          {list.map(e => {
            const f = forward(e)
            const last = (e.validations || []).at(-1)
            const proven = f.some(v => v.score >= 50)
            return (
              <li key={e.id}>
                <div>
                  <b>{e.name}</b>
                  <span>{e.symbol} · {e.strategy === 'composed_rule' ? 'Rule' : e.strategy === 'ml_model' ? 'ML model' : e.strategy.replace(/_/g, ' ')}
                    {last?.alpha != null && <> · alpha <em className={last.alpha >= 0 ? 'v3-up' : 'v3-down'}>{pct(last.alpha)}</em></>}
                    {e.fitness != null && ` · fitness ${Math.round(e.fitness)}`}</span>
                </div>
                <Badge tone={proven ? 'up' : 'warn'}>{proven ? 'Proven forward' : f.length ? 'On probation' : 'Awaiting new data'}</Badge>
              </li>
            )
          })}
        </ul>
      )}
    </Card>
  )
}

function ScheduleCard() {
  const j = useAuthedJson('/api/scheduler/jobs')
  const jobs = Array.isArray(j.data) ? j.data : []
  const byId = Object.fromEntries(jobs.map(x => [x.id, x]))
  const rows = LOOP_JOBS.map(id => byId[id]).filter(Boolean)
  return (
    <Card className="v3-span-12" title="Overnight schedule" sub="The jobs that run the loop, with their next run and last result since the server started">
      {rows.length === 0 ? <Empty text={j.loading ? 'Loading jobs…' : j.error || 'Scheduler status unavailable.'} /> : (
        <div className="v3-sched">
          {rows.map(x => {
            const r = x.result || {}
            const tone = r.status === 'error' ? 'down' : r.status === 'running' ? 'warn' : r.lastRun ? 'up' : 'neutral'
            return (
              <div key={x.id} className={x.enabled ? '' : 'is-off'}>
                <b>{x.name}</b>
                <span className="v3-num">{x.scheduleText}</span>
                <span><Badge tone={tone}>{!x.enabled ? 'OFF' : r.status === 'error' ? 'FAILED' : r.status === 'running' ? 'RUNNING' : r.lastRun ? 'OK' : 'NOT RUN'}</Badge>{r.lastRun && <em> {when(r.lastRun)}</em>}</span>
              </div>
            )
          })}
        </div>
      )}
    </Card>
  )
}

export default function BrainView({ onNavigate, onAnalyze, onSignIn }) {
  const { isAuthenticated } = useAuth()
  const track = useAuthedJson('/api/research-desk/track-record')
  const scan = useAuthedJson('/api/ai-brain/scan/latest')
  if (!isAuthenticated) {
    return (
      <div className="v3-home">
        <Loop />
        <Card><Empty icon={LogIn} text="Sign in to see the Brain's graded record, what it has learned and its strategy library." action={<button className="v3-btn primary" onClick={onSignIn}>Sign in</button>} /></Card>
      </div>
    )
  }
  return (
    <div className="v3-home">
      <Loop />
      <RecordTiles track={track.data} scan={scan.data} />
      {track.error && <p className="v3-note warn">Track record unavailable: {track.error}</p>}
      <div className="v3-grid">
        <CalibrationCard track={track.data} />
        <LearningsCard />
        <HistoryCard />
        <LibraryCard onNavigate={onNavigate} />
        <ScheduleCard />
      </div>
      <div className="v3-section-h"><h2>Every pick, as it was made</h2></div>
      <div className="v3-plain">
        <Suspense fallback={<Empty text="Loading the activity feed…" />}>
          <BrainActivityView onAnalyze={onAnalyze} />
        </Suspense>
      </div>
    </div>
  )
}
