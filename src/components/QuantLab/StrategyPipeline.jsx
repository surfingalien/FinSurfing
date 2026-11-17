/**
 * StrategyPipeline — two views of the strategy research pipeline:
 *
 *  - Funnel:    how many ideas were tested and where the rest died, from the
 *               Strategy Brain's own records (lib/strategy-brain.js:funnel).
 *               Real counts; each idea is counted at the first check it failed.
 *  - PaperDesk: every admitted strategy on virtual money for four weeks, on
 *               bars that arrived after it was enrolled (lib/strategy-paper.js).
 *
 * The paper desk is a simulation: it places no order and moves no money.
 */
import { lazy, Suspense, useCallback, useEffect, useMemo, useState } from 'react'
import { Loader2, RefreshCw } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'
import { Card, Note, Stat } from './shared'

const PriceChart = lazy(() => import('../shared/PriceChart'))
const COLORS = ['#2563eb', '#f59e0b', '#10b981', '#ec4899', '#8b5cf6', '#64748b', '#0891b2', '#dc2626']
const pct = v => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(2)}%`)
const tone = v => (v == null ? 'text-slate-500' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-300')
const STATUS = {
  graduated: ['Graduated', 'text-mint-400 border-mint-500/30 bg-mint-500/10'],
  failed: ['Failed', 'text-red-400 border-red-500/30 bg-red-500/10'],
  'no-trades': ['Did not trade', 'text-slate-300 border-slate-500/25 bg-slate-500/10'],
  running: ['Running', 'text-amber-300 border-amber-500/30 bg-amber-500/10'],
}

export function Funnel({ funnel }) {
  if (!funnel) return null
  const max = Math.max(1, funnel.tested)
  const rows = [
    { label: 'Ideas tested', count: funnel.tested, killed: null },
    ...funnel.stages.map(s => ({ label: s.label, count: s.survivors, killed: s.killed })),
  ]
  return (
    <Card title="The funnel — where ideas die">
      {funnel.tested === 0 ? (
        <p className="text-xs text-slate-500">Nothing has been tested yet. The counts appear after the Strategy Brain's first run.</p>
      ) : (
        <>
          <ol className="space-y-2">
            {rows.map((r, i) => (
              <li key={r.label}>
                <div className="flex items-baseline justify-between gap-3 text-xs">
                  <span className="text-slate-300">{i === 0 ? r.label : <>Still alive after: <span className="text-slate-400">{r.label}</span></>}</span>
                  <span className="tabular-nums shrink-0">
                    <b className="text-white font-semibold">{r.count.toLocaleString()}</b>
                    {r.killed != null && <span className="text-slate-500"> · {r.killed.toLocaleString()} died here</span>}
                  </span>
                </div>
                <div className="h-2 mt-1 rounded-full bg-slate-500/15 overflow-hidden" aria-hidden="true">
                  <div className={`h-full rounded-full ${i === rows.length - 1 ? 'bg-mint-400' : 'bg-indigo-400/70'}`} style={{ width: `${Math.max(r.count > 0 ? 1.5 : 0, (r.count / max) * 100)}%` }} />
                </div>
              </li>
            ))}
          </ol>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mt-3">
            <Stat label="Admitted to the library" value={funnel.admitted.toLocaleString()} sub={`${((funnel.admitted / max) * 100).toFixed(funnel.admitted / max < 0.1 ? 2 : 0)}% of ideas tested`} />
            <Stat label="Still active" value={funnel.stillActive} sub="not retired since" />
            <Stat label="Held up on new data" value={funnel.forwardProven} sub="passed a forward re-test" />
            <Stat label="Paper desk graduates" value={funnel.paper ? funnel.paper.graduated : '—'} sub={funnel.paper ? `${funnel.paper.running} running · ${funnel.paper.failed} failed` : 'no programs yet'} />
          </div>
          <div className="mt-3 space-y-1.5">
            <Note>Each idea is counted once, at the first check it failed, in the order the checks run. These are this app's real counts, not an illustration.</Note>
            {funnel.duplicates > 0 && <Note>{funnel.duplicates.toLocaleString()} passed every check but were not admitted: a parameter sweep keeps at most two settings of one rule on one symbol, since neighbouring settings are near-copies of the same idea. Every setting a sweep tries counts as a trial, so a bigger sweep raises the luck bar each one must clear.</Note>}
            {funnel.notTestable > 0 &&<Note>{funnel.notTestable.toLocaleString()} more could not be tested at all — no price history, a rule the allow-list refused, or an error — and are left out of the funnel.</Note>}
          </div>
        </>
      )}
    </Card>
  )
}

export function PaperDesk() {
  const { authFetch, isAuthenticated, user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(false)
  const [only, setOnly] = useState(null)        // isolate one curve

  const load = useCallback(async () => {
    if (!isAuthenticated) return
    try {
      const r = await authFetch('/api/strategy-brain/paper')
      const b = await r.json().catch(() => ({}))
      if (!r.ok || b.error) throw new Error(b.error || `Request failed (${r.status})`)
      setData(b); setError(null)
    } catch (e) { setError(e.message) }
  }, [authFetch, isAuthenticated])
  useEffect(() => { load() }, [load])
  useEffect(() => {
    if (!data?.running_now) return undefined
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [data?.running_now, load])

  const runNow = async () => {
    setBusy(true); setError(null)
    try {
      const r = await authFetch('/api/strategy-brain/paper/run', { method: 'POST' })
      const b = await r.json().catch(() => ({}))
      if (!r.ok || b.error) throw new Error(b.error || `Request failed (${r.status})`)
      setTimeout(load, 1500)
    } catch (e) { setError(e.message) } finally { setBusy(false) }
  }

  const all = useMemo(() => [...(data?.running || []), ...(data?.decided || [])], [data])
  const lines = useMemo(() => all.filter(p => p.curve.length >= 2 && (!only || only === p.id)).slice(0, 8)
    .map(p => ({ name: `${p.symbol} ${p.strategy || ''}`.trim(), points: p.curve, color: COLORS[all.indexOf(p) % COLORS.length] })), [all, only])

  if (!isAuthenticated) return null
  return (
    <Card title="Paper desk — four weeks on virtual money">
      <div className="flex flex-wrap items-start justify-between gap-3 mb-3">
        <p className="text-xs text-slate-400 max-w-3xl">
          Every strategy the library admits trades ${data ? data.capital.toLocaleString() : '10,000'} of virtual money for {data?.sessions ?? 20} trading days, on prices that arrive after it was enrolled — the first
          evidence nobody could have fitted to. It graduates only if it ends in profit after costs and never fell further than simply holding the stock. No order is placed anywhere.
        </p>
        {isAdmin && (
          <button type="button" onClick={runNow} disabled={busy || data?.running_now} title="Fetches today's prices and advances every running program. No AI call."
            className="inline-flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-500/25 text-slate-200 disabled:opacity-40">
            {busy || data?.running_now ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Update now
          </button>
        )}
      </div>
      {error && <p className="text-xs text-red-400 mb-2" role="alert">{error}</p>}
      {!data && !error && <p className="text-xs text-slate-500">Loading…</p>}

      {data && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Stat label="Running" value={data.counts.running} sub={`of ${data.sessions} sessions each`} />
            <Stat label="Graduated" value={data.counts.graduated} sub={data.graduationRate != null ? `${Math.round(data.graduationRate * 100)}% of those that traded` : 'none judged yet'} />
            <Stat label="Failed" value={data.counts.failed} sub="lost money or fell too far" />
            <Stat label="Did not trade" value={data.counts.noTrades} sub="too short to judge — not a pass" />
          </div>

          {all.length === 0 && (
            <p className="text-xs text-slate-500 mt-3">
              No programs yet. A program starts the evening after a strategy is admitted to the library; the desk updates each day at 6:10 PM New York time.
            </p>
          )}

          {lines.length > 0 && (
            <div className="mt-3">
              <Suspense fallback={<div className="h-[260px] text-xs text-slate-500">Loading chart…</div>}>
                <PriceChart lines={lines} percent height={260} label="Paper desk equity curves, as percent change from the starting capital" />
              </Suspense>
              <p className="text-[11px] text-slate-500 mt-1">Each line is one program's virtual equity, as percent change from its start. {only ? <button type="button" className="underline" onClick={() => setOnly(null)}>Show all</button> : 'Select a row to show only that one.'}</p>
            </div>
          )}

          {all.length > 0 && (
            <div className="relative overflow-x-auto mt-3">
              <table className="w-full text-xs min-w-[640px]">
                <thead><tr className="text-left text-slate-500">
                  <th scope="col" className="font-medium py-1.5 pr-3">Strategy</th>
                  <th scope="col" className="font-medium py-1.5 px-2">Status</th>
                  <th scope="col" className="font-medium py-1.5 px-2 text-right">Day</th>
                  <th scope="col" className="font-medium py-1.5 px-2 text-right">Return</th>
                  <th scope="col" className="font-medium py-1.5 px-2 text-right">Holding</th>
                  <th scope="col" className="font-medium py-1.5 px-2 text-right">Worst fall</th>
                  <th scope="col" className="font-medium py-1.5 pl-2">What happened</th>
                </tr></thead>
                <tbody>{all.map((p, i) => {
                  const [label, cls] = STATUS[p.status] || STATUS.running
                  return (
                    <tr key={p.id} className={`border-t border-slate-500/10 align-top ${only === p.id ? 'bg-slate-500/10' : ''}`}>
                      <th scope="row" className="text-left font-normal py-1.5 pr-3">
                        <button type="button" onClick={() => setOnly(only === p.id ? null : p.id)} aria-pressed={only === p.id} className="text-left">
                          <span className="inline-block w-2 h-2 rounded-full mr-1.5 align-middle" style={{ background: COLORS[i % COLORS.length] }} aria-hidden="true" />
                          <span className="font-semibold text-white">{p.symbol}</span> <span className="text-slate-400">{p.strategy}</span>
                        </button>
                        <div className="text-[10px] text-slate-500 truncate max-w-[16rem]">{p.name}</div>
                      </th>
                      <td className="py-1.5 px-2"><span className={`text-[10px] px-2 py-0.5 rounded-full border ${cls}`}>{label}</span></td>
                      <td className="py-1.5 px-2 text-right tabular-nums text-slate-300">{p.sessions}/{p.of}</td>
                      <td className={`py-1.5 px-2 text-right tabular-nums ${tone(p.returnPct)}`}>{pct(p.returnPct)}</td>
                      <td className={`py-1.5 px-2 text-right tabular-nums ${tone(p.result?.holdReturnPct)}`}>{p.result ? pct(p.result.holdReturnPct) : '—'}</td>
                      <td className="py-1.5 px-2 text-right tabular-nums text-slate-300">{p.result ? `${p.result.maxDrawdownPct}%` : '—'}</td>
                      <td className="py-1.5 pl-2 text-slate-400">
                        {p.reason || (p.sessions === 0 ? 'Waiting for its first session.' : p.inPosition ? 'Holding a position.' : 'In cash, waiting for a signal.')}
                        {p.fills.length > 0 && <div className="text-[10px] text-slate-500 mt-0.5">Last fills: {p.fills.slice(-3).map(f => `${f.type} ${f.date.slice(5)} @ ${f.price}`).join(' · ')}</div>}
                      </td>
                    </tr>
                  )
                })}</tbody>
              </table>
            </div>
          )}

          <div className="mt-3 space-y-1.5">
            <Note>Four weeks of one strategy is a small sample. Graduating means it did not fail its first live month — not that it is proven. The nightly forward re-test still decides what stays in the library.</Note>
            {data.lastRun && <Note>Last updated {new Date(data.lastRun.at).toLocaleString()}: {data.lastRun.advanced} advanced, {data.lastRun.decided} decided, {data.lastRun.enrolled} enrolled{data.lastRun.noData?.length ? `. No price data for ${data.lastRun.noData.join(', ')} — those programs wait; an outage is never counted as a failure` : ''}.</Note>}
          </div>
        </>
      )}
    </Card>
  )
}
