import { Clock } from 'lucide-react'
import {
  ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, Radar,
} from 'recharts'
import { fmt } from '../../../services/api'
import { SIGNAL_TYPES } from '../../../services/aiEngine'
import { signedPct, drawdownPct } from '../../../utils/formatPct'

/* ── Signal badge ────────────────────────────────── */
export function SignalBadge({ type, size = 'md' }) {
  const cfg = SIGNAL_TYPES[type] || SIGNAL_TYPES.HOLD
  const sz  = size === 'lg' ? 'px-5 py-2.5 text-sm font-black tracking-wide'
            : size === 'sm' ? 'px-2.5 py-1 text-xs font-bold'
            : 'px-4 py-1.5 text-sm font-bold'
  return (
    <span className={`inline-flex items-center gap-2 rounded-full border ${cfg.bg} ${cfg.border} ${cfg.text} ${sz}`}>
      <span>{cfg.emoji}</span>{cfg.label}
    </span>
  )
}

/* ── Factor bar ──────────────────────────────────── */
export function FactorBar({ factor }) {
  const pct   = (factor.score / 10) * 100
  const color = factor.score >= 7 ? '#10b981' : factor.score >= 5 ? '#f59e0b' : '#ef4444'
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-xs">
        <div className="flex items-center gap-1.5">
          <span>{factor.icon}</span>
          <span className="text-slate-300 font-medium">{factor.name}</span>
          <span className="text-slate-600">{factor.weight}</span>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-500 hidden sm:block truncate max-w-[200px]">{factor.detail}</span>
          <span className="font-mono font-bold text-white w-8 text-right">{factor.score.toFixed(1)}</span>
        </div>
      </div>
      <div className="h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all duration-700"
          style={{ width: `${pct}%`, background: color }} />
      </div>
    </div>
  )
}

/* ── Horizon card ────────────────────────────────── */
// Setups come from lib/horizon-setups.js, which validates them: a setup whose
// target is not above its entry (or stop not below it) arrives as
// `valid: false` with a reason and no levels. Percents are precomputed there,
// measured from the reference entry (the current price).
export function HorizonCard({ h, active, onClick }) {
  const valid = h.valid !== false
  const rr = h.rr >= 2 ? 'text-emerald-400' : h.rr >= 1.5 ? 'text-amber-400' : 'text-red-400'
  const entryText = h.entryLow != null && h.entryHigh != null
    ? `$${fmt(h.entryLow)}–$${fmt(h.entryHigh)}`
    : `$${fmt(h.entry)}`
  const fromEntry = `Measured from $${fmt(h.entry)}`
  return (
    <button onClick={onClick}
      className={`glass rounded-xl p-4 text-left transition-all border ${active ? 'border-mint-500/40 bg-mint-500/5' : 'border-white/[0.05] hover:border-white/[0.12]'}`}>
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-sm font-bold text-white">{h.label}</div>
          <div className="text-xs text-slate-500 flex items-center gap-1 mt-0.5">
            <Clock className="w-3 h-3" />{h.horizon}
          </div>
        </div>
        {valid
          ? <div className={`text-xl font-black font-mono ${rr}`} title="Reward / risk to TP1">{h.rr}:1</div>
          : <div className="text-xl font-black font-mono text-slate-500">—</div>}
      </div>
      {valid ? (
        <div className="space-y-1.5 text-xs">
          <div className="flex justify-between">
            <span className="text-slate-500">Entry</span>
            <span className="font-mono text-white">{entryText}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-emerald-400">TP1</span>
            <span className="font-mono text-emerald-400">${fmt(h.tp1)} <span className="text-[10px] text-slate-500" title={fromEntry}>({signedPct(h.tp1Pct, 1)})</span></span>
          </div>
          <div className="flex justify-between">
            <span className="text-emerald-400">TP2</span>
            <span className="font-mono text-emerald-400">${fmt(h.tp2)} <span className="text-[10px] text-slate-500" title={fromEntry}>({signedPct(h.tp2Pct, 1)})</span></span>
          </div>
          <div className="flex justify-between border-t border-white/[0.04] pt-1.5 mt-1.5">
            <span className="text-red-400">Stop</span>
            <span className="font-mono text-red-400">${fmt(h.stop)} <span className="text-[10px] text-slate-500" title={fromEntry}>({drawdownPct(h.stopPct, 1)})</span></span>
          </div>
        </div>
      ) : (
        <div className="text-xs rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
          <div className="font-semibold text-slate-300">No valid setup</div>
          <div className="text-slate-500 mt-1">{h.reason}</div>
          <div className="text-slate-600 mt-1">Price ${fmt(h.entry)}</div>
        </div>
      )}
      {h.note && <p className="text-[10px] text-slate-600 mt-2 border-t border-white/[0.04] pt-2">{h.note}</p>}
    </button>
  )
}

/* ── Radar chart for factor scoring ─────────────── */
export function FactorRadar({ factors }) {
  const data = factors.map(f => ({ subject: f.name.split(' ')[0], score: +f.score.toFixed(1), fullMark: 10 }))
  return (
    <ResponsiveContainer width="100%" height={200}>
      <RadarChart data={data} margin={{ top: 10, right: 30, bottom: 10, left: 30 }}>
        <PolarGrid stroke="rgba(255,255,255,0.06)" />
        <PolarAngleAxis dataKey="subject" tick={{ fill: '#64748b', fontSize: 10 }} />
        <Radar name="Score" dataKey="score" stroke="#00ffcc" fill="#00ffcc" fillOpacity={0.15} strokeWidth={1.5} />
      </RadarChart>
    </ResponsiveContainer>
  )
}
