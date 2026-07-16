/**
 * TrackRecordPanel.jsx
 *
 * The AI Brain's public scorecard — fetched from /api/ai-brain/learnings.
 * Shows benchmark-relative (alpha) win rates, confidence calibration,
 * cross-model ensemble splits, predictive signal factors, and risk signals
 * — all computed deterministically by lib/brain-learnings.js.
 */

import { useState, useEffect } from 'react'
import { Target, ChevronDown, ChevronUp, Sparkles, Scale, TrendingUp, AlertTriangle, Pencil, Pin, X, Check } from 'lucide-react'
import { useQuery, fetchJson, invalidateQuery } from '../../hooks/useQuery'
import { useAuth } from '../../contexts/AuthContext'

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

// White-box editable memory: the Brain writes keyLearnings nightly; a signed-in
// operator can suppress a wrong/stale finding, pin their own, and set a
// directive note. Edits are stored as overrides (PUT /learnings/overrides) that
// layer on top of the AI output and survive the next nightly regeneration.
function EditableLearnings({ data }) {
  const { authFetch, isAuthenticated } = useAuth()
  const [editing, setEditing] = useState(false)
  const [suppressed, setSuppressed] = useState([])
  const [pinned, setPinned] = useState([])
  const [note, setNote] = useState('')
  const [newPin, setNewPin] = useState('')
  const [saving, setSaving] = useState(false)
  const [msg, setMsg] = useState(null)

  // Seed local edit state from the server's overrides whenever they change.
  useEffect(() => {
    const o = data.overrides || {}
    setSuppressed(o.suppressed || [])
    setPinned(o.pinned || [])
    setNote(o.note || '')
  }, [data.overrides])

  const learnings = data.keyLearnings || []
  const isSuppressed = (l) => suppressed.some(s => s.trim().toLowerCase() === String(l).trim().toLowerCase())
  const toggleSuppress = (l) =>
    setSuppressed(prev => isSuppressed(l) ? prev.filter(s => s.trim().toLowerCase() !== String(l).trim().toLowerCase()) : [...prev, l])
  const addPin = () => { const v = newPin.trim(); if (v) { setPinned(prev => [...prev, v]); setNewPin('') } }
  const removePin = (i) => setPinned(prev => prev.filter((_, idx) => idx !== i))

  const save = async () => {
    setSaving(true); setMsg(null)
    try {
      const res = await authFetch('/api/ai-brain/learnings/overrides', {
        method: 'PUT',
        body: { suppressed, pinned, note },
      })
      if (!res.ok) throw new Error('save failed')
      setMsg('Saved — the Brain will use this on its next scan.')
      invalidateQuery('ai-brain-learnings')
      setEditing(false)
    } catch {
      setMsg('Could not save. Check that you are signed in.')
    } finally { setSaving(false) }
  }

  return (
    <div className="sm:col-span-2">
      <div className="flex items-center justify-between mb-1.5">
        <div className="text-[10px] uppercase tracking-widest text-slate-500">
          What the Brain learned from its own record
        </div>
        {isAuthenticated && (
          <button
            onClick={() => setEditing(v => !v)}
            className="flex items-center gap-1 text-[10px] text-slate-400 hover:text-mint-400 transition-colors"
          >
            <Pencil className="w-3 h-3" /> {editing ? 'Done' : 'Edit memory'}
          </button>
        )}
      </div>

      <ul className="space-y-1">
        {learnings.slice(0, 8).map((l, i) => (
          <li key={i} className="text-xs flex items-start gap-2">
            <span className="text-mint-500/60 shrink-0">{i + 1}.</span>
            <span className={isSuppressed(l) ? 'text-slate-600 line-through' : 'text-slate-400'}>{l}</span>
            {editing && (
              <button
                onClick={() => toggleSuppress(l)}
                title={isSuppressed(l) ? 'Restore this learning' : 'Suppress — stop injecting this into scans'}
                className="ml-auto shrink-0 text-slate-500 hover:text-red-400"
              >
                {isSuppressed(l) ? <Check className="w-3 h-3" /> : <X className="w-3 h-3" />}
              </button>
            )}
          </li>
        ))}
        {pinned.map((p, i) => (
          <li key={`pin-${i}`} className="text-xs flex items-start gap-2">
            <Pin className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
            <span className="text-amber-200/90">{p}</span>
            {editing && (
              <button onClick={() => removePin(i)} className="ml-auto shrink-0 text-slate-500 hover:text-red-400">
                <X className="w-3 h-3" />
              </button>
            )}
          </li>
        ))}
      </ul>

      {editing && (
        <div className="mt-2 space-y-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
          <div className="flex gap-2">
            <input
              value={newPin}
              onChange={e => setNewPin(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && addPin()}
              placeholder="Pin your own learning…"
              className="flex-1 bg-black/20 border border-white/[0.08] rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-mint-500/40"
            />
            <button onClick={addPin} className="px-2 py-1 rounded bg-mint-500/15 text-mint-300 text-xs hover:bg-mint-500/25">Pin</button>
          </div>
          <textarea
            value={note}
            onChange={e => setNote(e.target.value)}
            placeholder="Operator directive appended to every scan (e.g. 'Be extra cautious on unprofitable small-caps')…"
            rows={2}
            className="w-full bg-black/20 border border-white/[0.08] rounded px-2 py-1 text-xs text-slate-200 focus:outline-none focus:border-mint-500/40"
          />
          <div className="flex items-center gap-2">
            <button
              onClick={save}
              disabled={saving}
              className="px-3 py-1 rounded bg-mint-500/20 text-mint-300 text-xs font-medium hover:bg-mint-500/30 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save overrides'}
            </button>
            {msg && <span className="text-[10px] text-slate-400">{msg}</span>}
          </div>
        </div>
      )}
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
  const hasPat     = !!stats.byPattern && Object.keys(stats.byPattern).length > 0
  const hasSector  = !!stats.bySector  && Object.keys(stats.bySector).length  > 0

  const hasPredictive = hasScore || hasHC || hasRS || hasVol || hasPat
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
              {hasPat && Object.entries(stats.byPattern)
                .sort((a, b) => (b[1].alphaWinRate ?? 0) - (a[1].alphaWinRate ?? 0))
                .slice(0, 4)
                .map(([pat, c]) => (
                  <BucketRow key={pat} label={`Pattern: ${pat}`} bucket={c} accent={pctColor(c.alphaWinRate)} />
                ))
              }
              {data.bestCompositeThreshold != null && (
                <p className="text-[10px] text-slate-500 mt-1.5">
                  Best score threshold from history: <span className="text-mint-400 font-mono">{data.bestCompositeThreshold}/100</span>
                </p>
              )}
            </div>
          )}

          {/* By sector */}
          {hasSector && (
            <div>
              <SectionHeader icon={TrendingUp} label="By sector (alpha win, top picks)" />
              {Object.entries(stats.bySector)
                .sort((a, b) => b[1].n - a[1].n)
                .slice(0, 6)
                .map(([sector, c]) => (
                  <BucketRow key={sector} label={sector} bucket={c} accent={pctColor(c.alphaWinRate)} />
                ))
              }
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

          {/* Key learnings — editable white-box memory */}
          {(data.keyLearnings?.length > 0 || data.overrides?.pinned?.length > 0) && (
            <EditableLearnings data={data} />
          )}

          {/* Post-mortems */}
          {data.postMortems?.length > 0 && (
            <div className="sm:col-span-2">
              <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-widest text-slate-500 mb-2">
                <AlertTriangle className="w-3 h-3" /> Trade post-mortems — notable failures
              </div>
              <div className="space-y-2">
                {data.postMortems.map((pm, i) => (
                  <div key={i} className="rounded-xl border border-red-500/10 bg-red-500/[0.04] px-3 py-2.5 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-white">{pm.symbol}</span>
                      <div className="flex items-center gap-2 text-xs font-mono">
                        <span className="text-slate-500">{pm.date}</span>
                        {pm.actualReturn30d != null && (
                          <span className="text-red-400">{pm.actualReturn30d > 0 ? '+' : ''}{pm.actualReturn30d.toFixed(1)}%</span>
                        )}
                        {pm.benchmarkReturn30d != null && (
                          <span className="text-slate-500">vs {pm.benchmarkReturn30d > 0 ? '+' : ''}{pm.benchmarkReturn30d.toFixed(1)}% bench</span>
                        )}
                      </div>
                    </div>
                    <p className="text-xs text-red-300/80"><span className="text-red-400/60 font-medium">Root cause: </span>{pm.rootCause}</p>
                    <p className="text-xs text-slate-400"><span className="text-slate-500 font-medium">Lesson: </span>{pm.lessonLearned}</p>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
