/**
 * FinSurf Dashboard — Modern trading command center
 * Portfolio heatmap · Fear & Greed · Sector performance · AI scan · Risk analysis
 */
import { useState, useEffect, useMemo, useCallback } from 'react'
import {
  TrendingUp, TrendingDown, Activity, Shield, BarChart2,
  Zap, RefreshCw, Layers, AlertCircle,
} from 'lucide-react'
import { fetchQuotes, fmt, fmtPct } from '../../services/api'
import { calcFearGreed, calcSectorPerformance } from '../../services/forecast'
import { scanPortfolio, SIGNAL_TYPES } from '../../services/aiEngine'

/* ── Sector beta proxies ─────────────────────── */
const SECTOR_BETA = {
  'Technology': 1.32, 'Consumer Cyclical': 1.22, 'Financial Services': 1.38,
  'Communication Services': 1.15, 'Consumer Defensive': 0.62, 'Energy': 0.92,
  'Healthcare': 0.78, 'Real Estate': 0.96, 'Utilities': 0.44,
  'Materials': 1.08, 'Industrials': 1.10,
}

/* ── Fear & Greed Gauge ──────────────────────── */
function FearGreedGauge({ fg }) {
  if (!fg) return (
    <div className="h-28 flex items-center justify-center">
      <div className="w-5 h-5 border-2 border-mint-400/30 border-t-mint-400 rounded-full animate-spin" />
    </div>
  )
  const { score, label, color, components = [] } = fg

  // Cap at 99.5 to avoid the degenerate same-start-same-end arc at score=100
  const pct = Math.min(score, 99.5) / 100

  // Gauge geometry: semicircle from 180° (left) over the top to 0° (right)
  // SVG coords: x = cx + r·cos(θ), y = cy − r·sin(θ)  (y-axis flipped)
  const R = 65, CX = 100, CY = 78
  const pt = (deg, radius = R) => {
    const a = (deg * Math.PI) / 180
    return [+(CX + radius * Math.cos(a)).toFixed(2), +(CY - radius * Math.sin(a)).toFixed(2)]
  }

  const [x0, y0] = pt(180)           // left arc endpoint  (score = 0)
  const [x1, y1] = pt(0)             // right arc endpoint (score = 100)
  const needleDeg = 180 - pct * 180  // 180° = score 0, 0° = score 100
  const [ex, ey] = pt(needleDeg)     // active arc end point
  const [nx, ny] = pt(needleDeg, R - 16) // needle tip (shorter radius)

  // Five equal 36° colour zones across the semicircle
  const ZONES = [
    { from: 180, to: 144, color: '#7c3aed' }, // Extreme Fear
    { from: 144, to: 108, color: '#6366f1' }, // Fear
    { from: 108, to:  72, color: '#f59e0b' }, // Neutral
    { from:  72, to:  36, color: '#f97316' }, // Greed
    { from:  36, to:   0, color: '#ef4444' }, // Extreme Greed
  ]

  return (
    <div>
      {/* SVG gauge — viewBox leaves room for arc endpoints at y=78, top at y=13 */}
      <svg width="200" height="84" viewBox="0 0 200 84" className="mx-auto block">
        {/* Background track */}
        <path d={`M ${x0} ${y0} A ${R} ${R} 0 0 1 ${x1} ${y1}`}
          fill="none" stroke="rgba(255,255,255,0.07)" strokeWidth="14" strokeLinecap="round" />

        {/* Zone colour arcs — each span ≤ 36°, large-arc always 0 */}
        {ZONES.map((z, i) => {
          const [sx, sy] = pt(z.from), [ex2, ey2] = pt(z.to)
          return (
            <path key={i} d={`M ${sx} ${sy} A ${R} ${R} 0 0 1 ${ex2} ${ey2}`}
              fill="none" stroke={z.color} strokeWidth="12" strokeOpacity="0.45" />
          )
        })}

        {/* Active progress arc
            large-arc MUST be 0: the span is always ≤ 180° for this gauge.
            Setting it to 1 for score > 50 was making SVG take the longer
            bottom-of-circle path, inverting the arc for every score above 50. */}
        {pct > 0.005 && (
          <path d={`M ${x0} ${y0} A ${R} ${R} 0 0 1 ${ex} ${ey}`}
            fill="none" stroke={color} strokeWidth="10" strokeLinecap="round"
            style={{ filter: `drop-shadow(0 0 8px ${color}90)` }} />
        )}

        {/* Needle */}
        <line x1={CX} y1={CY} x2={nx} y2={ny}
          stroke="white" strokeWidth="2.5" strokeLinecap="round" opacity="0.9" />
        <circle cx={CX} cy={CY} r="5" fill="rgba(255,255,255,0.9)" />
        <circle cx={CX} cy={CY} r="2.5" fill={color} />
      </svg>

      {/* Score + label in HTML — more legible than SVG text */}
      <div className="text-center mt-1">
        <span className="font-mono font-black text-2xl text-white">{score}</span>
        <span className="ml-2 text-sm font-bold" style={{ color }}>{label}</span>
      </div>

      {/* Zone labels */}
      <div className="flex justify-between text-[8px] text-slate-600 px-2 mt-1">
        {['Ext Fear', 'Fear', 'Neutral', 'Greed', 'Ext Greed'].map(z => (
          <span key={z}>{z}</span>
        ))}
      </div>

      {/* Component breakdown */}
      {components.length > 0 && (
        <div className="mt-3 space-y-1.5 border-t border-white/[0.06] pt-3">
          {components.map((c, i) => (
            <div key={i} className="flex items-center justify-between text-xs">
              <span className="text-slate-500 truncate flex-1">{c.name}</span>
              <span className="font-mono text-slate-400 text-[10px] mx-2">{c.value}</span>
              <span className={`font-bold font-mono text-[10px] ${c.score > 50 ? 'text-emerald-400' : 'text-red-400'}`}>
                {c.score}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

/* ── Heatmap cell ────────────────────────────── */
function HeatCell({ symbol, price, changePct, pctOfPortfolio, onClick }) {
  const cp = changePct ?? 0
  const bg = cp >= 4  ? 'rgba(16,185,129,0.80)'
           : cp >= 2  ? 'rgba(16,185,129,0.55)'
           : cp >= 0.5? 'rgba(52,211,153,0.30)'
           : cp >= -0.5? 'rgba(100,116,139,0.25)'
           : cp >= -2 ? 'rgba(248,113,113,0.30)'
           : cp >= -4 ? 'rgba(248,113,113,0.55)'
           :             'rgba(239,68,68,0.80)'
  const clr = cp >= 1 ? 'text-emerald-100' : cp >= 0 ? 'text-emerald-300' : cp >= -1 ? 'text-red-300' : 'text-red-100'

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
        {cp >= 0 ? '+' : ''}{cp.toFixed(2)}%
      </div>
    </button>
  )
}

/* ── Portfolio heatmap ───────────────────────── */
function PortfolioHeatmap({ positions, quotes, onAnalyze }) {
  const cells = useMemo(() => {
    const totalValue = positions.reduce((s, p) => {
      const q = quotes[p.symbol]
      return s + (q?.price ?? p.avgCost) * p.shares
    }, 0)
    return positions.map(p => {
      const q     = quotes[p.symbol]
      const price = q?.price ?? null
      const mktV  = (price ?? p.avgCost) * p.shares
      return {
        symbol: p.symbol,
        price,
        changePct: q?.changePct ?? null,
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

/* ── Sector performance ──────────────────────── */
function SectorBars({ data }) {
  if (!data?.length) return <p className="text-slate-600 text-xs text-center py-4">Awaiting quotes…</p>
  const max = Math.max(...data.map(d => Math.abs(d.avg)), 0.01)
  return (
    <div className="space-y-2.5">
      {data.map(d => {
        const pos = d.avg >= 0
        const barW = Math.min((Math.abs(d.avg) / max) * 100, 100)
        return (
          <div key={d.name} className="flex items-center gap-3 text-xs">
            <div className="text-slate-400 w-[9.5rem] truncate shrink-0 text-[11px]">{d.name}</div>
            <div className="flex-1 h-5 bg-white/[0.04] rounded-full overflow-hidden relative">
              <div
                className={`absolute top-0 h-full rounded-full transition-all duration-700 ${pos ? 'left-0 bg-emerald-500/60' : 'right-0 bg-red-500/60'}`}
                style={{ width: `${barW}%` }}
              />
            </div>
            <span className={`w-16 text-right font-mono font-semibold text-[11px] ${pos ? 'text-emerald-400' : 'text-red-400'}`}>
              {pos ? '+' : ''}{d.avg.toFixed(2)}%
              <span className="text-slate-600 font-normal ml-1">({d.count})</span>
            </span>
          </div>
        )
      })}
    </div>
  )
}

/* ── Market movers ───────────────────────────── */
function MarketMovers({ positions, quotes }) {
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

/* ── Portfolio risk analysis ─────────────────── */
function PortfolioRisk({ positions, quotes }) {
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

/* ── AI Quick Signal Panel ───────────────────── */
function QuickSignals({ scan, loading, onScan }) {
  if (loading) return (
    <div className="flex flex-col items-center gap-3 py-8">
      <div className="flex gap-1">
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} className="w-1.5 h-6 bg-mint-400/40 rounded-full animate-pulse"
            style={{ animationDelay: `${i * 0.1}s` }} />
        ))}
      </div>
      <p className="text-slate-500 text-sm">Scanning portfolio…</p>
    </div>
  )

  if (!scan) return (
    <div className="text-center py-6 space-y-3">
      <Zap className="w-8 h-8 text-mint-400/40 mx-auto" />
      <p className="text-slate-500 text-sm">Instant AI signal scan for all holdings</p>
      <button onClick={onScan} className="btn-primary flex items-center gap-2 mx-auto">
        <Zap className="w-3.5 h-3.5" /> Quick Scan
      </button>
    </div>
  )

  const counts = {}
  scan.forEach(r => { counts[r.signal] = (counts[r.signal] || 0) + 1 })

  return (
    <div className="space-y-3">
      {/* Signal summary badges */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1.5 flex-wrap">
          {Object.entries(SIGNAL_TYPES).map(([key, cfg]) =>
            counts[key] ? (
              <span key={key}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] ${cfg.bg} ${cfg.border} ${cfg.text}`}>
                {cfg.emoji} {counts[key]}
              </span>
            ) : null
          )}
        </div>
        <button onClick={onScan}
          className="text-[11px] text-slate-500 hover:text-mint-400 flex items-center gap-1 transition-colors">
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      {/* Signal list */}
      <div className="space-y-1">
        {scan.map(r => {
          const cfg = SIGNAL_TYPES[r.signal] || SIGNAL_TYPES.HOLD
          return (
            <div key={r.symbol}
              className={`flex items-center justify-between text-xs px-3 py-2 rounded-lg border ${cfg.border} bg-white/[0.02] hover:bg-white/[0.04] transition-colors`}>
              <span className="font-mono font-black text-white w-14">{r.symbol}</span>
              <span className={`flex items-center gap-1 ${cfg.text} font-medium`}>
                <span>{cfg.emoji}</span>
                <span className="hidden sm:inline text-[11px]">{cfg.label}</span>
              </span>
              <div className="text-right">
                <div className={`font-mono font-semibold text-[11px] ${r.gainPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {r.gainPct >= 0 ? '+' : ''}{r.gainPct.toFixed(1)}%
                </div>
                <div className={`font-mono text-[10px] ${r.changePct >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
                  {r.changePct >= 0 ? '+' : ''}{r.changePct.toFixed(2)}% today
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

/* ── Main DashboardView ──────────────────────── */
export default function DashboardView({ portfolio, onAnalyze }) {
  const [scan,     setScan]     = useState(null)
  const [scanning, setScanning] = useState(false)
  const [vixPrice, setVixPrice] = useState(null)

  const positions = portfolio?.positions ?? []
  const quotes    = portfolio?.quotes    ?? {}
  const quotesArr = useMemo(() => Object.values(quotes), [quotes])

  /* Fetch VIX on mount */
  useEffect(() => {
    fetchQuotes(['^VIX']).then(data => {
      if (data?.[0]?.price) setVixPrice(data[0].price)
    }).catch(() => {})
  }, [])

  /* Derived data */
  const fg         = useMemo(() => calcFearGreed(quotesArr, vixPrice), [quotesArr, vixPrice])
  const sectorPerf = useMemo(() => calcSectorPerformance(quotes, positions), [quotes, positions])

  /* Portfolio totals */
  const totals = useMemo(() => {
    let totalCost = 0, totalValue = 0, todayGL = 0, upCount = 0, dnCount = 0
    positions.forEach(p => {
      const q     = quotes[p.symbol]
      const price = q?.price ?? p.avgCost
      totalCost  += p.avgCost * p.shares
      totalValue += price * p.shares
      // Only count today's move when the quote timestamp is from today's date
      const prevClose  = q?.prevClose ?? null
      const marketTime = q?.marketTime ?? null
      const isToday    = marketTime
        ? new Date(marketTime * 1000).toDateString() === new Date().toDateString()
        : true
      const dayMove = isToday
        ? (price !== null && prevClose !== null ? price - prevClose : q?.change ?? null)
        : 0   // reset to zero between sessions
      if (dayMove != null) {
        todayGL += dayMove * p.shares
        if (dayMove > 0) upCount++
        else if (dayMove < 0) dnCount++
      }
    })
    return {
      totalValue, totalCost, todayGL,
      totalGL:    totalValue - totalCost,
      totalGLPct: totalCost > 0 ? ((totalValue - totalCost) / totalCost) * 100 : 0,
      upCount, dnCount,
    }
  }, [positions, quotes])

  /* Auto-scan when data loads */
  const runScan = useCallback(async () => {
    if (!positions.length) return
    setScanning(true)
    try {
      const results = await scanPortfolio({ positions, quotes })
      setScan(results)
    } finally { setScanning(false) }
  }, [positions, quotes])

  useEffect(() => {
    if (positions.length > 0 && quotesArr.length > 0 && !scan && !scanning) {
      runScan()
    }
  }, [positions.length, quotesArr.length])  // eslint-disable-line

  const glColor   = totals.totalGL  >= 0 ? 'text-emerald-400' : 'text-red-400'
  const todayColor= totals.todayGL  >= 0 ? 'text-emerald-400' : 'text-red-400'

  return (
    <div className="space-y-5 animate-fade-in">

      {/* ── Summary stats ── */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <div className="glass-card">
          <div className="text-xs text-slate-500 mb-1">Portfolio Value</div>
          <div className="text-2xl font-black font-mono text-white">
            ${totals.totalValue.toLocaleString('en-US', { maximumFractionDigits: 0 })}
          </div>
          <div className={`text-xs font-mono font-semibold mt-0.5 ${glColor}`}>
            {totals.totalGL >= 0 ? '+' : ''}${Math.abs(totals.totalGL).toFixed(0)}{' '}
            ({totals.totalGLPct >= 0 ? '+' : ''}{totals.totalGLPct.toFixed(2)}%) all-time
          </div>
        </div>

        <div className="glass-card">
          <div className="text-xs text-slate-500 mb-1">Today's P/L</div>
          <div className={`text-2xl font-black font-mono ${todayColor}`}>
            {totals.todayGL >= 0 ? '+' : ''}${Math.abs(totals.todayGL).toFixed(0)}
          </div>
          <div className="text-[10px] text-slate-600 mt-0.5">
            {totals.upCount}↑ {totals.dnCount}↓ vs. prior close
          </div>
        </div>

        <div className="glass-card">
          <div className="text-xs text-slate-500 mb-1">Fear & Greed</div>
          <div className="flex items-center gap-2 mt-1">
            <div className="text-2xl font-black font-mono text-white">{fg?.score ?? '—'}</div>
            {fg && (
              <span className="text-xs font-semibold px-2 py-0.5 rounded-full border"
                style={{ color: fg.color, borderColor: fg.color + '50', background: fg.color + '18' }}>
                {fg.label}
              </span>
            )}
          </div>
        </div>

        <div className="glass-card">
          <div className="text-xs text-slate-500 mb-1">Market Breadth</div>
          <div className="text-2xl font-black font-mono text-white">{totals.upCount}/{positions.length}</div>
          <div className="text-[10px] text-slate-600 mt-0.5">holdings advancing today</div>
        </div>
      </div>

      {/* ── Heatmap + Fear & Greed ── */}
      <div className="grid xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2 glass rounded-xl p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white flex items-center gap-2">
              <Layers className="w-3.5 h-3.5 text-mint-400" /> Portfolio Heatmap
            </h3>
            <span className="text-[10px] text-slate-600">Click a tile to analyze · Color = day % change</span>
          </div>
          <PortfolioHeatmap positions={positions} quotes={quotes} onAnalyze={onAnalyze} />
        </div>

        <div className="glass rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-3">
            <Activity className="w-3.5 h-3.5 text-mint-400" /> Fear & Greed Index
          </h3>
          <FearGreedGauge fg={fg} />
          {vixPrice && (
            <div className="text-center text-[10px] text-slate-600 mt-2">
              VIX: {vixPrice.toFixed(2)} · {vixPrice < 15 ? 'Low volatility' : vixPrice < 25 ? 'Normal range' : 'Elevated fear'}
            </div>
          )}
        </div>
      </div>

      {/* ── Sector Performance + Market Movers ── */}
      <div className="grid xl:grid-cols-2 gap-4">
        <div className="glass rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-4">
            <BarChart2 className="w-3.5 h-3.5 text-mint-400" /> Sector Performance
          </h3>
          <SectorBars data={sectorPerf} />
        </div>

        <div className="glass rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-4">
            <TrendingUp className="w-3.5 h-3.5 text-mint-400" /> Market Movers
          </h3>
          <MarketMovers positions={positions} quotes={quotes} />
        </div>
      </div>

      {/* ── AI Signals + Risk Analysis ── */}
      <div className="grid xl:grid-cols-2 gap-4">
        <div className="glass rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-4">
            <Zap className="w-3.5 h-3.5 text-mint-400" /> AI Signal Scan
            <span className="ml-auto text-[10px] text-slate-600 font-normal">from live quote data</span>
          </h3>
          <QuickSignals scan={scan} loading={scanning} onScan={runScan} />
        </div>

        <div className="glass rounded-xl p-4">
          <h3 className="text-sm font-semibold text-white flex items-center gap-2 mb-4">
            <Shield className="w-3.5 h-3.5 text-mint-400" /> Portfolio Risk Analysis
          </h3>
          <PortfolioRisk positions={positions} quotes={quotes} />
        </div>
      </div>

      {/* Disclaimer */}
      <div className="text-center text-[11px] text-slate-600 border-t border-white/[0.04] pt-3">
        Beta values are sector proxies. Fear & Greed derived from portfolio breadth + VIX. ·
        <strong> Not financial advice.</strong>
      </div>
    </div>
  )
}
