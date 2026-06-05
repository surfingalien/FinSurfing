import { useState, useCallback } from 'react'
import { Filter, Search, AlertTriangle } from 'lucide-react'
import { getApiKeyHeaders, fmt } from '../../services/api'

// ── Constants ─────────────────────────────────────────────────────────────────

const SECTORS = [
  '', 'Technology', 'Healthcare', 'Financial Services', 'Consumer Cyclical',
  'Consumer Defensive', 'Energy', 'Industrials', 'Communication Services',
  'Real Estate', 'Basic Materials', 'Utilities',
]

const EXCHANGES = ['', 'NYSE', 'NASDAQ', 'AMEX']

const MARKET_CAP_PRESETS = [
  { label: 'Any',   min: '',              max: '' },
  { label: 'Mega',  min: '200000000000',  max: '' },
  { label: 'Large', min: '10000000000',   max: '200000000000' },
  { label: 'Mid',   min: '2000000000',    max: '10000000000' },
  { label: 'Small', min: '300000000',     max: '2000000000' },
  { label: 'Micro', min: '',              max: '300000000' },
]

const VOLUME_PRESETS = [
  { label: 'Any',  min: '' },
  { label: '100K', min: '100000' },
  { label: '500K', min: '500000' },
  { label: '1M',   min: '1000000' },
  { label: '5M',   min: '5000000' },
]

const TABS = ['Overview', 'Valuation', 'Technical']

function fmtCap(n) {
  if (!n) return '—'
  if (n >= 1e12) return `$${(n / 1e12).toFixed(1)}T`
  if (n >= 1e9)  return `$${(n / 1e9).toFixed(1)}B`
  if (n >= 1e6)  return `$${(n / 1e6).toFixed(0)}M`
  return `$${n.toLocaleString()}`
}

function chgColor(v) {
  return v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-slate-400'
}

// ── Column definitions per tab ─────────────────────────────────────────────────
function buildCols(onSelect) {
  return {
    Overview: [
      { key: 'symbol',      label: 'Symbol',   render: s => <button onClick={() => onSelect?.(s.symbol)} className="font-mono font-bold text-mint-400 hover:text-white transition-colors">{s.symbol}</button> },
      { key: 'companyName', label: 'Company',  render: s => <span className="text-xs text-slate-300 truncate max-w-[160px] block">{s.companyName || '—'}</span> },
      { key: 'sector',      label: 'Sector',   render: s => <span className="text-xs text-slate-400">{s.sector || '—'}</span> },
      { key: 'price',       label: 'Price',    right: true, render: s => <span className="font-mono text-white">{s.price != null ? `$${fmt(s.price)}` : '—'}</span> },
      { key: 'changes',     label: 'Chg%',     right: true, render: s => <span className={`font-mono font-semibold ${chgColor(s.changes)}`}>{s.changes != null ? `${s.changes > 0 ? '+' : ''}${fmt(s.changes)}%` : '—'}</span> },
      { key: 'marketCap',   label: 'Mkt Cap',  right: true, render: s => <span className="font-mono text-slate-300">{fmtCap(s.marketCap)}</span> },
      { key: 'volume',      label: 'Volume',   right: true, render: s => <span className="font-mono text-slate-400 text-xs">{s.volume ? (s.volume >= 1e6 ? `${(s.volume/1e6).toFixed(1)}M` : `${(s.volume/1e3).toFixed(0)}K`) : '—'}</span> },
    ],
    Valuation: [
      { key: 'symbol',      label: 'Symbol',   render: s => <button onClick={() => onSelect?.(s.symbol)} className="font-mono font-bold text-mint-400 hover:text-white transition-colors">{s.symbol}</button> },
      { key: 'companyName', label: 'Company',  render: s => <span className="text-xs text-slate-300 truncate max-w-[160px] block">{s.companyName || '—'}</span> },
      { key: 'price',       label: 'Price',    right: true, render: s => <span className="font-mono text-white">{s.price != null ? `$${fmt(s.price)}` : '—'}</span> },
      { key: 'marketCap',   label: 'Mkt Cap',  right: true, render: s => <span className="font-mono text-slate-300">{fmtCap(s.marketCap)}</span> },
      { key: 'beta',        label: 'Beta',     right: true, render: s => <span className="font-mono text-slate-400">{s.beta != null ? Number(s.beta).toFixed(2) : '—'}</span> },
      { key: 'lastAnnualDividend', label: 'Div ($)', right: true, render: s => <span className="font-mono text-slate-300">{s.lastAnnualDividend > 0 ? `$${Number(s.lastAnnualDividend).toFixed(2)}` : '—'}</span> },
      { key: 'exchange',    label: 'Exchange', right: true, render: s => <span className="text-xs text-slate-500">{s.exchangeShortName || s.exchange || '—'}</span> },
    ],
    Technical: [
      { key: 'symbol',    label: 'Symbol',   render: s => <button onClick={() => onSelect?.(s.symbol)} className="font-mono font-bold text-mint-400 hover:text-white transition-colors">{s.symbol}</button> },
      { key: 'companyName', label: 'Company', render: s => <span className="text-xs text-slate-300 truncate max-w-[160px] block">{s.companyName || '—'}</span> },
      { key: 'price',     label: 'Price',    right: true, render: s => <span className="font-mono text-white">{s.price != null ? `$${fmt(s.price)}` : '—'}</span> },
      { key: 'changes',   label: 'Chg%',     right: true, render: s => <span className={`font-mono font-semibold ${chgColor(s.changes)}`}>{s.changes != null ? `${s.changes > 0 ? '+' : ''}${fmt(s.changes)}%` : '—'}</span> },
      { key: 'volume',    label: 'Volume',   right: true, render: s => <span className="font-mono text-slate-400 text-xs">{s.volume ? (s.volume >= 1e6 ? `${(s.volume/1e6).toFixed(1)}M` : `${(s.volume/1e3).toFixed(0)}K`) : '—'}</span> },
      { key: 'beta',      label: 'Beta',     right: true, render: s => <span className={`font-mono ${s.beta > 1.5 ? 'text-amber-400' : 'text-slate-400'}`}>{s.beta != null ? Number(s.beta).toFixed(2) : '—'}</span> },
      { key: 'sector',    label: 'Sector',   render: s => <span className="text-xs text-slate-500">{s.sector || '—'}</span> },
    ],
  }
}

// ── Main Component ─────────────────────────────────────────────────────────────

export default function ScreenerView({ onSelectSymbol }) {
  const [results,    setResults]    = useState([])
  const [loading,    setLoading]    = useState(false)
  const [error,      setError]      = useState(null)
  const [hasLoaded,  setHasLoaded]  = useState(false)
  const [tab,        setTab]        = useState('Overview')
  const [sortBy,     setSortBy]     = useState('marketCap')
  const [sortDir,    setSortDir]    = useState(-1)

  // Filters
  const [sector,     setSector]     = useState('')
  const [exchange,   setExchange]   = useState('')
  const [capPreset,  setCapPreset]  = useState(0)
  const [priceMin,   setPriceMin]   = useState('')
  const [priceMax,   setPriceMax]   = useState('')
  const [volPreset,  setVolPreset]  = useState(0)
  const [betaMin,    setBetaMin]    = useState('')
  const [betaMax,    setBetaMax]    = useState('')
  const [dividendOn, setDividendOn] = useState(false)

  const run = useCallback(async () => {
    setLoading(true); setError(null)
    const cap = MARKET_CAP_PRESETS[capPreset]
    const vol = VOLUME_PRESETS[volPreset]
    const params = new URLSearchParams({ limit: 200 })
    if (sector)      params.set('sector', sector)
    if (exchange)    params.set('exchange', exchange)
    if (priceMin)    params.set('priceMin', priceMin)
    if (priceMax)    params.set('priceMax', priceMax)
    if (cap.min)     params.set('marketCapMin', cap.min)
    if (cap.max)     params.set('marketCapMax', cap.max)
    if (vol.min)     params.set('volumeMin', vol.min)
    if (betaMin)     params.set('betaMin', betaMin)
    if (betaMax)     params.set('betaMax', betaMax)
    if (dividendOn)  params.set('dividendMin', '0.01')
    try {
      const r    = await fetch(`/api/market-intel/screener?${params}`, { headers: getApiKeyHeaders() })
      const data = await r.json()
      if (!r.ok) throw new Error(data.error || 'Screener failed')
      setResults(Array.isArray(data) ? data : [])
      setHasLoaded(true)
    } catch (e) { setError(e.message) }
    setLoading(false)
  }, [sector, exchange, capPreset, priceMin, priceMax, volPreset, betaMin, betaMax, dividendOn])

  const handleSort = (key) => {
    if (sortBy === key) setSortDir(d => -d)
    else { setSortBy(key); setSortDir(-1) }
  }

  const sorted = [...results].sort((a, b) => {
    const va = a[sortBy] ?? (sortDir > 0 ? Infinity : -Infinity)
    const vb = b[sortBy] ?? (sortDir > 0 ? Infinity : -Infinity)
    return sortDir * (va > vb ? 1 : va < vb ? -1 : 0)
  })

  const cols = buildCols(onSelectSymbol)[tab] ?? buildCols(onSelectSymbol).Overview

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="p-2.5 rounded-xl bg-sky-500/10 border border-sky-500/20">
          <Filter className="w-5 h-5 text-sky-400" />
        </div>
        <div>
          <h1 className="text-xl font-bold text-white">Stock Screener</h1>
          <p className="text-xs text-slate-500">Live FMP screener · {hasLoaded ? `${results.length} results` : 'set filters and run'}</p>
        </div>
      </div>

      {/* Filter panel */}
      <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-5 space-y-4">
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-4 gap-4">

          <div>
            <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 block">Sector</label>
            <select value={sector} onChange={e => setSector(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500/40 transition-colors">
              {SECTORS.map(s => <option key={s} value={s}>{s || 'All Sectors'}</option>)}
            </select>
          </div>

          <div>
            <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 block">Exchange</label>
            <select value={exchange} onChange={e => setExchange(e.target.value)}
              className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-sky-500/40 transition-colors">
              {EXCHANGES.map(e => <option key={e} value={e}>{e || 'All Exchanges'}</option>)}
            </select>
          </div>

          <div>
            <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 block">Market Cap</label>
            <div className="flex gap-1 flex-wrap">
              {MARKET_CAP_PRESETS.map((p, i) => (
                <button key={i} onClick={() => setCapPreset(i)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all border ${
                    capPreset === i
                      ? 'bg-sky-500/20 border-sky-500/40 text-sky-300'
                      : 'bg-white/[0.03] border-white/[0.06] text-slate-500 hover:text-white'
                  }`}>{p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 block">Min Volume</label>
            <div className="flex gap-1 flex-wrap">
              {VOLUME_PRESETS.map((p, i) => (
                <button key={i} onClick={() => setVolPreset(i)}
                  className={`px-2.5 py-1 rounded-lg text-xs font-medium transition-all border ${
                    volPreset === i
                      ? 'bg-sky-500/20 border-sky-500/40 text-sky-300'
                      : 'bg-white/[0.03] border-white/[0.06] text-slate-500 hover:text-white'
                  }`}>{p.label}
                </button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 block">Price ($)</label>
            <div className="flex items-center gap-2">
              <input type="number" value={priceMin} onChange={e => setPriceMin(e.target.value)}
                placeholder="Min" min={0}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-sky-500/40" />
              <span className="text-slate-600 shrink-0">–</span>
              <input type="number" value={priceMax} onChange={e => setPriceMax(e.target.value)}
                placeholder="Max" min={0}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-sky-500/40" />
            </div>
          </div>

          <div>
            <label className="text-[10px] text-slate-500 uppercase tracking-wider mb-1.5 block">Beta</label>
            <div className="flex items-center gap-2">
              <input type="number" value={betaMin} onChange={e => setBetaMin(e.target.value)}
                placeholder="Min" min={0} step={0.1}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-sky-500/40" />
              <span className="text-slate-600 shrink-0">–</span>
              <input type="number" value={betaMax} onChange={e => setBetaMax(e.target.value)}
                placeholder="Max" min={0} step={0.1}
                className="w-full bg-white/[0.04] border border-white/[0.08] rounded-lg px-2.5 py-1.5 text-sm text-white font-mono focus:outline-none focus:border-sky-500/40" />
            </div>
          </div>

          <div className="flex items-end pb-0.5">
            <label className="flex items-center gap-2.5 cursor-pointer" onClick={() => setDividendOn(d => !d)}>
              <div className={`w-10 h-5 rounded-full border transition-all relative ${
                dividendOn ? 'bg-sky-500/40 border-sky-500/60' : 'bg-white/[0.05] border-white/[0.08]'
              }`}>
                <div className={`absolute top-0.5 w-4 h-4 rounded-full transition-all ${
                  dividendOn ? 'left-5 bg-sky-400' : 'left-0.5 bg-slate-500'
                }`} />
              </div>
              <span className="text-sm text-slate-400">Pays dividend</span>
            </label>
          </div>
        </div>

        <div className="flex items-center gap-3 pt-1">
          <button onClick={run} disabled={loading}
            className="flex items-center gap-2 px-5 py-2.5 bg-sky-500 hover:bg-sky-400 disabled:opacity-50 text-white text-sm font-semibold rounded-xl transition-colors">
            <Search className="w-4 h-4" />
            {loading ? 'Scanning…' : 'Run Screener'}
          </button>
          <button onClick={() => {
            setSector(''); setExchange(''); setCapPreset(0)
            setPriceMin(''); setPriceMax('')
            setVolPreset(0); setBetaMin(''); setBetaMax(''); setDividendOn(false)
          }} className="text-xs text-slate-500 hover:text-white transition-colors">
            Reset
          </button>
          {hasLoaded && <span className="text-xs text-slate-600 ml-auto">{results.length} results</span>}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" /> {error}
        </div>
      )}

      {hasLoaded && (
        <>
          <div className="flex items-center gap-1 border-b border-white/[0.06] pb-0">
            {TABS.map(t => (
              <button key={t} onClick={() => setTab(t)}
                className={`px-4 py-2.5 text-sm font-medium border-b-2 -mb-px transition-all ${
                  tab === t ? 'border-sky-500 text-sky-400' : 'border-transparent text-slate-400 hover:text-white'
                }`}>{t}
              </button>
            ))}
          </div>

          <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-white/[0.03] text-slate-500 text-xs">
                  <tr>
                    {cols.map(col => (
                      <th key={col.key} onClick={() => handleSort(col.key)}
                        className={`px-4 py-3 font-medium cursor-pointer hover:text-white transition-colors select-none ${col.right ? 'text-right' : 'text-left'}`}>
                        {col.label}
                        {sortBy === col.key && <span className="ml-0.5 text-sky-400">{sortDir > 0 ? '↑' : '↓'}</span>}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sorted.length === 0 ? (
                    <tr><td colSpan={cols.length} className="py-16 text-center text-slate-600">No results matched your filters</td></tr>
                  ) : sorted.map(s => (
                    <tr key={s.symbol} className="border-t border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                      {cols.map(col => (
                        <td key={col.key} className={`px-4 py-3 ${col.right ? 'text-right' : ''}`}>
                          {col.render(s)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {!hasLoaded && !loading && (
        <div className="text-center py-16 text-slate-600 text-sm">
          Set filters above and click <span className="text-white font-semibold">Run Screener</span>
        </div>
      )}
    </div>
  )
}
