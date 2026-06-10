import { Clock } from 'lucide-react'
import {
  ResponsiveContainer, RadarChart, PolarGrid, PolarAngleAxis, Radar,
} from 'recharts'
import { fmt } from '../../../services/api'
import { SIGNAL_TYPES } from '../../../services/aiEngine'

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

/* ── Confidence ring ─────────────────────────────── */
export function ConfidenceRing({ pct, type }) {
  const cfg   = SIGNAL_TYPES[type] || SIGNAL_TYPES.HOLD
  const r     = 36, circ = 2 * Math.PI * r
  const dash  = (pct / 100) * circ
  return (
    <div className="relative flex items-center justify-center w-24 h-24">
      <svg className="absolute" width="96" height="96" viewBox="0 0 96 96">
        <circle cx="48" cy="48" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="8" />
        <circle cx="48" cy="48" r={r} fill="none" stroke={cfg.color} strokeWidth="8"
          strokeDasharray={`${dash} ${circ}`} strokeDashoffset={circ / 4}
          strokeLinecap="round" style={{ transition: 'stroke-dasharray 1s ease' }} />
      </svg>
      <div className="text-center z-10">
        <div className="font-black text-xl text-white">{pct}%</div>
        <div className="text-[9px] text-slate-500 uppercase tracking-wide">confidence</div>
      </div>
    </div>
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
export function HorizonCard({ h, active, onClick }) {
  const rr = h.rr >= 2 ? 'text-emerald-400' : h.rr >= 1.5 ? 'text-amber-400' : 'text-red-400'
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
        <div className={`text-xl font-black font-mono ${rr}`}>{h.rr}:1</div>
      </div>
      <div className="space-y-1.5 text-xs">
        <div className="flex justify-between">
          <span className="text-slate-500">Entry</span>
          <span className="font-mono text-white">{typeof h.entry === 'string' ? h.entry : `$${fmt(h.entry)}`}</span>
        </div>
        <div className="flex justify-between">
          <span className="text-emerald-400">TP1</span>
          <span className="font-mono text-emerald-400">${fmt(h.tp1)} <span className="text-[10px] text-slate-500">(+{(((h.tp1 - h.stop) / Math.max(0.01, h.entry - h.stop || h.stop * 0.1) * 100)).toFixed(0)}% est.)</span></span>
        </div>
        <div className="flex justify-between">
          <span className="text-emerald-400">TP2</span>
          <span className="font-mono text-emerald-400">${fmt(h.tp2)}</span>
        </div>
        <div className="flex justify-between border-t border-white/[0.04] pt-1.5 mt-1.5">
          <span className="text-red-400">Stop</span>
          <span className="font-mono text-red-400">${fmt(h.stop)} <span className="text-[10px] text-slate-500">(-{h.stopPct}%)</span></span>
        </div>
      </div>
      <p className="text-[10px] text-slate-600 mt-2 border-t border-white/[0.04] pt-2">{h.note}</p>
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
