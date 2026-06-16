/**
 * EarningsCalendarView.jsx
 *
 * 4-week earnings calendar + Positioning panel (beat rate, EPS history, thesis link).
 * Clicking "Positioning" on any card loads historical beat rate & EPS surprise data.
 */

import { useState, useEffect, useCallback } from 'react'
import {
  Calendar, RefreshCw, TrendingUp, Search, ChevronLeft, ChevronRight,
  Info, BarChart2, BookOpen, PlusCircle, Loader2,
} from 'lucide-react'
import { useAuth }    from '../../contexts/AuthContext'
import { useApiKeys } from '../../contexts/ApiKeysContext'

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoToDate(str) {
  const [y, m, d] = str.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatDate(str) {
  return isoToDate(str).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function groupByWeek(earnings) {
  const groups = {}
  for (const e of earnings) {
    const d   = isoToDate(e.nextEarningsDate)
    const mon = new Date(d)
    mon.setDate(d.getDate() - d.getDay() + 1)
    const key = mon.toISOString().slice(0, 10)
    if (!groups[key]) groups[key] = []
    groups[key].push(e)
  }
  return groups
}

// ── Positioning panel ─────────────────────────────────────────────────────────
function PositioningPanel({ symbol, onNavigate, authFetch, getHeaders }) {
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)
  const [hasNote, setHasNote] = useState(null) // null=checking, true, false

  useEffect(() => {
    let cancelled = false
    async function load() {
      setLoading(true); setError(null)
      try {
        const res  = await fetch(
          `/api/earnings/positioning?symbols=${symbol}`,
          { headers: getHeaders() }
        )
        const json = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(json.error)
        setData(Array.isArray(json) ? json[0] : null)
      } catch (e) { if (!cancelled) setError(e.message) }
      if (!cancelled) setLoading(false)
    }

    async function checkNote() {
      try {
        const res  = await authFetch(`/api/research-notes?symbol=${symbol}&limit=1`)
        const notes = await res.json()
        if (!cancelled) setHasNote(Array.isArray(notes) && notes.length > 0)
      } catch { if (!cancelled) setHasNote(false) }
    }

    load()
    checkNote()
    return () => { cancelled = true }
  }, [symbol])

  const beatPct  = data?.beat_rate != null ? Math.round(data.beat_rate * 100) : null
  const avgSurp  = data?.avg_eps_surprise_pct

  return (
    <div className="mt-3 pt-3 border-t border-white/[0.06] space-y-3">
      {loading && (
        <div className="flex items-center gap-2 text-xs text-slate-500">
          <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading positioning data…
        </div>
      )}
      {error && <p className="text-xs text-red-400">{error}</p>}

      {!loading && data && (
        <>
          {/* Beat rate gauge */}
          <div className="flex items-center gap-4">
            <div className="text-center">
              <div className="text-lg font-black font-mono text-white">
                {beatPct != null ? `${beatPct}%` : '—'}
              </div>
              <div className="text-[9px] text-slate-500 uppercase tracking-wider">EPS Beat Rate</div>
              {data.total_quarters > 0 && (
                <div className="text-[9px] text-slate-600">{data.beat_count}/{data.total_quarters} qtrs</div>
              )}
            </div>

            {/* Beat rate bar */}
            {beatPct != null && (
              <div className="flex-1">
                <div className="h-2.5 w-full rounded-full bg-white/[0.06] overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${
                      beatPct >= 75 ? 'bg-emerald-400' : beatPct >= 50 ? 'bg-amber-400' : 'bg-red-400'
                    }`}
                    style={{ width: `${beatPct}%` }}
                  />
                </div>
                <div className="flex justify-between text-[8px] text-slate-600 mt-0.5">
                  <span>0%</span><span>50%</span><span>100%</span>
                </div>
              </div>
            )}

            {avgSurp != null && (
              <div className="text-center">
                <div className={`text-sm font-black font-mono ${avgSurp >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {avgSurp >= 0 ? '+' : ''}{avgSurp.toFixed(1)}%
                </div>
                <div className="text-[9px] text-slate-500 uppercase tracking-wider">Avg EPS Surprise</div>
              </div>
            )}
            {data.avg_price_move_pct != null && (
              <div className="text-center">
                <div className={`text-sm font-black font-mono ${data.avg_price_move_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {data.avg_price_move_pct >= 0 ? '+' : ''}{data.avg_price_move_pct.toFixed(1)}%
                </div>
                <div className="text-[9px] text-slate-500 uppercase tracking-wider">Avg Price Move</div>
              </div>
            )}
          </div>

          {/* Last 4 quarters table */}
          {data.recent_quarters?.length > 0 && (
            <div>
              <div className="text-[9px] text-slate-600 uppercase tracking-wider mb-1.5">Last {data.recent_quarters.length} Quarters</div>
              <table className="w-full text-[10px]">
                <thead>
                  <tr className="text-slate-600">
                    <th className="text-left font-medium pb-1">Period</th>
                    <th className="text-right font-medium pb-1">Estimate</th>
                    <th className="text-right font-medium pb-1">Actual</th>
                    <th className="text-right font-medium pb-1">Surprise</th>
                  </tr>
                </thead>
                <tbody>
                  {data.recent_quarters.map((q, i) => {
                    const beat = q.actual != null && q.estimate != null && q.actual >= q.estimate
                    const miss = q.actual != null && q.estimate != null && q.actual < q.estimate
                    return (
                      <tr key={i} className="border-t border-white/[0.04]">
                        <td className="py-1 text-slate-400">{q.period || '—'}</td>
                        <td className="py-1 text-right font-mono text-slate-400">
                          {q.estimate != null ? q.estimate.toFixed(2) : '—'}
                        </td>
                        <td className={`py-1 text-right font-mono font-semibold ${beat ? 'text-emerald-400' : miss ? 'text-red-400' : 'text-slate-400'}`}>
                          {q.actual != null ? q.actual.toFixed(2) : '—'}
                        </td>
                        <td className={`py-1 text-right font-mono ${q.surprise_pct != null && q.surprise_pct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {q.surprise_pct != null
                            ? `${q.surprise_pct >= 0 ? '+' : ''}${q.surprise_pct.toFixed(1)}%`
                            : '—'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}

      {/* Thesis link */}
      {onNavigate && hasNote !== null && (
        <div className="flex items-center gap-2 pt-1">
          {hasNote ? (
            <button
              onClick={() => onNavigate('second-brain', symbol)}
              className="flex items-center gap-1.5 text-[11px] text-indigo-400 hover:text-indigo-300 border border-indigo-500/25 rounded-lg px-2.5 py-1 hover:bg-indigo-500/10 transition-all"
            >
              <BookOpen className="w-3 h-3" /> View Thesis
            </button>
          ) : (
            <button
              onClick={() => onNavigate('second-brain', symbol)}
              className="flex items-center gap-1.5 text-[11px] text-slate-400 hover:text-white border border-white/[0.08] rounded-lg px-2.5 py-1 hover:bg-white/[0.05] transition-all"
            >
              <PlusCircle className="w-3 h-3" /> Create Thesis
            </button>
          )}
          <span className="text-[9px] text-slate-600">in Second Brain</span>
        </div>
      )}
    </div>
  )
}

// ── Single earnings card ──────────────────────────────────────────────────────
function EarningsCard({ item, onAnalyze, onNavigate, authFetch, getHeaders }) {
  const [showPositioning, setShowPositioning] = useState(false)
  const hasEps   = item.epsEstimate != null
  const daysAway = Math.round((isoToDate(item.nextEarningsDate) - Date.now()) / 86_400_000)
  const urgent   = daysAway <= 3

  return (
    <div className={`glass rounded-xl px-4 py-3 border transition-all
      ${urgent ? 'border-amber-500/25 bg-amber-500/3' : 'border-white/[0.06]'}`}>

      <div className="flex items-start gap-3">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-mono font-bold text-white">{item.symbol}</span>
            {urgent && (
              <span className="text-[9px] font-bold uppercase tracking-wide px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-400">
                {daysAway === 0 ? 'Today' : daysAway === 1 ? 'Tomorrow' : `${daysAway}d`}
              </span>
            )}
            {item.currentPrice != null && (
              <span className="text-xs font-mono text-slate-400">
                ${item.currentPrice.toFixed(2)}
                {item.changePct != null && (
                  <span className={item.changePct >= 0 ? ' text-emerald-400' : ' text-red-400'}>
                    {' '}{item.changePct >= 0 ? '+' : ''}{(item.changePct * 100).toFixed(2)}%
                  </span>
                )}
              </span>
            )}
          </div>
          <p className="text-xs text-slate-500 truncate mt-0.5">{item.name}</p>
        </div>

        <div className="text-right shrink-0 space-y-1">
          {hasEps && (
            <div>
              <div className="text-xs font-mono text-slate-300">{item.epsEstimate} EPS est.</div>
              {item.epsLow && item.epsHigh && (
                <div className="text-[10px] text-slate-600">{item.epsLow} – {item.epsHigh}</div>
              )}
            </div>
          )}
          {item.impliedMove != null && (
            <div className="flex items-center justify-end gap-1">
              <span className="text-[9px] text-slate-600 uppercase tracking-wide">Implied ±</span>
              <span className="text-[11px] font-mono font-bold text-violet-400">
                {item.impliedMove.toFixed(1)}%
              </span>
            </div>
          )}
        </div>
      </div>

      <div className="flex items-center gap-3 mt-2">
        <span className="text-[10px] text-slate-600">{formatDate(item.nextEarningsDate)}</span>
        {item.sector && <span className="text-[10px] text-slate-700">{item.sector}</span>}
        <button onClick={() => onAnalyze(item.symbol)}
          className="ml-auto text-[10px] font-medium text-mint-500 hover:text-mint-300 transition-colors flex items-center gap-1">
          <TrendingUp className="w-3 h-3" /> Analyze
        </button>
        <button
          onClick={() => setShowPositioning(v => !v)}
          className={`text-[10px] font-medium transition-colors flex items-center gap-1 ${
            showPositioning ? 'text-indigo-400' : 'text-slate-500 hover:text-slate-300'
          }`}
        >
          <BarChart2 className="w-3 h-3" /> Positioning
        </button>
      </div>

      {showPositioning && (
        <PositioningPanel
          symbol={item.symbol}
          onNavigate={onNavigate}
          authFetch={authFetch}
          getHeaders={getHeaders}
        />
      )}
    </div>
  )
}

// ── Symbol search / add ───────────────────────────────────────────────────────
function AddSymbol({ onAdd }) {
  const [val, setVal] = useState('')
  const submit = (e) => {
    e.preventDefault()
    const s = val.trim().toUpperCase()
    if (s) { onAdd(s); setVal('') }
  }
  return (
    <form onSubmit={submit} className="flex gap-2">
      <div className="relative flex-1">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-500" />
        <input value={val} onChange={e => setVal(e.target.value.toUpperCase())}
          placeholder="Add ticker…" maxLength={6}
          className="w-full pl-8 pr-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl
                     text-sm text-white placeholder-slate-600 font-mono
                     focus:outline-none focus:border-mint-500/40 transition-colors" />
      </div>
      <button type="submit"
        className="px-4 py-2 rounded-xl text-sm font-medium bg-mint-500/10 border border-mint-500/20 text-mint-400 hover:bg-mint-500/20 transition-colors">
        Add
      </button>
    </form>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────
export default function EarningsCalendarView({ portfolio, onAnalyze, onNavigate }) {
  const { authFetch }  = useAuth()
  const { getHeaders } = useApiKeys()

  const [earnings,   setEarnings]   = useState([])
  const [loading,    setLoading]    = useState(true)
  const [error,      setError]      = useState(null)
  const [extraSyms,  setExtraSyms]  = useState([])
  const [weekOffset, setWeekOffset] = useState(0)

  const portfolioSymbols = portfolio?.positions?.map(p => p.symbol) || []

  const load = useCallback(async () => {
    setLoading(true); setError(null)
    try {
      const symbols = [...new Set([...portfolioSymbols, ...extraSyms])]
      const q = symbols.length ? `?symbols=${symbols.join(',')}` : ''
      const res  = await fetch(`/api/earnings/calendar${q}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      setEarnings(data.upcoming || [])
    } catch (err) { setError(err.message) }
    finally { setLoading(false) }
  }, [portfolioSymbols.join(','), extraSyms.join(',')])

  useEffect(() => { load() }, [load])

  const today  = new Date()
  const monday = new Date(today)
  monday.setDate(today.getDate() - today.getDay() + 1 + weekOffset * 7)
  const sunday = new Date(monday)
  sunday.setDate(monday.getDate() + 6)

  const weekEarnings = earnings.filter(e => {
    const d = isoToDate(e.nextEarningsDate)
    return d >= monday && d <= sunday
  })

  const grouped  = groupByWeek(weekEarnings)
  const weekKeys = Object.keys(grouped).sort()

  const mondayLabel = monday.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const sundayLabel = sunday.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div>
          <h1 className="text-xl font-bold text-white">Earnings Calendar</h1>
          <p className="text-xs text-slate-500 mt-1">
            Upcoming earnings · EPS estimates · Click <strong className="text-slate-400">Positioning</strong> for beat rate & history
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium glass border border-white/[0.08] text-slate-400 hover:text-white transition-colors disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
        </button>
      </div>

      {/* Add symbol + week navigation */}
      <div className="flex items-center gap-3 flex-wrap">
        <div className="flex-1 min-w-48">
          <AddSymbol onAdd={sym => setExtraSyms(prev => [...new Set([...prev, sym])])} />
        </div>
        <div className="flex items-center gap-2 ml-auto">
          <button onClick={() => setWeekOffset(v => v - 1)}
            className="p-2 rounded-lg glass border border-white/[0.08] text-slate-400 hover:text-white transition-colors">
            <ChevronLeft className="w-4 h-4" />
          </button>
          <span className="text-xs text-slate-400 whitespace-nowrap min-w-36 text-center">
            {mondayLabel} – {sundayLabel}
          </span>
          <button onClick={() => setWeekOffset(v => v + 1)}
            className="p-2 rounded-lg glass border border-white/[0.08] text-slate-400 hover:text-white transition-colors">
            <ChevronRight className="w-4 h-4" />
          </button>
          {weekOffset !== 0 && (
            <button onClick={() => setWeekOffset(0)}
              className="px-3 py-1.5 rounded-lg text-xs text-slate-500 hover:text-white transition-colors">
              Today
            </button>
          )}
        </div>
      </div>

      {/* Summary strip */}
      {!loading && earnings.length > 0 && (
        <div className="flex items-center gap-4 text-xs text-slate-500 flex-wrap">
          <span className="flex items-center gap-1.5">
            <Calendar className="w-3.5 h-3.5" />
            {earnings.length} companies reporting in next 60 days
          </span>
          {weekEarnings.length > 0 && (
            <span className="text-mint-500">{weekEarnings.length} this week</span>
          )}
          {extraSyms.length > 0 && (
            <div className="flex items-center gap-1.5 ml-auto flex-wrap">
              {extraSyms.map(s => (
                <button key={s} onClick={() => setExtraSyms(prev => prev.filter(x => x !== s))}
                  className="px-2 py-0.5 rounded-md text-[10px] font-mono bg-white/[0.04] border border-white/[0.06]
                             text-slate-400 hover:text-red-400 hover:border-red-500/20 transition-colors">
                  {s} ×
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <RefreshCw className="w-6 h-6 text-slate-600 animate-spin" />
            <span className="text-xs text-slate-600">Fetching earnings dates…</span>
          </div>
        </div>
      )}

      {error && !loading && (
        <div className="flex items-start gap-3 glass rounded-xl p-4 border border-red-500/20">
          <Info className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {!loading && !error && weekEarnings.length === 0 && (
        <div className="text-center py-16 text-slate-600">
          <Calendar className="w-8 h-8 mx-auto mb-3 opacity-40" />
          <p className="text-sm">No earnings scheduled for this week.</p>
          <button onClick={() => setWeekOffset(v => v + 1)}
            className="mt-3 text-xs text-mint-500 hover:text-mint-300 transition-colors">
            Next week →
          </button>
        </div>
      )}

      {!loading && weekKeys.map(weekKey => {
        const dayGroups = {}
        for (const e of grouped[weekKey]) {
          const d = e.nextEarningsDate
          if (!dayGroups[d]) dayGroups[d] = []
          dayGroups[d].push(e)
        }
        return Object.entries(dayGroups).sort(([a], [b]) => a.localeCompare(b)).map(([date, items]) => (
          <div key={date}>
            <div className="flex items-center gap-3 mb-3">
              <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wide">
                {formatDate(date)}
              </h3>
              <div className="flex-1 h-px bg-white/[0.04]" />
              <span className="text-[10px] text-slate-600">{items.length} report{items.length > 1 ? 's' : ''}</span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
              {items.map(item => (
                <EarningsCard
                  key={item.symbol}
                  item={item}
                  onAnalyze={onAnalyze}
                  onNavigate={onNavigate}
                  authFetch={authFetch}
                  getHeaders={getHeaders}
                />
              ))}
            </div>
          </div>
        ))
      })}

      <footer className="text-[10px] text-slate-700 text-center pt-2">
        Earnings dates from Yahoo Finance / Finnhub · Estimates may differ from official guidance
      </footer>
    </div>
  )
}
