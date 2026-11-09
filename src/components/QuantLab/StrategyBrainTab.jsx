/**
 * Strategy Brain — the autonomous strategy researcher (lib/strategy-brain.js,
 * GET /api/strategy-brain/status). Shows its switch, the research arms with
 * what each has earned (Thompson-sampling posterior, share of the next tries,
 * forward record of what it admitted, lessons), the strategies it found, and
 * its recent runs. Admins can start a run, pause or resume.
 */
import { Fragment, useCallback, useEffect, useState } from 'react'
import { Play, Pause, RotateCcw, Loader2, Brain, Lock } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { Card, Note, Stat } from './shared'

const when = t => (t ? new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—')
const pct = v => (v == null ? '—' : `${Math.round(v * 100)}%`)
const STATUS_STYLE = { pass: 'text-mint-400', review: 'text-amber-300', fail: 'text-red-400', na: 'text-slate-500' }
const STATUS_TEXT = { pass: 'pass', review: 'review', fail: 'fail', na: 'n/a' }

/** The validation report card stored with an admitted strategy (lib/strategy-evidence.js). */
function ReportCard({ card, hypothesis }) {
  if (!card) return <p className="text-[11px] text-slate-500">No report card — admitted before cards were recorded.</p>
  return (
    <>
    {hypothesis?.statement && <p className="text-[11px] text-slate-400 mb-1">Hypothesis{hypothesis.source === 'default' ? ' (type default)' : ''}: {hypothesis.statement}</p>}
    <table className="text-[11px] w-full">
      <tbody>{card.rows.map(r => (
        <tr key={r.key} className="border-t border-slate-500/10 align-top">
          <td className="pr-3 py-1 text-slate-300 whitespace-nowrap">{r.label}</td>
          <td className={`pr-3 font-medium ${STATUS_STYLE[r.status] || 'text-slate-400'}`}>{STATUS_TEXT[r.status] || r.status}</td>
          <td className="text-slate-400">{r.value || '—'}</td>
        </tr>
      ))}</tbody>
    </table>
    </>
  )
}

const HYP_LABEL = { uptrend: 'Up-trends', downtrend: 'Down-trends', range: 'Ranges', calm: 'Calm markets', stressed: 'Stressed markets', 'none stated': 'None stated' }

/** Admitted strategies grouped by the market they claimed to work in. */
function HypothesisTally({ tally }) {
  const rows = Object.entries(tally || {})
  if (!rows.length) return null
  return (
    <Card title="Which ideas survive">
      <p className="text-[11px] text-slate-500 mb-2">Each strategy states the market it should work in before it is tested; its own trades in those markets then judge the claim (supported / unclear / too few trades), and a contradicted claim is never admitted. Forward = re-tests on bars after admission.</p>
      <table className="text-[11px] w-full">
        <thead><tr className="text-slate-500 text-left">{['Claimed market', 'Admitted', 'Active', 'Claim judged by its trades', 'Forward'].map(h => <th key={h} className="font-medium pr-3 pb-1">{h}</th>)}</tr></thead>
        <tbody>{rows.map(([k, t]) => (
          <tr key={k} className="border-t border-slate-500/10">
            <td className="pr-3 py-1 text-slate-300">{HYP_LABEL[k] || k}</td>
            <td className="pr-3 tabular-nums text-slate-300">{t.admitted}</td>
            <td className="pr-3 tabular-nums text-slate-300">{t.active}</td>
            <td className="pr-3 text-slate-400">{Object.entries(t.verdicts).map(([v, c]) => `${v} ${c}`).join(' · ')}</td>
            <td className="pr-3 tabular-nums text-slate-300">{t.forwardTests ? `${t.forwardPasses} / ${t.forwardTests} passed` : 'not yet'}</td>
          </tr>
        ))}</tbody>
      </table>
    </Card>
  )
}

export default function StrategyBrainTab() {
  const { authFetch, isAuthenticated, user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState(null)
  const [open, setOpen] = useState(null)

  const load = useCallback(async () => {
    if (!isAuthenticated) { setState({ loading: false, error: null, data: null }); return }
    try {
      const r = await authFetch('/api/strategy-brain/status')
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
      setState({ loading: false, error: null, data: d })
    } catch (e) { setState(s => ({ ...s, loading: false, error: e.message })) }
  }, [authFetch, isAuthenticated])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!state.data?.running) return undefined
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [state.data?.running, load])

  const act = async path => {
    setBusy(true); setMsg(null)
    try {
      const r = await authFetch(`/api/strategy-brain/${path}`, { method: 'POST' })
      const d = await r.json().catch(() => ({}))
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
    } catch (e) { setMsg(e.message) }
    setBusy(false)
    setTimeout(load, 800)
  }

  if (!isAuthenticated) return <Note><Lock className="inline w-3 h-3 mr-1" />Sign in to see the Strategy Brain.</Note>
  if (state.loading) return <Card><p className="text-xs text-slate-400">Loading the Strategy Brain…</p></Card>
  if (state.error) return <Note tone="warn">Could not load the Strategy Brain: {state.error}</Note>
  const d = state.data
  const label = !d.enabled ? 'Off' : d.paused ? 'Paused' : d.running ? 'Running' : 'On'

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex flex-wrap items-start gap-3">
          <Brain className="w-5 h-5 text-mint-400 mt-0.5" />
          <div className="flex-1 min-w-[16rem]">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-semibold text-white">Strategy Brain</h2>
              <span className={`text-[11px] px-2 py-0.5 rounded-full border ${d.enabled && !d.paused ? 'text-mint-400 border-mint-500/30 bg-mint-500/10' : 'text-amber-300 border-amber-500/30 bg-amber-500/10'}`}>{label}</span>
              {d.running && <Loader2 className="w-3.5 h-3.5 animate-spin text-slate-400" />}
            </div>
            <p className="text-xs text-slate-400 mt-1">
              An autonomous researcher. Every night it builds new strategies — machine-learning models as trading rules (including an ensemble it composes), random catalog parameters,
              and rules a language model proposes — tests each in the Quant Lab engine (next-day fills, costs, both the older and the recent window, the deflated Sharpe for every variant tried,
              the overfitting checks, at least 20 trades with a measurable edge per trade, and no common market state where it loses) and adds the survivors to the strategy library on its own. It then learns which kinds of research are worth its time: each method's share of the next tries
              follows what its strategies did — and strategies that die when re-tested forward count against the method twice. It never trades and cannot change its limits.
            </p>
            {d.stopReason && <p className="text-xs text-amber-300 mt-1">Not running: {d.stopReason}.</p>}
            {msg && <p className="text-xs text-red-400 mt-1">{msg}</p>}
          </div>
          {isAdmin && (
            <div className="flex gap-2">
              <button type="button" disabled={busy || !!d.stopReason || d.running} onClick={() => act('run')} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-500/25 text-slate-200 disabled:opacity-40"><Play className="w-3.5 h-3.5" /> Run now</button>
              {d.paused
                ? <button type="button" disabled={busy} onClick={() => act('resume')} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-500/25 text-slate-200 disabled:opacity-40"><RotateCcw className="w-3.5 h-3.5" /> Resume</button>
                : <button type="button" disabled={busy} onClick={() => act('pause')} className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-amber-500/30 text-amber-300 disabled:opacity-40"><Pause className="w-3.5 h-3.5" /> Pause</button>}
            </div>
          )}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
          <Stat label="Experiments per run" value={d.experimentsPerRun} sub="STRATEGY_BRAIN_EXPERIMENTS" />
          <Stat label="Strategies found" value={d.strategies.length} sub={`${d.strategies.filter(s => s.status !== 'retired').length} still active`} />
          <Stat label="Held up forward" value={d.strategies.reduce((a, s) => a + s.forwardPasses, 0)} sub={`of ${d.strategies.reduce((a, s) => a + s.forwardTests, 0)} forward re-tests`} />
          <Stat label="Shared AI budget" value={d.budget ? `$${d.budget.spentUsd} / $${d.budget.capUsd}` : '—'} sub={d.budget?.exhausted ? 'model-using methods paused' : 'with the Agent Desk'} />
        </div>
      </Card>

      <Card title="What it has learned — research methods">
        <p className="text-[11px] text-slate-500 mb-2">Score = the posterior chance a try with this method finds a strategy that holds up (admissions count once, forward re-tests twice). "Next tries" = how often it would pick this method right now.</p>
        <div className="overflow-x-auto">
          <table className="text-[11px] w-full">
            <thead><tr className="text-slate-500 text-left">{['Method', 'Tries', 'Found', 'Forward pass / fail', 'Score', 'Next tries', 'Lessons (why tries failed)'].map(h => <th key={h} className="font-medium pr-3 pb-1 whitespace-nowrap">{h}</th>)}</tr></thead>
            <tbody>{d.arms.map(a => (
              <tr key={a.id} className="border-t border-slate-500/10 align-top">
                <td className="pr-3 py-1 text-slate-200 whitespace-nowrap">{a.label}{a.llm ? <span className="text-slate-500"> · uses AI budget</span> : null}</td>
                <td className="pr-3 tabular-nums text-slate-300">{a.tries}</td>
                <td className="pr-3 tabular-nums text-slate-300">{a.admitted}</td>
                <td className="pr-3 tabular-nums text-slate-300">{a.forward?.forwardPass ?? 0} / {a.forward?.forwardFail ?? 0}</td>
                <td className="pr-3 tabular-nums text-slate-300">{pct(a.mean)}</td>
                <td className="pr-3 tabular-nums text-mint-400">{pct(a.pBest)}</td>
                <td className="pr-3 text-slate-400">{a.lessons.length ? a.lessons.map(([r, c]) => `${r} ×${c}`).join('; ') : '—'}</td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      </Card>

      <Card title={`Strategies it found (${d.strategies.length})`}>
        {!d.strategies.length ? <p className="text-xs text-slate-500">None yet — most tries find nothing, which is the honest result. Survivors appear here and in the strategy library.</p> : (
          <div className="overflow-x-auto">
            <table className="text-[11px] w-full">
              <thead><tr className="text-slate-500 text-left">{['Found', 'Symbol', 'Strategy', 'Method', 'Status', 'Fitness', 'Forward', 'Checks'].map(h => <th key={h} className="font-medium pr-3 pb-1 whitespace-nowrap">{h}</th>)}</tr></thead>
              <tbody>{d.strategies.map(s => (
                <Fragment key={s.id}>
                <tr className="border-t border-slate-500/10">
                  <td className="pr-3 py-1 text-slate-400 whitespace-nowrap">{when(s.discoveredAt)}</td>
                  <td className="pr-3"><a className="font-mono text-mint-400 hover:underline" href={`#/research-desk/${encodeURIComponent(s.symbol)}`}>{s.symbol}</a></td>
                  <td className="pr-3 text-slate-300">{s.name}</td>
                  <td className="pr-3 text-slate-400 whitespace-nowrap">{s.arm}</td>
                  <td className={`pr-3 ${s.status === 'retired' ? 'text-slate-500' : 'text-mint-400'}`}>{s.status}</td>
                  <td className="pr-3 tabular-nums text-slate-300">{s.fitness ?? '—'}</td>
                  <td className="pr-3 tabular-nums text-slate-300">{s.forwardPasses} / {s.forwardTests} passed</td>
                  <td className="pr-3"><button type="button" onClick={() => setOpen(open === s.id ? null : s.id)} className={`underline-offset-2 hover:underline ${STATUS_STYLE[s.card?.overall] || 'text-slate-400'}`}>{s.card ? `${s.card.overall}${open === s.id ? ' ▴' : ' ▾'}` : '—'}</button></td>
                </tr>
                {open === s.id && <tr><td colSpan={8} className="pb-3 pt-1"><ReportCard card={s.card} hypothesis={s.hypothesis} /></td></tr>}
                </Fragment>
              ))}</tbody>
            </table>
          </div>
        )}
      </Card>

      <HypothesisTally tally={d.hypotheses} />

      <Card title="Recent runs">
        {!d.runs.length ? <p className="text-xs text-slate-500">No run yet. It runs nightly at 3:40 AM ET when switched on{isAdmin ? ', or press Run now' : ''}.</p> : (
          <div className="space-y-3">{d.runs.map(r => (
            <div key={r.at}>
              <div className="text-[11px] text-slate-500">{when(r.at)} · {r.trigger}{r.stopped ? ` · stopped: ${r.stopped}` : ''}</div>
              <ul className="text-[11px] text-slate-300 mt-1 space-y-0.5">{r.experiments.map((e, i) => (
                <li key={i}><span className="text-slate-400">{e.arm}</span> on <span className="font-mono">{e.symbol}</span>: {e.admitted ? <span className="text-mint-400">{e.admitted} admitted</span> : 'nothing admitted'} of {e.tried} tried{Object.keys(e.reasons || {}).length ? <span className="text-slate-500"> — {Object.entries(e.reasons).map(([k, v]) => `${k} ×${v}`).join('; ')}</span> : null}</li>
              ))}</ul>
            </div>
          ))}</div>
        )}
      </Card>
      <Note>The library is research, not money: admitted strategies inform the AI Brain and the Agent Desk, are re-tested forward every night by the evolution job and retired when they decay. Nothing here places a trade.</Note>
    </div>
  )
}
