/**
 * SentimentPulseWidget — per-symbol news sentiment scores powered by Claude.
 * Auto-refreshes every 20 minutes. Results cached server-side for 25 min.
 */
import { useState, useEffect, useCallback, useRef } from 'react'
import { Activity, RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { useAuth }    from '../../contexts/AuthContext'
import { useApiKeys } from '../../contexts/ApiKeysContext'

const SENTIMENT_CFG = {
  bullish: {
    label: 'Bullish', Icon: TrendingUp,
    pill:  'bg-emerald-500/15 text-emerald-400 border-emerald-500/25',
    bar:   'bg-emerald-400',
  },
  neutral: {
    label: 'Neutral', Icon: Minus,
    pill:  'bg-amber-500/15 text-amber-400 border-amber-500/25',
    bar:   'bg-amber-400',
  },
  bearish: {
    label: 'Bearish', Icon: TrendingDown,
    pill:  'bg-red-500/15 text-red-400 border-red-500/25',
    bar:   'bg-red-400',
  },
}

function SkeletonRow() {
  return (
    <div className="flex items-center gap-3 py-1.5 animate-pulse">
      <div className="w-12 h-3.5 rounded bg-white/[0.07]" />
      <div className="w-16 h-3.5 rounded bg-white/[0.07]" />
      <div className="flex-1 h-1.5 rounded-full bg-white/[0.07]" />
      <div className="w-28 h-3 rounded bg-white/[0.07]" />
    </div>
  )
}

export default function SentimentPulseWidget({ symbols = [] }) {
  const { authFetch }  = useAuth()
  const { getHeaders } = useApiKeys()

  const [results,   setResults]   = useState([])
  const [loading,   setLoading]   = useState(false)
  const [error,     setError]     = useState(null)
  const [warning,   setWarning]   = useState(null)
  const [updatedAt, setUpdatedAt] = useState(null)
  const timerRef = useRef(null)

  const load = useCallback(async (bust = false) => {
    if (!symbols.length) return
    setLoading(true); setError(null); setWarning(null)
    try {
      const params = new URLSearchParams({ symbols: symbols.slice(0, 15).join(',') })
      if (bust) params.set('bust', String(Date.now()))
      const res  = await authFetch(`/api/sentiment/portfolio?${params}`, { headers: getHeaders() })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResults(data.results || [])
      setUpdatedAt(data.updatedAt || Date.now())
      if (data.warning) setWarning(data.warning)
    } catch (e) { setError(e.message) }
    setLoading(false)
  }, [symbols.join(','), authFetch, getHeaders])

  useEffect(() => {
    load()
    timerRef.current = setInterval(() => load(), 20 * 60 * 1000)
    return () => clearInterval(timerRef.current)
  }, [load])

  const ageMin = updatedAt ? Math.floor((Date.now() - updatedAt) / 60000) : null

  return (
    <div className="glass rounded-xl p-4">
      {/* Header */}
      <div className="flex items-center gap-2 mb-3">
        <Activity className="w-3.5 h-3.5 text-mint-400" />
        <h3 className="text-sm font-semibold text-white">News Sentiment</h3>
        {ageMin !== null && (
          <span className="text-[10px] text-slate-600">
            · {ageMin < 1 ? 'just now' : `${ageMin}m ago`}
          </span>
        )}
        <button
          onClick={() => load(true)}
          disabled={loading}
          aria-label="Refresh sentiment"
          className="ml-auto p-1 rounded text-slate-600 hover:text-slate-300 transition-colors disabled:opacity-40"
        >
          <RefreshCw className={`w-3 h-3 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Skeleton */}
      {loading && !results.length && (
        <div className="space-y-1">
          {Array.from({ length: Math.min(symbols.length || 4, 6) }).map((_, i) => (
            <SkeletonRow key={i} />
          ))}
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <p className="text-xs text-slate-500 text-center py-3">{error}</p>
      )}

      {/* Warning — e.g. company news unavailable on free Finnhub tier */}
      {warning && !loading && (
        <div className="flex items-start gap-2 text-[11px] text-amber-400/80 bg-amber-500/[0.08] border border-amber-500/20 rounded-lg px-3 py-2 mb-2">
          <span className="shrink-0 mt-0.5">⚠</span>
          <span>{warning}</span>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && !results.length && symbols.length === 0 && (
        <p className="text-xs text-slate-600 text-center py-3">Add holdings to see sentiment</p>
      )}

      {/* Results */}
      <div className="space-y-2">
        {results.map(r => {
          const cfg  = SENTIMENT_CFG[r.sentiment] || SENTIMENT_CFG.neutral
          const Icon = cfg.Icon
          const barW = `${Math.max(4, ((r.score - 1) / 9) * 100)}%`

          return (
            <div key={r.symbol} className="flex items-center gap-2.5">
              {/* Ticker */}
              <span className="w-12 text-[11px] font-mono font-bold text-mint-400 shrink-0">
                {r.symbol}
              </span>

              {/* Sentiment pill */}
              <span className={`flex items-center gap-0.5 text-[9px] font-medium px-1.5 py-0.5 rounded border shrink-0 ${cfg.pill}`}>
                <Icon className="w-2.5 h-2.5" />
                {cfg.label}
              </span>

              {/* Score bar */}
              <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
                <div className={`h-full rounded-full transition-all duration-500 ${cfg.bar}`} style={{ width: barW }} />
              </div>

              {/* Summary */}
              <span className="text-[10px] text-slate-500 truncate max-w-[130px] hidden sm:block" title={r.summary}>
                {r.summary}
              </span>
            </div>
          )
        })}
      </div>

      {results.length > 0 && (
        <div className="text-[9px] text-slate-700 text-right mt-2">
          AI-scored from Finnhub headlines · Not investment advice
        </div>
      )}
    </div>
  )
}
