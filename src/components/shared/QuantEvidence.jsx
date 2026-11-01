/**
 * QuantEvidence — the measured quant context the server computed from a year
 * of daily bars (lib/quant-snapshot.js): volatility outlook, trend vs mean
 * reversion, one-day tail risk, liquidity, beta, volatility state, and where
 * the name sits against the rest of its list. Context, not a signal: nothing
 * here changed the pick. Collapsed by default so a card stays short.
 *
 * Used by the AI Brain cards, AI Buy Signals cards and the Agent Hub pipeline.
 */
import { useState } from 'react'
import { Sigma, ChevronDown } from 'lucide-react'

const pct = (x, d = 0) => (Number.isFinite(x) ? `${(x * 100).toFixed(d)}%` : '—')

export default function QuantEvidence({ quant, className = '' }) {
  const [open, setOpen] = useState(false)
  const items = quant?.evidence
  if (!items?.length) return null
  const s = quant.stamp || {}
  const summary = [
    s.vol21 != null ? `vol ${pct(s.vol21)}` : null,
    s.character && s.character !== 'unknown' ? s.character : null,
    s.var95 != null ? `VaR95 ${pct(s.var95, 1)}` : null,
  ].filter(Boolean).join(' · ')
  return (
    <div className={`mt-2 rounded-lg border border-violet-500/20 bg-violet-500/5 ${className}`}>
      <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 text-left">
        <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold text-violet-400">
          <Sigma className="w-3 h-3" /> Measured quant context
        </span>
        <span className="inline-flex items-center gap-1 text-[9px] text-slate-500">
          {summary}
          <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} />
        </span>
      </button>
      {open && (
        <div className="px-2.5 pb-2 space-y-1">
          {items.map(e => (
            <div key={e.id} className="text-[10px] leading-snug">
              <span className="text-slate-400 font-medium">{e.title}: </span>
              <span className="text-slate-300">{e.text}</span>
            </div>
          ))}
          <p className="text-[9px] text-slate-500 leading-snug pt-0.5">
            Computed in code from daily bars — context the model was shown, not a buy or sell signal. Recorded with the pick so the track record can show whether any of it matters.
          </p>
        </div>
      )}
    </div>
  )
}
