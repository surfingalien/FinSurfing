import { Gauge, MessageSquareQuote, AlertCircle } from 'lucide-react'

/**
 * The evidence dossier. Each card carries the id a thesis claim must cite,
 * and says whether it is a MEASUREMENT or a third-party OPINION — the two are
 * not the same kind of fact and should never read as if they were.
 */
export default function EvidenceList({ evidence = [], gaps = [], highlight = null }) {
  return (
    <div className="space-y-2">
      {evidence.map(item => (
        <div
          key={item.id}
          id={`evidence-${item.id}`}
          className={`glass rounded-xl p-3 border transition-colors ${
            highlight === item.id ? 'border-mint-400/60' : 'border-transparent'
          }`}
        >
          <div className="flex items-center gap-2 mb-1">
            <span className="font-mono text-[10px] px-1.5 py-0.5 rounded bg-slate-500/15 text-slate-300">{item.id}</span>
            <span className="text-xs font-semibold">{item.label}</span>
            {item.measured ? (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-emerald-400">
                <Gauge className="w-3 h-3" /> measured
              </span>
            ) : (
              <span className="ml-auto flex items-center gap-1 text-[10px] text-amber-400">
                <MessageSquareQuote className="w-3 h-3" /> third-party opinion
              </span>
            )}
          </div>
          <p className="text-[12px] text-slate-400 leading-relaxed">{item.text}</p>
          {item.source && <p className="text-[10px] text-slate-600 mt-1">Source: {item.source}</p>}
        </div>
      ))}
      {gaps.length > 0 && (
        <div className="flex items-start gap-2 text-[11px] text-slate-500 px-1 pt-1">
          <AlertCircle className="w-3.5 h-3.5 shrink-0 mt-px" />
          <span>Not checked this run: {gaps.join(' · ')}. A missing source is not a clean bill of health.</span>
        </div>
      )}
    </div>
  )
}
