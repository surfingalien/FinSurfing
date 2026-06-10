// ── Mini equity chart (SVG sparkline) ────────────────────────────────────────

export default function EquityChart({ equity }) {
  if (!equity?.length) return null
  const values  = equity.map(e => e.value)
  const minV    = Math.min(...values)
  const maxV    = Math.max(...values)
  const range   = maxV - minV || 1
  const W = 600; const H = 140
  const pts = values.map((v, i) => {
    const x = (i / (values.length - 1)) * W
    const y = H - ((v - minV) / range) * H
    return `${x},${y}`
  }).join(' ')

  const isUp = values.at(-1) >= values[0]

  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-4">
      <div className="text-xs font-semibold text-slate-400 mb-3">Equity Curve</div>
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-28" preserveAspectRatio="none">
        <defs>
          <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%"   stopColor={isUp ? '#00ffcc' : '#f87171'} stopOpacity="0.15" />
            <stop offset="100%" stopColor={isUp ? '#00ffcc' : '#f87171'} stopOpacity="0" />
          </linearGradient>
        </defs>
        {/* Fill */}
        <polygon
          points={`0,${H} ${pts} ${W},${H}`}
          fill="url(#eqGrad)"
        />
        {/* Line */}
        <polyline
          points={pts}
          fill="none"
          stroke={isUp ? '#00ffcc' : '#f87171'}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      <div className="flex justify-between text-[10px] text-slate-600 mt-1">
        <span>{equity[0]?.date}</span>
        <span>{equity.at(-1)?.date}</span>
      </div>
    </div>
  )
}
