/**
 * RelationshipGraphView — the "Relationship Graph" over the portfolio's REAL
 * pairwise return correlations. Route id: 'relationship-graph'.
 *
 * Third of the MIROFISH visualizations (after Probability Lattice and Tail
 * Probability Ridge). Nodes are holdings; edges are the Pearson correlations
 * /api/analytics/portfolio already computes from a year of daily returns.
 * Strongly correlated names pull together into visible clusters — a cluster
 * IS concentration risk, whatever the sector labels claim. Data-driven only;
 * renders a "not enough data" state below 2 symbols. NEVER placeholder numbers.
 */

import { useRef, useEffect, useMemo, useState } from 'react'
import { Share2, RefreshCw, AlertTriangle } from 'lucide-react'
import { useQuery, fetchJson } from '../../hooks/useQuery'

const POS  = '#ff9f43'   // positive correlation — warm (concentration)
const NEG  = '#54a0ff'   // negative correlation — cool (diversification)
const NODE = '#00e87b'
const HIBETA = '#ff6b6b'
const DIM  = '#5a7a68'
const EDGE_MIN = 0.25    // hide noise below this |r|

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

function useGraphData(symbols) {
  const key = symbols?.length ? `analytics-graph:${symbols.join(',')}` : 'analytics-graph:default'
  const { data, error, loading, refetch } = useQuery(
    key,
    () => fetchJson(
      symbols?.length ? `/api/analytics/portfolio?symbols=${symbols.join(',')}` : '/api/analytics/portfolio',
      { credentials: 'include', headers: getApiKeyHeaders() },
    ),
    { staleMs: 5 * 60_000 },
  )
  const derived = useMemo(() => {
    const syms  = Array.isArray(data?.symbols) ? data.symbols : []
    const corrs = Array.isArray(data?.correlations) ? data.correlations : []
    const betas = data?.betas || {}
    const n = syms.length
    const avgAbsR = corrs.length ? corrs.reduce((s, c) => s + Math.abs(c.r), 0) / corrs.length : null
    let maxPair = null, minPair = null
    for (const c of corrs) {
      if (!maxPair || c.r > maxPair.r) maxPair = c
      if (!minPair || c.r < minPair.r) minPair = c
    }
    return { syms, corrs, betas, n, avgAbsR, maxPair, minPair }
  }, [data])
  return { ...derived, error, loading, refetch }
}

// Simple force-directed spring embedder, animated with cooling.
function GraphCanvas({ syms, corrs, betas }) {
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

    // seed nodes on a circle (deterministic — no Math.random, so replay is stable)
    const nodes = syms.map((s, i) => {
      const a = (i / syms.length) * Math.PI * 2
      return { s, x: w / 2 + Math.cos(a) * Math.min(w, h) * 0.32,
                  y: h / 2 + Math.sin(a) * Math.min(w, h) * 0.32, vx: 0, vy: 0 }
    })
    const idx = Object.fromEntries(nodes.map((n, i) => [n.s, i]))
    const edges = corrs
      .filter(c => Math.abs(c.r) >= EDGE_MIN && idx[c.a] != null && idx[c.b] != null)
      .map(c => ({ a: idx[c.a], b: idx[c.b], r: c.r }))

    let raf = 0
    let temp = 1 // cooling factor

    const frame = () => {
      // physics step
      const REPULSE = 5200, DAMP = 0.82
      for (let i = 0; i < nodes.length; i++) {
        let fx = 0, fy = 0
        for (let j = 0; j < nodes.length; j++) {
          if (i === j) continue
          const dx = nodes[i].x - nodes[j].x, dy = nodes[i].y - nodes[j].y
          const d2 = Math.max(100, dx * dx + dy * dy)
          const f = REPULSE / d2
          fx += (dx / Math.sqrt(d2)) * f
          fy += (dy / Math.sqrt(d2)) * f
        }
        // centering
        fx += (w / 2 - nodes[i].x) * 0.005
        fy += (h / 2 - nodes[i].y) * 0.005
        nodes[i].vx = (nodes[i].vx + fx * temp) * DAMP
        nodes[i].vy = (nodes[i].vy + fy * temp) * DAMP
      }
      // springs: higher |r| → shorter rest length (correlated names cluster)
      for (const e of edges) {
        const na = nodes[e.a], nb = nodes[e.b]
        const dx = nb.x - na.x, dy = nb.y - na.y
        const d = Math.max(1, Math.sqrt(dx * dx + dy * dy))
        const rest = e.r > 0
          ? 60 + (1 - e.r) * 180          // +1 → 60px, +0.25 → ~195px
          : 240 + Math.abs(e.r) * 80      // negative r pushes apart
        const f = (d - rest) * 0.012 * temp
        na.vx += (dx / d) * f; na.vy += (dy / d) * f
        nb.vx -= (dx / d) * f; nb.vy -= (dy / d) * f
      }
      const pad = 28
      for (const n of nodes) {
        n.x = Math.max(pad, Math.min(w - pad, n.x + n.vx))
        n.y = Math.max(pad, Math.min(h - pad, n.y + n.vy))
      }
      temp = Math.max(0.02, temp * 0.985)

      // draw
      ctx.clearRect(0, 0, w, h)
      for (const e of edges) {
        const na = nodes[e.a], nb = nodes[e.b]
        const alpha = Math.min(0.85, Math.abs(e.r))
        ctx.strokeStyle = (e.r > 0 ? POS : NEG) + Math.round(alpha * 255).toString(16).padStart(2, '0')
        ctx.lineWidth = 0.6 + Math.abs(e.r) * 2.4
        ctx.beginPath(); ctx.moveTo(na.x, na.y); ctx.lineTo(nb.x, nb.y); ctx.stroke()
      }
      ctx.font = '9px "JetBrains Mono", monospace'
      ctx.textAlign = 'center'
      for (const n of nodes) {
        const beta = betas[n.s]
        const hot = beta != null && beta > 1.3
        ctx.fillStyle = hot ? HIBETA : NODE
        ctx.beginPath(); ctx.arc(n.x, n.y, 5, 0, Math.PI * 2); ctx.fill()
        ctx.strokeStyle = 'rgba(255,255,255,0.25)'; ctx.lineWidth = 1; ctx.stroke()
        ctx.fillStyle = '#cfe3d8'
        ctx.fillText(n.s, n.x, n.y - 9)
        if (beta != null) {
          ctx.fillStyle = hot ? HIBETA : DIM
          ctx.fillText(`β${beta.toFixed(1)}`, n.x, n.y + 17)
        }
      }

      if (temp > 0.03) raf = requestAnimationFrame(frame)
    }
    raf = requestAnimationFrame(frame)
    return () => cancelAnimationFrame(raf)
  }, [syms, corrs, betas])

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

export default function RelationshipGraphView({ portfolio }) {
  const portfolioSymbols = portfolio?.positions?.map(p => p.symbol).filter(Boolean) ?? []
  const { syms, corrs, betas, n, avgAbsR, maxPair, minPair, error, loading, refetch } =
    useGraphData(portfolioSymbols)
  const [key, setKey] = useState(0)

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20">
            <Share2 className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Relationship Graph</h1>
            <p className="text-xs text-slate-500">Holdings pulled together by real return correlations — a tight cluster is concentration risk, whatever the sector labels say</p>
          </div>
        </div>
        <button onClick={() => { refetch(); setKey(k => k + 1) }} className="text-slate-400 hover:text-cyan-400 p-2 rounded-lg hover:bg-white/[0.04]" title="Replay">
          <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
        </button>
      </div>

      {error ? (
        <div className="glass rounded-2xl p-6 border border-red-500/20 flex items-start gap-3">
          <AlertTriangle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
          <p className="text-sm text-red-300">{error.message}</p>
        </div>
      ) : n < 2 ? (
        <div className="glass rounded-2xl p-10 text-center text-slate-500">
          <Share2 className="w-8 h-8 mx-auto mb-3 text-slate-600" />
          <p className="text-sm">Need at least 2 holdings with price history{portfolioSymbols.length ? '' : ' — add positions to your portfolio'}.</p>
          <p className="text-xs mt-1">Correlations come from a year of daily returns per pair.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Holdings" value={n} />
            <Stat label="Avg pairwise |r|" value={avgAbsR == null ? '—' : avgAbsR.toFixed(2)} color={avgAbsR > 0.6 ? HIBETA : '#00d4ff'} />
            <Stat label="Most correlated" value={maxPair ? `${maxPair.a}·${maxPair.b} ${maxPair.r.toFixed(2)}` : '—'} color={POS} />
            <Stat label="Best diversifier pair" value={minPair ? `${minPair.a}·${minPair.b} ${minPair.r.toFixed(2)}` : '—'} color={NEG} />
          </div>

          <div className="glass rounded-2xl p-3">
            <div style={{ position: 'relative', height: 420, background: 'var(--surface, #0b1210)', borderRadius: 10 }}>
              <GraphCanvas key={key} syms={syms} corrs={corrs} betas={betas} />
            </div>
            <p className="text-[10px] text-slate-600 mt-2 text-center">
              Edges shown for |r| ≥ {EDGE_MIN} over 1y of daily returns · <span style={{ color: POS }}>warm = co-move</span> · <span style={{ color: NEG }}>cool = offset</span> · <span style={{ color: HIBETA }}>red node = β &gt; 1.3 vs SPY</span> · not financial advice
            </p>
          </div>
        </>
      )}
    </div>
  )
}
