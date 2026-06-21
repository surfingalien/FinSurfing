import { useState, useCallback } from 'react'
import { Zap, AlertTriangle, RefreshCw } from 'lucide-react'
import { getApiKeyHeaders } from '../../services/api'
import { useWatchlist } from '../../hooks/useWatchlist'

const SOURCES = [
  { id: 'reddit',     label: 'Reddit' },
  { id: 'x',         label: 'X (Twitter)' },
  { id: 'news',      label: 'News' },
  { id: 'polymarket',label: 'Polymarket' },
]

const DAYS_OPTIONS = [1, 3, 7, 14, 30]

function sentimentColor(score) {
  if (score == null) return 'text-slate-400'
  if (score >= 65) return 'text-emerald-400'
  if (score >= 45) return 'text-amber-400'
  return 'text-red-400'
}

function buzzColor(score) {
  if (score == null) return 'text-slate-400'
  if (score >= 70) return 'text-mint-400'
  if (score >= 40) return 'text-slate-300'
  return 'text-slate-500'
}

function trendBadge(trend) {
  const t = String(trend || '').toLowerCase()
  if (t.includes('up') || t.includes('bull')) return 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
  if (t.includes('down') || t.includes('bear')) return 'bg-red-500/10 text-red-400 border-red-500/20'
  return 'bg-slate-500/10 text-slate-400 border-slate-500/20'
}

function ScoreBar({ value, color }) {
  if (value == null) return <span className="text-slate-600 text-xs">—</span>
  const pct = Math.min(100, Math.max(0, value))
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1.5 rounded-full bg-white/[0.06] overflow-hidden">
        <div className={`h-full rounded-full ${color} opacity-70`} style={{ width: `${pct}%` }} />
      </div>
      <span className={`text-xs font-mono font-semibold ${color}`}>{Math.round(value)}</span>
    </div>
  )
}

function Skeleton() {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4 animate-pulse">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="glass rounded-2xl p-4 border border-white/[0.06] h-44" />
      ))}
    </div>
  )
}

export default function SentimentView() {
  const { watchlist } = useWatchlist()
  const [customSymbols, setCustomSymbols] = useState('')
  const [source, setSource] = useState('reddit')
  const [days, setDays] = useState(7)
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const run = useCallback(async (e) => {
    e?.preventDefault()
    setLoading(true)
    setError(null)
    setData(null)
    try {
      const custom  = customSymbols.split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
      const symbols = custom.length ? custom : watchlist.slice(0, 20)
      if (!symbols.length) {
        setError('Add symbols to your watchlist or enter custom symbols above.')
        setLoading(false)
        return
      }
      const params = new URLSearchParams({ symbols: symbols.join(','), source, days: String(days) })
      const res = await fetch(`/api/sentiment/adanos?${params}`, {
        headers: getApiKeyHeaders(),
      })
      if (!res.ok) {
        const body = await res.json().catch(() => ({}))
        throw new Error(body.error || `Request failed (${res.status})`)
      }
      const json = await res.json()
      setData(json)
    } catch (err) {
      setError(err.message || 'Failed to fetch sentiment data')
    } finally {
      setLoading(false)
    }
  }, [customSymbols, source, days, watchlist])

  const stocks = data?.stocks || []

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-mint-500/10 border border-mint-500/20">
          <Zap className="w-5 h-5 text-mint-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Sentiment Scanner</h1>
          <p className="text-xs text-slate-500">Social & news sentiment scores via Adanos — powered by Reddit, X, news, and Polymarket</p>
        </div>
      </div>

      <form onSubmit={run} className="glass rounded-2xl p-4 border border-white/[0.06]">
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3 items-end">
          <div className="sm:col-span-2 lg:col-span-1">
            <label className="block text-xs text-slate-500 mb-1.5">Custom Symbols (optional)</label>
            <input
              value={customSymbols}
              onChange={(e) => setCustomSymbols(e.target.value)}
              placeholder={watchlist.length ? `e.g. AAPL, TSLA (or leave blank for watchlist)` : 'AAPL, TSLA, NVDA'}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:border-mint-500/40"
            />
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Source</label>
            <select
              value={source}
              onChange={(e) => setSource(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-mint-500/40"
            >
              {SOURCES.map(s => <option key={s.id} value={s.id} className="bg-slate-900">{s.label}</option>)}
            </select>
          </div>
          <div>
            <label className="block text-xs text-slate-500 mb-1.5">Days</label>
            <select
              value={days}
              onChange={(e) => setDays(Number(e.target.value))}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-xl px-3 py-2.5 text-sm text-white focus:outline-none focus:border-mint-500/40"
            >
              {DAYS_OPTIONS.map(d => <option key={d} value={d} className="bg-slate-900">{d}d</option>)}
            </select>
          </div>
          <button type="submit" disabled={loading} className="btn-primary flex items-center gap-2 justify-center disabled:opacity-50">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            {loading ? 'Fetching…' : 'Scan'}
          </button>
        </div>
        {watchlist.length > 0 && !customSymbols && (
          <p className="text-[10px] text-slate-600 mt-2">
            Will scan your watchlist: {watchlist.slice(0, 10).join(', ')}{watchlist.length > 10 ? ` +${watchlist.length - 10} more` : ''}
          </p>
        )}
      </form>

      {error && (
        <div className="glass rounded-2xl p-4 border border-red-500/20 flex items-center gap-3 text-red-400">
          <AlertTriangle className="w-5 h-5 shrink-0" />
          <span className="text-sm">{error}</span>
        </div>
      )}

      {data?.enabled === false && (
        <div className="glass rounded-2xl p-6 border border-amber-500/20 text-center space-y-2">
          <Zap className="w-8 h-8 text-amber-400 mx-auto" />
          <p className="text-sm font-medium text-amber-400">Adanos API key not configured</p>
          <p className="text-xs text-slate-500">Set <code className="text-slate-300">ADANOS_API_KEY</code> in your environment to enable social sentiment scanning.</p>
        </div>
      )}

      {loading && <Skeleton />}

      {data?.enabled !== false && stocks.length > 0 && !loading && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500">
              {stocks.length} stocks · {source} · last {days}d
              {data.cached && <span className="ml-2 text-slate-600">(cached)</span>}
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {stocks.map((s, i) => (
              <div key={i} className="glass rounded-2xl p-4 border border-white/[0.06] flex flex-col gap-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-bold text-white text-base">{s.ticker}</div>
                    {s.company_name && <div className="text-xs text-slate-500 truncate max-w-[140px]">{s.company_name}</div>}
                  </div>
                  <div className="flex flex-col items-end gap-1">
                    {s.trend && (
                      <span className={`px-2 py-0.5 rounded-lg text-[10px] font-semibold border ${trendBadge(s.trend)}`}>
                        {s.trend}
                      </span>
                    )}
                    {s.mentions != null && (
                      <span className="text-[10px] text-slate-500 font-mono">{s.mentions.toLocaleString()} mentions</span>
                    )}
                  </div>
                </div>

                <div className="space-y-2">
                  <div>
                    <div className="flex justify-between text-[10px] text-slate-500 mb-1">
                      <span>Sentiment</span>
                      <span className={sentimentColor(s.sentiment_score)}>{s.sentiment_score != null ? `${Math.round(s.sentiment_score)}/100` : '—'}</span>
                    </div>
                    <ScoreBar value={s.sentiment_score} color={sentimentColor(s.sentiment_score).replace('text-', 'bg-')} />
                  </div>
                  <div>
                    <div className="flex justify-between text-[10px] text-slate-500 mb-1">
                      <span>Buzz</span>
                      <span className={buzzColor(s.buzz_score)}>{s.buzz_score != null ? `${Math.round(s.buzz_score)}/100` : '—'}</span>
                    </div>
                    <ScoreBar value={s.buzz_score} color={buzzColor(s.buzz_score).replace('text-', 'bg-')} />
                  </div>
                </div>

                {(s.bullish_pct != null || s.bearish_pct != null) && (
                  <div className="flex gap-3 text-xs">
                    {s.bullish_pct != null && (
                      <span className="flex-1 text-center py-1 rounded-lg bg-emerald-500/10 text-emerald-400 font-mono font-semibold border border-emerald-500/20">
                        {Math.round(s.bullish_pct)}% bull
                      </span>
                    )}
                    {s.bearish_pct != null && (
                      <span className="flex-1 text-center py-1 rounded-lg bg-red-500/10 text-red-400 font-mono font-semibold border border-red-500/20">
                        {Math.round(s.bearish_pct)}% bear
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

          <p className="text-xs text-slate-600 text-center pt-2">
            Sentiment data sourced from {source} via Adanos API. Not financial advice.
          </p>
        </div>
      )}

      {data?.enabled !== false && stocks.length === 0 && !loading && data && (
        <div className="glass rounded-2xl p-8 border border-white/[0.06] text-center text-sm text-slate-500">
          No sentiment data returned for the selected symbols and source.
        </div>
      )}
    </div>
  )
}
