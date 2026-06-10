import { useMemo } from 'react'
import { TrendingUp, TrendingDown } from 'lucide-react'
import { fmt } from '../../../services/api'

/* ── Market movers ───────────────────────────── */
export default function MarketMovers({ positions, quotes }) {
  const movers = useMemo(() => (
    positions
      .map(p => {
        const q = quotes[p.symbol]
        return q ? { symbol: p.symbol, price: q.price, changePct: q.changePct ?? 0 } : null
      })
      .filter(Boolean)
      .sort((a, b) => b.changePct - a.changePct)
  ), [positions, quotes])

  const gainers = movers.slice(0, 5)
  const losers  = movers.slice(-5).reverse()

  return (
    <div className="grid grid-cols-2 gap-4">
      {/* Gainers */}
      <div>
        <div className="flex items-center gap-1.5 text-xs font-semibold text-emerald-400 mb-2.5">
          <TrendingUp className="w-3.5 h-3.5" /> Top Gainers
        </div>
        <div className="space-y-1">
          {gainers.map(m => (
            <div key={m.symbol} className="flex items-center justify-between text-xs glass-card py-1.5 px-3">
              <span className="font-mono font-bold text-white w-12">{m.symbol}</span>
              <span className="font-mono text-slate-500 text-[11px]">${fmt(m.price)}</span>
              <span className="font-mono text-emerald-400 font-semibold">
                {m.changePct >= 0 ? '+' : ''}{m.changePct.toFixed(2)}%
              </span>
            </div>
          ))}
        </div>
      </div>
      {/* Losers */}
      <div>
        <div className="flex items-center gap-1.5 text-xs font-semibold text-red-400 mb-2.5">
          <TrendingDown className="w-3.5 h-3.5" /> Top Losers
        </div>
        <div className="space-y-1">
          {losers.map(m => (
            <div key={m.symbol} className="flex items-center justify-between text-xs glass-card py-1.5 px-3">
              <span className="font-mono font-bold text-white w-12">{m.symbol}</span>
              <span className="font-mono text-slate-500 text-[11px]">${fmt(m.price)}</span>
              <span className="font-mono text-red-400 font-semibold">{m.changePct.toFixed(2)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
