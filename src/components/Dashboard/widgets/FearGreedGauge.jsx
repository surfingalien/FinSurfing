/* ── Fear & Greed Gauge ──────────────────────── */
export default function FearGreedGauge({ fg }) {
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
