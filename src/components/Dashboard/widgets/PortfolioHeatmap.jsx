import { useMemo } from 'react'
import { fmt } from '../../../services/api'
import * as portfolioPnl from '../../../../lib/portfolio-pnl.js'

/* ── Heatmap cell ────────────────────────────── */
function HeatCell({ symbol, price, changePct, unrealizedPct, pctOfPortfolio, stale, onClick }) {
  const hasData = changePct != null
  const cp = changePct ?? 0
  // Color cell by today's change
  const bg = !hasData ? 'rgba(100,116,139,0.12)'
           : cp >= 4  ? 'rgba(16,185,129,0.80)'
           : cp >= 2  ? 'rgba(16,185,129,0.55)'
           : cp >= 0.5? 'rgba(52,211,153,0.30)'
           : cp >= -0.5? 'rgba(100,116,139,0.25)'
           : cp >= -2 ? 'rgba(248,113,113,0.30)'
           : cp >= -4 ? 'rgba(248,113,113,0.55)'
           :             'rgba(239,68,68,0.80)'
  const clr = !hasData ? 'text-slate-500' : cp >= 1 ? 'text-emerald-100' : cp >= 0 ? 'text-emerald-300' : cp >= -1 ? 'text-red-300' : 'text-red-100'
  const upnlClr = unrealizedPct == null ? '' : unrealizedPct >= 0 ? 'text-emerald-400' : 'text-red-400'

  return (
    <button
      onClick={onClick}
      className="rounded-xl p-2.5 flex flex-col justify-between cursor-pointer hover:brightness-125 transition-all"
      style={{ background: bg, minHeight: pctOfPortfolio > 12 ? '90px' : '70px' }}
    >
      <div className="font-mono font-black text-white text-sm leading-none">{symbol}</div>
      {price != null && (
        <div className={`text-[10px] font-mono mt-1 ${stale ? 'text-amber-200/60' : 'text-white/70'}`}>
          ${fmt(price)}{stale ? ' ⏱' : ''}
        </div>
      )}
      <div className={`text-xs font-bold font-mono mt-auto ${clr}`}>
        {hasData ? `${cp >= 0 ? '+' : ''}${cp.toFixed(2)}%` : stale ? 'stale' : '—'}
      </div>
      {unrealizedPct != null && (
        <div className={`text-[9px] font-mono leading-none mt-0.5 ${upnlClr}`} title="Unrealized P&L from cost">
          {unrealizedPct >= 0 ? '+' : ''}{unrealizedPct.toFixed(1)}% total
        </div>
      )}
    </button>
  )
}

/* ── Portfolio heatmap ───────────────────────── */
export default function PortfolioHeatmap({ positions, quotes, onAnalyze }) {
  const cells = useMemo(() => {
    // P&L (mktValue, gainLossPct) comes from the shared lib/portfolio-pnl.js so
    // this widget can never drift from the hook's numbers. changePct/stale are
    // day-change display concerns handled here.
    const enriched   = positions.map(p => portfolioPnl.enrichPosition(p, quotes[p.symbol]))
    const totalValue = enriched.reduce((s, e) => s + (e.mktValue ?? e.costBasis), 0)
    return enriched.map(e => {
      const q     = quotes[e.symbol]
      const stale = !!q?.stale
      const mktV  = e.mktValue ?? e.costBasis
      // A stale (last-known) quote's day-change is from an old session —
      // never color the cell with it; show the price marked stale instead
      let changePct = stale ? null : (q?.changePct ?? null)
      // Derive changePct from prevClose when the API didn't supply it directly
      if (!stale && changePct == null && e.price != null && q?.prevClose != null && q.prevClose > 0) {
        changePct = (e.price - q.prevClose) / q.prevClose * 100
      }
      return {
        symbol: e.symbol,
        price:  e.price,
        changePct,
        unrealizedPct:  e.gainLossPct,
        stale,
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
