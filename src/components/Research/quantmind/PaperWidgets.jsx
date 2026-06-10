export function RelevanceDot({ score }) {
  const pct = Math.round((score || 0) * 100)
  const color = pct >= 75 ? 'bg-emerald-400' : pct >= 50 ? 'bg-amber-400' : 'bg-slate-500'
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-xs text-slate-400">{pct}%</span>
    </span>
  )
}

export function TagPill({ label }) {
  return (
    <span className="px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300 text-xs border border-violet-500/25">
      {label}
    </span>
  )
}
