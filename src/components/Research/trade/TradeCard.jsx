import { AlertTriangle, Clock } from 'lucide-react'
import { fmt } from '../../../services/api'
import { signedPct } from '../../../utils/formatPct'

/* ── Trade card ──────────────────────────────────── */
// The setup comes from generateAdvisory (src/services/research.js). A long is
// built and checked by lib/horizon-setups.js:advisoryLongSetup; one whose
// levels are not 0 < stop < every entry < TP1 ≤ TP2 arrives as
// `valid: false` with a `reason` and no levels, and so does a Neutral stance
// (no trade). The card then shows the reason, never the levels.
export default function TradeCard({ trade, stance }) {
  if (trade?.valid === false) return <NoTradeCard trade={trade} stance={stance} />

  const isBuy  = stance === 'Bullish'
  const isHold = stance === 'Neutral'
  const actionColor = isBuy ? 'text-emerald-400' : isHold ? 'text-amber-400' : 'text-red-400'
  const borderColor = isBuy ? 'border-emerald-500/25' : isHold ? 'border-amber-500/25' : 'border-red-500/25'
  const rrColor = rr => rr >= 2 ? 'text-emerald-400' : rr >= 1.5 ? 'text-amber-400' : 'text-red-400'
  const ref = trade.reference != null ? `$${fmt(trade.reference)}` : 'entry'
  // A long's R/R is quoted for a fill at the top of the entry zone (the worst
  // fill); `riskRewardBest` is the fill at the bottom.
  const hasRange = trade.riskRewardBest != null && trade.riskRewardBest !== trade.riskReward

  return (
    <div className={`glass rounded-xl p-5 border ${borderColor} space-y-4`}>
      <div className="flex items-center justify-between">
        <div>
          <div className={`text-2xl font-black tracking-tight ${actionColor}`}>{trade.action}</div>
          <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
            <Clock className="w-3 h-3" /> {trade.holdingPeriod}
          </div>
        </div>
        {trade.riskReward != null && (
          <div className="text-right">
            <div className="text-xs text-slate-400">Risk/Reward</div>
            <div className={`text-xl font-bold font-mono ${rrColor(trade.riskReward)}`}
              title={hasRange ? 'To TP1, for a fill at the top of the entry zone' : 'To TP1'}>
              {trade.riskReward}:1
            </div>
            {hasRange && (
              <div className="text-[10px] text-slate-500">
                top of zone · <span className={rrColor(trade.riskRewardBest)}>{trade.riskRewardBest}:1</span> at bottom
              </div>
            )}
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
          <div className="text-[10px] text-slate-500">
            {Math.abs(trade.stopLoss.pct)}% from {ref} · {trade.stopLoss.rationale}
          </div>
        </div>
        {trade.targets.map((t, i) => (
          <div key={i} className="glass-card space-y-0.5 border border-emerald-500/15">
            <div className="text-[10px] text-emerald-400 uppercase tracking-wide">{t.label}</div>
            <div className="font-mono font-bold text-emerald-400 text-sm">${fmt(t.price)}</div>
            <div className="text-[10px] text-slate-500">{signedPct(t.pct, 1)} from {ref}</div>
          </div>
        ))}
      </div>
      {trade.targetNote && <p className="text-[10px] text-slate-500 -mt-1">{trade.targetNote}</p>}

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

/* ── No trade: Neutral stance, or a setup that failed its check ── */
function NoTradeCard({ trade, stance }) {
  const isHold = stance === 'Neutral'
  const watch  = trade.watch
  return (
    <div className={`glass rounded-xl p-5 border ${isHold ? 'border-amber-500/25' : 'border-white/[0.08]'} space-y-4`}>
      <div>
        <div className={`text-2xl font-black tracking-tight ${isHold ? 'text-amber-400' : 'text-slate-300'}`}>{trade.action}</div>
        <div className="text-xs text-slate-500 mt-0.5 flex items-center gap-1">
          <Clock className="w-3 h-3" /> {isHold ? trade.holdingPeriod : 'No entry, stop or target'}
        </div>
      </div>

      <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-xs space-y-1">
        <div className="font-semibold text-slate-300">{isHold ? 'No active trade' : 'No valid setup'}</div>
        <div className="text-slate-500">{trade.reason}</div>
        {!isHold && stance === 'Bullish' && (
          <div className="text-slate-600">The stance is bullish, but these levels do not make a coherent long, so none are shown.</div>
        )}
        {trade.reference != null && <div className="text-slate-600">Price ${fmt(trade.reference)}</div>}
      </div>

      {watch && (watch.support != null || watch.resistance != null) && (
        <div className="grid grid-cols-2 gap-3">
          <div className="glass-card space-y-0.5">
            <div className="text-[10px] text-emerald-400 uppercase tracking-wide">Support below</div>
            <div className="font-mono font-bold text-white text-sm">{watch.support != null ? `$${fmt(watch.support)}` : '—'}</div>
          </div>
          <div className="glass-card space-y-0.5">
            <div className="text-[10px] text-red-400 uppercase tracking-wide">Resistance above</div>
            <div className="font-mono font-bold text-white text-sm">{watch.resistance != null ? `$${fmt(watch.resistance)}` : '—'}</div>
          </div>
        </div>
      )}
    </div>
  )
}
