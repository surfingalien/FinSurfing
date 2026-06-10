import { AlertTriangle, Clock } from 'lucide-react'
import { fmt } from '../../../services/api'

/* ── Trade card ──────────────────────────────────── */
export default function TradeCard({ trade, stance }) {
  const isBuy  = stance === 'Bullish'
  const isHold = stance === 'Neutral'
  const actionColor = isBuy ? 'text-emerald-400' : isHold ? 'text-amber-400' : 'text-red-400'
  const borderColor = isBuy ? 'border-emerald-500/25' : isHold ? 'border-amber-500/25' : 'border-red-500/25'

  return (
    <div className={`glass rounded-xl p-5 border ${borderColor} space-y-4`}>
      <div className="flex items-center justify-between">
        <div>
          <div className={`text-2xl font-black tracking-tight ${actionColor}`}>{trade.action}</div>
          <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
            <Clock className="w-3 h-3" /> {trade.holdingPeriod}
          </div>
        </div>
        {trade.riskReward && (
          <div className="text-right">
            <div className="text-xs text-slate-400">Risk/Reward</div>
            <div className={`text-xl font-bold font-mono ${trade.riskReward >= 2 ? 'text-emerald-400' : trade.riskReward >= 1.5 ? 'text-amber-400' : 'text-red-400'}`}>
              {trade.riskReward}:1
            </div>
          </div>
        )}
      </div>

      {/* Entry / Stop / Targets grid */}
      <div className="grid grid-cols-2 gap-3">
        <div className="glass-card space-y-0.5">
          <div className="text-[10px] text-slate-500 uppercase tracking-wide">Entry Zone</div>
          <div className="font-mono font-bold text-white text-sm">${fmt(trade.entryZone.low)} – ${fmt(trade.entryZone.high)}</div>
        </div>
        <div className="glass-card space-y-0.5 border border-red-500/15">
          <div className="text-[10px] text-red-400 uppercase tracking-wide">Stop-Loss</div>
          <div className="font-mono font-bold text-red-400 text-sm">${fmt(trade.stopLoss.price)}</div>
          <div className="text-[10px] text-slate-500">{trade.stopLoss.pct}% risk · {trade.stopLoss.rationale}</div>
        </div>
        {trade.targets.map((t, i) => (
          <div key={i} className="glass-card space-y-0.5 border border-emerald-500/15">
            <div className="text-[10px] text-emerald-400 uppercase tracking-wide">{t.label}</div>
            <div className="font-mono font-bold text-emerald-400 text-sm">${fmt(t.price)}</div>
            <div className="text-[10px] text-slate-500">+{t.pct}% from entry</div>
          </div>
        ))}
      </div>

      {/* Invalidation */}
      <div className="flex items-start gap-2 bg-red-500/5 border border-red-500/15 rounded-lg p-3">
        <AlertTriangle className="w-3.5 h-3.5 text-red-400 shrink-0 mt-0.5" />
        <div>
          <div className="text-[10px] text-red-400 font-semibold uppercase tracking-wide mb-0.5">Invalidation</div>
          <p className="text-xs text-slate-400">{trade.invalidation}</p>
        </div>
      </div>
    </div>
  )
}
