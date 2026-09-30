const STATE = {
  'open':       { label: 'Open',       tone: 'text-sky-400 bg-sky-500/10 border-sky-500/25' },
  'target-hit': { label: 'Target hit', tone: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/25' },
  'stopped':    { label: 'Stopped out', tone: 'text-red-400 bg-red-500/10 border-red-500/25' },
  'expired':    { label: 'Expired',    tone: 'text-slate-300 bg-slate-500/10 border-slate-500/25' },
  'no-data':    { label: 'No data',    tone: 'text-slate-400 bg-slate-500/10 border-slate-500/25' },
  'no-trade':   { label: 'No trade',   tone: 'text-slate-400 bg-slate-500/10 border-slate-500/25' },
}

/**
 * Every thesis the user has run, scored against real bars by which level was
 * touched first — the same rule the Brain's own picks are graded by.
 */
export default function ThesesList({ theses = [], onOpen }) {
  if (!theses.length) {
    return <p className="text-sm text-slate-500">No theses yet. Research a symbol and write one — every thesis is tracked here against the market.</p>
  }
  return (
    <div className="space-y-2">
      {theses.map(t => {
        const s = STATE[t.status?.state] || STATE['no-data']
        return (
          <button key={t.id} onClick={() => onOpen?.(t.symbol)}
            className="w-full text-left glass rounded-xl p-3 hover:border-mint-400/40 border border-transparent">
            <div className="flex items-center gap-2">
              <span className="font-semibold">{t.symbol}</span>
              {t.company && <span className="text-[11px] text-slate-500 truncate">{t.company}</span>}
              <span className={`ml-auto text-[10px] px-2 py-0.5 rounded-full border ${s.tone}`}>{s.label}</span>
            </div>
            <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-x-3">
              <span>{new Date(t.at).toLocaleDateString()}</span>
              <span>from ${Number(t.lastPrice).toFixed(2)}</span>
              {t.zones && <span>target +{t.zones.targetReturn}% · stop −{t.zones.stopLoss}% · {t.horizonDays}d</span>}
              {t.status?.retPct != null && <span className={t.status.retPct >= 0 ? 'text-emerald-400' : 'text-red-400'}>{t.status.retPct >= 0 ? '+' : ''}{t.status.retPct}%</span>}
              {t.status?.daysLeft != null && <span>{t.status.daysLeft}d left</span>}
              {t.verdict !== 'actionable' && t.reasons?.[0] && <span className="truncate">{t.reasons[0]}</span>}
            </div>
          </button>
        )
      })}
    </div>
  )
}
