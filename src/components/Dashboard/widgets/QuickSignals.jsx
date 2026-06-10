import { Zap, RefreshCw } from 'lucide-react'
import { SIGNAL_TYPES } from '../../../services/aiEngine'

/* ── AI Quick Signal Panel ───────────────────── */
export default function QuickSignals({ scan, loading, onScan }) {
  if (loading) return (
    <div className="flex flex-col items-center gap-3 py-8">
      <div className="flex gap-1">
        {[0, 1, 2, 3, 4].map(i => (
          <div key={i} className="w-1.5 h-6 bg-mint-400/40 rounded-full animate-pulse"
            style={{ animationDelay: `${i * 0.1}s` }} />
        ))}
      </div>
      <p className="text-slate-500 text-sm">Scanning portfolio…</p>
    </div>
  )

  if (!scan) return (
    <div className="text-center py-6 space-y-3">
      <Zap className="w-8 h-8 text-mint-400/40 mx-auto" />
      <p className="text-slate-500 text-sm">Instant AI signal scan for all holdings</p>
      <button onClick={onScan} className="btn-primary flex items-center gap-2 mx-auto">
        <Zap className="w-3.5 h-3.5" /> Quick Scan
      </button>
    </div>
  )

  const counts = {}
  scan.forEach(r => { counts[r.signal] = (counts[r.signal] || 0) + 1 })

  return (
    <div className="space-y-3">
      {/* Signal summary badges */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex gap-1.5 flex-wrap">
          {Object.entries(SIGNAL_TYPES).map(([key, cfg]) =>
            counts[key] ? (
              <span key={key}
                className={`flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px] ${cfg.bg} ${cfg.border} ${cfg.text}`}>
                {cfg.emoji} {counts[key]}
              </span>
            ) : null
          )}
        </div>
        <button onClick={onScan}
          className="text-[11px] text-slate-500 hover:text-mint-400 flex items-center gap-1 transition-colors">
          <RefreshCw className="w-3 h-3" /> Refresh
        </button>
      </div>

      {/* Signal list */}
      <div className="space-y-1">
        {scan.map(r => {
          const cfg = SIGNAL_TYPES[r.signal] || SIGNAL_TYPES.HOLD
          return (
            <div key={r.symbol}
              className={`flex items-center justify-between text-xs px-3 py-2 rounded-lg border ${cfg.border} bg-white/[0.02] hover:bg-white/[0.04] transition-colors`}>
              <span className="font-mono font-black text-white w-14">{r.symbol}</span>
              <span className={`flex items-center gap-1 ${cfg.text} font-medium`}>
                <span>{cfg.emoji}</span>
                <span className="hidden sm:inline text-[11px]">{cfg.label}</span>
              </span>
              <div className="text-right">
                <div className={`font-mono font-semibold text-[11px] ${r.gainPct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                  {r.gainPct >= 0 ? '+' : ''}{r.gainPct.toFixed(1)}%
                </div>
                <div className={`font-mono text-[10px] ${r.changePct >= 0 ? 'text-emerald-400/70' : 'text-red-400/70'}`}>
                  {r.changePct >= 0 ? '+' : ''}{r.changePct.toFixed(2)}% today
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
