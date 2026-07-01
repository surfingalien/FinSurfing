/**
 * ProbabilityLatticeView — the "Probability Lattice" (Galton board) over the
 * AI Brain's REAL resolved predictions. Route id: 'probability-lattice'.
 *
 * Every resolved pick is a ball dropping through a peg lattice and landing in a
 * return bin: losses left of zero, profits right. Over many picks the shape of
 * the distribution — and the profit/loss split — becomes the AI's actual,
 * empirically-earned edge. Data-driven only; renders an "not enough data yet"
 * state until predictions have resolved. NEVER placeholder numbers.
 *
 * Data: GET /api/ai-brain/activity (feed[].outcome.ret30d|ret7d + h30/h7 winRate).
 */

import { useRef, useEffect, useMemo, useState } from 'react'
import { Boxes, RefreshCw, AlertTriangle } from 'lucide-react'
import { useQuery, fetchJson } from '../../hooks/useQuery'

const N_BINS = 15
const LOSS = '#ff4757'
const WIN  = '#00e87b'
const DIM  = '#5a7a68'

// Resolved return for a feed item (30d preferred, then 7d). null if unresolved.
function resolvedReturn(item) {
  const o = item?.outcome
  if (!o) return null
  const r = o.ret30d ?? o.ret7d
  return typeof r === 'number' && isFinite(r) ? r : null
}

function useLatticeData() {
  const { data, error, loading, refetch } = useQuery(
    'brain-activity-lattice',
    () => fetchJson('/api/ai-brain/activity?limit=100'),
    { staleMs: 5 * 60_000 },
  )
  const derived = useMemo(() => {
    const feed = Array.isArray(data?.feed) ? data.feed : []
    const returns = feed.map(resolvedReturn).filter(r => r != null)
    const n = returns.length
    const wins = returns.filter(r => r > 0).length
    const winRate = n ? wins / n : null
    const avg = n ? returns.reduce((s, r) => s + r, 0) / n : null
    // aggregate win rate from the deterministic stats (cross-check)
    const statWin = data?.h30?.winRate ?? data?.h7?.winRate ?? null
    const statN   = data?.h30?.nTradeable ?? data?.h7?.nTradeable ?? null
    return { returns, n, wins, winRate, avg, statWin, statN, totalLogged: data?.totalLogged ?? null }
  }, [data])
  return { ...derived, error, loading, refetch }
}

function LatticeCanvas({ returns }) {
  const ref = useRef(null)

  useEffect(() => {
    const canvas = ref.current
    if (!canvas) return
    let raf = 0
    let cancelled = false

    const draw = () => {
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

      // Bin the real returns symmetrically around 0.
      const maxAbs = Math.max(5, ...returns.map(r => Math.abs(r)))
      const binOf = r => {
        const t = (r + maxAbs) / (2 * maxAbs)        // 0..1
        return Math.max(0, Math.min(N_BINS - 1, Math.floor(t * N_BINS)))
      }
      const balls = returns.map((r, i) => ({ r, bin: binOf(r), order: i }))
      const binCounts = new Array(N_BINS).fill(0)
      const maxCount = Math.max(1, ...(() => {
        const c = new Array(N_BINS).fill(0); balls.forEach(b => c[b.bin]++); return c
      })())

      const padB = 46, padT = 18, padX = 12
      const boardTop = padT, boardBot = h - padB
      const binW = (w - padX * 2) / N_BINS
      const zeroBin = binOf(0)

      // Peg lattice geometry
      const pegRows = 8
      const pegAreaH = (boardBot - boardTop) * 0.62

      let landed = 0
      const total = balls.length
      const start = performance.now()
      const DURATION = Math.min(2600, 700 + total * 12)

      const frame = (now) => {
        if (cancelled) return
        ctx.clearRect(0, 0, w, h)

        // pegs
        ctx.fillStyle = 'rgba(143,166,152,0.20)'
        for (let row = 0; row < pegRows; row++) {
          const y = boardTop + (pegAreaH / pegRows) * (row + 0.5)
          const count = row + 2
          for (let i = 0; i < count; i++) {
            const x = w / 2 + (i - (count - 1) / 2) * binW
            ctx.beginPath(); ctx.arc(x, y, 1.6, 0, Math.PI * 2); ctx.fill()
          }
        }

        // how many balls have "landed" by now (staggered)
        const prog = Math.min(1, (now - start) / DURATION)
        landed = Math.floor(prog * total)
        const counts = new Array(N_BINS).fill(0)
        for (let k = 0; k < landed; k++) counts[balls[k].bin]++

        // bins (histogram)
        for (let b = 0; b < N_BINS; b++) {
          const cnt = counts[b]
          const bh = (cnt / maxCount) * (boardBot - boardTop - pegAreaH - 8)
          const x = padX + b * binW
          const y = boardBot - bh
          const isWin = b >= zeroBin
          ctx.fillStyle = (isWin ? WIN : LOSS) + '88'
          ctx.fillRect(x + 1, y, binW - 2, bh)
        }

        // falling balls (the last few in transit)
        const transit = 10
        for (let k = landed; k < Math.min(total, landed + transit); k++) {
          const b = balls[k]
          const localT = (prog * total) - k + 1 // ~0..1 for the frontmost
          if (localT <= 0) continue
          const x = padX + b.bin * binW + binW / 2
          const y = boardTop + localT * (boardBot - boardTop) * 0.9
          ctx.fillStyle = b.r > 0 ? WIN : LOSS
          ctx.beginPath(); ctx.arc(x, y, 2.4, 0, Math.PI * 2); ctx.fill()
        }

        // zero divider
        const zx = padX + zeroBin * binW
        ctx.strokeStyle = 'rgba(143,166,152,0.5)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3])
        ctx.beginPath(); ctx.moveTo(zx, boardTop); ctx.lineTo(zx, boardBot); ctx.stroke(); ctx.setLineDash([])
        ctx.fillStyle = DIM; ctx.font = '8px "JetBrains Mono", monospace'; ctx.textAlign = 'center'
        ctx.fillText('0%', zx, boardBot + 12)
        ctx.textAlign = 'left';  ctx.fillStyle = LOSS; ctx.fillText(`−${maxAbs.toFixed(0)}%`, padX, boardBot + 12)
        ctx.textAlign = 'right'; ctx.fillStyle = WIN;  ctx.fillText(`+${maxAbs.toFixed(0)}%`, w - padX, boardBot + 12)

        // labels
        ctx.textAlign = 'center'; ctx.fillStyle = 'rgba(143,166,152,0.7)'; ctx.font = '9px "Space Grotesk", sans-serif'
        ctx.fillText('LOSS', padX + (zx - padX) / 2, boardTop + 10)
        ctx.fillText('PROFIT', zx + (w - padX - zx) / 2, boardTop + 10)

        if (prog < 1) raf = requestAnimationFrame(frame)
      }
      raf = requestAnimationFrame(frame)
    }

    draw()
    const onResize = () => { cancelAnimationFrame(raf); draw() }
    window.addEventListener('resize', onResize)
    return () => { cancelled = true; cancelAnimationFrame(raf); window.removeEventListener('resize', onResize) }
  }, [returns])

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

export default function ProbabilityLatticeView() {
  const { returns, n, winRate, avg, statWin, totalLogged, error, loading, refetch } = useLatticeData()
  const [key, setKey] = useState(0) // force replay

  const fmtPct = v => v == null ? '—' : `${(v * 100).toFixed(1)}%`

  return (
    <div className="space-y-6 animate-fade-in">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-cyan-500/10 border border-cyan-500/20">
            <Boxes className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">Probability Lattice</h1>
            <p className="text-xs text-slate-500">Every resolved AI prediction is a ball — the shape it settles into is the edge, earned over many picks</p>
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
      ) : n < 5 ? (
        <div className="glass rounded-2xl p-10 text-center text-slate-500">
          <Boxes className="w-8 h-8 mx-auto mb-3 text-slate-600" />
          <p className="text-sm">Not enough resolved predictions yet{totalLogged != null ? ` (${totalLogged} logged)` : ''}.</p>
          <p className="text-xs mt-1">The lattice fills in as picks resolve against their +7/+30d outcomes.</p>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Stat label="Resolved picks" value={n} />
            <Stat label="Win rate (this board)" value={fmtPct(winRate)} color={winRate >= 0.5 ? WIN : LOSS} />
            <Stat label="Avg return / pick" value={avg == null ? '—' : `${avg > 0 ? '+' : ''}${avg.toFixed(1)}%`} color={avg >= 0 ? WIN : LOSS} />
            <Stat label="Calibrated win rate" value={fmtPct(statWin)} color="#00d4ff" />
          </div>

          <div className="glass rounded-2xl p-3">
            <div style={{ position: 'relative', height: 360, background: 'var(--surface, #0b1210)', borderRadius: 10 }}>
              <LatticeCanvas key={key} returns={returns} />
            </div>
            <p className="text-[10px] text-slate-600 mt-2 text-center">
              Law of large numbers — a real edge shows only over many repetitions. Distribution of {n} resolved returns; not financial advice.
            </p>
          </div>
        </>
      )}
    </div>
  )
}
