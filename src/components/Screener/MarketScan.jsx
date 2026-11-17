/**
 * MarketScan — fixed whole-market screens (GET /api/screener/market-scan,
 * lib/tv-scanner.js). Each screen is one plainly stated fact, such as "trading
 * at twice its usual volume"; none is a buy signal.
 *
 * The data comes from TradingView's scanner, which is not a published API, so
 * it is off until the site's operator switches it on, and this panel says so.
 * Its prices are TradingView's and delayed: they are for finding names. Open a
 * name on the Research Desk, or compare several, to see this app's own figures.
 */
import { useCallback, useEffect, useState } from 'react'
import { Radar, Loader2, ArrowUpRight, Columns3 } from 'lucide-react'
import { useAuth } from '../../contexts/AuthContext'

const pct = v => (v == null ? '—' : `${v > 0 ? '+' : v < 0 ? '−' : ''}${Math.abs(v).toFixed(1)}%`)
const tone = v => (v == null ? 'text-slate-500' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-300')
const cap = v => (v == null ? '—' : v >= 1e12 ? `$${(v / 1e12).toFixed(2)}T` : v >= 1e9 ? `$${(v / 1e9).toFixed(1)}B` : `$${(v / 1e6).toFixed(0)}M`)

export default function MarketScan({ onResearch, onCompare }) {
  const { authFetch } = useAuth()
  const [preset, setPreset] = useState('unusual-volume')
  const [sector, setSector] = useState('')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)

  const load = useCallback(async (p, s) => {
    setLoading(true); setError(null)
    try {
      const res = await authFetch(`/api/screener/market-scan?preset=${encodeURIComponent(p)}${s ? `&sector=${encodeURIComponent(s)}` : ''}`)
      const body = await res.json().catch(() => ({}))
      if (!res.ok || body.error) throw new Error(body.error || `Request failed (${res.status})`)
      setData(body)
    } catch (e) { setError(e.message) } finally { setLoading(false) }
  }, [authFetch])
  useEffect(() => { load(preset, sector) }, [load, preset, sector])

  const rows = data?.rows || []
  return (
    <section className="glass rounded-2xl p-4 space-y-3" aria-labelledby="market-scan-title">
      <div>
        <h2 id="market-scan-title" className="text-base font-semibold text-white flex items-center gap-2"><Radar className="w-4 h-4 text-mint-400" aria-hidden="true" /> Market scan</h2>
        <p className="text-xs text-slate-400 mt-1">What is happening across US stocks right now, as fixed screens. Each one states a fact; none is a buy signal.</p>
      </div>

      {data && !data.enabled && (
        <div className="rounded-xl border border-slate-500/25 bg-slate-500/10 p-3 text-xs text-slate-400 space-y-1.5">
          <p className="text-slate-200 font-semibold">This panel is switched off.</p>
          <p>It reads TradingView's scanner, which is not a published API: it can change or be blocked without notice, and using it from a hosted app may be against TradingView's terms. Nothing else in the app depends on it.</p>
          <p>The site's operator can switch it on by setting <code className="text-slate-200">TV_SCANNER_ENABLED=true</code> on the server.</p>
        </div>
      )}

      {data?.enabled && (
        <>
          <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Screen">
            {data.presets.map(p => (
              <button key={p.id} type="button" onClick={() => setPreset(p.id)} aria-pressed={preset === p.id} title={p.fact}
                className={`px-2.5 py-1.5 rounded-lg text-xs border ${preset === p.id ? 'bg-mint-400/15 text-mint-400 border-mint-400/30' : 'text-slate-400 border-slate-500/20 hover:text-white'}`}>{p.label}</button>
            ))}
            <label className="ml-auto text-xs text-slate-500 inline-flex items-center gap-1.5">
              Sector
              <select value={sector} onChange={e => setSector(e.target.value)} className="bg-slate-500/10 border border-slate-500/20 rounded-lg px-2 py-1.5 text-xs text-slate-200">
                <option value="">All</option>
                {data.sectors.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          </div>

          {data.fact && <p className="text-xs text-slate-300">{data.fact} <span className="text-slate-500">Companies worth $2B or more, common shares on US exchanges{data.matched != null ? `; ${data.matched.toLocaleString()} match, the first ${rows.length} shown` : ''}.</span></p>}
          {data.unavailable && <p className="text-xs text-amber-300" role="alert">The scan could not be run: {data.unavailable}. The rest of the Screener is unaffected.</p>}
          {loading && <p className="text-xs text-slate-500 flex items-center gap-1.5"><Loader2 className="w-3.5 h-3.5 animate-spin" /> Scanning…</p>}
          {!loading && !data.unavailable && rows.length === 0 && <p className="text-xs text-slate-500">Nothing matches this screen right now.</p>}

          {rows.length > 0 && (
            <>
              <div className="relative overflow-x-auto">
                <table className="w-full text-xs min-w-[620px]">
                  <thead><tr className="text-left text-slate-500">
                    <th scope="col" className="font-medium py-1.5 pr-3">Company</th>
                    <th scope="col" className="font-medium py-1.5 px-2 text-right">Price</th>
                    <th scope="col" className="font-medium py-1.5 px-2 text-right">Today</th>
                    <th scope="col" className="font-medium py-1.5 px-2 text-right">Volume vs usual</th>
                    <th scope="col" className="font-medium py-1.5 px-2 text-right">1 month</th>
                    <th scope="col" className="font-medium py-1.5 px-2 text-right">RSI</th>
                    <th scope="col" className="font-medium py-1.5 px-2 text-right">Value</th>
                    <th scope="col" className="font-medium py-1.5 pl-2">Sector</th>
                  </tr></thead>
                  <tbody>{rows.map(r => (
                    <tr key={r.symbol} className="border-t border-slate-500/10 tabular-nums">
                      <th scope="row" className="text-left font-normal py-1.5 pr-3">
                        <button type="button" onClick={() => onResearch?.(r.symbol)} title={`Open ${r.symbol} on the Research Desk`} className="inline-flex items-center gap-0.5 font-semibold text-white hover:text-mint-400">{r.symbol}<ArrowUpRight className="w-3 h-3" aria-hidden="true" /></button>
                        {r.name && <div className="text-[10px] text-slate-500 truncate max-w-[13rem]">{r.name}</div>}
                      </th>
                      <td className="text-right px-2 text-slate-200">${r.close.toLocaleString(undefined, { maximumFractionDigits: 2 })}</td>
                      <td className={`text-right px-2 ${tone(r.changePct)}`}>{pct(r.changePct)}</td>
                      <td className="text-right px-2 text-slate-300">{r.relVolume == null ? '—' : `${r.relVolume.toFixed(1)}×`}</td>
                      <td className={`text-right px-2 ${tone(r.perf1m)}`}>{pct(r.perf1m)}</td>
                      <td className="text-right px-2 text-slate-300">{r.rsi == null ? '—' : r.rsi.toFixed(0)}</td>
                      <td className="text-right px-2 text-slate-300">{cap(r.marketCap)}</td>
                      <td className="pl-2 text-slate-400">{r.sector || r.tvSector || '—'}</td>
                    </tr>
                  ))}</tbody>
                </table>
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[11px] text-slate-500 max-w-3xl">
                  Figures are TradingView's and delayed, as of {new Date(data.at).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}; this app has not checked them. They are for finding names — open one for its measured dossier.
                </p>
                {onCompare && rows.length >= 2 && (
                  <button type="button" onClick={() => onCompare(rows.slice(0, 6).map(r => r.symbol))} className="text-xs px-3 py-1.5 rounded-lg border border-slate-500/25 text-slate-300 hover:text-mint-400 inline-flex items-center gap-1.5">
                    <Columns3 className="w-3.5 h-3.5" /> Compare the first {Math.min(6, rows.length)}
                  </button>
                )}
              </div>
            </>
          )}
        </>
      )}
      {error && <p className="text-xs text-red-400" role="alert">{error}</p>}
    </section>
  )
}
