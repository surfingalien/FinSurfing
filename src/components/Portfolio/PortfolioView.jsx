import { useState } from 'react'
import { PlusCircle, RefreshCw, TrendingUp, TrendingDown, Trash2, Edit3 } from 'lucide-react'
import { PieChart, Pie, Cell, Tooltip, ResponsiveContainer, AreaChart, Area, XAxis, YAxis } from 'recharts'
import { fmt, fmtPct, fmtLarge } from '../../services/api'
import { ChangeBadge, SectionCard, LoadingPulse } from '../shared/StockCard'
import AddStockModal from './AddStockModal'

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

export default function PortfolioView({ portfolio }) {
  const { positions, loading, refresh, addPosition, removePosition, summary } = portfolio
  const [showAdd, setShowAdd] = useState(false)
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
          value={`${summary.totalGL >= 0 ? '+' : ''}${fmtLarge(Math.abs(summary.totalGL))}`}
          sub={fmtPct(summary.totalGLPct)}
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
                      {pos.price !== null ? `$${fmt(pos.price)}` : '—'}
                    </td>
                    <td className="px-3 py-3 text-right hidden sm:table-cell">
                      <ChangeBadge pct={pos.changePct} />
                    </td>
                    <td className={`px-3 py-3 text-right font-mono text-xs hidden sm:table-cell ${(pos.todayGL ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {pos.todayGL != null
                        ? `${pos.todayGL >= 0 ? '+' : ''}$${fmt(Math.abs(pos.todayGL))}`
                        : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-white font-medium">
                      {pos.mktValue !== null ? `$${fmt(pos.mktValue)}` : `$${fmt(pos.costBasis)}`}
                    </td>
                    <td className={`px-3 py-3 text-right font-mono hidden md:table-cell ${(pos.gainLoss ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {pos.gainLoss !== null ? `${pos.gainLoss >= 0 ? '+' : ''}$${fmt(Math.abs(pos.gainLoss))}` : '—'}
                    </td>
                    <td className={`px-3 py-3 text-right font-mono hidden lg:table-cell ${(pos.gainLossPct ?? 0) >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                      {pos.gainLossPct !== null ? fmtPct(pos.gainLossPct) : '—'}
                    </td>
                    <td className="px-4 py-3">
                      <button
                        onClick={() => removePosition(pos.symbol)}
                        className="opacity-0 group-hover:opacity-100 p-1 text-slate-500 hover:text-red-400 transition-all"
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
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
    </div>
  )
}
