import { useState, useEffect } from 'react'
import { fetchQuotes } from '../../../services/api'

/* ── Market Overview strip ───────────────────── */
const OVERVIEW_ETFS = [
  { symbol: 'SPY',  label: 'S&P 500' },
  { symbol: 'QQQ',  label: 'Nasdaq' },
  { symbol: 'DIA',  label: 'Dow 30' },
  { symbol: 'IWM',  label: 'Russell' },
  { symbol: 'TLT',  label: 'Bonds' },
  { symbol: 'GLD',  label: 'Gold' },
]

export default function MarketOverview() {
  const [quotes, setQuotes] = useState({})

  useEffect(() => {
    fetchQuotes(OVERVIEW_ETFS.map(e => e.symbol))
      .then(qs => {
        const map = {}
        qs.forEach(q => { if (q.symbol) map[q.symbol] = q })
        setQuotes(map)
      })
      .catch(() => {})
  }, [])

  return (
    <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
      {OVERVIEW_ETFS.map(etf => {
        const q   = quotes[etf.symbol]
        const pct = q?.changePct ?? null
        const up  = pct != null && pct >= 0
        return (
          <div key={etf.symbol}
            className="bg-white/[0.02] border border-white/[0.06] rounded-xl px-3 py-2.5 flex flex-col gap-0.5">
            <div className="text-[10px] text-slate-500 font-medium">{etf.label}</div>
            <div className="font-mono font-black text-white text-sm">
              {q?.price != null ? `$${Number(q.price).toFixed(2)}` : '—'}
            </div>
            <div className={`text-xs font-mono font-semibold ${pct == null ? 'text-slate-500' : up ? 'text-emerald-400' : 'text-red-400'}`}>
              {pct != null ? `${up ? '+' : ''}${pct.toFixed(2)}%` : '—'}
            </div>
          </div>
        )
      })}
    </div>
  )
}
