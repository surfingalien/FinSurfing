import { useState, useEffect, useCallback } from 'react'
import { Star, Search, RefreshCw, TrendingUp, TrendingDown, Minus, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react'
import { getApiKeyHeaders } from '../../services/api'

const RATING_ORDER = ['Strong Buy', 'Buy', 'Overweight', 'Outperform', 'Market Perform', 'Neutral', 'Hold', 'Underperform', 'Underweight', 'Sell', 'Strong Sell', 'Initiated', 'Reiterated']

function ratingColor(r) {
  if (!r) return 'text-slate-400'
  const l = r.toLowerCase()
  if (l.includes('strong buy') || l.includes('outperform') || l.includes('overweight') || l === 'buy')
    return 'text-emerald-400'
  if (l.includes('strong sell') || l.includes('underperform') || l.includes('underweight') || l === 'sell')
    return 'text-red-400'
  if (l.includes('neutral') || l.includes('hold') || l.includes('market perform'))
    return 'text-slate-400'
  return 'text-amber-400'
}

function actionIcon(action) {
  if (!action) return <Minus className="w-3.5 h-3.5 text-slate-500" />
  const l = action.toLowerCase()
  if (l === 'upgrade')    return <TrendingUp  className="w-3.5 h-3.5 text-emerald-400" />
  if (l === 'downgrade')  return <TrendingDown className="w-3.5 h-3.5 text-red-400" />
  return <Minus className="w-3.5 h-3.5 text-slate-500" />
}

function actionBadge(action) {
  const l = (action || '').toLowerCase()
  if (l === 'upgrade')   return 'bg-emerald-500/10 border-emerald-500/25 text-emerald-400'
  if (l === 'downgrade') return 'bg-red-500/10 border-red-500/25 text-red-400'
  return 'bg-slate-500/10 border-slate-500/20 text-slate-400'
}

function ConsensusCard({ consensus }) {
  if (!consensus) return null
  const r = consensus.ratingDetailsDCFRecommendation || consensus.rating || 'N/A'
  const score = consensus.ratingScore ?? null
  return (
    <div className="glass rounded-xl p-4 flex items-center gap-4">
      <Star className="w-5 h-5 text-amber-400 shrink-0" />
      <div>
        <div className="text-[10px] text-slate-500 uppercase tracking-wider mb-0.5">Consensus</div>
        <div className={`text-sm font-bold ${ratingColor(r)}`}>{r}</div>
      </div>
      {score != null && (
        <>
          <div className="w-px h-8 bg-white/[0.08]" />
          <div>
            <div className="text-[10px] text-slate-500 mb-0.5">Score</div>
            <div className="font-mono font-bold text-white">{score}</div>
          </div>
        </>
      )}
      {consensus.ratingRecommendation && (
        <>
          <div className="w-px h-8 bg-white/[0.08]" />
          <div>
            <div className="text-[10px] text-slate-500 mb-0.5">Recommendation</div>
            <div className={`text-sm font-semibold ${ratingColor(consensus.ratingRecommendation)}`}>{consensus.ratingRecommendation}</div>
          </div>
        </>
      )}
    </div>
  )
}

function RatingRow({ item }) {
  const hasPriceChange = item.priceWhenPosted != null

  return (
    <tr className="border-t border-white/[0.04] hover:bg-white/[0.02] transition-colors">
      <td className="px-4 py-3">
        <span className="font-mono font-bold text-white text-sm">{item.symbol}</span>
      </td>
      <td className="px-4 py-3">
        <div className="text-xs text-white font-medium truncate max-w-[160px]">{item.gradingCompany || '—'}</div>
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-[11px] font-semibold border ${actionBadge(item.action)}`}>
          {actionIcon(item.action)}
          <span className="capitalize">{item.action || 'Reiterate'}</span>
        </span>
      </td>
      <td className="px-4 py-3">
        <div className="flex items-center gap-1.5 text-xs">
          {item.previousGrade && (
            <>
              <span className={`font-semibold ${ratingColor(item.previousGrade)}`}>{item.previousGrade}</span>
              <span className="text-slate-600">→</span>
            </>
          )}
          <span className={`font-semibold ${ratingColor(item.newGrade)}`}>{item.newGrade || '—'}</span>
        </div>
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs text-slate-400">
        {hasPriceChange ? `$${Number(item.priceWhenPosted).toFixed(2)}` : '—'}
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs text-slate-500">
        {(item.publishedDate || '').slice(0, 10)}
      </td>
    </tr>
  )
}

export default function AnalystView() {
  const [input,    setInput]    = useState('')
  const [symbol,   setSymbol]   = useState('')
  const [data,     setData]     = useState({ ratings: [], consensus: null })
  const [loading,  setLoading]  = useState(false)
  const [error,    setError]    = useState(null)
  const [page,     setPage]     = useState(0)
  const [filter,   setFilter]   = useState('all')  // 'all' | 'upgrade' | 'downgrade' | 'initiated'

  const load = useCallback(async (sym, pg = 0) => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams({ page: pg })
      if (sym) params.set('symbol', sym)
      const r    = await fetch(`/api/market-intel/analyst?${params}`, { headers: getApiKeyHeaders() })
      const json = await r.json()
      if (!r.ok) throw new Error(json.error || 'Failed to load analyst ratings')
      setData(json)
    } catch (e) { setError(e.message) }
    setLoading(false)
  }, [])

  useEffect(() => { load('', 0) }, [load])

  const search = () => {
    const sym = input.trim().toUpperCase()
    setSymbol(sym); setPage(0); load(sym, 0)
  }

  const goPage = (dir) => {
    const next = page + dir
    if (next < 0) return
    setPage(next); load(symbol, next)
  }

  const filtered = (data.ratings || []).filter(r => {
    if (filter === 'upgrade')   return r.action?.toLowerCase() === 'upgrade'
    if (filter === 'downgrade') return r.action?.toLowerCase() === 'downgrade'
    if (filter === 'initiated') return r.action?.toLowerCase() === 'initiated'
    return true
  })

  const upgrades   = data.ratings.filter(r => r.action?.toLowerCase() === 'upgrade').length
  const downgrades = data.ratings.filter(r => r.action?.toLowerCase() === 'downgrade').length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
          <Star className="w-5 h-5 text-amber-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Analyst Ratings</h1>
          <p className="text-xs text-slate-500">Upgrades, downgrades &amp; price target changes from Wall Street firms</p>
        </div>
      </div>

      {/* Search */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2 bg-white/[0.03] border border-white/[0.07] rounded-xl px-3 py-2 flex-1 min-w-[220px] max-w-xs">
          <Search className="w-4 h-4 text-slate-500 shrink-0" />
          <input
            value={input}
            onChange={e => setInput(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && search()}
            placeholder="Filter by symbol (AAPL)…"
            className="bg-transparent text-sm text-white placeholder-slate-600 focus:outline-none flex-1 font-mono"
          />
        </div>
        <button onClick={search} className="px-4 py-2 bg-amber-500/80 hover:bg-amber-400 text-white text-sm font-semibold rounded-xl transition-colors">
          Search
        </button>
        {symbol && (
          <button onClick={() => { setSymbol(''); setInput(''); setPage(0); load('', 0) }}
            className="text-xs text-slate-500 hover:text-white transition-colors">× Clear
          </button>
        )}

        {/* Action filter */}
        <div className="flex items-center gap-1 ml-auto">
          {[
            { id: 'all',       label: 'All' },
            { id: 'upgrade',   label: `↑ Upgrades (${upgrades})` },
            { id: 'downgrade', label: `↓ Downgrades (${downgrades})` },
            { id: 'initiated', label: 'Initiated' },
          ].map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                filter === f.id ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-white'
              }`}>{f.label}
            </button>
          ))}
        </div>

        <button onClick={() => { setPage(0); load(symbol, 0) }} disabled={loading}
          className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.05] transition-colors disabled:opacity-40">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {/* Consensus card (when symbol selected) */}
      {symbol && data.consensus && <ConsensusCard consensus={data.consensus} />}

      {/* Error */}
      {error && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {/* Table */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="bg-white/[0.03] text-slate-500 text-xs">
              <tr>
                <th className="px-4 py-3 text-left font-medium">Symbol</th>
                <th className="px-4 py-3 text-left font-medium">Firm</th>
                <th className="px-4 py-3 text-left font-medium">Action</th>
                <th className="px-4 py-3 text-left font-medium">Rating</th>
                <th className="px-4 py-3 text-right font-medium">Price at Post</th>
                <th className="px-4 py-3 text-right font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={6} className="py-16 text-center text-slate-600 text-sm">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={6} className="py-16 text-center text-slate-600 text-sm">No ratings found</td></tr>
              ) : (
                filtered.map((item, i) => <RatingRow key={i} item={item} />)
              )}
            </tbody>
          </table>
        </div>

        {/* Pagination */}
        <div className="px-4 py-3 border-t border-white/[0.05] flex items-center justify-between text-xs text-slate-500">
          <span>{filtered.length} records · page {page + 1}</span>
          <div className="flex items-center gap-2">
            <button onClick={() => goPage(-1)} disabled={page === 0}
              className="p-1.5 rounded-lg hover:bg-white/[0.05] disabled:opacity-30 transition-colors">
              <ChevronLeft className="w-4 h-4" />
            </button>
            <button onClick={() => goPage(1)} disabled={data.ratings.length < 20}
              className="p-1.5 rounded-lg hover:bg-white/[0.05] disabled:opacity-30 transition-colors">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="text-[10px] text-slate-600 text-center">
        Source: FMP · Analyst ratings are third-party opinions · Not financial advice
      </div>
    </div>
  )
}
