import { BarChart2, RefreshCw } from 'lucide-react'

// ── Tool call indicator ───────────────────────────────────────────────────────

const TOOL_META = {
  get_technical_analysis: { icon: '📊', label: 'Technical Analysis', color: 'mint' },
  get_fundamentals:       { icon: '📋', label: 'Fundamentals + Sentiment', color: 'indigo' },
  compare_stocks:         { icon: '⚖️', label: 'Stock Comparison', color: 'amber' },
}

export function ToolCallBadge({ name, input, done }) {
  const meta = TOOL_META[name] || { icon: '🔧', label: name, color: 'mint' }
  const sym  = input?.symbol || (input?.symbols ? input.symbols.join(', ') : '')

  const colorDone = meta.color === 'indigo' ? 'bg-indigo-500/5 border-indigo-500/20 text-indigo-300'
    : meta.color === 'amber' ? 'bg-amber-500/5 border-amber-500/20 text-amber-300'
    : 'bg-emerald-500/5 border-emerald-500/20 text-emerald-400'
  const colorPending = meta.color === 'indigo' ? 'bg-indigo-500/5 border-indigo-500/20 text-indigo-400'
    : meta.color === 'amber' ? 'bg-amber-500/5 border-amber-500/20 text-amber-400'
    : 'bg-mint-500/5 border-mint-500/20 text-mint-400'

  return (
    <div className={`flex items-center gap-2 px-3 py-1.5 rounded-lg text-xs font-mono border
      ${done ? colorDone : colorPending}`}>
      {done
        ? <><BarChart2 className="w-3 h-3 shrink-0" /> {meta.icon} {meta.label}{sym ? `: ${sym}` : ''} ✓</>
        : <><RefreshCw className="w-3 h-3 animate-spin shrink-0" /> {meta.icon} Running {meta.label}{sym ? ` for ${sym}` : ''}…</>
      }
    </div>
  )
}
