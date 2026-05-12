/**
 * PortfolioAnalyticsView.jsx
 *
 * Portfolio risk analytics: portfolio beta vs SPY, per-holding betas,
 * correlation heatmap, and sector concentration donut.
 */

import { useState, useEffect } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import {
  Activity, BarChart3, PieChart, AlertTriangle, RefreshCw, Info,
} from 'lucide-react'

// ── Colour helpers ────────────────────────────────────────────────────────────

function corrColor(r) {
  if (r === null) return '#1a1f2e'
  const t = (r + 1) / 2
  const r1 = Math.round(t * 248 + (1 - t) * 30)
  const g1 = Math.round(t * 113 + (1 - t) * 30)
  const b1 = Math.round(t * 113 + (1 - t) * 200)
  return `rgb(${r1},${g1},${b1})`
}

function betaColor(b) {
  if (b === null) return 'text-slate-500'
  if (b > 1.5) return 'text-red-400'
  if (b > 1.1) return 'text-amber-400'
  if (b < 0.5) return 'text-slate-400'
  return 'text-mint-400'
}

const SECTOR_COLORS = [
  '#6366f1', '#00ffcc', '#f59e0b', '#ec4899', '#14b8a6',
  '#f87171', '#a78bfa', '#34d399', '#fb923c', '#60a5fa',
]

// ── Beta gauge ────────────────────────────────────────────────────────────────

function BetaGauge({ beta }) {
  const clamped = Math.max(-0.5, Math.min(3, beta ?? 1))
  const pct     = ((clamped + 0.5) / 3.5) * 100
  const color   = beta > 1.5 ? '#f87171' : beta > 1.1 ? '#f59e0b' : '#00ffcc'
  return (
    <div className="space-y-2">
      <div className="flex justify-between text-xs text-slate-500">
        <span>-0.5</span><span>0</span><span>1</span><span>2</span><span>3+</span>
      </div>
      <div className="relative h-3 rounded-full bg-white/[0.05] overflow-hidden">
        {/* Zones */}
        <div className="absolute inset-y-0 left-0 w-[14%] bg-slate-500/20 rounded-l-full" />
        <div className="absolute inset-y-0 left-[14%] w-[43%] bg-mint-500/10" />
        <div className="absolute inset-y-0 left-[57%] w-[24%] bg-amber-500/10" />
        <div className="absolute inset-y-0 left-[81%] w-[19%] bg-red-500/10 rounded-r-full" />
        {/* Needle */}
        <div
          className="absolute top-0 w-3 h-3 rounded-full border-2 border-[#0a0e1a] shadow"
          style={{ left: `calc(${pct}% - 6px)`, background: color }}
        />
      </div>
      <div className="text-center">
        <span className={`text-3xl font-bold font-mono ${betaColor(beta)}`}>
          {beta != null ? beta.toFixed(2) : '—'}
        </span>
        <span className="text-slate-600 text-sm ml-1">β vs SPY</span>
      </div>
    </div>
  )
}

// ── Correlation heatmap ───────────────────────────────────────────────────────

function CorrelationHeatmap({ symbols, correlations }) {
  if (!symbols?.length) return null
  const n = symbols.length
  if (n < 2) return <p className="text-xs text-slate-600">Need at least 2 holdings for correlation.</p>

  const corMap = {}
  for (const c of correlations) {
    corMap[`${c.a}:${c.b}`] = c.r
    corMap[`${c.b}:${c.a}`] = c.r
  }
  const get = (a, b) => a === b ? 1 : (corMap[`${a}:${b}`] ?? null)

  return (
    <div className="overflow-x-auto">
      <table className="text-[10px] border-collapse">
        <thead>
          <tr>
            <th className="w-12" />
            {symbols.map(s => (
              <th key={s} className="w-10 h-10 font-mono font-semibold text-slate-400 pb-1 rotate-[-45deg] origin-bottom-left">
                {s.length > 5 ? s.slice(0, 5) : s}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {symbols.map(rowSym => (
            <tr key={rowSym}>
              <td className="font-mono font-semibold text-slate-400 pr-2 text-right w-12">{rowSym}</td>
              {symbols.map(colSym => {
                const r = get(rowSym, colSym)
                return (
                  <td key={colSym}
                    className="w-9 h-9 border border-[#0a0e1a] text-center font-mono"
                    style={{ background: corrColor(r), color: '#fff', fontSize: 9 }}
                    title={`${rowSym}↔${colSym}: ${r != null ? r.toFixed(2) : 'n/a'}`}
                  >
                    {r != null ? r.toFixed(2) : ''}
                  </td>
                )
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="flex items-center gap-2 mt-2 text-[9px] text-slate-600">
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded" style={{ background: corrColor(-1) }} />
          <span>-1 (inverse)</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded" style={{ background: corrColor(0) }} />
          <span>0 (uncorrelated)</span>
        </div>
        <div className="flex items-center gap-1">
          <div className="w-3 h-3 rounded" style={{ background: corrColor(1) }} />
          <span>+1 (perfect)</span>
        </div>
      </div>
    </div>
  )
}

// ── Sector donut (SVG) ────────────────────────────────────────────────────────

function SectorDonut({ sectors }) {
  if (!sectors?.length) return null
  const R = 50; const r = 30; const cx = 70; const cy = 70
  let startAngle = -Math.PI / 2
  const slices = sectors.map((s, i) => {
    const angle = (s.weight / 100) * 2 * Math.PI
    const x1 = cx + R * Math.cos(startAngle)
    const y1 = cy + R * Math.sin(startAngle)
    startAngle += angle
    const x2 = cx + R * Math.cos(startAngle)
    const y2 = cy + R * Math.sin(startAngle)
    const ix1 = cx + r * Math.cos(startAngle - angle)
    const iy1 = cy + r * Math.sin(startAngle - angle)
    const ix2 = cx + r * Math.cos(startAngle)
    const iy2 = cy + r * Math.sin(startAngle)
    const large = angle > Math.PI ? 1 : 0
    const d = `M ${x1} ${y1} A ${R} ${R} 0 ${large} 1 ${x2} ${y2} L ${ix2} ${iy2} A ${r} ${r} 0 ${large} 0 ${ix1} ${iy1} Z`
    return { ...s, d, color: SECTOR_COLORS[i % SECTOR_COLORS.length] }
  })

  return (
    <div className="flex items-start gap-6 flex-wrap">
      <svg width="140" height="140" className="shrink-0">
        {slices.map((s, i) => (
          <path key={i} d={s.d} fill={s.color} stroke="#070b14" strokeWidth="2">
            <title>{s.name}: {s.weight}%</title>
          </path>
        ))}
      </svg>
      <div className="space-y-1.5">
        {slices.map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <div className="w-2.5 h-2.5 rounded-sm shrink-0" style={{ background: s.color }} />
            <span className="text-slate-300 w-32 truncate">{s.name}</span>
            <span className="font-mono text-white font-semibold">{s.weight}%</span>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function PortfolioAnalyticsView() {
  const { authFetch, isAuthenticated } = useAuth()
  const [data,    setData]    = useState(null)
  const [loading, setLoading] = useState(false)
  const [error,   setError]   = useState(null)

  const load = async () => {
    if (!isAuthenticated) return
    setLoading(true); setError(null)
    try {
      const r = await authFetch('/api/analytics/portfolio')
      const d = await r.json()
      if (!r.ok) throw new Error(d.error || 'Analytics failed')
      setData(d)
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  const noData = !loading && data && data.symbols?.length === 0

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-amber-500/10 border border-amber-500/20">
            <Activity className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Portfolio Analytics</h1>
            <p className="text-xs text-slate-500">Beta, correlations & sector concentration vs SPY</p>
          </div>
        </div>
        <button onClick={load} disabled={loading}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs text-slate-400
                     hover:text-white hover:bg-white/[0.06] border border-white/[0.06] transition-all">
          <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} />
          Refresh
        </button>
      </div>

      {!isAuthenticated && (
        <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/[0.06] text-center text-slate-500 text-sm">
          Sign in to view your portfolio analytics.
        </div>
      )}

      {error && (
        <div className="flex items-center gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0" />{error}
        </div>
      )}

      {loading && (
        <div className="p-8 text-center text-slate-500 text-sm">
          <div className="w-6 h-6 border-2 border-amber-400/30 border-t-amber-400 rounded-full animate-spin mx-auto mb-2" />
          Fetching 1-year price history for all holdings…
        </div>
      )}

      {noData && (
        <div className="p-6 rounded-2xl bg-white/[0.02] border border-white/[0.06] text-center text-slate-500 text-sm">
          No holdings found. Add stocks to your portfolio to see analytics.
        </div>
      )}

      {data && data.symbols?.length > 0 && (
        <>
          {/* Beta panel */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <BarChart3 className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-semibold text-white">Portfolio Beta</span>
              </div>
              <BetaGauge beta={data.portfolioBeta} />
              <p className="text-xs text-slate-600 mt-3">
                {data.portfolioBeta != null && data.portfolioBeta > 1.2 && 'High beta — your portfolio amplifies market moves.'}
                {data.portfolioBeta != null && data.portfolioBeta < 0.8 && 'Low beta — relatively defensive vs the market.'}
                {data.portfolioBeta != null && data.portfolioBeta >= 0.8 && data.portfolioBeta <= 1.2 && 'Moderate beta — moves roughly in line with the market.'}
              </p>
            </div>

            {/* Per-holding betas */}
            <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-3">
                <BarChart3 className="w-4 h-4 text-amber-400" />
                <span className="text-sm font-semibold text-white">Per-Holding Beta</span>
              </div>
              <div className="space-y-2 max-h-52 overflow-y-auto">
                {Object.entries(data.betas)
                  .sort(([, a], [, b]) => (b ?? 0) - (a ?? 0))
                  .map(([sym, b]) => (
                    <div key={sym} className="flex items-center gap-3">
                      <span className="font-mono text-xs text-slate-400 w-14">{sym}</span>
                      <div className="flex-1 h-1.5 rounded-full bg-white/[0.05] overflow-hidden">
                        <div
                          className="h-full rounded-full transition-all"
                          style={{
                            width: `${Math.min(100, ((b ?? 0) / 3) * 100)}%`,
                            background: b > 1.5 ? '#f87171' : b > 1.1 ? '#f59e0b' : '#00ffcc',
                          }}
                        />
                      </div>
                      <span className={`font-mono text-xs font-semibold w-10 text-right ${betaColor(b)}`}>
                        {b != null ? b.toFixed(2) : '—'}
                      </span>
                    </div>
                  ))}
              </div>
            </div>
          </div>

          {/* Correlation heatmap */}
          {data.symbols.length >= 2 && (
            <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <Activity className="w-4 h-4 text-indigo-400" />
                <span className="text-sm font-semibold text-white">Correlation Matrix</span>
                <span className="text-[10px] text-slate-600 ml-1">1-year daily returns</span>
              </div>
              <CorrelationHeatmap symbols={data.symbols} correlations={data.correlations} />
            </div>
          )}

          {/* Sector donut */}
          {data.sectors?.length > 0 && (
            <div className="bg-white/[0.02] border border-white/[0.06] rounded-2xl p-5">
              <div className="flex items-center gap-2 mb-4">
                <PieChart className="w-4 h-4 text-mint-400" />
                <span className="text-sm font-semibold text-white">Sector Concentration</span>
              </div>
              <SectorDonut sectors={data.sectors} />
            </div>
          )}

          <div className="flex items-start gap-2 text-[10px] text-slate-600 p-3 rounded-lg bg-white/[0.02]">
            <Info className="w-3 h-3 mt-0.5 shrink-0" />
            Beta and correlations computed from 1-year daily close prices. Sector weights approximate —
            based on share counts, not current market value. Benchmark: SPY ETF.
          </div>
        </>
      )}
    </div>
  )
}
