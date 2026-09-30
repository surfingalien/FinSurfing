import { CheckCircle2, XCircle, ShieldOff, Target, TrendingDown, Scale, Ban } from 'lucide-react'

const pct = (v, dp = 1) => (v == null ? '—' : `${(v * 100).toFixed(dp)}%`)
const px  = v => (v == null ? '—' : `$${Number(v) >= 1 ? Number(v).toFixed(2) : Number(v).toPrecision(4)}`)

function Claim({ c, tone, onCite }) {
  return (
    <li className="flex items-start gap-2 text-[12px]">
      <CheckCircle2 className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${tone}`} />
      <span className="text-slate-300">
        {c.claim}{' '}
        {c.cites.map(id => (
          <button key={id} onClick={() => onCite?.(id)}
            className="font-mono text-[10px] px-1 py-px mx-0.5 rounded bg-slate-500/15 text-slate-400 hover:text-mint-400">
            {id}
          </button>
        ))}
      </span>
    </li>
  )
}

/**
 * A judged thesis. Everything the reader sees here passed a deterministic
 * check; what did not pass is listed separately with the reason — silently
 * dropping it would hide how much of the model's draft failed.
 */
export default function ThesisResult({ data, onCite }) {
  const j = data?.judgement
  if (!j) return null
  const actionable = j.verdict === 'actionable'
  const z = j.zones, ev = j.expectedValue

  return (
    <div className="space-y-3">
      <div className={`glass rounded-2xl p-4 border ${actionable ? 'border-emerald-500/30' : 'border-slate-500/30'}`}>
        <div className="flex items-center gap-2">
          {actionable
            ? <CheckCircle2 className="w-5 h-5 text-emerald-400" />
            : <Ban className="w-5 h-5 text-slate-400" />}
          <span className="font-semibold">{actionable ? 'Actionable long' : 'No trade'}</span>
          <span className="text-[11px] text-slate-500 ml-auto">
            {data.symbol} · ${Number(data.lastPrice).toFixed(2)} on {data.asOf} · {j.horizonDays}-day horizon
          </span>
        </div>
        <ul className="mt-2 space-y-0.5">
          {j.reasons.map((r, i) => <li key={i} className="text-[12px] text-slate-400">• {r}</li>)}
        </ul>
        {j.summary && <p className="text-sm text-slate-300 mt-3">{j.summary}</p>}
        {j.summaryRemoved && (
          <p className="text-[11px] text-amber-400 mt-2">Summary removed — {j.summaryRemoved}.</p>
        )}
      </div>

      <div className="grid md:grid-cols-2 gap-3">
        <div className="glass rounded-2xl p-4">
          <h4 className="text-xs font-semibold text-emerald-400 mb-2">Bull case ({j.bull.length} verified)</h4>
          {j.bull.length ? <ul className="space-y-1.5">{j.bull.map((c, i) => <Claim key={i} c={c} tone="text-emerald-400" onCite={onCite} />)}</ul>
            : <p className="text-[12px] text-slate-500">No bull claim survived verification.</p>}
        </div>
        <div className="glass rounded-2xl p-4">
          <h4 className="text-xs font-semibold text-red-400 mb-2">Bear case ({j.bear.length} verified)</h4>
          {j.bear.length ? <ul className="space-y-1.5">{j.bear.map((c, i) => <Claim key={i} c={c} tone="text-red-400" onCite={onCite} />)}</ul>
            : <p className="text-[12px] text-slate-500">No bear claim survived verification.</p>}
        </div>
      </div>

      {j.invalidation && (
        <div className="glass rounded-2xl p-4 text-[12px]">
          <span className="font-semibold">Proven wrong if: </span><span className="text-slate-400">{j.invalidation}</span>
        </div>
      )}

      {z && (
        <div className="glass rounded-2xl p-4">
          <h4 className="text-xs font-semibold mb-2 flex items-center gap-1.5"><Scale className="w-3.5 h-3.5" /> Levels (derived from the price and the percentages — not taken from the model)</h4>
          <div className="grid grid-cols-3 gap-2 text-[12px]">
            <div><div className="text-slate-500 text-[10px]">Entry zone</div>{px(z.entryLow)}–{px(z.entryHigh)}</div>
            <div><div className="text-slate-500 text-[10px] flex items-center gap-1"><Target className="w-3 h-3" />Target +{z.targetReturn}%</div>{px(z.targetLow)}–{px(z.targetHigh)}</div>
            <div><div className="text-slate-500 text-[10px] flex items-center gap-1"><TrendingDown className="w-3 h-3" />Stop −{z.stopLoss}%</div>{px(z.stopLow)}–{px(z.stopHigh)}</div>
          </div>
        </div>
      )}

      {ev && (
        <div className="glass rounded-2xl p-4 text-[12px] space-y-1">
          <h4 className="text-xs font-semibold mb-1">Expected value, net of {ev.costPct}% round-trip cost</h4>
          <div>Needs a <b>{pct(ev.breakEvenWinProb, 0)}</b> win rate to break even; this system is calibrated at <b>{pct(ev.winProb, 0)}</b> <span className="text-slate-500">({ev.winProbSource})</span>.</div>
          <div>Net edge per unit risked: <b className={ev.netEdge > 0 ? 'text-emerald-400' : 'text-red-400'}>{(ev.netEdge * 100).toFixed(2)}%</b></div>
          {j.sizing?.uncalibrated && <div className="text-amber-400">No position size suggested: {j.sizing.reason}.</div>}
          {j.sizing && !j.sizing.uncalibrated && <div>Suggested size (half-Kelly, capped at {j.sizing.maxPct}%): <b>{j.sizing.suggestedPct}%</b> of the portfolio. A suggestion — nothing is executed.</div>}
        </div>
      )}

      {j.droppedClaims?.length > 0 && (
        <div className="glass rounded-2xl p-4">
          <h4 className="text-xs font-semibold text-amber-400 mb-2 flex items-center gap-1.5"><ShieldOff className="w-3.5 h-3.5" /> Removed by verification ({j.droppedClaims.length})</h4>
          <ul className="space-y-1.5">
            {j.droppedClaims.map((c, i) => (
              <li key={i} className="flex items-start gap-2 text-[12px]">
                <XCircle className="w-3.5 h-3.5 shrink-0 mt-0.5 text-amber-400" />
                <span><span className="text-slate-400 line-through">{c.claim}</span> <span className="text-slate-500">— {c.side}: {c.reason}</span></span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}
