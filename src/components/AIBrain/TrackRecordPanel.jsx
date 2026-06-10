/**
 * TrackRecordPanel.jsx
 *
 * The AI Brain's public scorecard — fetched from /api/ai-brain/learnings.
 * Shows benchmark-relative (alpha) win rates, confidence calibration and
 * cross-model ensemble splits computed by lib/brain-learnings.js, plus the
 * key learnings the Brain injects into its own future scans.
 */

import { useState } from 'react'
import { Target, ChevronDown, ChevronUp, Sparkles, Scale } from 'lucide-react'
import { useQuery, fetchJson } from '../../hooks/useQuery'

const fmtPct = v => (v == null ? '—' : `${Math.round(v * 100)}%`)

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
        <span className="text-slate-600"> · {bucket.n} picks</span>
      </span>
    </div>
  )
}

export default function TrackRecordPanel() {
  const [expanded, setExpanded] = useState(false)
  // Learnings refresh nightly — cache for the whole session
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

  // Not enough resolved predictions yet — explain what's coming instead of hiding
  if (!data.available || !stats) {
    return (
      <div className="glass rounded-xl px-4 py-3 border border-white/[0.06] flex items-center gap-3">
        <Target className="w-4 h-4 text-slate-500 shrink-0" />
        <p className="text-xs text-slate-500">
          <span className="text-slate-400 font-medium">Track record: collecting outcomes.</span>{' '}
          Every pick is logged and scored against its real price at +7/+30 days, entry-zone fill,
          and the benchmark (SPY/BTC). Win rates appear once enough predictions resolve.
        </p>
      </div>
    )
  }

  const calBuckets = stats.calibration || {}
  const hasCal     = Object.keys(calBuckets).length > 0
  const hasEns     = !!stats.ensemble

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

      {/* Detail — calibration, ensemble, learnings */}
      {expanded && (
        <div className="px-4 pb-4 pt-1 grid gap-4 sm:grid-cols-2 border-t border-white/[0.05]">
          {hasCal && (
            <div>
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">
                <Scale className="w-3 h-3" /> Confidence calibration (alpha win)
              </div>
              <BucketRow label="High confidence"   bucket={calBuckets.High} />
              <BucketRow label="Medium confidence" bucket={calBuckets.Medium} />
              <BucketRow label="Low confidence"    bucket={calBuckets.Low} accent="text-slate-300" />
              {data.confidenceCalibrated === false && (
                <p className="text-[10px] text-amber-400/80 mt-1.5">
                  ⚠️ Stated confidence has not been predictive so far — treat High-confidence labels with skepticism.
                </p>
              )}
            </div>
          )}

          {hasEns && (
            <div>
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500 mb-1.5">
                <Sparkles className="w-3 h-3" /> Cross-model agreement (alpha win)
              </div>
              <BucketRow label="Both models agreed" bucket={stats.ensemble.confirmed} />
              <BucketRow label="Primary model only" bucket={stats.ensemble.unconfirmed} accent="text-slate-300" />
            </div>
          )}

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
