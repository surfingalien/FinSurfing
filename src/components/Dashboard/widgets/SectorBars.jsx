/* ── Sector performance ──────────────────────── */
export default function SectorBars({ data }) {
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
