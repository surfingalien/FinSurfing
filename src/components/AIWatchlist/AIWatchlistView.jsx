/**
 * AIWatchlistView — Displays stocks saved from AI Brain & Buy Signals recommendations.
 * Props: { onAnalyze }  — called with symbol string when user clicks "Analyze"
 */

import { useState, useRef } from 'react'
import { Bookmark, X, TrendingUp, Target, Shield, Brain, Sparkles, Trash2, Search, Plus } from 'lucide-react'
import { useAIWatchlist } from '../../hooks/useAIWatchlist'

/* ── helpers ─────────────────────────────────────────────── */

/** Format an ISO date string as "May 12" */
function fmtDate(iso) {
  if (!iso) return ''
  try {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  } catch { return '' }
}

/** Format a dollar price with 2 decimal places */
function fmtPrice(val) {
  if (val == null) return '—'
  return `$${Number(val).toFixed(2)}`
}

/* ── CompositeRing ────────────────────────────────────────── */
function CompositeRing({ score }) {
  if (score == null) return null
  const r    = 14
  const circ = 2 * Math.PI * r
  const dash = (Math.min(100, Math.max(0, score)) / 100) * circ
  const color =
    score >= 75 ? '#34d399' :
    score >= 55 ? '#fbbf24' :
                  '#f87171'
  return (
    <div className="relative w-10 h-10 shrink-0" title={`Composite score: ${score}`}>
      <svg className="w-10 h-10 -rotate-90" viewBox="0 0 36 36">
        <circle cx="18" cy="18" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="3.5" />
        <circle
          cx="18" cy="18" r={r} fill="none"
          stroke={color} strokeWidth="3.5" strokeLinecap="round"
          strokeDasharray={`${dash} ${circ}`}
        />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-[10px] font-black text-white">
        {score}
      </span>
    </div>
  )
}

/* ── Source badge ─────────────────────────────────────────── */
function SourceBadge({ source }) {
  if (source === 'ai-brain') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-indigo-500/15 text-indigo-400 border border-indigo-500/25 shrink-0">
        <Brain className="w-2.5 h-2.5" />
        AI Brain
      </span>
    )
  }
  if (source === 'buy-signals') {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-mint-500/15 text-mint-400 border border-mint-500/25 shrink-0">
        <Sparkles className="w-2.5 h-2.5" />
        Buy Signals
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full bg-slate-500/15 text-slate-400 border border-slate-500/25 shrink-0">
      <Plus className="w-2.5 h-2.5" />
      Manual
    </span>
  )
}

/* ── Verdict badge ────────────────────────────────────────── */
function VerdictBadge({ verdict }) {
  if (!verdict) return null
  const isStrong = verdict.toLowerCase().includes('strong')
  return (
    <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border shrink-0 ${
      isStrong
        ? 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30'
        : 'bg-mint-500/15 text-mint-400 border-mint-500/30'
    }`}>
      {verdict}
    </span>
  )
}

/* ── Horizon badge ────────────────────────────────────────── */
function HorizonBadge({ horizon }) {
  if (!horizon) return null
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.05] text-slate-400 border border-white/[0.06] shrink-0 font-mono">
      {horizon}
    </span>
  )
}

/* ── Sector badge ─────────────────────────────────────────── */
function SectorBadge({ sector }) {
  if (!sector) return null
  return (
    <span className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-slate-500 shrink-0">
      {sector}
    </span>
  )
}

/* ── Single watchlist item ────────────────────────────────── */
function WatchlistItem({ item, onRemove, onAnalyze }) {
  return (
    <div className="glass rounded-2xl border border-white/[0.07] p-4 hover:border-white/[0.12] transition-all group">
      {/* Top row */}
      <div className="flex items-start gap-3">
        {/* Composite score ring */}
        {item.compositeScore != null && (
          <CompositeRing score={item.compositeScore} />
        )}

        {/* Main content */}
        <div className="flex-1 min-w-0">
          {/* Symbol + name row */}
          <div className="flex items-start justify-between gap-2 mb-2">
            <div className="min-w-0">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-mono font-black text-white text-base leading-none">
                  {item.symbol}
                </span>
                <SourceBadge source={item.addedFrom} />
                {item.verdict && <VerdictBadge verdict={item.verdict} />}
                {item.horizon && <HorizonBadge horizon={item.horizon} />}
              </div>
              <div className="flex items-center gap-2 mt-1 flex-wrap">
                <span className="text-[11px] text-slate-400 truncate">{item.name}</span>
                {item.sector && <SectorBadge sector={item.sector} />}
              </div>
            </div>

            {/* Actions */}
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                onClick={() => onAnalyze?.(item.symbol)}
                className="text-[11px] px-2.5 py-1 rounded-lg bg-mint-500/15 text-mint-400 border border-mint-500/25 hover:bg-mint-500/25 transition-all font-medium"
              >
                Analyze
              </button>
              <button
                onClick={() => onRemove(item.symbol)}
                className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-all opacity-0 group-hover:opacity-100"
                title="Remove from AI Watchlist"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>

          {/* Price targets row */}
          {(item.entryPrice != null || item.takeProfitPrice != null || item.stopLossPrice != null) && (
            <div className="flex flex-wrap gap-3 mt-3 pt-3 border-t border-white/[0.05]">
              {item.entryPrice != null && (
                <div className="flex flex-col">
                  <span className="text-[9px] text-slate-600 uppercase tracking-wider mb-0.5">Entry</span>
                  <span className="text-xs font-mono text-slate-300 font-semibold">
                    {fmtPrice(item.entryPrice)}
                  </span>
                </div>
              )}
              {item.takeProfitPrice != null && (
                <div className="flex flex-col">
                  <span className="text-[9px] text-slate-600 uppercase tracking-wider mb-0.5 flex items-center gap-0.5">
                    <Target className="w-2 h-2" /> Target
                  </span>
                  <span className="text-xs font-mono text-emerald-400 font-semibold">
                    {fmtPrice(item.takeProfitPrice)}
                    {item.targetReturn != null && (
                      <span className="text-[10px] ml-1 opacity-80">(+{item.targetReturn}%)</span>
                    )}
                  </span>
                </div>
              )}
              {item.stopLossPrice != null && (
                <div className="flex flex-col">
                  <span className="text-[9px] text-slate-600 uppercase tracking-wider mb-0.5 flex items-center gap-0.5">
                    <Shield className="w-2 h-2" /> Stop
                  </span>
                  <span className="text-xs font-mono text-red-400 font-semibold">
                    {fmtPrice(item.stopLossPrice)}
                    {item.stopLoss != null && (
                      <span className="text-[10px] ml-1 opacity-80">(-{item.stopLoss}%)</span>
                    )}
                  </span>
                </div>
              )}

              {/* Target/stop pct only (buy-signals style — no absolute prices) */}
              {item.entryPrice == null && item.takeProfitPrice == null && item.targetReturn != null && (
                <div className="flex items-center gap-3">
                  <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-mono font-bold">
                    <TrendingUp className="w-3 h-3" />
                    +{item.targetReturn}%
                  </span>
                  {item.stopLoss != null && (
                    <span className="flex items-center gap-1 text-[11px] text-red-400 font-mono font-bold">
                      <Shield className="w-3 h-3" />
                      -{item.stopLoss}%
                    </span>
                  )}
                </div>
              )}
            </div>
          )}

          {/* Note */}
          {item.note && (
            <p className="text-[11px] text-slate-500 mt-2 leading-relaxed italic">{item.note}</p>
          )}
        </div>
      </div>

      {/* Footer: date */}
      <div className="mt-2 pt-2 border-t border-white/[0.04] flex items-center justify-end">
        <span className="text-[10px] text-slate-600">Added {fmtDate(item.addedAt)}</span>
      </div>
    </div>
  )
}

/* ── Empty state ──────────────────────────────────────────── */
function EmptyState() {
  return (
    <div className="glass rounded-2xl border border-white/[0.07] p-16 text-center space-y-4">
      <div className="flex items-center justify-center">
        <div className="p-5 rounded-full bg-white/[0.03] border border-white/[0.07]">
          <Bookmark className="w-10 h-10 text-slate-600" />
        </div>
      </div>
      <div>
        <p className="text-white font-semibold">Your AI Watchlist is empty</p>
        <p className="text-slate-500 text-sm mt-1 max-w-sm mx-auto">
          Save stocks from <span className="text-indigo-400 font-medium">AI Brain</span> or{' '}
          <span className="text-mint-400 font-medium">Buy Signals</span> recommendations
          to track them here and revisit your top picks at a glance.
        </p>
      </div>
    </div>
  )
}

/* ── AddStockRow ──────────────────────────────────────────── */
function AddStockRow({ onAdd }) {
  const [val, setVal] = useState('')
  const inputRef = useRef(null)

  const submit = () => {
    const syms = val
      .split(/[,\s]+/)
      .map(s => s.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, ''))
      .filter(Boolean)
    if (!syms.length) return
    syms.forEach(sym => onAdd({ symbol: sym, addedFrom: 'manual', addedAt: new Date().toISOString() }))
    setVal('')
    inputRef.current?.focus()
  }

  return (
    <div className="flex items-center gap-2 p-3 rounded-xl bg-white/[0.03] border border-white/[0.08]">
      <Search className="w-4 h-4 text-slate-500 shrink-0" />
      <input
        ref={inputRef}
        type="text"
        value={val}
        onChange={e => setVal(e.target.value.toUpperCase())}
        onKeyDown={e => e.key === 'Enter' && submit()}
        placeholder="Add any symbol — stock, ETF, or crypto (e.g. NVDA, SPY, BTC-USD)"
        className="flex-1 bg-transparent text-sm text-white placeholder-slate-600 focus:outline-none font-mono"
      />
      {val && (
        <button
          onClick={submit}
          className="flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium bg-mint-500/20 text-mint-400 border border-mint-500/30 hover:bg-mint-500/30 transition-all"
        >
          <Plus className="w-3 h-3" /> Add
        </button>
      )}
    </div>
  )
}

/* ── SourceBadge — extend for manual ─────────────────────── */

/* ── Main view ────────────────────────────────────────────── */
export default function AIWatchlistView({ onAnalyze }) {
  const { items, addStock, removeStock, clear } = useAIWatchlist()

  // Sort by addedAt descending (newest first)
  const sorted = [...items].sort((a, b) => {
    const ta = a.addedAt ? new Date(a.addedAt).getTime() : 0
    const tb = b.addedAt ? new Date(b.addedAt).getTime() : 0
    return tb - ta
  })

  return (
    <div className="space-y-5 animate-fade-in">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
            <Bookmark className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">AI Watchlist</h1>
            <p className="text-xs text-slate-500">
              Stocks, ETFs &amp; Crypto from AI Brain, Buy Signals, or added manually
            </p>
          </div>
        </div>

        {items.length > 0 && (
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-xs text-slate-500">{items.length} item{items.length !== 1 ? 's' : ''}</span>
            <button
              onClick={() => {
                if (window.confirm('Clear all items from your AI Watchlist?')) clear()
              }}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-red-500/10 text-red-400 border border-red-500/20 hover:bg-red-500/20 transition-all"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Clear All
            </button>
          </div>
        )}
      </div>

      {/* ── Add stock row ── */}
      <AddStockRow onAdd={addStock} />

      {/* ── Content ── */}
      {sorted.length === 0 ? (
        <EmptyState />
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {sorted.map(item => (
            <WatchlistItem
              key={item.symbol}
              item={item}
              onRemove={removeStock}
              onAnalyze={onAnalyze}
            />
          ))}
        </div>
      )}

      {/* ── Disclaimer ── */}
      {sorted.length > 0 && (
        <div className="text-center text-[11px] text-slate-600 border-t border-white/[0.04] pt-3">
          AI Watchlist is for informational purposes only. Not financial advice.
          AI-generated price targets and verdicts do not guarantee future results.
          Always conduct independent research before making investment decisions.
        </div>
      )}
    </div>
  )
}
