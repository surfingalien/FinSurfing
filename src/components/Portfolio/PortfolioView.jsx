import { useState, useRef, useEffect } from 'react'
import { PlusCircle, RefreshCw, TrendingUp, TrendingDown, Trash2, Edit3, Upload } from 'lucide-react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, AreaChart, Area, XAxis, YAxis } from 'recharts'
import { fmt, fmtPct, fmtLarge } from '../../services/api'
import { ChangeBadge, SectionCard, LoadingPulse } from '../shared/StockCard'
import AddStockModal from './AddStockModal'
import ImportModal from './ImportModal'

const SECTOR_COLORS = {
  'Technology': '#6366f1',
  'Consumer Cyclical': '#f59e0b',
  'Consumer Defensive': '#10b981',
  'Communication Services': '#3b82f6',
  'Financial Services': '#8b5cf6',
  'Financials': '#8b5cf6',
  'Energy': '#f97316',
  'Health Care': '#ec4899',
  'Industrials': '#64748b',
  'Materials': '#a16207',
  'Real Estate': '#0891b2',
  'Utilities': '#059669',
}

const COLORS = ['#00ffcc','#6366f1','#f59e0b','#3b82f6','#ec4899','#10b981','#f97316','#8b5cf6','#64748b','#a16207']

// Flashes green/red for 800ms whenever `value` changes (price tick from SSE stream)
function useFlash(value) {
  const prev = useRef(value)
  const [cls, setCls] = useState('')
  useEffect(() => {
    if (prev.current == null || value == null || value === prev.current) {
      prev.current = value
      return
    }
    setCls(value > prev.current ? 'flash-up' : 'flash-down')
    prev.current = value
    const t = setTimeout(() => setCls(''), 800)
    return () => clearTimeout(t)
  }, [value])
  return cls
}

function FlashPrice({ price, className = '' }) {
  const flash = useFlash(price)
  if (price == null) return <span className="text-white">—</span>
  return <span className={`${className} ${flash}`}>${fmt(price)}</span>
}

function FlashPnL({ value, className = '' }) {
  const flash = useFlash(value)
  if (value == null) return <span className="text-slate-600">—</span>
  const color = value >= 0 ? 'text-emerald-400' : 'text-red-400'
  return (
    <span className={`${color} ${className} ${flash}`}>
      {value >= 0 ? '+' : ''}${fmt(Math.abs(value))}
    </span>
  )
}

function SummaryCard({ label, value, sub, up }) {
  return (
    <div className="glass-card">
      <div className="stat-label mb-1">{label}</div>
      <div className={`stat-value mono ${up === true ? 'text-emerald-400' : up === false ? 'text-red-400' : 'text-white'}`}>
        {value}
      </div>
      {sub && <div className="text-xs text-slate-500 mt-0.5">{sub}</div>}
    </div>
  )
}

function EditPositionModal({ pos, onSave, onClose }) {
  const [shares,  setShares]  = useState(String(pos.shares))
  const [avgCost, setAvgCost] = useState(String(pos.avgCost))
  const canSave = !!(parseFloat(shares) > 0 && parseFloat(avgCost) >= 0)

  const handleSave = () => {
    if (!canSave) return
    onSave(pos.symbol, { shares: parseFloat(shares), avgCost: parseFloat(avgCost) })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" onClick={onClose} />
      <div className="relative glass rounded-2xl p-6 w-full max-w-sm space-y-4 border border-white/[0.1]">
        <div className="flex items-center justify-between">
          <h2 className="text-base font-semibold text-white">Edit {pos.symbol}</h2>
          <button onClick={onClose} className="text-slate-500 hover:text-white text-lg leading-none">×</button>
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1.5 block">Shares / Units</label>
          <input type="number" min="0.001" step="0.001" value={shares}
            onChange={e => setShares(e.target.value)} className="input" />
        </div>
        <div>
          <label className="text-xs text-slate-400 mb-1.5 block">Avg Cost Basis (per share)</label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-500 text-sm">$</span>
            <input type="number" min="0" step="0.01" value={avgCost}
              onChange={e => setAvgCost(e.target.value)} className="input pl-7" />
          </div>
        </div>
        {canSave && (
          <div className="glass rounded-lg px-4 py-2.5 text-sm flex justify-between text-slate-400">
            <span>Total Cost Basis</span>
            <span className="font-mono text-white font-semibold">
              ${(parseFloat(shares) * parseFloat(avgCost)).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
          </div>
        )}
        <div className="flex gap-3 pt-1">
          <button onClick={onClose} className="btn-ghost flex-1">Cancel</button>
          <button onClick={handleSave} disabled={!canSave}
            className="btn-primary flex-1 disabled:opacity-40 disabled:cursor-not-allowed">
            Save Changes
          </button>
        </div>
      </div>
    </div>
  )
}

export default function PortfolioView({ portfolio, portfolioId, authFetch }) {
  const { positions, loading, refresh, addPosition, removePosition, updatePosition, summary } = portfolio
  const [showAdd,    setShowAdd]    = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [editPos,    setEditPos]    = useState(null)
  const [sortBy, setSortBy] = useState('mktValue')
  const [sortDir, setSortDir] = useState(-1)
  const [selectedTab, setSelectedTab] = useState('holdings')

  const sorted = [...positions].sort((a, b) => {
    const va = a[sortBy] ?? -Infinity
    const vb = b[sortBy] ?? -Infinity
    return sortDir * (va > vb ? 1 : va < vb ? -1 : 0)
  })

  const sectorAlloc = positions.reduce((acc, p) => {
    const sector = p.sector || 'Other'
    const val = p.mktValue ?? p.costBasis
    acc[sector] = (acc[sector] || 0) + val
    return acc
  }, {})
  const pieData = Object.entries(sectorAlloc).map(([name, value]) => ({ name, value }))

  const stockAlloc = [...positions]
    .sort((a, b) => (b.mktValue ?? 0) - (a.mktValue ?? 0))
    .slice(0, 10)
    .map(p => ({ name: p.symbol, value: p.mktValue ?? p.costBasis }))

  const handleSort = (col) => {
    if (sortBy === col) setSortDir(d => -d)
    else { setSortBy(col); setSortDir(-1) }
  }

  const SortBtn = ({ col, label }) => (
    <button onClick={() => handleSort(col)} className="text-slate-400 hover:text-white transition-colors">
      {label}
      {sortBy === col && <span className="ml-0.5 text-mint-400">{sortDir > 0 ? '↑' : '↓'}</span>}
    </button>
  )

  return (
    <div className="space-y-4 animate-fade-in">
      {/* Summary row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <SummaryCard label="Total Value" value={fmtLarge(summary.totalValue)} sub={`Cost: ${fmtLarge(summary.totalCost)}`} />
        <SummaryCard
          label="Total Gain/Loss"
          value={`${summary.totalGL >= 0 ? '+' : '-'}${fmtLarge(Math.abs(summary.totalGL))}`}
          sub={summary.unpricedCount > 0
            ? `⚠ excludes ${summary.unpricedCount} unpriced position${summary.unpricedCount > 1 ? 's' : ''} (${fmtLarge(summary.unpricedCost)} at cost)`
            : summary.staleCount > 0
              ? `${fmtPct(summary.totalGLPct)} · ${summary.staleCount} stale price${summary.staleCount > 1 ? 's' : ''}`
              : fmtPct(summary.totalGLPct)}
          up={summary.totalGL >= 0}
        />
        <SummaryCard
          label="Today's P&L"
          value={`${summary.todayTotal >= 0 ? '+' : '-'}$${fmt(Math.abs(summary.todayTotal))}`}
          sub={`${positions.length} positions`}
          up={summary.todayTotal >= 0}
        />
        <SummaryCard label="Positions" value={positions.length} sub="US Equities" />
      </div>

      {/* Sub-tabs */}
      <div className="flex gap-2 border-b border-white/[0.06] pb-0">
        {['holdings','allocation'].map(t => (
          <button
            key={t}
            onClick={() => setSelectedTab(t)}
            className={`px-4 py-2 text-sm font-medium border-b-2 transition-all capitalize -mb-px
              ${selectedTab === t ? 'border-mint-500 text-mint-400' : 'border-transparent text-slate-400 hover:text-white'}`}
          >
            {t}
          </button>
        ))}
        <div className="ml-auto flex items-center gap-2 pb-2">
          <button onClick={refresh} className="btn-ghost flex items-center gap-1.5 py-1.5">
            <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
            <span className="hidden sm:inline">Refresh</span>
          </button>
          {authFetch && (
            <button onClick={() => setShowImport(true)} className="btn-ghost flex items-center gap-1.5 py-1.5">
              <Upload className="w-3.5 h-3.5" />
              <span className="hidden sm:inline">Import</span>
            </button>
          )}
          <button onClick={() => setShowAdd(true)} className="btn-primary flex items-center gap-1.5">
            <PlusCircle className="w-3.5 h-3.5" />
            Add Stock
          </button>
        </div>
      </div>

      {selectedTab === 'holdings' && (
        <div className="glass rounded-xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-white/[0.06] text-xs">
                  <th className="text-left px-4 py-3 text-slate-400 font-medium w-40">
                    <SortBtn col="symbol" label="Symbol" />
                  </th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium">
                    <SortBtn col="shares" label="Shares" />
                  </th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium">
                    <SortBtn col="price" label="Price" />
                  </th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium hidden sm:table-cell">
                    <SortBtn col="changePct" label="Day %" />
                  </th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium hidden sm:table-cell">
                    <SortBtn col="todayGL" label="Today P/L" />
                  </th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium">
                    <SortBtn col="mktValue" label="Mkt Value" />
                  </th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium hidden md:table-cell">
                    <SortBtn col="gainLoss" label="Gain/Loss" />
                  </th>
                  <th className="text-right px-3 py-3 text-slate-400 font-medium hidden lg:table-cell">
                    <SortBtn col="gainLossPct" label="Return %" />
                  </th>
                  <th className="px-4 py-3" />
                </tr>
              </thead>
              <tbody>
                {loading && !positions.length ? (
                  <tr><td colSpan={8} className="px-4 py-8"><LoadingPulse rows={5} /></td></tr>
                ) : sorted.map(pos => (
                  <tr key={pos.symbol} className="border-b border-white/[0.04] hover:bg-white/[0.03] transition-colors group">
                    <td className="px-4 py-3">
                      <div className="font-semibold font-mono text-white">{pos.symbol}</div>
                      <div className="text-xs text-slate-500 truncate max-w-[120px]">{pos.name}</div>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-slate-300">{pos.shares}</td>
                    <td className="px-3 py-3 text-right font-mono text-white">
                      <FlashPrice price={pos.price} />
                    </td>
                    <td className="px-3 py-3 text-right hidden sm:table-cell">
                      <ChangeBadge pct={pos.changePct} />
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-xs hidden sm:table-cell">
                      <FlashPnL value={pos.todayGL} />
                    </td>
                    <td className="px-3 py-3 text-right font-mono font-medium">
                      {pos.mktValue !== null
                        ? <FlashPrice price={pos.mktValue} className="text-white" />
                        : <span className="text-slate-500" title="No live price — showing cost basis">${fmt(pos.costBasis)} <span className="text-[10px]">cost</span></span>}
                    </td>
                    <td className="px-3 py-3 text-right font-mono hidden md:table-cell">
                      <FlashPnL value={pos.gainLoss} />
                    </td>
                    <td className={`px-3 py-3 text-right font-mono hidden lg:table-cell ${(pos.gainLossPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {pos.gainLossPct !== null ? fmtPct(pos.gainLossPct) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100 transition-all">
                        <button
                          onClick={() => setEditPos(pos)}
                          className="p-1 text-slate-500 hover:text-mint-400 transition-colors"
                          title="Edit position"
                        >
                          <Edit3 className="w-3.5 h-3.5" />
                        </button>
                        <button
                          onClick={() => removePosition(pos.symbol)}
                          className="p-1 text-slate-500 hover:text-red-400 transition-colors"
                          title="Remove position"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {selectedTab === 'allocation' && (
        <div className="grid md:grid-cols-2 gap-4">
          <SectionCard title="Sector Allocation">
            <ResponsiveContainer width="100%" height={280}>
              <PieChart>
                <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} innerRadius={55} paddingAngle={2}>
                  {pieData.map((entry, i) => (
                    <Cell key={i} fill={SECTOR_COLORS[entry.name] || COLORS[i % COLORS.length]} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(v) => [`$${fmt(v)}`, '']}
                  contentStyle={{ background: 'rgba(10,15,26,0.95)', border: '1px solid rgba(255,255,255,0.1)', borderRadius: 8 }}
                  labelStyle={{ color: '#fff' }}
                />
              </PieChart>
            </ResponsiveContainer>
            <div className="grid grid-cols-2 gap-1 mt-2">
              {pieData.map((entry, i) => (
                <div key={i} className="flex items-center gap-1.5 text-xs text-slate-400">
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ background: SECTOR_COLORS[entry.name] || COLORS[i % COLORS.length] }} />
                  <span className="truncate">{entry.name}</span>
                </div>
              ))}
            </div>
          </SectionCard>

          <SectionCard title="Top Holdings by Value">
            <div className="space-y-2 mt-2">
              {stockAlloc.map((s, i) => {
                const total = stockAlloc.reduce((a, b) => a + b.value, 0)
                const pct = total > 0 ? (s.value / total) * 100 : 0
                return (
                  <div key={s.name} className="flex items-center gap-3">
                    <div className="w-16 text-xs font-mono font-semibold text-white">{s.name}</div>
                    <div className="flex-1 bg-white/[0.06] rounded-full h-1.5">
                      <div className="h-1.5 rounded-full" style={{ width: `${pct}%`, background: COLORS[i % COLORS.length] }} />
                    </div>
                    <div className="w-12 text-right text-xs font-mono text-slate-400">{pct.toFixed(1)}%</div>
                  </div>
                )
              })}
            </div>
          </SectionCard>
        </div>
      )}

      {showAdd && <AddStockModal onAdd={addPosition} onClose={() => setShowAdd(false)} />}
      {showImport && authFetch && (
        <ImportModal
          portfolioId={portfolioId}
          authFetch={authFetch}
          onImported={() => { refresh(); setShowImport(false) }}
          onClose={() => setShowImport(false)}
        />
      )}
      {editPos && (
        <EditPositionModal
          pos={editPos}
          onSave={updatePosition}
          onClose={() => setEditPos(null)}
        />
      )}
    </div>
  )
}
