/**
 * Queue — the watchlist and holdings as one research worklist
 * (POST /api/research-desk/queue, lib/research-compare.js). No model is called.
 *
 * Rows that need a decision come first: a thesis whose check-by date has
 * arrived, one that hit its target or stop, then anything carrying a flag.
 * Flags are measured facts at fixed thresholds (listed under the table), not
 * signals.
 *
 * "Since you last looked" compares with the price this browser saw on an
 * earlier day (localStorage); a record is only replaced once it is ~a day old,
 * so reloading the page does not erase the comparison.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Loader2, RefreshCw, ArrowUpRight, Columns3, ListTodo } from 'lucide-react'

const SEEN_KEY = 'finsurf_research_queue_seen'
const SEEN_MIN_AGE_MS = 20 * 3600_000

const readSeen = () => { try { return JSON.parse(localStorage.getItem(SEEN_KEY) || '{}') || {} } catch { return {} } }
const writeSeen = (m) => { try { localStorage.setItem(SEEN_KEY, JSON.stringify(m)) } catch { /* private mode */ } }

const pct = (v, dp = 1) => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(dp)}%`)
const tone = (v) => (v == null || v === 0 ? 'text-slate-300' : v > 0 ? 'text-emerald-400' : 'text-red-400')

const THESIS = {
  'target-hit': { label: 'Target hit', cls: 'text-emerald-400 border-emerald-500/25 bg-emerald-500/10' },
  stopped:      { label: 'Stopped out', cls: 'text-red-400 border-red-500/25 bg-red-500/10' },
  open:         { label: 'Thesis open', cls: 'text-sky-400 border-sky-500/25 bg-sky-500/10' },
  expired:      { label: 'Thesis expired', cls: 'text-slate-300 border-slate-500/25 bg-slate-500/10' },
  'no-trade':   { label: 'No trade', cls: 'text-slate-400 border-slate-500/25 bg-slate-500/10' },
}
const COLS = [
  { key: 'ret1d', label: 'Day' }, { key: 'ret1m', label: '1 month' }, { key: 'ret3m', label: '3 months' },
  { key: 'fromHigh', label: 'From high' }, { key: 'vol21', label: 'Vol forecast' },
]

export default function QueueTab({ call, symbols = [], onOpen, onCompare }) {
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [sort, setSort] = useState(null)            // { key, dir } | null = the server's needs-attention order
  const [picked, setPicked] = useState([])
  const [seen, setSeen] = useState({})
  const key = symbols.join(',')
  const reqId = useRef(0)

  const load = useCallback(async () => {
    if (!symbols.length) { setData({ rows: [], flagRules: [] }); return }
    // The list arrives in two steps (watchlist, then holdings). Only the newest request may
    // write the table — an older, smaller answer landing late must not replace it.
    const id = ++reqId.current
    setBusy(true); setError(null)
    try {
      const d = await call('/api/research-desk/queue', { method: 'POST', body: { symbols } })
      if (id !== reqId.current) return
      const before = readSeen()
      setSeen(before)                                // compare against what was stored BEFORE this load
      const next = { ...before }
      const now = Date.now()
      for (const r of d.rows) if (r.ok && (!before[r.symbol] || now - before[r.symbol].at > SEEN_MIN_AGE_MS)) next[r.symbol] = { last: r.last, at: now }
      writeSeen(next)
      setData(d)
    } catch (e) { if (id === reqId.current) setError(e.message) } finally { if (id === reqId.current) setBusy(false) }
  }, [call, key]) // eslint-disable-line react-hooks/exhaustive-deps

  // Wait for the list to settle before asking, so a list that is still filling in costs one request.
  useEffect(() => { const t = setTimeout(load, 500); return () => clearTimeout(t) }, [load])

  const rows = useMemo(() => {
    if (!data?.rows) return []
    if (!sort) return data.rows
    const val = r => (r.ok ? r.values?.[sort.key] : null)
    return [...data.rows].sort((a, b) => {
      const x = val(a), y = val(b)
      if (x == null && y == null) return 0
      if (x == null) return 1                         // missing values always last, whichever direction
      if (y == null) return -1
      return sort.dir === 'desc' ? y - x : x - y
    })
  }, [data, sort])

  const toggleSort = (k) => setSort(s => (s?.key !== k ? { key: k, dir: 'desc' } : s.dir === 'desc' ? { key: k, dir: 'asc' } : null))
  const togglePick = (s) => setPicked(p => (p.includes(s) ? p.filter(x => x !== s) : p.length >= 6 ? p : [...p, s]))
  const sinceSeen = (r) => {
    const rec = seen[r.symbol]
    if (!rec || !rec.last || Date.now() - rec.at < SEEN_MIN_AGE_MS) return null
    return { pct: (r.last / rec.last - 1) * 100, at: rec.at }
  }

  if (!symbols.length) {
    return (
      <div className="glass rounded-2xl p-6 text-sm text-slate-500 flex gap-3">
        <ListTodo className="w-5 h-5 shrink-0 text-slate-500" />
        <p>Your research queue is built from your watchlist and your holdings, and both are empty. Add symbols to the Watchlist and they appear here with what has moved, what is flagged, and which of your theses are due for another look.</p>
      </div>
    )
  }

  const needs = (data?.rows || []).filter(r => r.ok && (r.thesis?.review?.state === 'due' || r.thesis?.state === 'target-hit' || r.thesis?.state === 'stopped')).length

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="text-sm text-slate-400 mr-auto">
          {symbols.length} symbols from your watchlist and holdings.
          {data && (needs > 0 ? <span className="text-amber-300"> {needs} need{needs === 1 ? 's' : ''} a decision — listed first.</span> : ' Nothing is waiting on a decision.')}
        </p>
        {onCompare && (
          <button type="button" disabled={picked.length < 2} onClick={() => onCompare(picked)}
            title="Tick two to six rows, then compare them side by side"
            className="px-3 py-1.5 rounded-lg text-xs border border-slate-500/25 text-slate-300 hover:text-white disabled:opacity-40 inline-flex items-center gap-1.5">
            <Columns3 className="w-3.5 h-3.5" /> Compare selected{picked.length ? ` (${picked.length})` : ''}
          </button>
        )}
        <button type="button" onClick={load} disabled={busy} className="px-3 py-1.5 rounded-lg text-xs border border-slate-500/25 text-slate-300 hover:text-white disabled:opacity-40 inline-flex items-center gap-1.5">
          {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <RefreshCw className="w-3.5 h-3.5" />} Refresh
        </button>
      </div>
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!data && busy && <div className="glass rounded-2xl p-6 text-sm text-slate-500 flex items-center gap-2"><Loader2 className="w-4 h-4 animate-spin" /> Pricing {symbols.length} symbols…</div>}

      {data && rows.length > 0 && rows.length < symbols.length && busy && <p className="text-[11px] text-slate-500">Updating — pricing the rest of the list…</p>}
      {data && rows.length > 0 && (
        <div className="glass rounded-2xl p-4">
          <div className="relative overflow-x-auto">
            <table className="w-full text-xs min-w-[760px]">
              <thead>
                <tr className="text-[11px] text-slate-500">
                  <th scope="col" className="w-6 pb-2"><span className="sr-only">Select to compare</span></th>
                  <th scope="col" className="text-left font-medium pb-2 pr-3">Symbol</th>
                  <th scope="col" className="text-right font-medium pb-2 px-2">Last</th>
                  {COLS.map(c => (
                    <th key={c.key} scope="col" className="text-right font-medium pb-2 px-2 whitespace-nowrap" aria-sort={sort?.key === c.key ? (sort.dir === 'desc' ? 'descending' : 'ascending') : 'none'}>
                      <button type="button" onClick={() => toggleSort(c.key)} className={`hover:text-white ${sort?.key === c.key ? 'text-mint-400' : ''}`} title="Sort — click again to reverse, a third time to return to what needs attention">
                        {c.label}{sort?.key === c.key ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
                      </button>
                    </th>
                  ))}
                  <th scope="col" className="text-left font-medium pb-2 px-2">What to know</th>
                </tr>
              </thead>
              <tbody>
                {rows.map(r => {
                  if (!r.ok) {
                    return (
                      <tr key={r.symbol} className="border-t border-slate-500/10">
                        <td /><td className="py-2 pr-3 font-semibold text-slate-500">{r.symbol}</td>
                        <td colSpan={COLS.length + 2} className="py-2 px-2 text-amber-300">Could not be priced: {r.reason}.</td>
                      </tr>
                    )
                  }
                  const th = r.thesis && (THESIS[r.thesis.state] || (r.thesis.verdict === 'no-trade' ? THESIS['no-trade'] : null))
                  const since = sinceSeen(r)
                  const due = r.thesis?.review?.state === 'due'
                  return (
                    <tr key={r.symbol} className="border-t border-slate-500/10 align-top">
                      <td className="py-2">
                        <input type="checkbox" checked={picked.includes(r.symbol)} onChange={() => togglePick(r.symbol)}
                          disabled={!picked.includes(r.symbol) && picked.length >= 6} aria-label={`Select ${r.symbol} to compare`} />
                      </td>
                      <td className="py-2 pr-3">
                        <button type="button" onClick={() => onOpen?.(r.symbol)} title={`Open the full dossier for ${r.symbol}`}
                          className="inline-flex items-center gap-0.5 font-semibold text-white hover:text-mint-400">
                          {r.symbol}<ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                        </button>
                        {r.name && <div className="text-[10px] text-slate-500 truncate max-w-[11rem]">{r.name}</div>}
                      </td>
                      <td className="py-2 px-2 text-right tabular-nums text-slate-200">${r.last?.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td className={`py-2 px-2 text-right tabular-nums ${tone(r.values.ret1d)}`}>{pct(r.values.ret1d, 2)}</td>
                      <td className={`py-2 px-2 text-right tabular-nums ${tone(r.values.ret1m)}`}>{pct(r.values.ret1m)}</td>
                      <td className={`py-2 px-2 text-right tabular-nums ${tone(r.values.ret3m)}`}>{pct(r.values.ret3m)}</td>
                      <td className="py-2 px-2 text-right tabular-nums text-slate-300">{r.values.fromHigh == null ? '—' : `${r.values.fromHigh.toFixed(0)}%`}</td>
                      <td className="py-2 px-2 text-right tabular-nums text-slate-300">{r.values.vol21 == null ? '—' : `${r.values.vol21.toFixed(0)}%`}</td>
                      <td className="py-2 px-2">
                        <div className="flex flex-wrap gap-1">
                          {due && <span className="text-[10px] px-2 py-0.5 rounded-full border text-amber-300 border-amber-500/30 bg-amber-500/10">Review due</span>}
                          {th && <span className={`text-[10px] px-2 py-0.5 rounded-full border ${th.cls}`}>{th.label}</span>}
                          {r.flags.map(f => <span key={f.id} title={f.label} className="text-[10px] px-2 py-0.5 rounded-full border text-slate-300 border-slate-500/25 bg-slate-500/10">{f.label}</span>)}
                        </div>
                        {due && <div className="text-[11px] text-slate-400 mt-1">Wrong if: {r.thesis.review.wrongIf}</div>}
                        {since && <div className="text-[11px] text-slate-500 mt-1">Since you last looked ({new Date(since.at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}): <span className={tone(since.pct)}>{pct(since.pct)}</span></div>}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-500 mt-3">
            Measured from daily bars as of {rows.find(r => r.ok)?.asOf || 'the last close'}; no AI is involved. The labels are facts at fixed thresholds, not buy or sell signals:{' '}
            {(data.flagRules || []).map(f => f.label.toLowerCase()).join('; ')}.
            {data.dropped?.length > 0 && ` Showing the first 40 symbols; ${data.dropped.length} more were left out.`}
            {data.invalid?.length > 0 && ` Not valid tickers, ignored: ${data.invalid.join(', ')}.`}
          </p>
        </div>
      )}
    </div>
  )
}
