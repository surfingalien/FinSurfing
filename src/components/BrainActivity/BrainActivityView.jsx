/**
 * BrainActivityView — "look inside the brain" thought stream.
 *
 * Surfaces the per-pick reasoning the AI Brain scan already produces but used to
 * discard: scores, cross-model ensemble (dis)agreement, the mechanical baseline
 * delta, agent conflict, falsifiable thesis assumptions, and — once the nightly
 * job resolves them — the benchmark-relative outcome. Pairs each pick with the
 * deterministic confidence-calibration stats so a "High" claim is shown next to
 * how High-confidence picks have *actually* performed vs. their benchmark.
 *
 * Reads GET /api/ai-brain/activity. No new infrastructure — pure observability
 * over data/ai-brain-predictions.jsonl + data/brain-learnings.json.
 */

import { useState, useRef, useEffect } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
  Activity, RefreshCw, GitBranch, Scale, AlertTriangle, Target,
  TrendingUp, TrendingDown, Brain, Sparkles, ChevronDown, ChevronUp,
  Cpu, Layers, TerminalSquare, Radio,
} from 'lucide-react'
import { useQuery, fetchJson } from '../../hooks/useQuery'
import { fmtPct } from '../../services/api'

// ── Helpers ───────────────────────────────────────────────────────────────────

function timeSince(isoStr) {
  if (!isoStr) return '—'
  const diff = Math.floor((Date.now() - new Date(isoStr).getTime()) / 1000)
  if (diff < 60)   return `${diff}s ago`
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`
  return `${Math.floor(diff / 86400)}d ago`
}

const VERDICT_COLOR = {
  'STRONG BUY': 'text-emerald-400',
  'BUY':        'text-emerald-400',
  'ACCUMULATE': 'text-teal-400',
  'HOLD':       'text-slate-400',
  'AVOID':      'text-red-400',
  'SELL':       'text-red-400',
}

function scoreColor(v) {
  if (v == null) return 'text-slate-600'
  if (v >= 75) return 'text-emerald-400'
  if (v >= 55) return 'text-teal-400'
  if (v >= 40) return 'text-amber-400'
  return 'text-red-400'
}

// A pick is "interesting" for research when the models disagree: the second
// model declined to confirm, or the AI took a contrarian-to-momentum stance.
function isDisagreement(t) {
  return t.ensemble === 'primary-only' || (t.baseline && !t.baseline.agrees)
}

// ── Calibration strip ─────────────────────────────────────────────────────────

function CalibrationStrip({ calibration, ensemble, baseline }) {
  const buckets = calibration ? Object.entries(calibration) : []
  if (!buckets.length && !ensemble && !baseline) return null

  return (
    <div className="rounded-xl border border-white/[0.06] bg-[#0a0f1a] px-4 py-3 space-y-2.5">
      {buckets.length > 0 && (
        <div>
          <div className="text-[10px] text-slate-600 uppercase tracking-wide mb-1.5 flex items-center gap-1">
            <Scale size={9} /> Confidence calibration — stated confidence → actual alpha win rate
          </div>
          <div className="flex flex-wrap gap-2">
            {buckets.map(([bucket, c]) => {
              const rate = c.alphaWinRate ?? c.winRate
              const good = rate != null && rate >= 0.5
              return (
                <span
                  key={bucket}
                  className={`text-[11px] px-2 py-1 rounded-lg border ${
                    good ? 'border-emerald-500/25 bg-emerald-500/10 text-emerald-300'
                         : 'border-amber-500/25 bg-amber-500/10 text-amber-300'
                  }`}
                >
                  {bucket}: {rate != null ? `${(rate * 100).toFixed(0)}%` : 'n/a'}
                  <span className="text-slate-500"> · n={c.n}</span>
                </span>
              )
            })}
          </div>
        </div>
      )}

      <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px] text-slate-500">
        {ensemble && (
          <span className="flex items-center gap-1">
            <GitBranch size={10} className="text-[#00ffcc]" />
            Ensemble agreement alpha:
            {ensemble.confirmed && <b className="text-emerald-400 ml-1">confirmed {(((ensemble.confirmed.alphaWinRate ?? ensemble.confirmed.winRate) ?? 0) * 100).toFixed(0)}%</b>}
            {ensemble.unconfirmed && <span className="text-slate-400 ml-1">primary-only {(((ensemble.unconfirmed.alphaWinRate ?? ensemble.unconfirmed.winRate) ?? 0) * 100).toFixed(0)}%</span>}
          </span>
        )}
        {baseline && (
          <span className="flex items-center gap-1">
            <Cpu size={10} className="text-sky-400" />
            AI vs TA baseline (7d): AI {(((baseline.aiWinRate7d) ?? 0) * 100).toFixed(0)}% · baseline {(((baseline.baselineAccuracy7d) ?? 0) * 100).toFixed(0)}%
          </span>
        )}
      </div>
    </div>
  )
}

// ── A single "thought" ─────────────────────────────────────────────────────────

function ThoughtRow({ t, idx, calibration, onAnalyze }) {
  const [open, setOpen] = useState(false)
  const verdictClass = VERDICT_COLOR[(t.verdict || '').toUpperCase()] || 'text-slate-400'
  const calib = t.confidence && calibration ? calibration[t.confidence] : null
  const calibRate = calib ? (calib.alphaWinRate ?? calib.winRate) : null
  const disagree = isDisagreement(t)

  return (
    <motion.div
      initial={{ opacity: 0, x: -6 }}
      animate={{ opacity: 1, x: 0 }}
      transition={{ delay: Math.min(idx * 0.025, 0.4) }}
      className={`rounded-lg border overflow-hidden ${
        disagree ? 'border-amber-500/20 bg-amber-500/[0.03]' : 'border-white/[0.05] bg-[#0a0f1a]'
      }`}
    >
      <button onClick={() => setOpen(o => !o)} className="w-full flex items-center gap-2.5 px-3 py-2 text-left font-mono">
        <span className="text-[10px] text-slate-600 flex-shrink-0 w-14">{timeSince(t.generatedAt)}</span>
        <span className="text-[#00ffcc] flex-shrink-0">›</span>
        <button
          onClick={(e) => { e.stopPropagation(); onAnalyze?.(t.symbol) }}
          className="font-bold text-sm text-white hover:text-[#00ffcc] transition-colors flex-shrink-0"
        >
          {t.symbol}
        </button>
        {t.verdict && <span className={`text-[10px] font-semibold flex-shrink-0 ${verdictClass}`}>{t.verdict}</span>}

        <span className="text-[10px] text-slate-500 flex-shrink-0">
          comp <b className={scoreColor(t.scores.composite)}>{t.scores.composite ?? '—'}</b>
        </span>

        {/* Disagreement / signal badges */}
        <div className="flex items-center gap-1.5 ml-auto flex-shrink-0">
          {t.ensemble === 'primary-only' && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-amber-500/10 text-amber-400 border border-amber-500/20">model split</span>
          )}
          {t.ensemble === 'confirmed' && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">both agree</span>
          )}
          {t.baseline && !t.baseline.agrees && (
            <span className="text-[9px] px-1.5 py-0.5 rounded bg-sky-500/10 text-sky-400 border border-sky-500/20">contrarian</span>
          )}
          {t.conflict && <AlertTriangle size={11} className="text-amber-500" />}
          {t.outcome && (
            <OutcomeBadge outcome={t.outcome} />
          )}
          <span className="text-slate-600">{open ? <ChevronUp size={13} /> : <ChevronDown size={13} />}</span>
        </div>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.16 }}
            className="overflow-hidden"
          >
            <div className="px-3 pb-3 pt-1 border-t border-white/[0.04] space-y-2.5 text-xs">
              {/* Score breakdown */}
              <div className="grid grid-cols-3 sm:grid-cols-6 gap-1.5 pt-2">
                {[
                  ['Fund', t.scores.fundamental], ['Tech', t.scores.technical],
                  ['Sent', t.scores.sentiment], ['Macro', t.scores.macro],
                  ['Risk', t.scores.risk], ['Comp', t.scores.composite],
                ].map(([label, v]) => (
                  <div key={label} className="rounded bg-[#060810] border border-white/[0.04] px-2 py-1 text-center">
                    <div className="text-[9px] text-slate-600 uppercase">{label}</div>
                    <div className={`text-sm font-bold font-mono ${scoreColor(v)}`}>{v ?? '—'}</div>
                  </div>
                ))}
              </div>

              {/* Reasoning signals */}
              <div className="space-y-1.5 text-slate-400">
                {t.confidence && (
                  <div className="flex items-start gap-2">
                    <Scale size={12} className="text-slate-500 mt-0.5 flex-shrink-0" />
                    <span>
                      Stated <b className="text-white">{t.confidence}</b> confidence
                      {calibRate != null && (
                        <span className={calibRate >= 0.5 ? 'text-emerald-400' : 'text-amber-400'}>
                          {' '}— this band has historically beaten its benchmark {(calibRate * 100).toFixed(0)}% of the time
                          {calibRate < 0.5 && ' (be skeptical)'}
                        </span>
                      )}
                    </span>
                  </div>
                )}
                {t.ensemble && (
                  <div className="flex items-start gap-2">
                    <GitBranch size={12} className="text-slate-500 mt-0.5 flex-shrink-0" />
                    <span>
                      Cross-model: {t.ensemble === 'confirmed'
                        ? 'both models independently picked this with a matching verdict.'
                        : 'only the primary model picked this — the second model did not confirm.'}
                    </span>
                  </div>
                )}

                {/* Model-split drill-down — only when the models actually diverged */}
                {(t.ensemble === 'primary-only' || t.ensembleDetail?.verdictMatch === false) && (
                  <div className="rounded bg-amber-500/[0.05] border border-amber-500/15 px-3 py-2 ml-5">
                    <div className="text-[10px] text-amber-400 uppercase tracking-wide mb-1 flex items-center gap-1">
                      <GitBranch size={9} /> Why the models split
                    </div>
                    <div className="text-[11px] text-slate-400 space-y-0.5">
                      {t.ensembleDetail?.inSecondModel === false && (
                        <div>The second model did not surface this symbol at all — this is single-model conviction.</div>
                      )}
                      {t.ensembleDetail?.inSecondModel && t.ensembleDetail?.verdictMatch === false && (
                        <div>
                          Both models picked it, but disagreed on the call — primary said <b className="text-white">{t.verdict}</b>,
                          the second model said <b className="text-white">{t.ensembleDetail.secondVerdict ?? 'something else'}</b>.
                        </div>
                      )}
                      {t.ensembleDetail?.scoreDelta != null && (
                        <div>Composite-score gap between models: <b className="text-white">{t.ensembleDetail.scoreDelta}</b> pts.</div>
                      )}
                      {t.baseline && (
                        <div>
                          Tie-breaker — the mechanical TA baseline leans <b className="text-white">{t.baseline.dir}</b>,
                          {t.baseline.agrees ? ' siding with the primary model.' : ' siding against the primary model.'}
                        </div>
                      )}
                      {!t.ensembleDetail && (
                        <div className="text-slate-500">Detailed split data wasn't logged for this older pick — newer scans capture the second model's verdict.</div>
                      )}
                    </div>
                  </div>
                )}
                {t.baseline && (
                  <div className="flex items-start gap-2">
                    <Cpu size={12} className="text-slate-500 mt-0.5 flex-shrink-0" />
                    <span>
                      Mechanical TA baseline called <b className="text-white">{t.baseline.dir}</b>
                      {t.baseline.prob != null && ` (${(t.baseline.prob * 100).toFixed(0)}% up-prob)`}
                      {' — '}
                      {t.baseline.agrees ? 'agrees with the AI.' : 'the AI is taking a contrarian-to-momentum stance.'}
                    </span>
                  </div>
                )}
                {t.thesis?.length > 0 && (
                  <div className="flex items-start gap-2">
                    <Target size={12} className="text-slate-500 mt-0.5 flex-shrink-0" />
                    <div>
                      <span className="text-slate-500">Falsifiable thesis:</span>
                      <ul className="list-disc list-inside text-slate-400 mt-0.5">
                        {t.thesis.map((a, i) => <li key={i}>{a}</li>)}
                      </ul>
                    </div>
                  </div>
                )}
                {t.supervisorNote && (
                  <div className="flex items-start gap-2">
                    <Brain size={12} className="text-slate-500 mt-0.5 flex-shrink-0" />
                    <span className="text-slate-400 italic">{t.supervisorNote}</span>
                  </div>
                )}
                <div className="flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-600 pt-0.5">
                  {t.sector && <span>{t.sector}</span>}
                  {t.assetType && <span>{t.assetType}</span>}
                  {t.volumeSignal && <span>volume: {t.volumeSignal}</span>}
                  {t.catalyst && <span>catalyst: {t.catalyst}</span>}
                </div>
              </div>

              {/* Resolved outcome */}
              {t.outcome && (
                <div className="rounded bg-[#060810] border border-white/[0.05] px-3 py-2">
                  <div className="text-[10px] text-slate-600 uppercase tracking-wide mb-1">Resolved outcome</div>
                  <div className="flex flex-wrap gap-x-5 gap-y-1 text-[11px]">
                    {t.outcome.entered === false && (
                      <span className="text-slate-500">entry zone never filled (excluded from win rate)</span>
                    )}
                    <OutcomeStat label="7d" ret={t.outcome.ret7d} bench={t.outcome.benchRet7d} />
                    <OutcomeStat label="30d" ret={t.outcome.ret30d} bench={t.outcome.benchRet30d} />
                  </div>
                </div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  )
}

function OutcomeBadge({ outcome }) {
  const ret = outcome.ret30d ?? outcome.ret7d
  if (ret == null) return null
  const up = ret >= 0
  return (
    <span className={`text-[10px] font-mono font-semibold flex items-center gap-0.5 ${up ? 'text-emerald-400' : 'text-red-400'}`}>
      {up ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
      {fmtPct(ret)}
    </span>
  )
}

function OutcomeStat({ label, ret, bench }) {
  if (ret == null) return null
  const alpha = bench != null ? ret - bench : null
  return (
    <span className="text-slate-400">
      <span className="text-slate-600">{label}:</span>{' '}
      <b className={ret >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtPct(ret)}</b>
      {bench != null && (
        <span className="text-slate-600"> vs bench {fmtPct(bench)}{' '}
          <span className={alpha >= 0 ? 'text-emerald-500' : 'text-red-500'}>(α {fmtPct(alpha)})</span>
        </span>
      )}
    </span>
  )
}

// ── Live terminal mode ──────────────────────────────────────────────────────
// Renders the same feed as a continuous monospace tail, oldest→newest, that
// auto-scrolls to the freshest line as polling brings new picks in.

function TerminalLine({ t }) {
  const ts = new Date(t.generatedAt).toLocaleTimeString('en-US', { hour12: false })
  const ret = t.outcome ? (t.outcome.ret30d ?? t.outcome.ret7d) : null
  const verdictClass = VERDICT_COLOR[(t.verdict || '').toUpperCase()] || 'text-slate-400'
  return (
    <div className="flex flex-wrap items-center gap-x-2">
      <span className="text-slate-600">[{ts}]</span>
      <span className="text-[#00ffcc]">›</span>
      <span className="text-white font-bold w-14">{t.symbol}</span>
      <span className={verdictClass}>{t.verdict || '—'}</span>
      <span className="text-slate-500">comp <b className={scoreColor(t.scores.composite)}>{t.scores.composite ?? '—'}</b></span>
      {t.ensemble === 'confirmed'    && <span className="text-emerald-400">⑂ both</span>}
      {t.ensemble === 'primary-only' && <span className="text-amber-400">⑂ split</span>}
      {t.baseline && !t.baseline.agrees && <span className="text-sky-400">contrarian</span>}
      {t.conflict && <span className="text-amber-500">⚠ conflict</span>}
      {ret != null && <span className={ret >= 0 ? 'text-emerald-400' : 'text-red-400'}>{fmtPct(ret)}</span>}
      {isDisagreement(t) && <span className="text-amber-500/60">◄ review</span>}
    </div>
  )
}

function TerminalStream({ feed }) {
  const endRef = useRef(null)
  const lines  = [...feed].reverse() // newest-first feed → oldest-first tail
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [feed.length])

  return (
    <div className="rounded-xl border border-[#00ffcc]/15 bg-black/60 font-mono text-[11px] leading-relaxed overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-white/[0.06] bg-[#0a0f1a]">
        <Radio size={10} className="text-[#00ffcc] animate-pulse" />
        <span className="text-[#00ffcc] text-[10px] tracking-wide">brain://activity — live tail · auto-scroll</span>
      </div>
      <div className="max-h-[60vh] overflow-y-auto px-3 py-2 space-y-0.5">
        {lines.map(t => <TerminalLine key={`${t.symbol}-${t.generatedAt}`} t={t} />)}
        <div ref={endRef} className="flex items-center gap-1.5 text-[#00ffcc] pt-1.5">
          <span>brain@finsurf:~$</span>
          <span className="inline-block w-2 h-3.5 bg-[#00ffcc] animate-pulse" />
        </div>
      </div>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function BrainActivityView({ onAnalyze }) {
  const [filter, setFilter] = useState('all') // all | splits | resolved
  const [live,   setLive]   = useState(false)
  const { data, loading, fetching, error, refetch } = useQuery(
    'ai-brain-activity',
    () => fetchJson('/api/ai-brain/activity?limit=60'),
    { staleMs: 30_000, refetchMs: live ? 20_000 : 60_000 },
  )

  const feed = data?.feed ?? []
  const splitCount    = feed.filter(isDisagreement).length
  const resolvedCount = feed.filter(t => t.outcome).length

  const filtered = filter === 'splits'   ? feed.filter(isDisagreement)
                 : filter === 'resolved' ? feed.filter(t => t.outcome)
                 : feed

  return (
    <div className="space-y-4 max-w-3xl mx-auto">

      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-bold text-white flex items-center gap-2">
            <Activity size={18} className="text-[#00ffcc]" />
            Brain Activity
          </h1>
          <p className="text-xs text-slate-500 mt-0.5">
            Inside the AI Brain — every pick's reasoning, model (dis)agreement, and graded outcome
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.totalLogged != null && (
            <span className="text-[10px] text-slate-600">{data.totalLogged} logged</span>
          )}
          <button
            onClick={() => setLive(l => !l)}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-xs font-medium transition-all ${
              live
                ? 'bg-[#00ffcc]/15 border-[#00ffcc]/30 text-[#00ffcc]'
                : 'bg-transparent border-white/[0.07] text-slate-500 hover:text-white'
            }`}
            title={live ? 'Live terminal — auto-scrolling, polling every 20s' : 'Switch to live terminal tail'}
          >
            <TerminalSquare size={12} />
            {live ? 'Live' : 'Terminal'}
          </button>
          <button
            onClick={refetch}
            disabled={fetching}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[#00ffcc]/10 border border-[#00ffcc]/20 text-[#00ffcc] text-xs font-medium hover:bg-[#00ffcc]/20 transition-all disabled:opacity-40"
          >
            <RefreshCw size={11} className={fetching ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </div>

      {/* Calibration strip */}
      {data?.available && (
        <CalibrationStrip calibration={data.calibration} ensemble={data.ensemble} baseline={data.baseline} />
      )}

      {/* Error */}
      {error && !loading && (
        <div className="rounded-xl border border-red-500/20 bg-red-500/5 px-4 py-3 text-sm text-red-400">
          {error.message}
        </div>
      )}

      {/* Loading skeleton */}
      {loading && (
        <div className="space-y-2">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="h-9 rounded-lg bg-slate-800/40 animate-pulse" style={{ animationDelay: `${i * 70}ms` }} />
          ))}
        </div>
      )}

      {/* Filters + feed */}
      {!loading && feed.length > 0 && (
        <>
          <div className="flex gap-1.5 flex-wrap">
            {[
              { id: 'all',      label: `All (${feed.length})`,          icon: Layers },
              { id: 'splits',   label: `Disagreements (${splitCount})`, icon: GitBranch },
              { id: 'resolved', label: `Graded (${resolvedCount})`,     icon: Target },
            ].map(tab => {
              const Icon = tab.icon
              return (
                <button
                  key={tab.id}
                  onClick={() => setFilter(tab.id)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-all border flex items-center gap-1.5 ${
                    filter === tab.id
                      ? 'bg-[#00ffcc]/15 border-[#00ffcc]/30 text-[#00ffcc]'
                      : 'bg-transparent border-white/[0.07] text-slate-500 hover:text-white'
                  }`}
                >
                  <Icon size={11} /> {tab.label}
                </button>
              )
            })}
          </div>

          {live ? (
            <TerminalStream feed={filtered} />
          ) : (
            <div className="space-y-1.5">
              <AnimatePresence mode="popLayout">
                {filtered.map((t, i) => (
                  <ThoughtRow
                    key={`${t.symbol}-${t.generatedAt}`}
                    t={t}
                    idx={i}
                    calibration={data.calibration}
                    onAnalyze={onAnalyze}
                  />
                ))}
              </AnimatePresence>
            </div>
          )}

          {filtered.length === 0 && (
            <div className="text-center py-8 text-slate-600 text-sm">Nothing in this view yet.</div>
          )}
        </>
      )}

      {/* Empty state */}
      {!loading && !error && feed.length === 0 && (
        <div className="rounded-xl border border-white/[0.06] bg-[#0a0f1a] px-6 py-10 text-center">
          <Brain size={32} className="mx-auto text-[#00ffcc]/20 mb-3" />
          <p className="text-slate-400 text-sm font-medium">No brain activity logged yet</p>
          <p className="text-slate-600 text-xs mt-1">
            Run an AI Brain scan — each pick's reasoning will stream here, and outcomes appear after the nightly resolver grades them.
          </p>
        </div>
      )}

      {data?.available && (
        <p className="text-[10px] text-slate-700 text-center">
          <Sparkles size={10} className="inline mr-1 text-[#00ffcc]" />
          Reasoning + calibration from the brain's own track record · outcomes graded vs benchmark · not financial advice
        </p>
      )}
    </div>
  )
}
