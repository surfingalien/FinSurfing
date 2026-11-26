/**
 * RankedPortfolio — does a model that combines every price/volume feature,
 * holding its top names, beat owning the whole list? (lib/ranked-portfolio.js,
 * GET /api/evolution/ranked-portfolio). Walk-forward, after costs, with the
 * simplest alternative (momentum alone) beside it. Read-only; an admin can rerun.
 */
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { Card, Note, Stat } from './shared'

const VERDICT = {
  outperforms:   ['text-emerald-400', 'Beat owning the whole list'],
  underperforms: ['text-red-400', 'Did worse than owning the whole list'],
  'no-difference': ['text-slate-300', 'No measurable difference from owning the whole list'],
  insufficient:  ['text-slate-400', 'Not enough rebalances yet to judge'],
}
const pct = v => (v == null ? '—' : `${v > 0 ? '+' : ''}${v}%`)

function Row({ label, s }) {
  if (!s) return null
  return (
    <tr className="text-slate-300">
      <td className="pr-3 py-1">{label}</td>
      <td className={`pr-3 ${VERDICT[s.verdict]?.[0] || ''}`}>{VERDICT[s.verdict]?.[1] || s.verdict}</td>
      <td className="pr-3 font-mono tabular-nums">{pct(s.meanExcessPct)}</td>
      <td className="pr-3 font-mono tabular-nums">{s.t ?? '—'}</td>
      <td className="pr-3 font-mono tabular-nums">{pct(s.olderPct)} / {pct(s.newerPct)}</td>
      <td className="font-mono tabular-nums">{pct(s.portfolioTotalPct)} vs {pct(s.benchmarkTotalPct)}</td>
    </tr>
  )
}

export default function RankedPortfolio() {
  const { authFetch, isAuthenticated, user } = useAuth()
  const [state, setState] = useState({ loading: true, error: null, study: null })
  const [running, setRunning] = useState(false)

  const load = useCallback(async () => {
    if (!isAuthenticated) return
    try {
      const r = await authFetch('/api/evolution/ranked-portfolio')
      const d = await r.json()
      if (!r.ok || d.error) throw new Error(d.error || `HTTP ${r.status}`)
      setState({ loading: false, error: null, study: d.study })
    } catch (e) { setState({ loading: false, error: e.message, study: null }) }
  }, [authFetch, isAuthenticated])
  useEffect(() => { load() }, [load])

  const rerun = async () => {
    setRunning(true)
    try { await authFetch('/api/evolution/ranked-portfolio/run', { method: 'POST' }) } catch { /* the reload shows the state */ }
    setTimeout(() => { setRunning(false); load() }, 60_000)
  }

  if (!isAuthenticated || state.loading) return null
  const s = state.study, p = s?.params
  return (
    <Card title="Ranked portfolio — many features, one ranking, the top names held">
      {state.error ? <Note tone="warn">Could not load the study: {state.error}</Note> : !s ? (
        <p className="text-xs text-slate-400">Not run yet — the weekly job runs it on Saturdays{user?.role === 'admin' ? ', or start it now' : ''}.</p>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-slate-400">
            {p.features.length} price and volume features (returns, volatility, distance from averages and highs, range position, volume surge), ranked across {s.universe} large caps
            every {p.horizon} sessions. A ridge model refitted each time on earlier results only ranks them; the portfolio holds the top {p.topK}, changing at
            most {p.nDrop} a time, paying {p.costBps}bps a round trip. Compared with owning all {s.universe} equally.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Rebalances tested" value={s.model.periods} sub={`after ${p.minTrain} of training`} />
            <Stat label="Average excess a rebalance" value={pct(s.model.meanExcessPct)} sub={`t ${s.model.t ?? '—'}`} />
            <Stat label="Rank correlation" value={s.model.meanIc ?? '—'} sub={`t ${s.model.icT ?? '—'}`} />
            <Stat label="Names changed a rebalance" value={s.model.meanTurnover ?? '—'} sub={`of ${p.topK} held`} />
          </div>
          <div className="overflow-x-auto">
            <table className="text-[11px] w-full">
              <thead><tr className="text-slate-500 text-left">
                <th className="pr-3 font-normal">Ranking</th><th className="pr-3 font-normal">Verdict</th><th className="pr-3 font-normal">Excess / rebalance</th>
                <th className="pr-3 font-normal">t</th><th className="pr-3 font-normal">Older / newer half</th><th className="font-normal">Total: portfolio vs list</th>
              </tr></thead>
              <tbody>
                <Row label="Model (all features)" s={s.model} />
                <Row label="Momentum alone (3-month)" s={s.momentum} />
              </tbody>
            </table>
          </div>
          {s.today?.top?.length > 0 && (
            <p className="text-xs text-slate-400">
              {s.model.verdict === 'outperforms' ? 'Top of the ranking' : 'Top of the ranking (the model has not shown an edge, so this is not a buy list)'} on {s.today.date}:{' '}
              {s.today.top.map((x, i) => <span key={x.symbol}>{i ? ', ' : ''}<a href={`#/research-desk/${encodeURIComponent(x.symbol)}`} className="font-mono text-mint-400 hover:underline">{x.symbol}</a></span>)}
            </p>
          )}
          <div className="space-y-1">
            <Note>Verdict needs t ≥ 2 on the excess per rebalance (rebalances do not overlap) and both halves of the record positive. {s.caveats?.join(' ')}</Note>
            <p className="text-[10px] text-slate-500">Last run {String(s.ranAt).slice(0, 16).replace('T', ' ')} UTC.</p>
          </div>
        </div>
      )}
      {user?.role === 'admin' && (
        <button type="button" disabled={running} onClick={rerun} className="mt-2 inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-500/25 text-slate-200 disabled:opacity-40">
          <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} /> {running ? 'Running — about a minute' : 'Run now'}
        </button>
      )}
    </Card>
  )
}
