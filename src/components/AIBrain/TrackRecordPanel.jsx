/**
 * TrackRecordPanel.jsx
 *
 * The AI Brain's public scorecard — fetched from /api/ai-brain/learnings.
 * Shows benchmark-relative (alpha) win rates, confidence calibration,
 * cross-model ensemble splits, predictive signal factors, and risk signals
 * — all computed deterministically by lib/brain-learnings.js.
 */

import { useState } from 'react'
import { Target, ChevronDown, ChevronUp, Sparkles, Scale, TrendingUp, AlertTriangle } from 'lucide-react'
import { useQuery, fetchJson } from '../../hooks/useQuery'

const fmtPct = v => (v == null ? '—' : `${Math.round(v * 100)}%`)
const pctColor = (v, neutral = 0.5) => {
  if (v == null) return 'text-slate-400'
  if (v >= neutral + 0.15) return 'text-emerald-400'
  if (v >= neutral - 0.05) return 'text-mint-400'
  return 'text-red-400'
}

function StatCell({ label, value, sub }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[9px] uppercase tracking-widest text-slate-600">{label}</span>
      <span className="text-base font-semibold font-mono text-white">{value}</span>
      {sub && <span className="text-[10px] text-slate-500">{sub}</span>}
    </div>
  )
}

function BucketRow({ label, bucket, accent = 'text-mint-400' }) {
  if (!bucket) return null
  return (
    <div className="flex items-center justify-between text-xs py-1 border-b border-white/[0.04] last:border-0">
      <span className="text-slate-400">{label}</span>
      <span className="font-mono">
        <span className={accent}>{fmtPct(bucket.alphaWinRate ?? bucket.winRate)}</span>
        <span className="text-slate-600"> · {bucket.n}×</span>
      </span>
    </div>
  )
}

function SectionHeader({ icon: Icon, label }) {
  return (
    <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">
      <Icon className="w-3 h-3" /> {label}
    </div>
  )
}

export default function TrackRecordPanel() {
  const [expanded, setExpanded] = useState(false)
  const { data, error } = useQuery(
    'ai-brain-learnings',
    () => fetchJson('/api/ai-brain/learnings'),
    { staleMs: 60 * 60_000 },
  )

  if (error) return null
  if (!data) return null

  const stats = data.stats
  const ageDays = data.updatedAt
    ? Math.max(0, Math.floor((Date.now() - new Date(data.updatedAt).getTime()) / 86400000))
    : null

  if (!data.available || !stats) {
    return (
      <div className="glass rounded-xl px-4 py-3 border border-white/[0.06] flex items-center gap-3">
        <Target className="w-4 h-4 text-slate-500 shrink-0" />
        <p className="text-xs text-slate-500">
          <span className="text-slate-400 font-medium">Track record: collecting outcomes.</span>{' '}
          Every pick is logged and scored against its real price at +7/+30/+90 days, entry-zone fill,
          and the benchmark (SPY/BTC). Win rates appear once enough predictions resolve.
        </p>
      </div>
    )
  }

  const calBuckets = stats.calibration || {}
  const hasCal     = Object.keys(calBuckets).length > 0
  const hasEns     = !!stats.ensemble
  const hasScore   = !!stats.byCompositeScore
  const hasHC      = !!stats.byHighConviction
  const hasRS      = !!stats.byRsRank
  const hasVol     = !!stats.byVolumeSignal
  const hasEarn    = !!stats.earningsWindowImpact
  const hasOpts    = !!stats.optionsFlowImpact
  const hasConfl   = !!stats.conflictImpact

  const hasPredictive = hasScore || hasHC || hasRS || hasVol
  const hasRisk       = hasEarn  || hasOpts || hasConfl

  return (
    <div className="glass rounded-xl border border-white/[0.06] overflow-hidden">
      {/* Summary row — always visible */}
      <button
        onClick={() => setExpanded(v => !v)}
        className="w-full flex items-center gap-4 px-4 py-3 text-left hover:bg-white/[0.02] transition-colors"
      >
        <div className="p-2 rounded-lg bg-mint-500/10 border border-mint-500/20 shrink-0">
          <Target className="w-4 h-4 text-mint-400" />
        </div>

        <div className="flex items-center gap-6 flex-1 flex-wrap">
          <StatCell
            label="Alpha win 30d"
            value={fmtPct(stats.h30?.alphaWinRate)}
            sub="vs SPY/BTC benchmark"
          />
          <StatCell
            label="Alpha win 7d"
            value={fmtPct(stats.h7?.alphaWinRate)}
          />
          {stats.h90 && (
            <StatCell
              label="Alpha win 90d"
              value={fmtPct(stats.h90.alphaWinRate)}
            />
          )}
          <StatCell
            label="Avg alpha 30d"
            value={stats.h30?.avgAlpha != null ? `${stats.h30.avgAlpha > 0 ? '+' : ''}${stats.h30.avgAlpha}%` : '—'}
          />
          <StatCell
            label="Resolved"
            value={stats.totalResolved ?? data.totalResolved ?? '—'}
            sub={ageDays != null ? `updated ${ageDays}d ago` : null}
          />
        </div>

        {expanded ? <ChevronUp className="w-4 h-4 text-slate-500" /> : <ChevronDown className="w-4 h-4 text-slate-500" />}
      </button>

      {expanded && (
        <div className="px-4 pb-4 pt-1 grid gap-4 sm:grid-cols-2 border-t border-white/[0.05]">

          {/* Confidence calibration */}
          {hasCal && (
            <div>
              <SectionHeader icon={Scale} label="Confidence calibration (alpha win)" />
              <BucketRow label="High confidence"   bucket={calBuckets.High} />
              <BucketRow label="Medium confidence" bucket={calBuckets.Medium} />
              <BucketRow label="Low confidence"    bucket={calBuckets.Low} accent="text-slate-300" />
              {data.confidenceCalibrated === false && (
                <p className="text-[10px] text-amber-400/80 mt-1.5">
                  ⚠️ Stated confidence has not been predictive — treat High labels with skepticism.
                </p>
              )}
            </div>
          )}

          {/* Cross-model ensemble */}
          {hasEns && (
            <div>
              <SectionHeader icon={Sparkles} label="Cross-model agreement (alpha win)" />
              <BucketRow label="Both models agreed" bucket={stats.ensemble.confirmed} />
              <BucketRow label="Primary model only" bucket={stats.ensemble.unconfirmed} accent="text-slate-300" />
            </div>
          )}

          {/* Predictive signal factors */}
          {hasPredictive && (
            <div>
              <SectionHeader icon={TrendingUp} label="Predictive signal factors (alpha win)" />
              {hasScore && (
                <>
                  {stats.byCompositeScore.elite  && <BucketRow label="Score ≥80 (elite)"  bucket={stats.byCompositeScore.elite}  accent={pctColor(stats.byCompositeScore.elite?.alphaWinRate)} />}
                  {stats.byCompositeScore.high   && <BucketRow label="Score 70-79 (high)" bucket={stats.byCompositeScore.high}   accent={pctColor(stats.byCompositeScore.high?.alphaWinRate)} />}
                  {stats.byCompositeScore.mid    && <BucketRow label="Score 40-69 (mid)"  bucket={stats.byCompositeScore.mid}    accent={pctColor(stats.byCompositeScore.mid?.alphaWinRate)} />}
                  {stats.byCompositeScore.low    && <BucketRow label="Score <40 (low)"    bucket={stats.byCompositeScore.low}    accent={pctColor(stats.byCompositeScore.low?.alphaWinRate, 0.4)} />}
                </>
              )}
              {hasHC && stats.byHighConviction['true'] && (
                <BucketRow label="High-conviction (≥3 signals)" bucket={stats.byHighConviction['true']} accent={pctColor(stats.byHighConviction['true']?.alphaWinRate)} />
              )}
              {hasRS && (
                <>
                  {stats.byRsRank.strong && <BucketRow label="RS rank strong (71-100)" bucket={stats.byRsRank.strong} accent={pctColor(stats.byRsRank.strong?.alphaWinRate)} />}
                  {stats.byRsRank.mid    && <BucketRow label="RS rank mid (31-70)"     bucket={stats.byRsRank.mid}    accent="text-slate-300" />}
                  {stats.byRsRank.weak   && <BucketRow label="RS rank weak (0-30)"     bucket={stats.byRsRank.weak}   accent={pctColor(stats.byRsRank.weak?.alphaWinRate, 0.4)} />}
                </>
              )}
              {hasVol && stats.byVolumeSignal.Confirming && (
                <BucketRow label="Volume: Confirming" bucket={stats.byVolumeSignal.Confirming} accent={pctColor(stats.byVolumeSignal.Confirming?.alphaWinRate)} />
              )}
              {hasVol && stats.byVolumeSignal.Weak && (
                <BucketRow label="Volume: Weak/Diverging" bucket={stats.byVolumeSignal.Weak} accent="text-slate-300" />
              )}
              {data.bestCompositeThreshold != null && (
                <p className="text-[10px] text-slate-500 mt-1.5">
                  Best score threshold from history: <span className="text-mint-400 font-mono">{data.bestCompositeThreshold}/100</span>
                </p>
              )}
            </div>
          )}

          {/* Risk signals */}
          {hasRisk && (
            <div>
              <SectionHeader icon={AlertTriangle} label="Risk signal calibration (alpha win)" />
              {hasEarn && (
                <>
                  {stats.earningsWindowImpact.imminent  && <BucketRow label="Earnings ≤7d (imminent)"  bucket={stats.earningsWindowImpact.imminent}  accent={pctColor(stats.earningsWindowImpact.imminent?.alphaWinRate, 0.4)} />}
                  {stats.earningsWindowImpact.upcoming  && <BucketRow label="Earnings 8-21d (upcoming)" bucket={stats.earningsWindowImpact.upcoming} accent="text-slate-300" />}
                  {stats.earningsWindowImpact.distant   && <BucketRow label="Earnings >21d (distant)"   bucket={stats.earningsWindowImpact.distant}  accent={pctColor(stats.earningsWindowImpact.distant?.alphaWinRate)} />}
                </>
              )}
              {hasOpts && (
                <>
                  {stats.optionsFlowImpact.bullish && <BucketRow label="Options P/C <0.70 (bullish)" bucket={stats.optionsFlowImpact.bullish} accent={pctColor(stats.optionsFlowImpact.bullish?.alphaWinRate)} />}
                  {stats.optionsFlowImpact.neutral && <BucketRow label="Options P/C neutral"         bucket={stats.optionsFlowImpact.neutral} accent="text-slate-300" />}
                  {stats.optionsFlowImpact.bearish && <BucketRow label="Options P/C ≥1.30 (bearish)" bucket={stats.optionsFlowImpact.bearish} accent={pctColor(stats.optionsFlowImpact.bearish?.alphaWinRate, 0.4)} />}
                </>
              )}
              {hasConfl && stats.conflictImpact.conflict && stats.conflictImpact.noConflict && (
                <>
                  <BucketRow label="No agent conflict"     bucket={stats.conflictImpact.noConflict} accent={pctColor(stats.conflictImpact.noConflict?.alphaWinRate)} />
                  <BucketRow label="Agent conflict ⚠️"    bucket={stats.conflictImpact.conflict}   accent={pctColor(stats.conflictImpact.conflict?.alphaWinRate, 0.4)} />
                </>
              )}
            </div>
          )}

          {/* Vs mechanical TA baseline */}
          {stats.baseline && (
            <div>
              <SectionHeader icon={Scale} label={`Vs mechanical TA baseline (7d, ${stats.baseline.n} picks)`} />
              <div className="flex items-center justify-between text-xs py-1 border-b border-white/[0.04]">
                <span className="text-slate-400">AI win rate</span>
                <span className={`font-mono ${pctColor(stats.baseline.aiWinRate7d)}`}>{fmtPct(stats.baseline.aiWinRate7d)}</span>
              </div>
              <div className="flex items-center justify-between text-xs py-1 border-b border-white/[0.04]">
                <span className="text-slate-400">Baseline accuracy</span>
                <span className="font-mono text-slate-300">{fmtPct(stats.baseline.baselineAccuracy7d)}</span>
              </div>
              <div className="flex items-center justify-between text-xs py-1 border-b border-white/[0.04]">
                <span className="text-slate-400">AI win (baseline agrees)</span>
                <span className="font-mono text-slate-300">{fmtPct(stats.baseline.aiWinWhenBaselineAgrees)}</span>
              </div>
              <div className="flex items-center justify-between text-xs py-1">
                <span className="text-slate-400">AI win (baseline disagrees)</span>
                <span className="font-mono text-slate-300">{fmtPct(stats.baseline.aiWinWhenBaselineDisagrees)}</span>
              </div>
              {stats.baseline.aiWinRate7d != null && stats.baseline.baselineAccuracy7d != null
                && stats.baseline.aiWinRate7d <= stats.baseline.baselineAccuracy7d && (
                <p className="text-[10px] text-amber-400/80 mt-1.5">
                  ⚠️ The AI is not currently beating a simple momentum model on identical picks.
                </p>
              )}
            </div>
          )}

          {/* Key learnings */}
          {data.keyLearnings?.length > 0 && (
            <div className="sm:col-span-2">
              <div className="text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">
                What the Brain learned from its own record
              </div>
              <ul className="space-y-1">
                {data.keyLearnings.slice(0, 6).map((l, i) => (
                  <li key={i} className="text-xs text-slate-400 flex gap-2">
                    <span className="text-mint-500/60 shrink-0">{i + 1}.</span>{l}
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
