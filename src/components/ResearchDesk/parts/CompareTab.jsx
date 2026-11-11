/**
 * Compare — up to six symbols side by side on measured facts
 * (GET /api/research-desk/compare, lib/research-compare.js). No model is called.
 *
 * Each row marks who is best and worst ON THAT MEASURE, when the measure has a
 * direction and at least two symbols have a value. There is deliberately no
 * overall score: a weighted total would be an opinion. A missing value shows as
 * "—" and is never ranked.
 */
import { useEffect, useRef, useState } from 'react'
import { Loader2, Columns3, Users, Info, ArrowUpRight } from 'lucide-react'

const fmt = {
  pct: v => `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(Math.abs(v) < 10 ? 1 : 0)}%`,
  ratio: v => v.toFixed(2),
  usd: v => (v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(0)}M` : `$${Math.round(v).toLocaleString()}`),
  text: v => v,
}
// Signed colouring only where the sign itself is the message (returns).
const SIGNED = new Set(['ret1m', 'ret3m', 'ret1y'])
// Risk measures are magnitudes: "+27%" would read as a gain.
const UNSIGNED_PCT = new Set(['vol21', 'var95', 'netMargin', 'roe', 'earningsYield', 'fcfYield', 'accruals'])

/** "aapl, msft nvda" → "AAPL,MSFT,NVDA": one form for the request, the URL and the already-ran check. */
const norm = (raw) => String(raw || '').toUpperCase().split(/[\s,;]+/).filter(Boolean).join(',')

function cellText(m, v) {
  if (v == null) return '—'
  if (m.key === 'pe') return v >= 100 ? v.toFixed(0) : v.toFixed(1)
  if (m.unit === 'pct' && UNSIGNED_PCT.has(m.key)) return `${v.toFixed(Math.abs(v) < 10 ? 1 : 0)}%`
  return fmt[m.unit](v)
}

export default function CompareTab({ call, initial = '', onOpen, onSymbols }) {
  const [input, setInput] = useState(initial)
  const [data, setData] = useState(null)
  const [busy, setBusy] = useState(null)       // 'compare' | 'peers'
  const [error, setError] = useState(null)
  const [peerNote, setPeerNote] = useState(null)
  const ran = useRef(null)

  const run = async (raw) => {
    const q = norm(raw)
    if (!q) return
    // Remember what was run in the URL's own form, so writing it to the URL below does not run it again.
    ran.current = q
    setBusy('compare'); setError(null)
    try {
      const d = await call(`/api/research-desk/compare?symbols=${encodeURIComponent(q)}`)
      setData(d)
      ran.current = d.order.join(',')
      onSymbols?.(ran.current)
    } catch (e) { setError(e.message); setData(null) } finally { setBusy(null) }
  }

  // Deep link (#/research-desk/vs:AAPL,MSFT) or a hand-off from AI Brain / Buy Signals.
  useEffect(() => {
    if (initial && norm(initial) !== ran.current) { setInput(norm(initial).replace(/,/g, ', ')); run(initial) }
  }, [initial]) // eslint-disable-line react-hooks/exhaustive-deps

  const suggestPeers = async () => {
    const first = input.split(/[\s,;]+/).filter(Boolean)[0]
    if (!first) return
    setBusy('peers'); setError(null); setPeerNote(null)
    try {
      const d = await call(`/api/research-desk/peers/${encodeURIComponent(first)}`)
      if (!d.peers.length) { setPeerNote(d.note || `No peers found for ${d.symbol} — it may not be a classified US stock.`); return }
      const list = [d.symbol, ...d.peers.map(p => p.symbol)].join(', ')
      setInput(list)
      setPeerNote(`Large companies in the same ${d.basis}${d.of?.[d.basis] ? ` (${d.of[d.basis]})` : ''}, from the symbol index — a starting list, edit it freely.`)
      run(list)
    } catch (e) { setError(e.message) } finally { setBusy(null) }
  }

  const first = input.split(/[\s,;]+/).filter(Boolean)[0]
  const bySymbol = (m) => Object.fromEntries(m.values.map(v => [v.symbol, v.value]))

  return (
    <div className="space-y-4">
      <form className="flex flex-wrap gap-2" onSubmit={e => { e.preventDefault(); run(input) }}>
        <input value={input} onChange={e => setInput(e.target.value.toUpperCase())} placeholder="Two to six tickers, e.g. NVDA, AMD, AVGO" aria-label="Symbols to compare"
          className="flex-1 min-w-[14rem] bg-slate-500/10 border border-slate-500/20 rounded-xl px-3 py-2 text-sm outline-none focus:border-mint-400/50" />
        <button type="button" onClick={suggestPeers} disabled={!first || !!busy} title={first ? `Fill in large companies in ${first}'s industry` : 'Type a ticker first'}
          className="px-3 py-2 rounded-xl text-sm border border-slate-500/25 text-slate-300 hover:text-white disabled:opacity-50 inline-flex items-center gap-1.5">
          {busy === 'peers' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Users className="w-4 h-4" />} {first ? `Add ${first}’s peers` : 'Add peers'}
        </button>
        <button type="submit" disabled={!input || !!busy} className="btn-primary px-4 py-2 rounded-xl text-sm flex items-center gap-1.5 disabled:opacity-50">
          {busy === 'compare' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Columns3 className="w-4 h-4" />} Compare
        </button>
      </form>
      {peerNote && <p className="text-[11px] text-slate-500">{peerNote}</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!data && !busy && !error && (
        <div className="glass rounded-2xl p-6 text-sm text-slate-500">
          Put two to six symbols side by side on what can be measured: returns, forecast volatility, tail risk, beta, liquidity, and
          valuation and fundamentals as first filed with the SEC. No AI is involved and there is no overall score — each row shows who
          leads on that measure, and you weigh them.
        </div>
      )}

      {data && (
        <>
          <div className="glass rounded-2xl p-4">
            <div className="relative overflow-x-auto">
              <table className="w-full text-xs min-w-[560px]">
                <thead>
                  <tr>
                    <th scope="col" className="text-left font-medium text-slate-500 pb-3 pr-3 align-bottom">Measure</th>
                    {data.symbols.map(s => (
                      <th key={s.symbol} scope="col" className="text-right pb-3 px-2 align-bottom">
                        <button type="button" onClick={() => onOpen?.(s.symbol)} title={`Open the full dossier for ${s.symbol}`}
                          className="inline-flex items-center gap-0.5 text-sm font-semibold text-white hover:text-mint-400">
                          {s.symbol}<ArrowUpRight className="w-3 h-3" aria-hidden="true" />
                        </button>
                        {s.name && <div className="text-[10px] font-normal text-slate-500 truncate max-w-[9rem] ml-auto">{s.name}</div>}
                        <div className="text-[11px] font-normal text-slate-400 tabular-nums">${s.last?.toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
                      </th>
                    ))}
                  </tr>
                </thead>
                {data.groups.map(g => (
                  <tbody key={g}>
                    <tr><th scope="colgroup" colSpan={data.symbols.length + 1} className="text-left text-[10px] uppercase tracking-wide text-slate-500 pt-3 pb-1 border-t border-slate-500/15">{g}</th></tr>
                    {data.metrics.filter(m => m.group === g).map(m => {
                      const vals = bySymbol(m)
                      return (
                        <tr key={m.key} className="border-t border-slate-500/10">
                          <th scope="row" className="text-left font-normal text-slate-400 py-1.5 pr-3">
                            {m.label}
                            {m.better && <span className="text-slate-600"> · {m.better === 'high' ? 'higher is better' : 'lower is better'}</span>}
                          </th>
                          {data.symbols.map(s => {
                            const v = vals[s.symbol]
                            const best = m.best === s.symbol, worst = m.worst === s.symbol
                            const sign = SIGNED.has(m.key) && v != null ? (v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : '') : ''
                            return (
                              <td key={s.symbol} className="text-right px-2 py-1.5 tabular-nums">
                                <span className={`inline-block rounded-md px-1.5 py-0.5 ${best ? 'bg-mint-500/15 text-mint-400 font-semibold' : worst ? 'bg-amber-500/10 text-amber-300' : sign || (v == null ? 'text-slate-600' : 'text-slate-200')}`}
                                  title={best ? 'Best of these on this measure' : worst ? 'Weakest of these on this measure' : undefined}>
                                  {cellText(m, v)}{best && <span className="sr-only"> (best)</span>}{worst && <span className="sr-only"> (weakest)</span>}
                                </span>
                              </td>
                            )
                          })}
                        </tr>
                      )
                    })}
                  </tbody>
                ))}
              </table>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 mt-3 text-[11px] text-slate-500">
              <span><span className="inline-block w-2 h-2 rounded-sm bg-mint-400/60 mr-1 align-middle" />best on that measure</span>
              <span><span className="inline-block w-2 h-2 rounded-sm bg-amber-400/50 mr-1 align-middle" />weakest on that measure</span>
              <span>— not available (never counted as zero)</span>
            </div>
          </div>

          {(data.notes.length > 0 || data.failed.length > 0 || data.invalid?.length > 0 || data.dropped?.length > 0) && (
            <ul className="space-y-1.5">
              {data.notes.map((n, i) => <li key={i} className="flex gap-2 text-[12px] text-slate-400"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5 text-slate-500" />{n}</li>)}
              {data.failed.map(f => <li key={f.symbol} className="flex gap-2 text-[12px] text-amber-300"><Info className="w-3.5 h-3.5 shrink-0 mt-0.5" />{f.symbol} was left out: {f.reason}.</li>)}
              {data.invalid?.length > 0 && <li className="text-[12px] text-amber-300">Not valid tickers, ignored: {data.invalid.join(', ')}.</li>}
              {data.dropped?.length > 0 && <li className="text-[12px] text-amber-300">Only six at a time — left out: {data.dropped.join(', ')}.</li>}
            </ul>
          )}

          {data.correlation?.pairs?.length > 0 && (
            <div className="glass rounded-2xl p-4">
              <h3 className="text-xs font-semibold mb-2">How closely they move together <span className="font-normal text-slate-500">· daily returns over the {data.correlation.observations} sessions all of them share</span></h3>
              <ul className="grid sm:grid-cols-2 lg:grid-cols-3 gap-x-6 gap-y-1 text-xs">
                {data.correlation.pairs.map(p => (
                  <li key={`${p.a}-${p.b}`} className="flex justify-between gap-3">
                    <span className="text-slate-400">{p.a} · {p.b}</span>
                    <span className={`tabular-nums ${p.movesTogether ? 'text-amber-300 font-medium' : 'text-slate-300'}`}>{p.rho.toFixed(2)}{p.movesTogether ? ' · one bet' : ''}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <p className="text-[11px] text-slate-500">
            {data.method} Prices as of {data.symbols[0]?.asOf}
            {data.symbols.some(s => s.filedAsOf) ? `; filings through ${data.symbols.map(s => s.filedAsOf).filter(Boolean).sort().at(-1)}` : ''}. Select a ticker to open its full dossier.
          </p>
        </>
      )}
    </div>
  )
}
