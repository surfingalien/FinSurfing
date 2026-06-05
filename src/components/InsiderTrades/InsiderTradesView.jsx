import { useState, useEffect, useCallback } from 'react'
import { Users, Search, RefreshCw, TrendingUp, TrendingDown, AlertTriangle, ChevronLeft, ChevronRight } from 'lucide-react'
import { getApiKeyHeaders } from '../../services/api'

const TRANSACTION_LABELS = {
  'P-Purchase':          { label: 'Purchase',    color: 'text-emerald-400', bg: 'bg-emerald-500/10', border: 'border-emerald-500/20' },
  'S-Sale':              { label: 'Sale',         color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/20' },
  'A-Award':             { label: 'Award',        color: 'text-indigo-400',  bg: 'bg-indigo-500/10',  border: 'border-indigo-500/20' },
  'S-Sale+OE':           { label: 'Sale (OE)',    color: 'text-red-400',     bg: 'bg-red-500/10',     border: 'border-red-500/20' },
  'M-Exempt':            { label: 'Exempt',       color: 'text-slate-400',   bg: 'bg-slate-500/10',   border: 'border-slate-500/20' },
  'G-Gift':              { label: 'Gift',         color: 'text-amber-400',   bg: 'bg-amber-500/10',   border: 'border-amber-500/20' },
  'F-InKind':            { label: 'In-Kind',      color: 'text-slate-400',   bg: 'bg-slate-500/10',   border: 'border-slate-500/20' },
}

function txStyle(type) {
  return TRANSACTION_LABELS[type] ?? { label: type ?? '—', color: 'text-slate-400', bg: 'bg-slate-500/10', border: 'border-slate-500/20' }
}

function fmtVal(n) {
  if (!n && n !== 0) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e9)  return `$${(abs / 1e9).toFixed(1)}B`
  if (abs >= 1e6)  return `$${(abs / 1e6).toFixed(1)}M`
  if (abs >= 1e3)  return `$${(abs / 1e3).toFixed(0)}K`
  return `$${abs.toFixed(0)}`
}

function fmtShares(n) {
  if (!n && n !== 0) return '—'
  const abs = Math.abs(n)
  if (abs >= 1e6) return `${(abs / 1e6).toFixed(2)}M`
  if (abs >= 1e3) return `${(abs / 1e3).toFixed(1)}K`
  return abs.toLocaleString()
}

function InsiderRow({ trade }) {
  const tx   = txStyle(trade.transactionType)
  const val  = trade.securitiesTransacted && trade.price
    ? trade.securitiesTransacted * trade.price : null

  return (
    <tr className="border-t border-white/[0.04] hover:bg-white/[0.02] transition-colors">
      <td className="px-4 py-3">
        <span className="font-mono font-bold text-white text-sm">{trade.symbol}</span>
      </td>
      <td className="px-4 py-3">
        <div className="text-xs text-white font-medium truncate max-w-[140px]">{trade.reportingName || '—'}</div>
        <div className="text-[10px] text-slate-500 capitalize">{(trade.typeOfOwner || '').replace(/_/g, ' ')}</div>
      </td>
      <td className="px-4 py-3">
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${tx.color} ${tx.bg} ${tx.border}`}>
          {tx.label.startsWith('S') ? <TrendingDown className="w-3 h-3" /> : <TrendingUp className="w-3 h-3" />}
          {tx.label}
        </span>
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs text-slate-300">
        {fmtShares(trade.securitiesTransacted)}
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs text-slate-300">
        {trade.price ? `$${Number(trade.price).toFixed(2)}` : '—'}
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs text-slate-300">
        {fmtVal(val)}
      </td>
      <td className="px-4 py-3 text-right font-mono text-xs text-slate-500">
        {trade.transactionDate || trade.filingDate || '—'}
      </td>
    </tr>
  )
}

export default function InsiderTradesView() {
  const [symbol,  setSymbol]  = useState('')
  const [input,   setInput]   = useState('')
  const [trades,  setTrades]  = useState([])
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)
  const [page,    setPage]    = useState(0)
  const [filter,  setFilter]  = useState('all')  // 'all' | 'buy' | 'sell'

  const load = useCallback(async (sym, pg = 0) => {
    setLoading(true); setError(null)
    try {
      const params = new URLSearchParams({ page: pg, limit: 50 })
      if (sym) params.set('symbol', sym)
      const r    = await fetch(`/api/market-intel/insider?${params}`, { headers: getApiKeyHeaders() })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Failed to load insider trades')
      setTrades(data)
    } catch (e) { setError(e.message) }
    setLoading(false)
  }, [])

  useEffect(() => { load('', 0) }, [load])

  const search = () => {
    const sym = input.trim().toUpperCase()
    setSymbol(sym); setPage(0)
    load(sym, 0)
  }

  const goPage = (dir) => {
    const next = page + dir
    if (next < 0) return
    setPage(next)
    load(symbol, next)
  }

  const filtered = trades.filter(t => {
    if (filter === 'buy')  return t.transactionType === 'P-Purchase'
    if (filter === 'sell') return t.transactionType === 'S-Sale' || t.transactionType === 'S-Sale+OE'
    return true
  })

  const buys  = trades.filter(t => t.transactionType === 'P-Purchase').length
  const sells = trades.filter(t => t.transactionType?.startsWith('S-')).length

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-emerald-500/10 border border-emerald-500/20">
          <Users className="w-5 h-5 text-emerald-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Insider Trades</h1>
          <p className="text-xs text-slate-500">SEC Form 4 · Officer &amp; director buy/sell activity</p>
        </div>
      </div>

      {/* Search + filter bar */}
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
        <button onClick={search} className="px-4 py-2 bg-emerald-500/80 hover:bg-emerald-400 text-white text-sm font-semibold rounded-xl transition-colors">
          Search
        </button>
        {symbol && (
          <button onClick={() => { setSymbol(''); setInput(''); setPage(0); load('', 0) }}
            className="text-xs text-slate-500 hover:text-white transition-colors">
            × Clear
          </button>
        )}

        {/* Buy/sell filter */}
        <div className="flex items-center gap-1 ml-auto">
          {[
            { id: 'all',  label: 'All' },
            { id: 'buy',  label: `Buys (${buys})` },
            { id: 'sell', label: `Sells (${sells})` },
          ].map(f => (
            <button key={f.id} onClick={() => setFilter(f.id)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                filter === f.id ? 'bg-white/10 text-white' : 'text-slate-500 hover:text-white'
              }`}>{f.label}</button>
          ))}
        </div>

        <button onClick={() => { setPage(0); load(symbol, 0) }} disabled={loading}
          className="p-2 rounded-lg text-slate-500 hover:text-white hover:bg-white/[0.05] transition-colors disabled:opacity-40">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

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
                <th className="px-4 py-3 text-left font-medium">Insider</th>
                <th className="px-4 py-3 text-left font-medium">Type</th>
                <th className="px-4 py-3 text-right font-medium">Shares</th>
                <th className="px-4 py-3 text-right font-medium">Price</th>
                <th className="px-4 py-3 text-right font-medium">Value</th>
                <th className="px-4 py-3 text-right font-medium">Date</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr><td colSpan={7} className="py-16 text-center text-slate-600 text-sm">Loading…</td></tr>
              ) : filtered.length === 0 ? (
                <tr><td colSpan={7} className="py-16 text-center text-slate-600 text-sm">No trades found</td></tr>
              ) : (
                filtered.map((t, i) => <InsiderRow key={i} trade={t} />)
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
            <button onClick={() => goPage(1)} disabled={filtered.length < 50}
              className="p-1.5 rounded-lg hover:bg-white/[0.05] disabled:opacity-30 transition-colors">
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        </div>
      </div>

      <div className="text-[10px] text-slate-600 text-center">
        Source: SEC Form 4 via FMP · Filings may lag 2–4 business days · Not financial advice
      </div>
    </div>
  )
}
