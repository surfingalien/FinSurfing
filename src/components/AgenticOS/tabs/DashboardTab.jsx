import { useState, useEffect } from 'react'
import {
  Network, Zap, Plug, CheckCircle, Activity, Clock,
  ChevronRight, BrainCircuit, AlertTriangle, TrendingUp,
  BarChart2, RefreshCw,
} from 'lucide-react'
import MiniGraph from './MiniGraph'
import { apiFetch } from './shared'

function sigCol(v) {
  if (!v) return '#6b7280'
  const u = String(v).toUpperCase()
  if (u.includes('STRONG') && u.includes('BUY'))  return '#10b981'
  if (u.includes('BUY') || u.includes('ACCUMULATE')) return '#34d399'
  if (u.includes('SELL') || u.includes('AVOID'))  return '#f87171'
  return '#f59e0b'
}

export default function DashboardTab({ stats, graph, jobs, mcps, skills, onTabSwitch }) {
  const [scanCache, setScanCache] = useState(null)

  useEffect(() => {
    apiFetch('/api/scheduler/cache/scan').then(d => setScanCache(d)).catch(() => {})
  }, [])

  const connectedMcps = mcps.filter(m => m.status === 'connected').length
  const activeJobs    = jobs.filter(j => j.result?.status === 'running').length
  const failedJobs    = jobs.filter(j => j.result?.status === 'failed')
  const topSignals    = scanCache?.broad?.rankedStocks?.slice(0, 3) ?? []
  const regime        = scanCache?.broad?.marketRegime ?? null

  const statCards = [
    { label: 'Graph Nodes',   value: stats?.nodes    ?? '—', sub: `${stats?.edges ?? 0} edges`,     icon: Network,   color: 'indigo'  },
    { label: 'Active Skills', value: skills.length   || '—', sub: 'all operational',                icon: Zap,       color: 'purple'  },
    { label: 'MCP Servers',   value: connectedMcps   || '—', sub: `of ${mcps.length} total`,        icon: Plug,      color: 'cyan'    },
    { label: 'Live Signals',  value: scanCache?.broad?.rankedStocks?.length ?? '—', sub: regime ?? 'last brain scan', icon: BarChart2,  color: 'emerald' },
  ]

  const colorMap = {
    indigo:  { border: 'hover:border-indigo-500/40',  text: 'text-indigo-400',  icon: 'bg-indigo-500/15'  },
    purple:  { border: 'hover:border-purple-500/40',  text: 'text-purple-400',  icon: 'bg-purple-500/15'  },
    cyan:    { border: 'hover:border-cyan-500/40',    text: 'text-cyan-400',    icon: 'bg-cyan-500/15'    },
    emerald: { border: 'hover:border-emerald-500/40', text: 'text-emerald-400', icon: 'bg-emerald-500/15' },
  }

  // Real activity from job results (sorted by lastRun, newest first)
  const recentActivity = jobs
    .filter(j => j.result?.lastRun)
    .sort((a, b) => new Date(b.result.lastRun) - new Date(a.result.lastRun))
    .slice(0, 4)
    .map(j => {
      const status = j.result?.status || 'done'
      const icon   = status === 'failed' ? AlertTriangle : status === 'running' ? RefreshCw : CheckCircle
      const color  = status === 'failed' ? 'text-red-400' : status === 'running' ? 'text-amber-400' : 'text-emerald-400'
      const ago    = (() => {
        const ms = Date.now() - new Date(j.result.lastRun).getTime()
        if (ms < 60000) return `${Math.round(ms / 1000)}s ago`
        if (ms < 3600000) return `${Math.round(ms / 60000)}m ago`
        return `${Math.round(ms / 3600000)}h ago`
      })()
      const text = status === 'failed'
        ? `${j.name} failed — ${(j.result?.error || 'unknown error').slice(0, 50)}`
        : `${j.name} ${status}`
      return { icon, color, text, time: ago }
    })

  // Fallback static items if no job run data
  const activityItems = recentActivity.length > 0 ? recentActivity : [
    { icon: CheckCircle, color: 'text-emerald-400', text: `Graph scanned — ${stats?.nodes ?? 0} nodes indexed`,   time: 'startup' },
    { icon: Activity,    color: 'text-indigo-400',  text: `${connectedMcps} MCP servers connected`,                time: 'startup' },
    { icon: Zap,         color: 'text-purple-400',  text: `${skills.length} skills registered and active`,         time: 'startup' },
    { icon: Clock,       color: 'text-amber-400',   text: `${jobs.length} scheduled jobs loaded`,                  time: 'startup' },
  ]

  return (
    <div className="space-y-5">
      {/* Failed job warning */}
      {failedJobs.length > 0 && (
        <div className="flex items-center gap-2.5 px-4 py-2.5 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-xs">
          <AlertTriangle size={13} className="flex-shrink-0" />
          <span>{failedJobs.length} job{failedJobs.length > 1 ? 's' : ''} failed: {failedJobs.map(j => j.name).join(', ')}</span>
        </div>
      )}

      {/* Stat cards */}
      <div className="grid grid-cols-4 gap-4">
        {statCards.map(c => {
          const Icon = c.icon
          const cl   = colorMap[c.color]
          return (
            <div key={c.label} className={`rounded-xl p-4 border border-white/[0.06] ${cl.border} bg-[#12121a] transition-all cursor-default`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider">{c.label}</span>
                <div className={`w-7 h-7 rounded-lg ${cl.icon} flex items-center justify-center`}>
                  <Icon size={14} className={cl.text} />
                </div>
              </div>
              <div className="text-2xl font-bold font-mono text-white">{c.value}</div>
              <div className={`text-[10px] mt-1 ${cl.text} truncate`}>{c.sub}</div>
            </div>
          )
        })}
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Graph preview */}
        <div className="col-span-2 rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
          <div className="flex items-center justify-between px-4 py-3 border-b border-white/[0.06]">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center">
                <Network size={13} className="text-white" />
              </div>
              <div>
                <div className="text-sm font-semibold text-white">FinSurfing Knowledge Graph</div>
                <div className="text-[10px] text-slate-500">
                  {stats?.routes ?? 0}R · {stats?.libs ?? 0}L · {stats?.components ?? 0}C · {stats?.jsxFiles ?? 0} JSX · {stats?.totalLines?.toLocaleString() ?? 0} lines
                </div>
              </div>
            </div>
            <button onClick={() => onTabSwitch('graphify')} className="text-[11px] px-2.5 py-1 rounded-lg bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 transition-colors flex items-center gap-1">
              Open Full Graph <ChevronRight size={11} />
            </button>
          </div>
          <MiniGraph graph={graph} />
        </div>

        {/* Brain status + activity */}
        <div className="space-y-4">
          <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.06] flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-500 to-indigo-500 flex items-center justify-center animate-pulse">
                <BrainCircuit size={13} className="text-white" />
              </div>
              <div>
                <div className="text-sm font-semibold text-white">Agentic Brain</div>
                <div className="text-[10px] text-emerald-400 flex items-center gap-1">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                  Online · claude-sonnet-4-6
                </div>
              </div>
            </div>
            <div className="p-4 space-y-2.5">
              {[
                { label: 'Routes mapped',  value: stats?.routes     ?? '—', color: 'text-indigo-400'  },
                { label: 'Lib modules',    value: stats?.libs       ?? '—', color: 'text-cyan-400'    },
                { label: 'Components',     value: stats?.components ?? '—', color: 'text-purple-400'  },
                { label: 'Scheduled jobs', value: jobs.length        || '—', color: 'text-emerald-400' },
                { label: 'Jobs running',   value: activeJobs         || 0,   color: activeJobs ? 'text-amber-400' : 'text-slate-600' },
              ].map(r => (
                <div key={r.label} className="flex items-center justify-between">
                  <span className="text-xs text-slate-400">{r.label}</span>
                  <span className={`text-xs font-mono font-semibold ${r.color}`}>{r.value}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
            <div className="px-4 py-3 border-b border-white/[0.06]">
              <div className="text-sm font-semibold text-white">Job Activity</div>
            </div>
            <div className="p-3 space-y-2">
              {activityItems.map((a, i) => {
                const Icon = a.icon
                return (
                  <div key={i} className="flex items-start gap-2">
                    <Icon size={11} className={`mt-0.5 flex-shrink-0 ${a.color}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] text-slate-300 leading-tight truncate">{a.text}</div>
                      <div className="text-[9px] text-slate-600 mt-0.5">{a.time}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      <div className="grid grid-cols-5 gap-4">
        {/* Scheduled jobs table — 3 cols */}
        <div className="col-span-3 rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
          <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
            <div className="text-sm font-semibold text-white">Scheduled Jobs</div>
            <div className="text-[10px] text-slate-500">{jobs.length} jobs · {activeJobs} running</div>
          </div>
          {jobs.length === 0
            ? <div className="p-6 text-center text-xs text-slate-600">No scheduler data available</div>
            : (
              <div className="divide-y divide-white/[0.04]">
                {jobs.map(j => {
                  const status     = j.result?.status || 'idle'
                  const statusColor = { done: 'text-emerald-400', running: 'text-amber-400', failed: 'text-red-400', idle: 'text-slate-600' }[status] || 'text-slate-600'
                  const dotColor    = { done: 'bg-emerald-400', running: 'bg-amber-400 animate-pulse', failed: 'bg-red-400', idle: 'bg-slate-700' }[status] || 'bg-slate-700'
                  return (
                    <div key={j.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors">
                      <div className="flex items-center gap-2.5">
                        <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dotColor}`} />
                        <span className="text-xs text-white font-medium">{j.name}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-[10px] text-slate-500">{j.scheduleText}</span>
                        <span className={`text-[10px] font-mono ${statusColor}`}>{status}</span>
                        {j.result?.lastRun && <span className="text-[10px] text-slate-600">{new Date(j.result.lastRun).toLocaleTimeString()}</span>}
                      </div>
                    </div>
                  )
                })}
              </div>
            )
          }
        </div>

        {/* Live scan signal summary — 2 cols */}
        <div className="col-span-2 rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
          <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse flex-shrink-0" />
              <div className="text-sm font-semibold text-white">Live Signal Summary</div>
            </div>
            <button onClick={() => onTabSwitch('graphify')} className="text-[10px] text-indigo-400 hover:text-indigo-300 transition-colors flex items-center gap-0.5">
              Signal Net <ChevronRight size={10} />
            </button>
          </div>
          {topSignals.length === 0 ? (
            <div className="p-5 text-center text-xs text-slate-600">
              <TrendingUp size={18} className="mx-auto mb-2 opacity-30" />
              Scan fires at :05 each hour during market hours
            </div>
          ) : (
            <div className="p-3 space-y-2">
              {regime && (
                <div className="flex items-center justify-between mb-3">
                  <span className="text-[10px] text-slate-500">Market Regime</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/15 text-indigo-400 border border-indigo-500/20 font-mono">{regime}</span>
                </div>
              )}
              {topSignals.map(s => {
                const col = sigCol(s.agentVerdict)
                const score = s.compositeScore ?? 0
                return (
                  <div key={s.symbol} className="flex items-center gap-2">
                    <div className="w-12 font-mono font-bold text-xs text-white">{s.symbol}</div>
                    <div className="flex-1 h-1 bg-white/[0.05] rounded-full overflow-hidden">
                      <div className="h-full rounded-full transition-all" style={{ width: `${score}%`, background: col }} />
                    </div>
                    <span className="text-[10px] font-mono w-20 text-right truncate" style={{ color: col }}>{s.agentVerdict}</span>
                  </div>
                )
              })}
              {(scanCache?.broad?.rankedStocks?.length ?? 0) > 3 && (
                <div className="text-[9px] text-slate-600 text-right mt-1">
                  +{scanCache.broad.rankedStocks.length - 3} more in Signal Net →
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
