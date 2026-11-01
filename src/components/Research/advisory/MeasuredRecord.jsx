/**
 * The AI Advisory Engine's measured numbers (server: lib/advisory-engine.js).
 *
 *  MeasuredRing     — how often this signal type has actually been right,
 *                     from recorded signals scored against real prices; an
 *                     explicit "uncalibrated" ring until there are enough.
 *  RuleBacktest     — the engine's own price-only rule tested walk-forward on
 *                     this symbol, beside the base rate of the same windows.
 */
import { SIGNAL_TYPES } from '../../../services/aiEngine'

const pc = v => (v == null ? '—' : `${Math.round(v * 100)}%`)

export function MeasuredRing({ calibration, signal, recorded }) {
  const cfg = SIGNAL_TYPES[signal] || SIGNAL_TYPES.HOLD
  const c = calibration?.bySignal?.[signal]
  const r = 36, circ = 2 * Math.PI * r
  const measured = c?.sufficient && c.winRate != null
  const pct = measured ? c.winRate * 100 : 0
  return (
    <div className="flex flex-col items-center gap-1 max-w-[180px] text-center">
      <div className="relative flex items-center justify-center w-24 h-24">
        <svg className="absolute" width="96" height="96" viewBox="0 0 96 96">
          <circle cx="48" cy="48" r={r} fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8"
            strokeDasharray={measured ? undefined : '4 6'} />
          {measured && (
            <circle cx="48" cy="48" r={r} fill="none" stroke={cfg.color} strokeWidth="8"
              strokeDasharray={`${(pct / 100) * circ} ${circ}`} strokeDashoffset={circ / 4}
              strokeLinecap="round" style={{ transition: 'stroke-dasharray 1s ease' }} />
          )}
        </svg>
        <div className="z-10">
          <div className="font-black text-xl text-white">{measured ? `${Math.round(pct)}%` : '—'}</div>
          <div className="text-[9px] text-slate-500 uppercase tracking-wide">{measured ? 'measured right' : 'uncalibrated'}</div>
        </div>
      </div>
      <div className="text-[10px] text-slate-500 leading-snug">
        {!calibration ? 'Sign in to see this engine\'s measured record.'
          : measured
            ? <>{c.wins} of {c.nScored} past {cfg.label} signals were right after a week (95%: {pc(c.winRateLo)}–{pc(c.winRateHi)}){c.alphaWinRate != null ? `; ${pc(c.alphaWinRate)} beat the market` : ''}.</>
            : <>{c?.n ?? 0} of {calibration.minSample} scored {cfg.label} signals needed before a hit rate is shown — {c?.recorded ?? 0} recorded so far.</>}
      </div>
      {recorded && (
        <div className="text-[9px] text-slate-600">
          {recorded.recorded ? `This signal is recorded at $${recorded.price} (${recorded.priceAsOf}) and will be scored.` : recorded.reason}
        </div>
      )}
    </div>
  )
}

function Side({ title, side, correct }) {
  if (!side) return null
  const tone = side.verdict === 'beats-base-rate' ? 'text-emerald-400'
    : side.verdict === 'worse-than-base-rate' ? 'text-red-400'
    : side.verdict === 'insufficient' ? 'text-slate-500' : 'text-amber-400'
  return (
    <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 space-y-1">
      <div className="text-[11px] font-semibold text-slate-300">{title}</div>
      {side.signals ? (
        <div className="text-[11px] text-slate-400 leading-snug">
          {side.hits} of {side.signals} were {correct} — <span className="font-mono text-white">{pc(side.hitRate)}</span> (95%: {pc(side.hitRateLo)}–{pc(side.hitRateHi)})
          {' '}vs <span className="font-mono text-white">{pc(side.baseRate)}</span> for any window. Average {side.avgReturnPct}% per signal.
        </div>
      ) : <div className="text-[11px] text-slate-500">The rule gave no such signal in this history.</div>}
      <div className={`text-[11px] font-medium ${tone}`}>{side.text}</div>
    </div>
  )
}

export function RuleBacktest({ backtest, loading, error }) {
  return (
    <div className="glass rounded-xl p-4 space-y-2">
      <h3 className="font-semibold text-white text-sm">Does this engine's rule work on this stock?</h3>
      {loading && <p className="text-[11px] text-slate-500">Testing the rule on five years of daily bars…</p>}
      {error && <p className="text-[11px] text-amber-400">{error}</p>}
      {backtest && (
        <>
          <p className="text-[11px] text-slate-400 leading-snug">
            {backtest.windows} non-overlapping {backtest.horizon}-session windows, {backtest.from} → {backtest.to}. Average window {backtest.avgReturnAllPct}% net of costs.
          </p>
          <div className="grid sm:grid-cols-2 gap-2">
            <Side title="BUY / STRONG BUY signals" side={backtest.buy} correct="up" />
            <Side title="SELL signals" side={backtest.sell} correct="down" />
          </div>
          <p className="text-[10px] text-slate-500 leading-snug">Tests the {backtest.rule}. {backtest.caveat}</p>
        </>
      )}
    </div>
  )
}
