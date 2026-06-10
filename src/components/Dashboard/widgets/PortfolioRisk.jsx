import { useMemo } from 'react'

/* ── Sector beta proxies ─────────────────────── */
const SECTOR_BETA = {
  'Technology': 1.32, 'Consumer Cyclical': 1.22, 'Financial Services': 1.38,
  'Communication Services': 1.15, 'Consumer Defensive': 0.62, 'Energy': 0.92,
  'Healthcare': 0.78, 'Real Estate': 0.96, 'Utilities': 0.44,
  'Materials': 1.08, 'Industrials': 1.10,
}

/* ── Portfolio risk analysis ─────────────────── */
export default function PortfolioRisk({ positions, quotes }) {
  const risk = useMemo(() => {
    const totalValue = positions.reduce((s, p) => {
      const q = quotes[p.symbol]
      return s + (q?.price ?? p.avgCost) * p.shares
    }, 0)

    let portfolioBeta = 0
    const sectorMap   = {}
    const holdings    = []

    positions.forEach(p => {
      const q     = quotes[p.symbol]
      const price = q?.price ?? p.avgCost
      const val   = price * p.shares
      const w     = totalValue > 0 ? val / totalValue : 0
      const beta  = SECTOR_BETA[p.sector] ?? 1.05

      portfolioBeta += w * beta

      const sec = p.sector || 'Other'
      sectorMap[sec] = (sectorMap[sec] || 0) + val

      holdings.push({ symbol: p.symbol, weight: w * 100, val, sector: p.sector })
    })

    // Herfindahl-Hirschman Index for concentration
    const hhi        = holdings.reduce((s, h) => s + (h.weight / 100) ** 2, 0)
    const concRisk   = hhi > 0.20 ? 'High' : hhi > 0.12 ? 'Moderate' : 'Low'

    const sortedH    = [...holdings].sort((a, b) => b.weight - a.weight)
    const top5Weight = sortedH.slice(0, 5).reduce((s, h) => s + h.weight, 0)
    const top3       = sortedH.slice(0, 3)

    const sectors = Object.entries(sectorMap)
      .map(([name, val]) => ({ name, val, pct: totalValue > 0 ? (val / totalValue) * 100 : 0 }))
      .sort((a, b) => b.pct - a.pct)

    const techWeight = sectors.find(s => s.name === 'Technology')?.pct ?? 0

    return { portfolioBeta: +portfolioBeta.toFixed(2), concRisk, hhi: +hhi.toFixed(3),
      top5Weight: +top5Weight.toFixed(1), top3, sectors, techWeight: +techWeight.toFixed(1),
      numPositions: positions.length, totalValue }
  }, [positions, quotes])

  const betaColor = risk.portfolioBeta > 1.3 ? 'text-red-400' : risk.portfolioBeta > 1.1 ? 'text-amber-400' : 'text-emerald-400'
  const concColor = risk.concRisk === 'High' ? 'text-red-400' : risk.concRisk === 'Moderate' ? 'text-amber-400' : 'text-emerald-400'

  return (
    <div className="space-y-4">
      {/* Risk metric cards */}
      <div className="grid grid-cols-2 gap-3">
        <div className="glass-card text-center">
          <div className="text-xs text-slate-500 mb-1">Portfolio Beta</div>
          <div className={`text-2xl font-black font-mono ${betaColor}`}>{risk.portfolioBeta}β</div>
          <div className="text-[10px] text-slate-600 mt-0.5">
            {risk.portfolioBeta > 1.2 ? 'High market sensitivity' : risk.portfolioBeta > 1 ? 'Above market avg' : 'Defensive posture'}
          </div>
        </div>
        <div className="glass-card text-center">
          <div className="text-xs text-slate-500 mb-1">Concentration</div>
          <div className={`text-xl font-black ${concColor}`}>{risk.concRisk}</div>
          <div className="text-[10px] text-slate-600 mt-0.5">HHI {risk.hhi} · {risk.numPositions} positions</div>
        </div>
        <div className="glass-card text-center">
          <div className="text-xs text-slate-500 mb-1">Top-5 Weight</div>
          <div className={`text-2xl font-black font-mono ${risk.top5Weight > 55 ? 'text-amber-400' : 'text-white'}`}>
            {risk.top5Weight}%
          </div>
          <div className="text-[10px] text-slate-600 mt-0.5">
            {risk.top3.map(h => h.symbol).join(', ')}
          </div>
        </div>
        <div className="glass-card text-center">
          <div className="text-xs text-slate-500 mb-1">Tech Exposure</div>
          <div className={`text-2xl font-black font-mono ${risk.techWeight > 60 ? 'text-amber-400' : 'text-white'}`}>
            {risk.techWeight}%
          </div>
          <div className="text-[10px] text-slate-600 mt-0.5">
            {risk.techWeight > 60 ? 'Concentrated sector risk' : 'Within normal range'}
          </div>
        </div>
      </div>

      {/* Sector allocation bars */}
      <div>
        <div className="text-xs font-semibold text-slate-400 mb-2">Sector Allocation</div>
        <div className="space-y-1.5">
          {risk.sectors.map(s => (
            <div key={s.name} className="flex items-center gap-3 text-xs">
              <div className="text-slate-400 w-36 truncate shrink-0 text-[11px]">{s.name}</div>
              <div className="flex-1 h-3.5 bg-white/[0.04] rounded-full overflow-hidden">
                <div className="h-full rounded-full bg-mint-500/40 transition-all duration-700"
                  style={{ width: `${s.pct}%` }} />
              </div>
              <span className="font-mono text-slate-300 w-10 text-right text-[11px]">{s.pct.toFixed(0)}%</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
