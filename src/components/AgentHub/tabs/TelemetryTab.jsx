import { useState } from 'react'
import { BarChart2, Timer } from 'lucide-react'
import { TELEMETRY_KEY, loadTelemetry, timeAgo } from './shared'

// ── ─────────────────────────────────────────────────────────────────────────────
//    TAB 4 — Telemetry (run history)
// ── ─────────────────────────────────────────────────────────────────────────────

const STATUS_DOT = { done: 'bg-emerald-400', partial: 'bg-amber-400', failed: 'bg-red-400' }
const MODE_BADGE = {
  parallel: { label: 'Parallel', color: 'text-mint-400 border-mint-500/25 bg-mint-500/8' },
  pipeline: { label: 'Pipeline', color: 'text-violet-400 border-violet-500/25 bg-violet-500/8' },
}

export default function TelemetryTab() {
  const [runs, setRuns] = useState(loadTelemetry)

  const clearAll = () => {
    localStorage.removeItem(TELEMETRY_KEY)
    setRuns([])
  }

  if (runs.length === 0) return (
    <div className="text-center py-16 text-slate-600 text-sm space-y-2">
      <BarChart2 className="w-8 h-8 mx-auto opacity-20" />
      <p>No runs recorded yet — launch research or pipeline agents to see telemetry.</p>
    </div>
  )

  const totalRuns = runs.length
  const avgDuration = runs.length ? Math.round(runs.reduce((s,r) => s + (r.durationMs||0), 0) / runs.length) : 0
  const successRate = runs.length ? Math.round(runs.filter(r => r.status === 'done' || r.status === 'partial').length / runs.length * 100) : 0

  return (
    <div className="space-y-4">
      {/* Summary row */}
      <div className="grid grid-cols-3 gap-3">
        {[
          { label: 'Total Runs',   value: totalRuns,        unit: '' },
          { label: 'Avg Duration', value: avgDuration,      unit: 'ms' },
          { label: 'Success Rate', value: `${successRate}`, unit: '%' },
        ].map(({ label, value, unit }) => (
          <div key={label} className="glass rounded-xl p-3 border border-white/[0.06] text-center">
            <div className="text-lg font-bold text-white">{value}<span className="text-xs text-slate-500 ml-0.5">{unit}</span></div>
            <div className="text-[10px] text-slate-500 mt-0.5">{label}</div>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between text-xs text-slate-500">
        <span>Last {runs.length} runs</span>
        <button onClick={clearAll} className="text-xs text-red-500/60 hover:text-red-400 transition-colors">Clear history</button>
      </div>

      <div className="space-y-1.5">
        {runs.map(run => {
          const mode = MODE_BADGE[run.mode] ?? MODE_BADGE.parallel
          const dot  = STATUS_DOT[run.status] ?? 'bg-slate-500'
          return (
            <div key={run.id} className="flex items-center gap-3 px-4 py-2.5 rounded-xl bg-white/[0.02] border border-white/[0.05] hover:bg-white/[0.03] transition-colors">
              <div className={`w-2 h-2 rounded-full shrink-0 ${dot}`} />
              <span className="text-xs font-mono font-bold text-white w-16 shrink-0">{run.symbol || '—'}</span>
              <span className={`text-[10px] px-1.5 py-0.5 rounded border ${mode.color} shrink-0`}>{mode.label}</span>
              <span className="text-[11px] text-slate-400 flex-1">{run.agentCount} agent{run.agentCount !== 1 ? 's' : ''}</span>
              {run.llmUsed && <span className="text-[10px] text-slate-600 shrink-0">{run.llmUsed}</span>}
              <span className="text-[10px] text-slate-600 shrink-0 flex items-center gap-1">
                <Timer className="w-2.5 h-2.5" />{run.durationMs ? `${(run.durationMs/1000).toFixed(1)}s` : '—'}
              </span>
              <span className="text-[10px] text-slate-600 shrink-0 w-16 text-right">{timeAgo(run.timestamp)}</span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
