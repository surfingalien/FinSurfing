import { useState, useCallback, useEffect } from 'react'
import {
  TrendingUp, Search, Loader2, ExternalLink, ChevronRight,
  BarChart2, RefreshCw, AlertTriangle,
} from 'lucide-react'

const FINANCE_TAGS = [
  { slug: '',          label: 'Trending' },
  { slug: 'crypto',    label: 'Crypto' },
  { slug: 'finance',   label: 'Finance' },
  { slug: 'politics',  label: 'Politics' },
  { slug: 'science',   label: 'Science & Tech' },
  { slug: 'sports',    label: 'Sports' },
]

// Map common portfolio symbols → useful Polymarket search terms
const SYMBOL_HINTS = {
  'BTC-USD': 'Bitcoin', 'ETH-USD': 'Ethereum', 'SOL-USD': 'Solana',
  'BNB-USD': 'BNB', 'XRP-USD': 'XRP', 'DOGE-USD': 'Dogecoin',
  'NVDA': 'Nvidia', 'AAPL': 'Apple', 'TSLA': 'Tesla', 'MSFT': 'Microsoft',
  'AMZN': 'Amazon', 'GOOG': 'Google', 'META': 'Meta', 'AMD': 'AMD',
}

// ── Probability bar ───────────────────────────────────────────────────────────
function ProbBar({ yesPct, outcomes, prices }) {
  if (yesPct == null) return null
  const noLabel  = outcomes?.[1] || 'No'
  const yesLabel = outcomes?.[0] || 'Yes'
  const isMulti  = outcomes?.length > 2

  if (isMulti) {
    return (
      <div className="space-y-1 mt-2">
        {outcomes.slice(0, 4).map((o, i) => {
          const pct = prices?.[i] != null ? Math.round(prices[i] * 100) : 0
          return (
            <div key={i} className="flex items-center gap-2">
              <span className="text-[10px] text-slate-500 w-20 truncate">{o}</span>
              <div className="flex-1 h-1.5 bg-slate-700 rounded-full overflow-hidden">
                <div className="h-full bg-violet-500/70 rounded-full" style={{ width: `${pct}%` }} />
              </div>
              <span className="text-[10px] font-mono text-slate-400 w-8 text-right">{pct}%</span>
            </div>
          )
        })}
      </div>
    )
  }

  const clr = yesPct >= 60 ? 'bg-emerald-500' : yesPct >= 40 ? 'bg-amber-500' : 'bg-red-500'
  return (
    <div className="mt-2">
      <div className="flex justify-between text-[10px] text-slate-500 mb-1">
        <span>{yesLabel}</span>
        <span>{noLabel}</span>
      </div>
      <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
        <div className={`h-full ${clr} rounded-full transition-all`} style={{ width: `${yesPct}%` }} />
      </div>
      <div className="flex justify-between text-[10px] font-mono mt-0.5">
        <span className={yesPct >= 50 ? 'text-emerald-400 font-bold' : 'text-slate-500'}>{yesPct}%</span>
        <span className={yesPct < 50 ? 'text-red-400 font-bold' : 'text-slate-500'}>{100 - yesPct}%</span>
      </div>
    </div>
  )
}

// ── Market card ───────────────────────────────────────────────────────────────
function MarketCard({ market }) {
  const daysLeft = market.endDate
    ? Math.ceil((new Date(market.endDate) - Date.now()) / 86400000)
    : null

  const fmtVol = (v) => {
    if (v >= 1_000_000) return `$${(v / 1_000_000).toFixed(1)}M`
    if (v >= 1_000)     return `$${(v / 1_000).toFixed(0)}K`
    return `$${v.toFixed(0)}`
  }

  return (
    <div className="rounded-xl bg-slate-800/50 border border-slate-700/50 p-4 hover:border-violet-500/30 transition-colors">
      <div className="flex items-start justify-between gap-2 mb-2">
        <p className="text-sm text-slate-200 leading-snug flex-1">{market.question}</p>
        <a
          href={market.url} target="_blank" rel="noreferrer"
          className="flex-shrink-0 text-slate-600 hover:text-violet-400 transition-colors mt-0.5"
          title="Open on Polymarket"
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </a>
      </div>

      <ProbBar yesPct={market.yesPct} outcomes={market.outcomes} prices={market.prices} />

      <div className="flex items-center gap-3 mt-3 pt-2.5 border-t border-slate-700/40 text-[10px] text-slate-500">
        <span className="flex items-center gap-1">
          <BarChart2 className="w-3 h-3" /> {fmtVol(market.volume)} vol
        </span>
        {daysLeft != null && (
          <span className={daysLeft <= 7 ? 'text-amber-500' : ''}>
            {daysLeft > 0 ? `${daysLeft}d left` : 'Resolving'}
          </span>
        )}
        {market.tags?.length > 0 && (
          <span className="ml-auto text-slate-600">{market.tags[0]}</span>
        )}
      </div>
    </div>
  )
}

// ── Symbol search pill (from portfolio) ──────────────────────────────────────
function SymbolPill({ symbol, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`px-3 py-1 rounded-full text-xs font-mono font-bold border transition-colors ${
        active
          ? 'border-violet-500/60 bg-violet-500/15 text-violet-300'
          : 'border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-300'
      }`}
    >
      {symbol}
    </button>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────
export default function PolymarketView({ portfolio }) {
  const [activeTag, setActiveTag]       = useState('')
  const [searchQuery, setSearchQuery]   = useState('')
  const [markets, setMarkets]           = useState([])
  const [loading, setLoading]           = useState(false)
  const [error, setError]               = useState(null)
  const [mode, setMode]                 = useState('browse')  // 'browse' | 'search'

  const apiBase = import.meta.env.VITE_API_URL || ''

  // Portfolio symbols with Polymarket hints
  const portfolioSymbols = (portfolio?.positions || [])
    .map(p => p.symbol)
    .filter(s => SYMBOL_HINTS[s] || s.length <= 5)
    .slice(0, 12)

  // ── Browse by tag ────────────────────────────────────────────────────────────
  const browseTag = useCallback(async (tag) => {
    setActiveTag(tag); setMode('browse'); setError(null); setLoading(true)
    try {
      const params = new URLSearchParams({ limit: 24 })
      if (tag) params.set('tag', tag)
      const res  = await fetch(`${apiBase}/api/polymarket/markets?${params}`, { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load markets')
      setMarkets(data.markets || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [apiBase])

  // ── Search ───────────────────────────────────────────────────────────────────
  const doSearch = useCallback(async (q) => {
    const query = (q ?? searchQuery).trim()
    if (!query) return
    setMode('search'); setError(null); setLoading(true)
    try {
      const res  = await fetch(`${apiBase}/api/polymarket/search?q=${encodeURIComponent(query)}&limit=20`, { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Search failed')
      setMarkets(data.markets || [])
    } catch (e) { setError(e.message) }
    finally { setLoading(false) }
  }, [searchQuery, apiBase])

  const searchSymbol = (symbol) => {
    const q = SYMBOL_HINTS[symbol] || symbol
    setSearchQuery(q)
    doSearch(q)
  }

  // Load trending on mount
  useEffect(() => { browseTag('') }, []) // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="space-y-5 max-w-4xl mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-emerald-500/15 border border-emerald-500/25">
          <TrendingUp className="w-5 h-5 text-emerald-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-slate-100">Polymarket Sentiment</h2>
          <p className="text-xs text-slate-500">Prediction market probabilities · powered by Polymarket</p>
        </div>
        <button
          onClick={() => mode === 'search' ? doSearch() : browseTag(activeTag)}
          disabled={loading}
          className="ml-auto flex items-center gap-1.5 text-xs text-slate-500 hover:text-slate-300 transition-colors disabled:opacity-40"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {/* ── Search bar ─────────────────────────────────────────────────────── */}
      <div className="flex gap-2">
        <input
          value={searchQuery}
          onChange={e => setSearchQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && doSearch()}
          placeholder="Search markets… e.g. Bitcoin, Fed rate, NVDA earnings"
          className="flex-1 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-emerald-500 transition-colors"
        />
        <button
          onClick={() => doSearch()}
          disabled={loading || !searchQuery.trim()}
          className="px-4 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white text-sm font-medium transition-colors flex items-center gap-1.5"
        >
          {loading && mode === 'search'
            ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
            : <Search className="w-3.5 h-3.5" />}
          Search
        </button>
      </div>

      {/* ── Portfolio symbol pills ─────────────────────────────────────────── */}
      {portfolioSymbols.length > 0 && (
        <div className="flex flex-wrap gap-1.5 items-center">
          <span className="text-[10px] text-slate-600 uppercase tracking-wider">My holdings:</span>
          {portfolioSymbols.map(s => (
            <SymbolPill
              key={s}
              symbol={s}
              active={searchQuery === (SYMBOL_HINTS[s] || s)}
              onClick={() => searchSymbol(s)}
            />
          ))}
        </div>
      )}

      {/* ── Category tabs ──────────────────────────────────────────────────── */}
      <div className="flex gap-1 border-b border-slate-700/50">
        {FINANCE_TAGS.map(t => (
          <button
            key={t.slug}
            onClick={() => { setSearchQuery(''); browseTag(t.slug) }}
            className={`px-3 py-2 text-xs font-medium border-b-2 transition-colors ${
              mode === 'browse' && activeTag === t.slug
                ? 'border-emerald-500 text-emerald-400'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Error ──────────────────────────────────────────────────────────── */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* ── Loading skeleton ───────────────────────────────────────────────── */}
      {loading && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="rounded-xl bg-slate-800/40 border border-slate-700/30 p-4 animate-pulse">
              <div className="h-3 bg-slate-700 rounded w-3/4 mb-2" />
              <div className="h-3 bg-slate-700 rounded w-1/2 mb-4" />
              <div className="h-2 bg-slate-700 rounded-full" />
            </div>
          ))}
        </div>
      )}

      {/* ── Markets grid ───────────────────────────────────────────────────── */}
      {!loading && markets.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {markets.map(m => <MarketCard key={m.id || m.conditionId || m.slug} market={m} />)}
        </div>
      )}

      {!loading && markets.length === 0 && !error && (
        <div className="text-center py-12 text-slate-600">
          <TrendingUp className="w-8 h-8 mx-auto mb-3 opacity-20" />
          <p className="text-sm">No markets found</p>
          <p className="text-xs mt-1">Try a different keyword or category</p>
        </div>
      )}

      {/* ── Footer note ────────────────────────────────────────────────────── */}
      {markets.length > 0 && (
        <p className="text-center text-[10px] text-slate-700">
          Data from{' '}
          <a href="https://polymarket.com" target="_blank" rel="noreferrer" className="hover:text-slate-500 transition-colors">
            Polymarket
          </a>
          {' '}· Prices are crowd-sourced probabilities, not financial advice
        </p>
      )}
    </div>
  )
}
