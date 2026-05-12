/**
 * EarningsCalendarView.jsx  (F)
 *
 * 4-week earnings calendar pulling upcoming dates from /api/earnings/calendar.
 * Shows expected EPS, ticker, date, and a quick "Analyze" link to the AI Agent.
 */

import { useState, useEffect, useCallback } from 'react'
import { Calendar, RefreshCw, TrendingUp, Search, ChevronLeft, ChevronRight, Info } from 'lucide-react'

// ── Helpers ───────────────────────────────────────────────────────────────────

function isoToDate(str) {
  // "2026-05-14" → Date at local midnight
  const [y, m, d] = str.split('-').map(Number)
  return new Date(y, m - 1, d)
}

function formatDate(str) {
  const d = isoToDate(str)
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
}

function weekLabel(str) {
  const d = isoToDate(str)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function groupByWeek(earnings) {
  const groups = {}
  for (const e of earnings) {
    const d    = isoToDate(e.nextEarningsDate)
    const mon  = new Date(d)
    mon.setDate(d.getDate() - d.getDay() + 1)   // Monday of that week
    const key  = mon.toISOString().slice(0, 10)
    if (!groups[key]) groups[key] = []
    groups[key].push(e)
  }
  return groups
}

// ── P&L badge ─────────────────────────────────────────────────────────────────

function PnlBadge({ pnl }) {
  if (pnl == null) return null
  const pos = pnl >= 0
  return (
    <span className={`text-[10px] font-bold font-mono px-1.5 py-0.5 rounded
      ${pos ? 'bg-emerald-500/15 text-emerald-400' : 'bg-red-500/15 text-red-400'}`}>
      {pos ? '+' : ''}{pnl.toFixed(1)}%
    </span>
  )
}

// ── Single earnings card ──────────────────────────────────────────────────────

function EarningsCard({ item, onAnalyze }) {
  const hasEps = item.epsEstimate != null
  const daysAway = Math.round((isoToDate(item.nextEarningsDate) - Date.now()) / 86_400_000)
  const urgent = daysAway <= 3

  return (
    <div className={`glass rounded-xl px-4 py-3 border transition-all
      ${urgent ? 'border-amber-500/25 bg-amber-500/3' : 'border-white/[0.06]'}`}>
      <div className="flex items-start gap-3">
        {/* Ticker + name */}
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

        {/* EPS estimate */}
        {hasEps && (
          <div className="text-right shrink-0">
            <div className="text-xs font-mono text-slate-300">{item.epsEstimate} EPS est.</div>
            {item.epsLow && item.epsHigh && (
              <div className="text-[10px] text-slate-600">{item.epsLow} – {item.epsHigh}</div>
            )}
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 mt-2">
        <span className="text-[10px] text-slate-600">{formatDate(item.nextEarningsDate)}</span>
        {item.sector && <span className="text-[10px] text-slate-700">{item.sector}</span>}
        {item.marketCap && <span className="text-[10px] text-slate-700">{item.marketCap}</span>}
        <button
          onClick={() => onAnalyze(item.symbol)}
          className="ml-auto text-[10px] font-medium text-mint-500 hover:text-mint-300 transition-colors flex items-center gap-1">
          <TrendingUp className="w-3 h-3" /> Analyze
        </button>
      </div>
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
        <input
          value={val}
          onChange={e => setVal(e.target.value.toUpperCase())}
          placeholder="Add ticker…"
          maxLength={6}
          className="w-full pl-8 pr-3 py-2 bg-white/[0.04] border border-white/[0.08] rounded-xl
                     text-sm text-white placeholder-slate-600 font-mono
                     focus:outline-none focus:border-mint-500/40 transition-colors"
        />
      </div>
      <button type="submit"
        className="px-4 py-2 rounded-xl text-sm font-medium bg-mint-500/10 border border-mint-500/20 text-mint-400 hover:bg-mint-500/20 transition-colors">
        Add
      </button>
    </form>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function EarningsCalendarView({ portfolio, onAnalyze }) {
  const [earnings,  setEarnings]  = useState([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState(null)
  const [extraSyms, setExtraSyms] = useState([])
  const [weekOffset, setWeekOffset] = useState(0)   // 0 = current week

  // Build symbol list: portfolio holdings + watchlist + extras + defaults
  const portfolioSymbols = portfolio?.positions?.map(p => p.symbol) || []

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const symbols = [...new Set([...portfolioSymbols, ...extraSyms])]
      const q = symbols.length ? `?symbols=${symbols.join(',')}` : ''
      const res  = await fetch(`/api/earnings/calendar${q}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed')
      setEarnings(data.upcoming || [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [portfolioSymbols.join(','), extraSyms.join(',')])

  useEffect(() => { load() }, [load])

  // Filter to target week
  const today   = new Date()
  const monday  = new Date(today)
  monday.setDate(today.getDate() - today.getDay() + 1 + weekOffset * 7)
  const sunday  = new Date(monday)
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
            Upcoming earnings dates · EPS estimates · Click Analyze to run AI deep-dive
          </p>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium
                     glass border border-white/[0.08] text-slate-400 hover:text-white transition-colors disabled:opacity-50">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
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

      {/* Loading */}
      {loading && (
        <div className="flex items-center justify-center py-20">
          <div className="flex flex-col items-center gap-3">
            <RefreshCw className="w-6 h-6 text-slate-600 animate-spin" />
            <span className="text-xs text-slate-600">Fetching earnings dates…</span>
          </div>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="flex items-start gap-3 glass rounded-xl p-4 border border-red-500/20">
          <Info className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Empty week */}
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

      {/* Day groups */}
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
                <EarningsCard key={item.symbol} item={item} onAnalyze={onAnalyze} />
              ))}
            </div>
          </div>
        ))
      })}

      <footer className="text-[10px] text-slate-700 text-center pt-2">
        Earnings dates from Yahoo Finance · Estimates may differ from official guidance
      </footer>
    </div>
  )
}
