import { BarChart2, RefreshCw } from 'lucide-react'

// ── Tool call indicator ───────────────────────────────────────────────────────

const TOOL_META = {
  scan_market:            { icon: '🧠', label: 'AI Brain Scan',         color: 'mint'   },
  get_recommendations:    { icon: '🎯', label: 'AI Recommendations',     color: 'mint'   },
  analyze_symbol:         { icon: '📊', label: 'Technical Analysis',     color: 'mint'   },
  get_fundamentals:       { icon: '📋', label: 'Fundamentals',           color: 'indigo' },
  get_price_performance:  { icon: '📈', label: 'Price Performance',      color: 'indigo' },
  compare_stocks:         { icon: '⚖️', label: 'Stock Comparison',       color: 'amber'  },
  get_social_sentiment:   { icon: '💬', label: 'Social Sentiment',       color: 'amber'  },
  get_macro:              { icon: '🌍', label: 'Macro Indicators',       color: 'mint'   },
  get_earnings_catalyst:  { icon: '📅', label: 'Earnings Catalyst',      color: 'amber'  },
  get_options_flow:       { icon: '🔀', label: 'Options Flow',           color: 'amber'  },
  get_analyst_consensus:  { icon: '🏦', label: 'Analyst Consensus',      color: 'indigo' },
  get_insider_activity:   { icon: '🔍', label: 'Insider Activity',       color: 'indigo' },
  classify_symbol:        { icon: '🏷️', label: 'Symbol Classifier',      color: 'mint'   },
  sector_universe:        { icon: '🗂️', label: 'Sector Universe',        color: 'mint'   },
  portfolio_risk:         { icon: '⚠️', label: 'Portfolio Risk',         color: 'amber'  },
  get_calibration:        { icon: '🎓', label: 'AI Track Record',        color: 'mint'   },
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
