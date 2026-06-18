/**
 * MarketFocusView — Real-time AI predictions for what to concentrate on during the trading session.
 * Auto-refreshes every 30 min. Shows priority-ranked focus items for holdings + watchlist.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { motion, AnimatePresence } from 'motion/react'
import {
  Zap, Eye, TrendingUp, TrendingDown, Minus, RefreshCw,
  Clock, AlertTriangle, ShieldAlert, Target, Activity,
  ArrowUpRight, ArrowDownRight, ChevronDown, ChevronUp,
  Radio, Sparkles, BarChart2,
} from 'lucide-react'

// ── Helpers ───────────────────────────────────────────────────────────────────

function getApiKeyHeaders() {
  try {
    const s = JSON.parse(localStorage.getItem('finsurf_api_keys') || '{}')
    const h = {}
    if (s.aisa?.trim())    h['x-aisa-key']    = s.aisa.trim()
    if (s.finnhub?.trim()) h['x-finnhub-key'] = s.finnhub.trim()
    if (s.fmp?.trim())     h['x-fmp-key']     = s.fmp.trim()
    return h
  } catch { return {} }
}

function timeSince(isoStr) {
  if (!isoStr) return '—'
  const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000)
  if (diff < 60) return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  return `${Math.floor(diff / 3600)}h ago`
}

function timeUntil(isoStr) {
  if (!isoStr) return '—'
  const diff = Math.floor((new Date(isoStr).getTime() - Date.now()) / 1000)
  if (diff <= 0) return 'now'
  if (diff < 60) return `${diff}s`
  return `${Math.floor(diff / 60)}m`
}

const PRIORITY_CONFIG = {
  urgent: { color: 'text-red-400',    bg: 'bg-red-500/10',    border: 'border-red-500/30',    dot: 'bg-red-400',    icon: AlertTriangle, emoji: '🔴', label: 'URGENT' },
  watch:  { color: 'text-amber-400',  bg: 'bg-amber-500/10',  border: 'border-amber-500/30',  dot: 'bg-amber-400',  icon: Eye,           emoji: '🟡', label: 'WATCH'  },
  hold:   { color: 'text-emerald-400',bg: 'bg-emerald-500/10',border: 'border-emerald-500/30',dot: 'bg-emerald-400',icon: ShieldAlert,   emoji: '🟢', label: 'HOLD'   },
  skip:   { color: 'text-slate-500',  bg: 'bg-slate-800/40',  border: 'border-slate-700/40',  dot: 'bg-slate-600',  icon: Minus,         emoji: '⚪', label: 'SKIP'   },
}

const ACTION_COLORS = {
  'Cut':       'text-red-400 bg-red-500/15 border-red-500/30',
  'Trim':      'text-orange-400 bg-orange-500/15 border-orange-500/30',
  'Buy dip':   'text-emerald-400 bg-emerald-500/15 border-emerald-500/30',
  'Hold':      'text-slate-400 bg-slate-700/40 border-slate-600/30',
  'Watch':     'text-amber-400 bg-amber-500/15 border-amber-500/30',
  'Skip':      'text-slate-600 bg-slate-800/30 border-slate-700/20',
}

const SENTIMENT_CONFIG = {
  Bullish:  { color: 'text-emerald-400', icon: TrendingUp },
  Bearish:  { color: 'text-red-400',     icon: TrendingDown },
  Mixed:    { color: 'text-amber-400',   icon: Activity },
  Cautious: { color: 'text-amber-400',   icon: Eye },
}

// ── FocusItem card ────────────────────────────────────────────────────────────

function FocusCard({ item, idx }) {
  const [expanded, setExpanded] = useState(item.priority === 'urgent')
  const cfg = PRIORITY_CONFIG[item.priority] || PRIORITY_CONFIG.hold
  const Icon = cfg.icon
  const actionClass = ACTION_COLORS[item.action] || ACTION_COLORS['Watch']

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: idx * 0.04 }}
      className={`rounded-xl border ${cfg.border} ${cfg.bg} overflow-hidden`}
    >
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-3 px-4 py-3 text-left"
      >
        {/* Priority dot */}
        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${cfg.dot} ${item.priority === 'urgent' ? 'animate-pulse' : ''}`} />

        {/* Symbol + holding badge */}
        <div className="flex items-center gap-2 min-w-0 flex-1">
          <span className={`font-bold text-sm ${item.priority === 'skip' ? 'text-slate-500' : 'text-white'}`}>
            {item.symbol}
          </span>
          {item.isHolding && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-[#00ffcc]/10 text-[#00ffcc] border border-[#00ffcc]/20 font-semibold">HELD</span>
          )}
          <span className={`text-[10px] font-semibold ${cfg.color}`}>{cfg.label}</span>
        </div>

        {/* Action badge */}
        <span className={`text-[10px] font-semibold px-2 py-0.5 rounded border ${actionClass} flex-shrink-0`}>
          {item.action}
        </span>

        {/* Confidence */}
        <span className={`text-[10px] text-slate-500 flex-shrink-0 hidden sm:block`}>
          {item.confidence}
        </span>

        {/* Expand */}
        <div className="text-slate-600 flex-shrink-0">
          {expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="overflow-hidden"
          >
            <div className="px-4 pb-3 space-y-2 border-t border-white/[0.04] pt-2.5">
              {item.prediction && (
                <div className="flex gap-2 text-xs">
                  <Zap size={12} className={`${cfg.color} mt-0.5 flex-shrink-0`} />
                  <span className="text-slate-300">{item.prediction}</span>
                </div>
              )}
              {item.signal && (
                <div className="flex gap-2 text-xs">
                  <BarChart2 size={12} className="text-slate-500 mt-0.5 flex-shrink-0" />
                  <span className="text-slate-500">{item.signal}</span>
                </div>
              )}
              <div className="flex gap-4 text-[10px] text-slate-600 pt-1">
                {item.timeframe && <span>⏱ {item.timeframe}</span>}
                {item.priceTarget && <span className="text-emerald-500">🎯 Target ${item.priceTarget}</span>}
                {item.stopWatch   && <span className="text-red-500">🛑 Stop ${item.stopWatch}</span>}
                {item.analystTarget && <span className="text-sky-400">👥 Analysts ${item.analystTarget}</span>}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

// ── Pulse header ──────────────────────────────────────────────────────────────

function MarketPulseBar({ pulse, sessionLabel }) {
  if (!pulse) return null
  const sentCfg = SENTIMENT_CONFIG[pulse.sentiment] || SENTIMENT_CONFIG.Mixed
  const SIcon   = sentCfg.icon

  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-2.5 bg-[#0d1421] border-b border-white/[0.05] text-xs">
      <div className="flex items-center gap-1.5">
        <Radio size={10} className="text-[#00ffcc] animate-pulse" />
        <span className="text-[#00ffcc] font-semibold">{sessionLabel}</span>
      </div>
      <div className={`flex items-center gap-1 ${sentCfg.color}`}>
        <SIcon size={11} />
        <span className="font-semibold">{pulse.sentiment}</span>
        <span className="text-slate-600">·</span>
        <span className="text-slate-400">{pulse.strength}</span>
      </div>
      {pulse.breadth && <span className="text-slate-500 hidden md:block">{pulse.breadth}</span>}
      {pulse.keyRisk && (
        <span className="ml-auto text-amber-500/80 flex items-center gap-1">
          <AlertTriangle size={10} /> {pulse.keyRisk}
        </span>
      )}
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function MarketFocusView({ portfolio, watchlist: watchlistSymbols = [] }) {
  const { accessToken } = useAuth()
  const [data,     setData]     = useState(null)
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [filter,   setFilter]   = useState('all') // all | urgent | watch | holdings
  const timerRef = useRef(null)

  const holdings = portfolio?.positions?.map(p => p.symbol) ?? []

  const authHeader = accessToken ? { Authorization: `Bearer ${accessToken}` } : {}

  const loadFocus = useCallback(async (force = false) => {
    setLoading(true)
    setError(null)
    try {
      let res
      if (force) {
        res = await fetch('/api/market-focus/refresh', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders(), ...authHeader },
          body: JSON.stringify({ holdings, watchlist: watchlistSymbols }),
        })
      } else {
        res = await fetch('/api/market-focus', {
          headers: { ...getApiKeyHeaders(), ...authHeader },
        })
      }
      const d = await res.json()
      if (!res.ok) throw new Error(d.error || 'Failed to load focus')
      setData(d)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [holdings, watchlistSymbols, accessToken])

  // Load on mount
  useEffect(() => { loadFocus(false) }, [])

  // Auto-refresh every 30 min
  useEffect(() => {
    timerRef.current = setInterval(() => loadFocus(true), 30 * 60 * 1000)
    return () => clearInterval(timerRef.current)
  }, [loadFocus])

  const focusItems = data?.focusItems ?? []
  const filtered = filter === 'all'       ? focusItems
                 : filter === 'holdings'  ? focusItems.filter(i => i.isHolding)
                 : focusItems.filter(i => i.priority === filter)

  const urgentCount  = focusItems.filter(i => i.priority === 'urgent').length
  const watchCount   = focusItems.filter(i => i.priority === 'watch').length
  const holdingCount = focusItems.filter(i => i.isHolding).length

  return (
    <div className="space-y-4 max-w-3xl mx-auto">

      {/* ── Header ── */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <Zap size={18} className="text-[#00ffcc]" />
            Market Focus
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            AI-ranked priorities for this trading session · refreshes every 30 min
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.updatedAt && (
            <span className="text-[10px] text-slate-600">
              Updated {timeSince(data.updatedAt)}
              {data.nextRefreshAt && ` · next in ${timeUntil(data.nextRefreshAt)}`}
            </span>
          )}
          <button
            onClick={() => loadFocus(true)}
            disabled={loading}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#00ffcc]/10 border border-[#00ffcc]/20 text-[#00ffcc] text-xs font-medium hover:bg-[#00ffcc]/20 transition-all disabled:opacity-40"
          >
            <RefreshCw size={11} className={loading ? 'animate-spin' : ''} />
            {loading ? 'Analyzing…' : 'Refresh'}
          </button>
        </div>
      </div>

      {/* ── Market pulse bar ── */}
      {data?.marketPulse && (
        <div className="rounded-xl border border-white/[0.06] overflow-hidden">
          <MarketPulseBar pulse={data.marketPulse} sessionLabel={data.sessionLabel || 'Market'} />

          {/* Session theme + top opportunity/risk */}
          {(data.sessionTheme || data.topOpportunity || data.topRisk) && (
            <div className="px-4 py-3 grid sm:grid-cols-3 gap-3 text-xs bg-[#0a0f1a]">
              {data.sessionTheme && (
                <div>
                  <div className="text-[10px] text-slate-600 uppercase tracking-wide mb-1 flex items-center gap-1">
                    <Activity size={9} /> Session Theme
                  </div>
                  <div className="text-slate-300 font-medium">{data.sessionTheme}</div>
                </div>
              )}
              {data.topOpportunity && (
                <div>
                  <div className="text-[10px] text-emerald-600 uppercase tracking-wide mb-1 flex items-center gap-1">
                    <ArrowUpRight size={9} /> Best Opportunity
                  </div>
                  <div className="text-emerald-400">{data.topOpportunity}</div>
                </div>
              )}
              {data.topRisk && (
                <div>
                  <div className="text-[10px] text-red-600 uppercase tracking-wide mb-1 flex items-center gap-1">
                    <AlertTriangle size={9} /> Top Risk
                  </div>
                  <div className="text-red-400">{data.topRisk}</div>
                </div>
              )}
            </div>
          )}

          {/* Session plan */}
          {data.sessionPlan && (
            <div className="px-4 py-2.5 bg-[#060810] border-t border-white/[0.04]">
              <div className="text-[10px] text-slate-600 uppercase tracking-wide mb-1 flex items-center gap-1">
                <Target size={9} /> Session Plan
              </div>
              <p className="text-xs text-slate-400 leading-relaxed">{data.sessionPlan}</p>
            </div>
          )}
        </div>
      )}

      {/* ── Error ── */}
      {error && !loading && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {error}
        </div>
      )}

      {/* ── Loading skeleton ── */}
      {loading && !data && (
        <div className="space-y-2">
          {[...Array(5)].map((_, i) => (
            <div key={i} className="h-12 rounded-xl bg-slate-800/40 animate-pulse" style={{ animationDelay: `${i * 80}ms` }} />
          ))}
          <p className="text-center text-xs text-slate-600 pt-2">
            <Sparkles size={11} className="inline mr-1 text-[#00ffcc]" />
            AI is analyzing your holdings and the market…
          </p>
        </div>
      )}

      {/* ── Focus items ── */}
      {!loading && focusItems.length > 0 && (
        <>
          {/* Filter tabs */}
          <div className="flex gap-1.5 flex-wrap">
            {[
              { id: 'all',      label: `All (${focusItems.length})` },
              urgentCount  > 0 && { id: 'urgent',   label: `🔴 Urgent (${urgentCount})` },
              watchCount   > 0 && { id: 'watch',    label: `🟡 Watch (${watchCount})` },
              holdingCount > 0 && { id: 'holdings', label: `★ Holdings (${holdingCount})` },
            ].filter(Boolean).map(tab => (
              <button
                key={tab.id}
                onClick={() => setFilter(tab.id)}
                className={`px-3 py-1 rounded-lg text-xs font-medium transition-all border ${
                  filter === tab.id
                    ? 'bg-[#00ffcc]/15 border-[#00ffcc]/30 text-[#00ffcc]'
                    : 'bg-transparent border-white/[0.07] text-slate-500 hover:text-white'
                }`}
              >
                {tab.label}
              </button>
            ))}
          </div>

          {/* Cards */}
          <div className="space-y-2">
            <AnimatePresence mode="popLayout">
              {filtered.map((item, i) => (
                <FocusCard key={`${item.symbol}-${item.priority}`} item={item} idx={i} />
              ))}
            </AnimatePresence>
          </div>

          {filtered.length === 0 && (
            <div className="text-center py-8 text-slate-600 text-sm">
              No items in this category right now.
            </div>
          )}
        </>
      )}

      {/* ── Empty state ── */}
      {!loading && !error && focusItems.length === 0 && !data && (
        <div className="rounded-xl border border-white/[0.06] bg-[#0a0f1a] px-6 py-10 text-center">
          <Zap size={32} className="mx-auto text-[#00ffcc]/20 mb-3" />
          <p className="text-slate-400 text-sm font-medium">Ready to analyze your session</p>
          <p className="text-slate-600 text-xs mt-1 mb-4">
            Click Refresh to get AI-ranked priorities for your holdings and watchlist.
          </p>
          <button
            onClick={() => loadFocus(true)}
            className="px-4 py-2 rounded-lg bg-[#00ffcc]/15 border border-[#00ffcc]/25 text-[#00ffcc] text-sm font-medium hover:bg-[#00ffcc]/25 transition-all"
          >
            Analyze Now
          </button>
        </div>
      )}

      {/* ── Data source + disclaimer ── */}
      {data && (
        <p className="text-[10px] text-slate-700 text-center">
          {data.dataSource === 'live' ? '● Live market data' : '● Knowledge-based'} · Not financial advice · Powered by Claude
        </p>
      )}
    </div>
  )
}
