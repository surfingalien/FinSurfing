import { useState, useEffect } from 'react'
import { PlusCircle, X, RefreshCw, Search, Star, PieChart, ChevronDown, ChevronUp } from 'lucide-react'
import { AreaChart, Area, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts'
import { fmt, fmtPct, fmtLarge, fmtVol, fetchChart } from '../../services/api'
import { ChangeBadge, LoadingPulse, EmptyState } from '../shared/StockCard'
import { searchSymbol } from '../../services/api'

function MiniSparkline({ symbol }) {
  const [data, setData] = useState(null)
  useEffect(() => {
    fetchChart(symbol, '1d', '1mo').then(d => {
      setData(d.candles.map(c => ({ v: c.close })))
    }).catch(() => {})
  }, [symbol])
  if (!data) return <div className="w-24 h-10 bg-white/[0.03] rounded animate-pulse" />
  const up = data.length > 1 && data[data.length-1].v >= data[0].v
  return (
    <ResponsiveContainer width={96} height={40}>
      <AreaChart data={data} margin={{ top: 2, right: 0, left: 0, bottom: 2 }}>
        <defs>
          <linearGradient id={`sg-${symbol}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={up ? '#10b981' : '#ef4444'} stopOpacity={0.4} />
            <stop offset="100%" stopColor={up ? '#10b981' : '#ef4444'} stopOpacity={0} />
          </linearGradient>
        </defs>
        <Area type="monotone" dataKey="v" stroke={up ? '#10b981' : '#ef4444'} strokeWidth={1.5} fill={`url(#sg-${symbol})`} dot={false} />
      </AreaChart>
    </ResponsiveContainer>
  )
}

const POPULAR_FUNDS = [
  { symbol: 'FXAIX', name: 'Fidelity 500 Index',            category: 'Large Blend'       },
  { symbol: 'VFIAX', name: 'Vanguard 500 Index Admiral',     category: 'Large Blend'       },
  { symbol: 'VTSAX', name: 'Vanguard Total Stock Market',    category: 'Total Market'      },
  { symbol: 'FSKAX', name: 'Fidelity Total Market Index',    category: 'Total Market'      },
  { symbol: 'FSELX', name: 'Fidelity Select Semiconductors', category: 'Sector - Tech'    },
  { symbol: 'FCNTX', name: 'Fidelity Contrafund',            category: 'Large Growth'      },
  { symbol: 'FDGRX', name: 'Fidelity Growth Company',        category: 'Large Growth'      },
  { symbol: 'PRGFX', name: 'T. Rowe Price Growth Stock',     category: 'Large Growth'      },
  { symbol: 'AGTHX', name: 'American Funds Growth Fund',     category: 'Large Growth'      },
  { symbol: 'PRWCX', name: 'T. Rowe Price Capital Apprec.', category: 'Moderate Alloc.'   },
  { symbol: 'TRBCX', name: 'T. Rowe Price Blue Chip Growth', category: 'Large Growth'     },
  { symbol: 'DODGX', name: 'Dodge & Cox Stock Fund',         category: 'Large Value'       },
]

export default function WatchlistView({ watchlist }) {
  const { quotes, loading, refresh, addSymbol, removeSymbol } = watchlist
  const [addQuery, setAddQuery] = useState('')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching] = useState(false)
  const [showSearch, setShowSearch] = useState(false)
  const [showFunds, setShowFunds] = useState(false)

  const handleSearch = async (q) => {
    setAddQuery(q)
    if (!q.trim()) { setSearchResults([]); return }
    setSearching(true)
    try {
      const r = await searchSymbol(q)
      setSearchResults(r)
    } catch {}
    setSearching(false)
  }

  const handleAdd = (sym) => {
    addSymbol(sym)
    setAddQuery('')
    setSearchResults([])
    setShowSearch(false)
  }

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Toolbar */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Star className="w-4 h-4 text-mint-400" />
          <h2 className="text-base font-semibold text-white">Watchlist</h2>
          <span className="text-xs text-slate-500">({quotes.length} stocks)</span>
        </div>
        <div className="flex gap-2">
          <button onClick={refresh} className="btn-ghost flex items-center gap-1.5 py-1.5 text-xs">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </button>
          <button onClick={() => setShowSearch(v => !v)} className="btn-primary flex items-center gap-1.5">
            <PlusCircle className="w-3.5 h-3.5" />
            Add
          </button>
          <button
            onClick={() => setShowFunds(v => !v)}
            className="btn-ghost flex items-center gap-1.5 py-1.5 text-xs text-teal-400 border border-teal-500/30 hover:bg-teal-500/10"
          >
            <PieChart className="w-3.5 h-3.5" />
            Mutual Funds
            {showFunds ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
          </button>
        </div>
      </div>

      {/* Search panel */}
      {showSearch && (
        <div className="glass rounded-xl p-4 animate-slide-up">
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input
              value={addQuery}
              onChange={e => handleSearch(e.target.value)}
              placeholder="Search symbol or company name…"
              className="input pl-9"
              autoFocus
            />
          </div>
          {searching && <div className="text-xs text-slate-500 mt-2 px-1">Searching…</div>}
          {searchResults.length > 0 && (
            <div className="mt-2 space-y-1">
              {searchResults.map(r => (
                <button
                  key={r.symbol}
                  onClick={() => handleAdd(r.symbol)}
                  className="w-full flex items-center gap-3 px-3 py-2.5 glass rounded-lg hover:bg-white/[0.08] text-left transition-colors"
                >
                  <span className="font-mono font-semibold text-mint-400 text-sm w-14 shrink-0">{r.symbol}</span>
                  <span className="text-sm text-slate-300 truncate flex-1">{r.name}</span>
                  <span className="text-xs text-slate-500">{r.exchange}</span>
                  <PlusCircle className="w-4 h-4 text-mint-400 shrink-0" />
                </button>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Mutual fund quick-add panel */}
      {showFunds && (
        <div className="glass rounded-xl p-4 animate-slide-up space-y-3">
          <div className="flex items-center gap-2 mb-1">
            <PieChart className="w-3.5 h-3.5 text-teal-400" />
            <span className="text-xs font-semibold text-teal-400">Popular Mutual Funds</span>
            <span className="text-[10px] text-slate-500 ml-1">Click to add to watchlist</span>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
            {POPULAR_FUNDS.map(fund => {
              const inList = quotes.some(q => q.symbol === fund.symbol)
              return (
                <button
                  key={fund.symbol}
                  onClick={() => !inList && addSymbol(fund.symbol)}
                  disabled={inList}
                  className={`flex items-center gap-3 px-3 py-2 rounded-lg text-left transition-all text-xs ${
                    inList
                      ? 'bg-teal-500/10 border border-teal-500/20 cursor-default'
                      : 'bg-white/[0.03] border border-white/[0.06] hover:bg-teal-500/10 hover:border-teal-500/20'
                  }`}
                >
                  <span className={`font-mono font-bold w-12 shrink-0 ${inList ? 'text-teal-400' : 'text-white'}`}>{fund.symbol}</span>
                  <span className="text-slate-400 truncate flex-1">{fund.name}</span>
                  <span className="text-[10px] text-slate-600 shrink-0">{fund.category}</span>
                  {inList
                    ? <span className="text-[10px] text-teal-400 shrink-0">✓</span>
                    : <PlusCircle className="w-3.5 h-3.5 text-teal-400/50 shrink-0" />
                  }
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* Watchlist cards */}
      {loading && !quotes.length ? (
        <div className="glass rounded-xl p-4"><LoadingPulse rows={6} /></div>
      ) : quotes.length === 0 ? (
        <EmptyState icon="⭐" title="Your watchlist is empty" subtitle="Add stocks to track them here" />
      ) : (
        <div className="glass rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-xs">
                  <th className="text-left px-4 py-3 text-slate-400 font-medium">Symbol</th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium">Price</th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium hidden sm:table-cell">Change</th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium hidden md:table-cell">Volume</th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium hidden lg:table-cell">Mkt Cap</th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium hidden lg:table-cell">52W Range</th>
                  <th className="text-center px-3 py-3 text-slate-400 font-medium hidden xl:table-cell">1M Trend</th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {quotes.map(q => (
                  <tr key={q.symbol} className="border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors group">
                    <td className="px-4 py-3">
                      <div className="font-semibold font-mono text-white">{q.symbol}</div>
                      <div className="text-xs text-slate-500 truncate max-w-[150px]">{q.name}</div>
                    </td>
                    <td className="px-3 py-3 text-right font-mono font-semibold text-white">
                      {q.price !== null ? `$${fmt(q.price)}` : '—'}
                    </td>
                    <td className="px-3 py-3 text-right hidden sm:table-cell">
                      <div className="flex flex-col items-end gap-0.5">
                        <ChangeBadge pct={q.changePct} />
                        <span className={`text-xs font-mono ${(q.change || 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                          {q.change !== null ? `${q.change >= 0 ? '+' : ''}$${fmt(Math.abs(q.change))}` : ''}
                        </span>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-slate-400 text-xs hidden md:table-cell">
                      {fmtVol(q.volume)}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-slate-400 text-xs hidden lg:table-cell">
                      {fmtLarge(q.marketCap)}
                    </td>
                    <td className="px-3 py-3 hidden lg:table-cell">
                      <div className="text-right">
                        <div className="text-xs font-mono text-slate-400">
                          ${fmt(q.low52)} – ${fmt(q.high52)}
                        </div>
                        {q.price !== null && q.low52 && q.high52 && (
                          <div className="mt-1 w-24 ml-auto bg-white/[0.06] rounded-full h-1">
                            <div
                              className="h-1 rounded-full bg-mint-500"
                              style={{ width: `${Math.min(100, Math.max(0, ((q.price - q.low52) / (q.high52 - q.low52)) * 100))}%` }}
                            />
                          </div>
                        )}
                      </div>
                    </td>
                    <td className="px-3 py-3 hidden xl:table-cell">
                      <div className="flex justify-center">
                        <MiniSparkline symbol={q.symbol} />
                      </div>
                    </td>
                    <td className="px-2 py-1">
                      <button
                        onClick={() => removeSymbol(q.symbol)}
                        aria-label={`Remove ${q.symbol} from watchlist`}
                        className="flex items-center justify-center min-h-[44px] min-w-[44px] text-slate-600 hover:text-red-400 focus-visible:text-red-400 transition-all rounded-lg hover:bg-red-500/10 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40 sm:opacity-0 sm:group-hover:opacity-100"
                      >
                        <X className="w-3.5 h-3.5" />
                      </button>
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
