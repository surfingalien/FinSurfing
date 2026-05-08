import { useState, useEffect } from 'react'
import { Filter, RefreshCw, TrendingUp, TrendingDown } from 'lucide-react'
import { fetchQuotes, fmt, fmtPct, fmtLarge } from '../../services/api'
import { ChangeBadge, LoadingPulse } from '../shared/StockCard'
import { SCREENER_UNIVERSE } from '../../data/portfolio'

const SECTORS = ['All', 'Technology', 'Consumer Cyclical', 'Consumer Defensive', 'Communication Services', 'Financial Services', 'Financials', 'Energy', 'Health Care']
const SORT_COLS = [
  { key: 'price', label: 'Price' },
  { key: 'changePct', label: 'Change %' },
  { key: 'marketCap', label: 'Mkt Cap' },
  { key: 'pe', label: 'P/E' },
  { key: 'volume', label: 'Volume' },
]

export default function ScreenerView({ onSelectSymbol }) {
  const [stocks, setStocks] = useState(SCREENER_UNIVERSE)
  const [quotes, setQuotes] = useState({})
  const [loading, setLoading] = useState(false)
  const [sector, setSector] = useState('All')
  const [sortBy, setSortBy] = useState('marketCap')
  const [sortDir, setSortDir] = useState(-1)
  const [minPrice, setMinPrice] = useState('')
  const [maxPrice, setMaxPrice] = useState('')
  const [minPE, setMinPE] = useState('')
  const [maxPE, setMaxPE] = useState('')
  const [signal, setSignal] = useState('All')

  useEffect(() => {
    const load = async () => {
      setLoading(true)
      try {
        const symbols = SCREENER_UNIVERSE.map(s => s.symbol)
        const results = await fetchQuotes(symbols)
        const map = {}
        results.forEach(q => { map[q.symbol] = q })
        setQuotes(map)
      } catch (e) { console.warn(e) }
      setLoading(false)
    }
    load()
  }, [])

  const enriched = stocks.map(s => ({ ...s, ...(quotes[s.symbol] || {}) }))

  const filtered = enriched
    .filter(s => sector === 'All' || s.sector === sector)
    .filter(s => !minPrice || (s.price || 0) >= parseFloat(minPrice))
    .filter(s => !maxPrice || (s.price || 0) <= parseFloat(maxPrice))
    .filter(s => !minPE || (s.pe || 0) >= parseFloat(minPE))
    .filter(s => !maxPE || (s.pe || s.pe === null ? true : s.pe <= parseFloat(maxPE)))
    .sort((a, b) => {
      const va = a[sortBy] ?? (sortDir > 0 ? Infinity : -Infinity)
      const vb = b[sortBy] ?? (sortDir > 0 ? Infinity : -Infinity)
      return sortDir * (va > vb ? 1 : va < vb ? -1 : 0)
    })

  const handleSort = (col) => {
    if (sortBy === col) setSortDir(d => -d)
    else { setSortBy(col); setSortDir(-1) }
  }

  const SortBtn = ({ col, label }) => (
    <button onClick={() => handleSort(col)} className="text-slate-400 hover:text-white transition-colors whitespace-nowrap">
      {label}
      {sortBy === col && <span className="ml-0.5 text-mint-400">{sortDir > 0 ? '↑' : '↓'}</span>}
    </button>
  )

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Filters */}
      <div className="glass rounded-xl p-4">
        <div className="flex items-center gap-2 mb-3">
          <Filter className="w-4 h-4 text-mint-400" />
          <h3 className="text-sm font-semibold text-white">Filters</h3>
          {loading && <RefreshCw className="w-3.5 h-3.5 animate-spin text-slate-500 ml-auto" />}
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-5 gap-3">
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Sector</label>
            <select value={sector} onChange={e => setSector(e.target.value)} className="input text-xs">
              {SECTORS.map(s => <option key={s} value={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Min Price ($)</label>
            <input value={minPrice} onChange={e => setMinPrice(e.target.value)} placeholder="0" type="number" className="input text-xs" />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Max Price ($)</label>
            <input value={maxPrice} onChange={e => setMaxPrice(e.target.value)} placeholder="Any" type="number" className="input text-xs" />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Min P/E</label>
            <input value={minPE} onChange={e => setMinPE(e.target.value)} placeholder="0" type="number" className="input text-xs" />
          </div>
          <div>
            <label className="text-xs text-slate-400 mb-1 block">Max P/E</label>
            <input value={maxPE} onChange={e => setMaxPE(e.target.value)} placeholder="Any" type="number" className="input text-xs" />
          </div>
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs text-slate-500">
        <span>{filtered.length} results</span>
      </div>

      {/* Table */}
      {loading && !Object.keys(quotes).length ? (
        <div className="glass rounded-xl p-4"><LoadingPulse rows={8} /></div>
      ) : (
        <div className="glass rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-xs">
                  <th className="text-left px-4 py-3 text-slate-400 font-medium">Symbol</th>
                  <th className="text-left px-3 py-3 text-slate-400 font-medium hidden md:table-cell">Sector</th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium"><SortBtn col="price" label="Price" /></th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium"><SortBtn col="changePct" label="Change %" /></th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium hidden sm:table-cell"><SortBtn col="marketCap" label="Mkt Cap" /></th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium hidden lg:table-cell"><SortBtn col="pe" label="P/E" /></th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium hidden xl:table-cell"><SortBtn col="volume" label="Volume" /></th>
                  <th className="px-3 py-3" />
                </tr>
              </thead>
              <tbody>
                {filtered.map(s => (
                  <tr key={s.symbol} className="border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors cursor-pointer"
                    onClick={() => onSelectSymbol?.(s.symbol)}>
                    <td className="px-4 py-3">
                      <div className="font-semibold font-mono text-white">{s.symbol}</div>
                      <div className="text-xs text-slate-500 truncate max-w-[120px]">{s.name}</div>
                    </td>
                    <td className="px-3 py-3 hidden md:table-cell">
                      <span className="text-xs text-slate-400">{s.sector}</span>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-white font-medium">
                      {s.price ? `$${fmt(s.price)}` : '—'}
                    </td>
                    <td className="px-3 py-3 text-right"><ChangeBadge pct={s.changePct} /></td>
                    <td className="px-3 py-3 text-right font-mono text-slate-400 text-xs hidden sm:table-cell">
                      {s.marketCap ? fmtLarge(s.marketCap) : s.mktCap ? fmtLarge(s.mktCap) : '—'}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-slate-400 text-xs hidden lg:table-cell">
                      {(s.pe || s.pe === null) ? (s.pe ? fmt(s.pe) + '×' : '—') : '—'}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-slate-400 text-xs hidden xl:table-cell">
                      {s.volume ? (s.volume >= 1e6 ? (s.volume / 1e6).toFixed(1) + 'M' : s.volume.toLocaleString()) : '—'}
                    </td>
                    <td className="px-3 py-3">
                      <button className="text-xs text-mint-400 hover:text-mint-300 font-medium">Analyze →</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  )
}
