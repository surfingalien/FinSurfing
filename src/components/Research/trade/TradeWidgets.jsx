import { TrendingUp, TrendingDown, Minus } from 'lucide-react'

/* ── Stance badge ────────────────────────────────── */
export function StanceBadge({ stance, size = 'md' }) {
  const cfg = {
    Bullish: { cls: 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30', icon: TrendingUp },
    Bearish: { cls: 'bg-red-500/20 text-red-400 border-red-500/30',          icon: TrendingDown },
    Neutral: { cls: 'bg-amber-500/20 text-amber-400 border-amber-500/30',    icon: Minus },
  }
  const c   = cfg[stance] || cfg.Neutral
  const Icon = c.icon
  const sz  = size === 'lg' ? 'px-5 py-2 text-base font-bold' : 'px-3 py-1 text-sm font-semibold'
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border ${c.cls} ${sz}`}>
      <Icon className={size === 'lg' ? 'w-5 h-5' : 'w-3.5 h-3.5'} />
      {stance}
    </span>
  )
}

/* ── Signal pill ─────────────────────────────────── */
export function SignalPill({ signal }) {
  const map = {
    'Strong Buy':  'bg-emerald-500/20 text-emerald-400 border-emerald-500/30',
    'Buy':         'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    'Hold':        'bg-amber-500/10  text-amber-400  border-amber-500/20',
    'Sell':        'bg-red-500/10    text-red-400    border-red-500/20',
    'Strong Sell': 'bg-red-500/20    text-red-400    border-red-500/30',
  }
  return (
    <span className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-bold border ${map[signal] || map.Hold}`}>
      {signal}
    </span>
  )
}

/* ── Confidence meter ────────────────────────────── */
export function ConfidenceMeter({ score }) {
  const pct  = (score / 10) * 100
  const color = score >= 7.5 ? '#10b981' : score >= 5 ? '#f59e0b' : '#ef4444'
  const label = score >= 7.5 ? 'High' : score >= 5 ? 'Moderate' : 'Low'
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-400">Confidence</span>
        <span className="font-mono font-bold" style={{ color }}>{score}/10 · {label}</span>
      </div>
      <div className="h-2 bg-white/[0.06] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

/* ── Indicator row ───────────────────────────────── */
export function IndicatorRow({ label, value, bullish, sub }) {
  const dot = bullish === true ? 'bg-emerald-400' : bullish === false ? 'bg-red-400' : 'bg-amber-400'
  return (
    <div className="flex items-center justify-between py-1.5 border-b border-white/[0.04] last:border-0">
      <div className="flex items-center gap-2">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${dot}`} />
        <span className="text-xs text-slate-400">{label}</span>
      </div>
      <div className="text-right">
        <div className="text-xs font-mono text-white">{value}</div>
        {sub && <div className="text-[10px] text-slate-500">{sub}</div>}
      </div>
    </div>
  )
}
