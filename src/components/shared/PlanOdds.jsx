/**
 * PlanOdds — what the stock's measured volatility says about a plan's own
 * target and stop (server: lib/plan-odds.js). The no-skill odds of the target
 * first, and whether the stop sits inside ordinary daily noise. A plan worth
 * taking has to beat these odds; the Track record measures whether picks do.
 *
 * Optional extras for the AI Brain: a size only from a MEASURED win rate, the
 * slate weight, and the names this one moves with.
 */
const pc = v => (v == null ? '—' : `${Math.round(v * 100)}%`)

export default function PlanOdds({ plan, sizing = null, slateWeightPct = null, movesWith = null, className = '' }) {
  if (!plan && !sizing && slateWeightPct == null && !movesWith?.length) return null
  const o = plan?.odds, s = plan?.stop
  const stopTone = s?.level === 'inside-noise' ? 'text-amber-400' : s?.level === 'tight' ? 'text-amber-300' : 'text-slate-400'
  return (
    <div className={`mt-1.5 space-y-1 text-[9px] leading-snug ${className}`}>
      {o && (
        <div className="text-slate-400" title={`${o.model}: a diffusion with zero expected price change and the stock's own forecast volatility. Not a forecast of THIS trade — the base rate its levels imply before any skill.`}>
          <span className="text-slate-500">No-skill odds of these levels:</span>{' '}
          target first <span className="font-mono text-emerald-400">{pc(o.pTarget)}</span> · stop first <span className="font-mono text-red-400">{pc(o.pStop)}</span> · neither in {o.sessions} sessions <span className="font-mono">{pc(o.pNeither)}</span>
        </div>
      )}
      {s && (
        <div className={stopTone}>
          {s.level === 'inside-noise' ? '⚠ ' : ''}{s.text}
          {s.level !== 'clear' && s.volatilityStopPrice != null ? ` A volatility stop (2.5 daily moves) would sit near $${s.volatilityStopPrice} (−${s.volatilityStopPct}%).` : ''}
        </div>
      )}
      {sizing && (
        <div className="text-slate-400">
          {sizing.uncalibrated || sizing.suggestedPct == null
            ? <>Size: <span className="text-slate-500">not suggested — no measured win rate for picks like this yet</span></>
            : <>Size: <span className="font-mono text-white">{sizing.suggestedPct}%</span> of the portfolio{sizing.limitedBy ? ` (limited by ${sizing.limitedBy})` : ''}{sizing.winProbSource ? ` — win rate from ${sizing.winProbSource}` : ''}</>}
        </div>
      )}
      {(slateWeightPct != null || movesWith?.length > 0) && (
        <div className="text-slate-400">
          {slateWeightPct != null && <>Slate weight <span className="font-mono text-white">{slateWeightPct}%</span> (HRP across this scan's picks)</>}
          {slateWeightPct != null && movesWith?.length > 0 && ' · '}
          {movesWith?.length > 0 && <span className="text-amber-300">moves with {movesWith.map(m => `${m.symbol} ${m.rho}`).join(', ')}</span>}
        </div>
      )}
    </div>
  )
}
