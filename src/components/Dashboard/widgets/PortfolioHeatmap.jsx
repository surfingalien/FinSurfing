import { useMemo } from 'react'
import { fmt } from '../../../services/api'

/* ── Heatmap cell ────────────────────────────── */
function HeatCell({ symbol, price, changePct, pctOfPortfolio, onClick }) {
  const hasData = changePct != null
  const cp = changePct ?? 0
  const bg = !hasData ? 'rgba(100,116,139,0.12)'
           : cp >= 4  ? 'rgba(16,185,129,0.80)'
           : cp >= 2  ? 'rgba(16,185,129,0.55)'
           : cp >= 0.5? 'rgba(52,211,153,0.30)'
           : cp >= -0.5? 'rgba(100,116,139,0.25)'
           : cp >= -2 ? 'rgba(248,113,113,0.30)'
           : cp >= -4 ? 'rgba(248,113,113,0.55)'
           :             'rgba(239,68,68,0.80)'
  const clr = !hasData ? 'text-slate-500' : cp >= 1 ? 'text-emerald-100' : cp >= 0 ? 'text-emerald-300' : cp >= -1 ? 'text-red-300' : 'text-red-100'

  return (
    <button
      onClick={onClick}
      className="rounded-xl p-2.5 flex flex-col justify-between cursor-pointer hover:brightness-125 transition-all"
      style={{ background: bg, minHeight: pctOfPortfolio > 12 ? '90px' : '70px' }}
    >
      <div className="font-mono font-black text-white text-sm leading-none">{symbol}</div>
      {price != null && (
        <div className="text-[10px] text-white/70 font-mono mt-1">${fmt(price)}</div>
      )}
      <div className={`text-xs font-bold font-mono mt-auto ${clr}`}>
        {hasData ? `${cp >= 0 ? '+' : ''}${cp.toFixed(2)}%` : '—'}
      </div>
    </button>
  )
}

/* ── Portfolio heatmap ───────────────────────── */
export default function PortfolioHeatmap({ positions, quotes, onAnalyze }) {
  const cells = useMemo(() => {
    const totalValue = positions.reduce((s, p) => {
      const q = quotes[p.symbol]
      return s + (q?.price ?? p.avgCost) * p.shares
    }, 0)
    return positions.map(p => {
      const q     = quotes[p.symbol]
      const price = q?.price ?? null
      const mktV  = (price ?? p.avgCost) * p.shares
      let changePct = q?.changePct ?? null
      // Derive changePct from prevClose when the API didn't supply it directly
      if (changePct == null && price != null && q?.prevClose != null && q.prevClose > 0) {
        changePct = (price - q.prevClose) / q.prevClose * 100
      }
      return {
        symbol: p.symbol,
        price,
        changePct,
        mktValue:  mktV,
        pctOfPortfolio: totalValue > 0 ? (mktV / totalValue) * 100 : 0,
      }
    }).sort((a, b) => b.mktValue - a.mktValue)
  }, [positions, quotes])

  if (!cells.length) return <p className="text-slate-600 text-sm text-center py-6">No holdings loaded</p>

  return (
    <div className="grid grid-cols-4 sm:grid-cols-5 md:grid-cols-7 gap-2">
      {cells.map(c => (
        <HeatCell key={c.symbol} {...c} onClick={() => onAnalyze?.(c.symbol)} />
      ))}
    </div>
  )
}
