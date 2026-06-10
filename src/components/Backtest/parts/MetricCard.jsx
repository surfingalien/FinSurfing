// ── Metric card ───────────────────────────────────────────────────────────────

export default function MetricCard({ label, value, sub, positive, icon: Icon, big }) {
  const color = positive === true  ? 'text-mint-400'
               : positive === false ? 'text-red-400'
               : 'text-white'
  return (
    <div className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4">
      {Icon && <Icon className="w-3.5 h-3.5 text-slate-500 mb-2" />}
      <div className={`${big ? 'text-2xl' : 'text-lg'} font-bold font-mono ${color}`}>{value}</div>
      <div className="text-xs text-slate-500 mt-0.5">{label}</div>
      {sub && <div className="text-[10px] text-slate-600 mt-0.5">{sub}</div>}
    </div>
  )
}
