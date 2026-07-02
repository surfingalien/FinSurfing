/**
 * TailProbabilityRidgeView — the "Tail Probability Ridge" over the portfolio's
 * REAL historical daily-return distribution vs SPY. Route id: 'tail-ridge'.
 *
 * Two stacked density ridges (portfolio, benchmark) built from actual daily
 * returns fetched from /api/analytics/portfolio. The left tail beyond the
 * empirical 95% VaR is shaded — that shaded sliver is the historical
 * probability of a loss day at least that bad. Data-driven only; renders a
 * "not enough data yet" state until at least 20 trading days are available
 * (the same floor lib/portfolio-metrics.js uses for VaR/CVaR). NEVER
 * placeholder numbers.
 */

import { useRef, useEffect, useMemo, useState } from 'react'
import { Mountain, RefreshCw, AlertTriangle } from 'lucide-react'
import { useQuery, fetchJson } from '../../hooks/useQuery'

const PORT_COLOR  = '#00e87b'
const BENCH_COLOR = '#7aa2f7'
const TAIL_COLOR  = '#ff4757'
const DIM         = '#5a7a68'

function getApiKeyHeaders() {
  try {
    const s = JSON.parse(localStorage.getItem('finsurf_api_keys') || '{}')
    const h = {}
    if (s.aisa?.trim())    h['x-aisa-key']    = s.aisa.trim()
    if (s.finnhub?.trim()) h['x-finnhub-key'] = s.finnhub.trim()
    if (s.fmp?.trim())     h['x-fmp-key']     = s.fmp.trim()
    if (s.td?.trim())      h['x-td-key']      = s.td.trim()
    if (s.av?.trim())      h['x-av-key']      = s.av.trim()
    return h
  } catch { return {} }
}

// Gaussian KDE, evaluated at `xs`, bandwidth via Silverman's rule of thumb.
function kde(values, xs) {
  const n = values.length
  if (n < 2) return xs.map(() => 0)
  const mean = values.reduce((s, v) => s + v, 0) / n
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / n
  const std = Math.sqrt(variance)
  const bw = Math.max(0.05, 1.06 * std * Math.pow(n, -0.2))
  const norm = 1 / (n * bw * Math.sqrt(2 * Math.PI))
  return xs.map(x => {
    let sum = 0
    for (let i = 0; i < n; i++) {
      const z = (x - values[i]) / bw
      sum += Math.exp(-0.5 * z * z)
    }
    return sum * norm
  })
}

function useRidgeData(symbols) {
  const key = symbols?.length ? `analytics-ridge:${symbols.join(',')}` : 'analytics-ridge:default'
  const { data, error, loading, refetch } = useQuery(
    key,
    () => fetchJson(
      symbols?.length ? `/api/analytics/portfolio?symbols=${symbols.join(',')}` : '/api/analytics/portfolio',
      { credentials: 'include', headers: getApiKeyHeaders() },
    ),
    { staleMs: 5 * 60_000 },
  )
  const derived = useMemo(() => {
    const rm = data?.riskMetrics
    const port  = rm?.returnSeries?.portfolio ?? []
    const bench = rm?.returnSeries?.benchmark ?? []
    return {
      port, bench,
      n: port.length,
      var95:  rm?.portfolio?.var95  ?? null,
      cvar95: rm?.portfolio?.cvar95 ?? null,
      benchVar95: rm?.benchmark?.var95 ?? null,
      volatility: rm?.portfolio?.volatility ?? null,
    }
  }, [data])
  return { ...derived, error, loading, refetch }
}

function RidgeCanvas({ port, bench, var95 }) {
  const ref = useRef(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    const parent = canvas.parentElement
    if (!parent) return
    const w = parent.clientWidth
    const h = parent.clientHeight
    if (!w || !h) return
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = w * dpr
    canvas.height = h * dpr
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, w, h)

    const all = [...port, ...bench]
    const maxAbs = Math.max(2, ...all.map(v => Math.abs(v)))
    const N = 140
    const xs = Array.from({ length: N }, (_, i) => -maxAbs + (2 * maxAbs * i) / (N - 1))
    const xOf = x => padX + ((x + maxAbs) / (2 * maxAbs)) * (w - padX * 2)

    const padX = 12
    const rowH = (h - 40) / 2
    const rows = [
      { label: 'PORTFOLIO', values: port,  color: PORT_COLOR,  baseline: 20 + rowH * 0.92 },
      { label: 'SPY',       values: bench, color: BENCH_COLOR, baseline: 20 + rowH * 1.92 },
    ]

    ctx.font = '9px "Space Grotesk", sans-serif'

    for (const row of rows) {
      if (row.values.length < 2) continue
      const density = kde(row.values, xs)
      const peak = Math.max(...density, 1e-9)
      const scaled = density.map(d => (d / peak) * (rowH * 0.78))

      // filled ridge path
      ctx.beginPath()
      ctx.moveTo(xOf(xs[0]), row.baseline)
      xs.forEach((x, i) => ctx.lineTo(xOf(x), row.baseline - scaled[i]))
      ctx.lineTo(xOf(xs[N - 1]), row.baseline)
      ctx.closePath()
      const grad = ctx.createLinearGradient(0, row.baseline - rowH * 0.78, 0, row.baseline)
      grad.addColorStop(0, row.color + '55')
      grad.addColorStop(1, row.color + '08')
      ctx.fillStyle = grad
      ctx.fill()
      ctx.strokeStyle = row.color
      ctx.lineWidth = 1.4
      ctx.stroke()

      // shade the tail beyond var95 (portfolio ridge only)
      if (row.label === 'PORTFOLIO' && var95 != null) {
        const cutoff = -Math.abs(var95)
        ctx.beginPath()
        ctx.moveTo(xOf(xs[0]), row.baseline)
        let started = false
        xs.forEach((x, i) => {
          if (x > cutoff) return
          ctx.lineTo(xOf(x), row.baseline - scaled[i])
          started = true
        })
        ctx.lineTo(xOf(Math.min(cutoff, xs[N - 1])), row.baseline)
        ctx.closePath()
        if (started) { ctx.fillStyle = TAIL_COLOR + '55'; ctx.fill() }

        ctx.strokeStyle = TAIL_COLOR
        ctx.setLineDash([3, 3])
        ctx.lineWidth = 1
        ctx.beginPath()
        ctx.moveTo(xOf(cutoff), row.baseline - rowH * 0.85)
        ctx.lineTo(xOf(cutoff), row.baseline + 4)
        ctx.stroke()
        ctx.setLineDash([])
        ctx.fillStyle = TAIL_COLOR
        ctx.textAlign = 'center'
        ctx.fillText(`VaR 95%: −${Math.abs(var95).toFixed(1)}%`, xOf(cutoff), row.baseline - rowH * 0.85 - 4)
      }

      ctx.fillStyle = row.color
      ctx.textAlign = 'left'
      ctx.fillText(row.label, padX, row.baseline - rowH * 0.9)
    }

    // zero line + axis labels
    const zx = xOf(0)
    ctx.strokeStyle = 'rgba(143,166,152,0.35)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.moveTo(zx, 16); ctx.lineTo(zx, h - 8); ctx.stroke()
    ctx.fillStyle = DIM
    ctx.font = '8px "JetBrains Mono", monospace'
    ctx.textAlign = 'center'
    ctx.fillText('0%', zx, h - 2)
    ctx.textAlign = 'left'
    ctx.fillText(`−${maxAbs.toFixed(1)}%`, padX, h - 2)
    ctx.textAlign = 'right'
    ctx.fillText(`+${maxAbs.toFixed(1)}%`, w - padX, h - 2)
  }, [port, bench, var95])

  return <canvas ref={ref} style={{ position: 'absolute', inset: 0, width: '100%', height: '100%' }} />
}

function Stat({ label, value, color }) {
  return (
    <div className="p-2.5 rounded-xl bg-white/[0.03] border border-white/[0.06]">
      <p className="text-[9px] uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mono text-lg font-bold" style={{ color: color || '#e4ede8' }}>{value}</p>
    </div>
  )
}

export default function TailProbabilityRidgeView({ portfolio }) {
  const portfolioSymbols = portfolio?.positions?.map(p => p.symbol).filter(Boolean) ?? []
  const { port, bench, n, var95, cvar95, benchVar95, volatility, error, loading, refetch } =
    useRidgeData(portfolioSymbols)
  const [key, setKey] = useState(0)

  const fmtPct = v => v == null ? '—' : `−${Math.abs(v).toFixed(2)}%`

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20">
            <Mountain className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Tail Probability Ridge</h1>
            <p className="text-xs text-slate-500">Real historical daily returns, portfolio vs SPY — the shaded sliver is the empirical odds of a bad day</p>
          </div>
        </div>
        <button onClick={() => { refetch(); setKey(k => k + 1) }} className="text-slate-400 hover:text-cyan-400 p-2 rounded-lg hover:bg-white/[0.04]" title="Refresh">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error ? (
        <div className="glass rounded-2xl p-6 border border-red-500/20 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <p className="text-sm text-red-300">{error.message}</p>
        </div>
      ) : n < 20 ? (
        <div className="glass rounded-2xl p-10 text-center text-slate-500">
          <Mountain className="w-8 h-8 mx-auto mb-3 text-slate-600" />
          <p className="text-sm">Not enough trading history yet{portfolioSymbols.length ? '' : ' — add holdings to your portfolio'}.</p>
          <p className="text-xs mt-1">The ridge needs at least 20 daily returns to estimate a distribution.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Trading days" value={n} />
            <Stat label="Portfolio VaR 95% (1d)" value={fmtPct(var95)} color={TAIL_COLOR} />
            <Stat label="Portfolio CVaR 95% (1d)" value={fmtPct(cvar95)} color={TAIL_COLOR} />
            <Stat label="Ann. volatility" value={volatility == null ? '—' : `${volatility.toFixed(1)}%`} color="#00d4ff" />
          </div>

          <div className="glass rounded-2xl p-3">
            <div style={{ position: 'relative', height: 320, background: 'var(--surface, #0b1210)', borderRadius: 10 }}>
              <RidgeCanvas key={key} port={port} bench={bench} var95={var95} />
            </div>
            <p className="text-[10px] text-slate-600 mt-2 text-center">
              Kernel density estimate of {n} daily returns per series, each ridge independently peak-normalized. SPY 95% VaR: {fmtPct(benchVar95)}. Not financial advice.
            </p>
          </div>
        </>
      )}
    </div>
  )
}
