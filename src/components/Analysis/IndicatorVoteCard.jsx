import { useEffect, useState } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { SectionCard } from '../shared/StockCard'
import { fmt } from '../../services/api'

/**
 * The Analyze page's one indicator verdict (lib/indicator-vote.js) and how
 * that exact rule — with its 2-ATR stop / 3-ATR target — has done on this
 * stock over five years, against the same number of trades on random days
 * (lib/indicator-vote-backtest.js, GET /api/indicator-vote/backtest/:symbol).
 */
const VOTE_CLS = { 1: 'bg-emerald-500/20 text-emerald-400', '-1': 'bg-red-500/20 text-red-400', 0: 'bg-slate-500/15 text-slate-400' }
const VOTE_TXT = { 1: 'For', '-1': 'Against', 0: 'No opinion' }
const VERDICT_TXT = {
  'beats-random': ['text-emerald-400', 'Its BUY timing beat random days on this stock'],
  'no-better':    ['text-red-400', 'Its BUY timing did no better than random days on this stock'],
  unclear:        ['text-amber-400', 'Not clearly better than random days on this stock'],
  insufficient:   ['text-slate-400', 'Too few BUY signals on this stock to judge'],
}
const pct = x => (x == null ? '—' : `${Math.round(x * 100)}%`)
const sgn = x => (x == null ? '—' : `${x > 0 ? '+' : ''}${x}%`)

export default function IndicatorVoteCard({ vote, symbol, onResearch }) {
  const { authFetch, isAuthenticated } = useAuth()
  const [bt, setBt] = useState(null)
  const [btState, setBtState] = useState({ loading: false, error: null })
  const [open, setOpen] = useState(false)

  useEffect(() => {
    setBt(null)
    if (!symbol || !isAuthenticated) return
    let cancelled = false
    setBtState({ loading: true, error: null })
    authFetch(`/api/indicator-vote/backtest/${encodeURIComponent(symbol)}`)
      .then(r => r.json().then(d => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (cancelled) return
        if (!ok || d.error) throw new Error(d.error || 'backtest failed')
        setBt(d); setBtState({ loading: false, error: null })
      })
      .catch(e => { if (!cancelled) setBtState({ loading: false, error: e.message }) })
    return () => { cancelled = true }
  }, [symbol, isAuthenticated, authFetch])

  if (!vote) return null
  const color = vote.verdict === 'BUY' ? 'text-emerald-400' : vote.verdict === 'SELL' ? 'text-red-400' : 'text-amber-400'
  const trend = vote.votes[0]

  return (
    <SectionCard title="Indicator vote">
      <div className="flex items-center justify-between mb-2">
        <span className={`text-lg font-black tracking-tight ${color}`}>{vote.verdict}</span>
        <div className="text-right text-[11px] text-slate-400">
          <div><span className="text-emerald-400 font-semibold">{vote.for}</span> for · <span className="text-red-400 font-semibold">{vote.against}</span> against · {vote.noOpinion} no opinion</div>
          <div className="text-[10px] text-slate-500">of {vote.total} independent readings — a rule, not AI</div>
        </div>
      </div>

      <div className="space-y-1.5 mb-3">
        {vote.votes.map(v => (
          <div key={v.name} className="flex items-start gap-2">
            <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded shrink-0 w-[70px] text-center ${VOTE_CLS[v.vote]}`}>{VOTE_TXT[v.vote]}</span>
            <div className="min-w-0">
              <div className="text-xs text-white">{v.name}</div>
              <div className="text-[10px] text-slate-500">{v.detail}</div>
            </div>
          </div>
        ))}
      </div>
      {trend?.components?.length > 0 && (
        <button onClick={() => setOpen(o => !o)} className="text-[10px] text-slate-400 hover:text-slate-200 underline underline-offset-2 mb-2">
          {open ? 'Hide' : 'Show'} the trend readings (counted as one vote — they all measure the same trend)
        </button>
      )}
      {open && (
        <ul className="mb-3 space-y-0.5 text-[10px] text-slate-400">
          {trend.components.map(c => <li key={c.name}>{c.name}: {c.detail}</li>)}
        </ul>
      )}

      {vote.verdict === 'BUY' && vote.stop != null && (
        <div className="grid grid-cols-2 gap-2 mb-3">
          <div className="p-2 rounded-lg bg-red-500/10 border border-red-500/20">
            <div className="text-[10px] text-red-400 font-medium">Stop (2 ATR below)</div>
            <div className="text-xs font-mono text-white">${fmt(vote.stop)}</div>
          </div>
          <div className="p-2 rounded-lg bg-emerald-500/10 border border-emerald-500/20">
            <div className="text-[10px] text-emerald-400 font-medium">Target (3 ATR above)</div>
            <div className="text-xs font-mono text-white">${fmt(vote.target)}</div>
          </div>
        </div>
      )}
      {vote.verdict === 'SELL' && (
        <p className="text-[11px] text-slate-400 mb-3">Bearish: if you hold it, this is an exit signal; no new long.</p>
      )}

      <div className="pt-2 border-t border-white/[0.06]">
        <div className="text-[11px] font-semibold text-slate-300 mb-1">Has this BUY rule worked on {symbol}?</div>
        {!isAuthenticated ? (
          <p className="text-[10px] text-slate-500">Sign in to test the rule on five years of this stock's prices.</p>
        ) : btState.loading ? (
          <p className="text-[10px] text-slate-500">Testing the rule on five years of daily prices…</p>
        ) : btState.error ? (
          <p className="text-[10px] text-amber-400">Could not test it: {btState.error}</p>
        ) : bt ? (
          <div className="space-y-1 text-[11px] text-slate-400">
            <div className={VERDICT_TXT[bt.verdict]?.[0]}>{VERDICT_TXT[bt.verdict]?.[1]}{bt.p != null && bt.verdict !== 'insufficient' ? ` (p ${bt.p})` : ''}{bt.reason ? ` — ${bt.reason}` : ''}</div>
            {bt.trades > 0 && (
              <>
                <div>{bt.trades} BUY trades in {bt.years} years: target first {bt.targetFirst} ({pct(bt.targetRate)}), stop first {bt.stopFirst}, time limit {bt.timeExit} ({bt.maxHold} sessions).</div>
                <div>Average trade after costs <span className="text-slate-200 font-semibold">{sgn(bt.meanNetPct)}</span>{bt.random ? <> vs <span className="text-slate-200">{sgn(bt.random.meanNetPct)}</span> entering on random days (target first {pct(bt.random.targetRate)})</> : null}.</div>
                <div>These levels need the target first in {pct(bt.breakEvenRate)} of trades to break even before costs.</div>
              </>
            )}
            <p className="text-[10px] text-slate-500">Entry at the next day's open, the card's own stop and target, a bar touching both counts as the stop, net of {bt.costBps}bps round trip. Long only. Past results on one stock, not a forecast.</p>
          </div>
        ) : null}
      </div>
      {onResearch && (
        <button onClick={() => onResearch(symbol)} className="mt-3 w-full text-xs px-3 py-1.5 rounded-lg border border-slate-500/25 text-slate-300 hover:text-mint-400">
          Research {symbol} on the Research Desk →
        </button>
      )}
    </SectionCard>
  )
}
