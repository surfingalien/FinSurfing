/**
 * BuySignalsView — AI-powered buy recommendations for 3-month and 6-month holding periods.
 * Covers stocks, ETFs, and cryptocurrencies.
 */

import { useState, useCallback } from 'react'
import {
  Sparkles, RefreshCw, TrendingUp, Clock,
  AlertTriangle, Target, Shield, Zap, BarChart2,
  Bookmark, BookmarkCheck, Search, X,
} from 'lucide-react'
import { useAIWatchlist } from '../../hooks/useAIWatchlist'

/* ── Helpers ─────────────────────────────────── */
function getApiKeyHeaders() {
  try {
    const stored = JSON.parse(localStorage.getItem('finsurf_api_keys') || '{}')
    const h = {}
    if (stored.aisa?.trim())    h['x-aisa-key']    = stored.aisa.trim()
    if (stored.finnhub?.trim()) h['x-finnhub-key'] = stored.finnhub.trim()
    if (stored.fmp?.trim())     h['x-fmp-key']     = stored.fmp.trim()
    return h
  } catch { return {} }
}

const TYPE_CONFIG = {
  Stock:  { color: 'text-blue-400',    bg: 'bg-blue-500/10',    border: 'border-blue-500/25',    emoji: '📈' },
  ETF:    { color: 'text-purple-400',  bg: 'bg-purple-500/10',  border: 'border-purple-500/25',  emoji: '🧺' },
  Crypto: { color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/25',   emoji: '₿'  },
}

const RISK_CONFIG = {
  Low:    { color: 'text-emerald-400', bg: 'bg-emerald-500/10', dot: 'bg-emerald-400' },
  Medium: { color: 'text-amber-400',   bg: 'bg-amber-500/10',   dot: 'bg-amber-400'   },
  High:   { color: 'text-red-400',     bg: 'bg-red-500/10',     dot: 'bg-red-400'     },
}

const PERIOD_CONFIG = {
  '3m': { label: '3-Month Hold', color: 'text-cyan-400',  bg: 'bg-cyan-500/10',  border: 'border-cyan-500/20'  },
  '6m': { label: '6-Month Hold', color: 'text-violet-400', bg: 'bg-violet-500/10', border: 'border-violet-500/20' },
}

/* ── Single recommendation card ─────────────────── */
function RecCard({ rec, onAnalyze }) {
  const { addStock, removeStock, hasSymbol } = useAIWatchlist()
  const type     = TYPE_CONFIG[rec.type]    || TYPE_CONFIG.Stock
  const risk     = RISK_CONFIG[rec.risk]    || RISK_CONFIG.Medium
  const period   = PERIOD_CONFIG[rec.period] || PERIOD_CONFIG['3m']
  const inWatchlist = hasSymbol(rec.symbol)

  const toggleWatchlist = () => {
    if (inWatchlist) {
      removeStock(rec.symbol)
    } else {
      addStock({
        symbol:       rec.symbol,
        name:         rec.name,
        sector:       rec.sector,
        addedFrom:    'buy-signals',
        targetReturn: rec.targetReturn,
        stopLoss:     rec.stopLoss,
        horizon:      rec.period,
        verdict:      rec.risk + ' Risk',
      })
    }
  }

  return (
    <div className={`glass rounded-2xl p-4 border ${type.border} hover:brightness-105 transition-all`}>
      {/* Top row */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg">{type.emoji}</span>
          <div>
            <button
              onClick={() => onAnalyze?.(rec.symbol)}
              className="font-mono font-black text-white text-base hover:text-mint-400 transition-colors leading-none"
            >
              {rec.symbol}
            </button>
            <div className="text-xs text-slate-400 truncate max-w-[140px] mt-0.5">{rec.name}</div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${period.bg} ${period.color} border ${period.border}`}>
            {period.label}
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1 ${risk.bg} ${risk.color}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${risk.dot}`} />
            {rec.risk} Risk
          </span>
        </div>
      </div>

      {/* Return targets */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="bg-white/[0.03] rounded-lg p-2 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5 flex items-center justify-center gap-1">
            <Target className="w-2.5 h-2.5" /> Target
          </div>
          <div className="text-emerald-400 font-mono font-bold text-sm">+{rec.targetReturn}%</div>
        </div>
        <div className="bg-white/[0.03] rounded-lg p-2 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5 flex items-center justify-center gap-1">
            <Shield className="w-2.5 h-2.5" /> Stop Loss
          </div>
          <div className="text-red-400 font-mono font-bold text-sm">{rec.stopLoss}%</div>
        </div>
      </div>

      {/* Thesis */}
      <p className="text-xs text-slate-400 leading-relaxed mb-2">{rec.thesis}</p>

      {/* Catalyst + technical */}
      <div className="space-y-1">
        {rec.catalyst && (
          <div className="flex items-start gap-1.5 text-[11px]">
            <Zap className="w-3 h-3 text-mint-400 shrink-0 mt-0.5" />
            <span className="text-slate-400"><span className="text-mint-400 font-medium">Catalyst:</span> {rec.catalyst}</span>
          </div>
        )}
        {rec.technicalSignal && (
          <div className="flex items-start gap-1.5 text-[11px]">
            <BarChart2 className="w-3 h-3 text-indigo-400 shrink-0 mt-0.5" />
            <span className="text-slate-500">{rec.technicalSignal}</span>
          </div>
        )}
      </div>

      {/* Footer: sector + watchlist */}
      <div className="flex items-center justify-between mt-3">
        {rec.sector
          ? <span className={`text-[10px] px-2 py-0.5 rounded-full ${type.bg} ${type.color}`}>{rec.sector}</span>
          : <span />
        }
        <button
          onClick={toggleWatchlist}
          className={`flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-medium border transition-all ${
            inWatchlist
              ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'
              : 'bg-white/[0.04] text-slate-500 border-white/[0.07] hover:text-indigo-400 hover:border-indigo-500/30'
          }`}
        >
          {inWatchlist ? <BookmarkCheck className="w-3 h-3" /> : <Bookmark className="w-3 h-3" />}
          {inWatchlist ? 'Saved' : 'Save'}
        </button>
      </div>
    </div>
  )
}

/* ── Main view ───────────────────────────────────── */
export default function BuySignalsView({ portfolio, onAnalyze }) {
  const [recs,          setRecs]          = useState(null)
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [filter,        setFilter]        = useState('all')   // 'all' | 'Stock' | 'ETF' | 'Crypto'
  const [period,        setPeriod]        = useState('all')   // 'all' | '3m' | '6m'
  const [customSymbols, setCustomSymbols] = useState('')

  const holdings = portfolio?.positions?.map(p => p.symbol) ?? []

  const parseSymbols = (str) =>
    str.split(/[,\s]+/)
      .map(s => s.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, ''))
      .filter(Boolean)
      .slice(0, 15)

  const generate = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const body = { holdings }
      if (customSymbols.trim()) body.watchlist = parseSymbols(customSymbols)
      const res = await fetch('/api/recommendations', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders() },
        body:    JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to get recommendations')
      setRecs(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [holdings, customSymbols])

  const displayed = (recs?.recommendations ?? []).filter(r => {
    if (filter !== 'all' && r.type !== filter) return false
    if (period !== 'all' && r.period !== period) return false
    return true
  })

  const counts = (recs?.recommendations ?? []).reduce((acc, r) => {
    acc[r.type]   = (acc[r.type]   || 0) + 1
    acc[r.period] = (acc[r.period] || 0) + 1
    return acc
  }, {})

  return (
    <div className="space-y-6 animate-fade-in">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-mint-500/10 border border-mint-500/20">
            <Sparkles className="w-5 h-5 text-mint-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">AI Buy Signals</h1>
            <p className="text-xs text-slate-500">Claude-powered picks for 3-month & 6-month horizons</p>
          </div>
        </div>

        <button
          onClick={generate}
          disabled={loading}
          className="btn-primary flex items-center gap-2 shrink-0 disabled:opacity-50"
        >
          {loading
            ? <><RefreshCw className="w-4 h-4 animate-spin" /> Analyzing…</>
            : <><Sparkles className="w-4 h-4" /> {recs ? 'Regenerate' : 'Generate Picks'}</>
          }
        </button>
      </div>

      {/* ── Symbol search ── */}
      <div className="flex items-center gap-2 p-3 rounded-xl bg-white/[0.03] border border-white/[0.08]">
        <Search className="w-4 h-4 text-slate-500 shrink-0" />
        <input
          type="text"
          value={customSymbols}
          onChange={e => setCustomSymbols(e.target.value.toUpperCase())}
          disabled={loading}
          placeholder="Focus on specific symbols (e.g. NVDA,TSLA,ETH-USD) — leave blank for AI-selected picks"
          className="flex-1 bg-transparent text-sm text-white placeholder-slate-600 focus:outline-none font-mono disabled:opacity-40"
        />
        {customSymbols && (
          <button onClick={() => setCustomSymbols('')} className="text-slate-500 hover:text-slate-300">
            <X className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* ── Error ── */}
      {error && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          {error}
          {error.includes('ANTHROPIC_API_KEY') && (
            <span className="text-slate-500 text-xs ml-1">— Set ANTHROPIC_API_KEY in Railway env vars.</span>
          )}
        </div>
      )}

      {/* ── Loading skeleton ── */}
      {loading && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {Array.from({ length: 8 }).map((_, i) => (
            <div key={i} className="glass rounded-2xl p-4 space-y-3 animate-pulse">
              <div className="flex gap-2">
                <div className="w-8 h-8 bg-white/[0.06] rounded-full" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-4 bg-white/[0.06] rounded w-20" />
                  <div className="h-3 bg-white/[0.04] rounded w-28" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="h-10 bg-white/[0.04] rounded-lg" />
                <div className="h-10 bg-white/[0.04] rounded-lg" />
              </div>
              <div className="space-y-1.5">
                <div className="h-3 bg-white/[0.04] rounded w-full" />
                <div className="h-3 bg-white/[0.04] rounded w-4/5" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && !recs && !error && (
        <div className="glass rounded-2xl p-16 text-center space-y-4">
          <Sparkles className="w-12 h-12 text-mint-400/30 mx-auto" />
          <div>
            <p className="text-white font-semibold">Ready to generate recommendations</p>
            <p className="text-slate-500 text-sm mt-1">
              Claude will analyze current market conditions and suggest the best stocks, ETFs,
              and crypto for 3-month and 6-month holding periods.
            </p>
            {holdings.length > 0 && (
              <p className="text-xs text-slate-600 mt-2">
                Portfolio holdings ({holdings.length}) will be excluded from picks to avoid overlap.
              </p>
            )}
          </div>
          <button onClick={generate} className="btn-primary flex items-center gap-2 mx-auto">
            <Sparkles className="w-4 h-4" /> Generate Picks
          </button>
        </div>
      )}

      {/* ── Results ── */}
      {!loading && recs && (
        <>
          {/* Market outlook banner */}
          <div className="glass rounded-xl p-4 border border-white/[0.06]">
            <div className="flex items-start gap-3">
              <TrendingUp className="w-4 h-4 text-mint-400 mt-0.5 shrink-0" />
              <div>
                <div className="text-xs font-semibold text-mint-400 mb-1">Market Outlook</div>
                <p className="text-sm text-slate-300">{recs.marketOutlook}</p>
                {recs.keyRisks && (
                  <div className="flex items-start gap-1.5 mt-2">
                    <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
                    <p className="text-xs text-amber-400/80">{recs.keyRisks}</p>
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Filters */}
          <div className="flex flex-wrap items-center gap-2">
            {/* Type filter */}
            <div className="flex gap-1">
              {['all','Stock','ETF','Crypto'].map(f => (
                <button
                  key={f}
                  onClick={() => setFilter(f)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                    filter === f
                      ? 'bg-mint-500/20 text-mint-400 border border-mint-500/30'
                      : 'bg-white/[0.03] text-slate-400 hover:text-white border border-white/[0.06]'
                  }`}
                >
                  {f === 'all' ? `All (${recs.recommendations.length})` : `${TYPE_CONFIG[f]?.emoji} ${f} (${counts[f] || 0})`}
                </button>
              ))}
            </div>

            <div className="w-px h-4 bg-white/[0.08] hidden sm:block" />

            {/* Period filter */}
            <div className="flex gap-1">
              {['all','3m','6m'].map(p => (
                <button
                  key={p}
                  onClick={() => setPeriod(p)}
                  className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all flex items-center gap-1 ${
                    period === p
                      ? 'bg-mint-500/20 text-mint-400 border border-mint-500/30'
                      : 'bg-white/[0.03] text-slate-400 hover:text-white border border-white/[0.06]'
                  }`}
                >
                  <Clock className="w-3 h-3" />
                  {p === 'all' ? 'All Periods' : p === '3m' ? `3-Month (${counts['3m'] || 0})` : `6-Month (${counts['6m'] || 0})`}
                </button>
              ))}
            </div>

            <div className="ml-auto text-[10px] text-slate-600">
              Generated {new Date(recs.generatedAt).toLocaleTimeString()}
            </div>
          </div>

          {/* Cards grid */}
          {displayed.length === 0 ? (
            <div className="glass rounded-xl p-8 text-center text-slate-500 text-sm">
              No recommendations match the selected filters.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
              {displayed.map((rec, i) => (
                <RecCard key={`${rec.symbol}-${i}`} rec={rec} onAnalyze={onAnalyze} />
              ))}
            </div>
          )}

          {/* Disclaimer */}
          <div className="text-center text-[11px] text-slate-600 border-t border-white/[0.04] pt-3">
            AI-generated recommendations are for informational purposes only. Not financial advice.
            Past performance does not guarantee future results. Always do your own research.
          </div>
        </>
      )}
    </div>
  )
}
