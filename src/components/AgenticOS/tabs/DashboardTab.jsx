import {
  Network, Zap, Plug, ZapOff, CheckCircle, Activity, Clock,
  ChevronRight, BrainCircuit,
} from 'lucide-react'
import MiniGraph from './MiniGraph'

// ── Dashboard Tab ─────────────────────────────────────────────────────────────

export default function DashboardTab({ stats, graph, jobs, mcps, skills, onTabSwitch }) {
  const connectedMcps = mcps.filter(m => m.status === 'connected').length
  const activeJobs    = jobs.filter(j => j.result?.status === 'running').length

  const statCards = [
    { label: 'Graph Nodes',   value: stats?.nodes  ?? '—', sub: `${stats?.edges ?? 0} edges`, icon: Network,   color: 'indigo' },
    { label: 'Active Skills', value: skills.length  || '—',  sub: 'all operational',            icon: Zap,       color: 'purple' },
    { label: 'MCP Servers',   value: connectedMcps  || '—',  sub: `of ${mcps.length} total`,    icon: Plug,      color: 'cyan'   },
    { label: 'Token Savings', value: '71.5×',                sub: 'vs raw file reading',        icon: ZapOff,    color: 'emerald'},
  ]

  const colorMap = {
    indigo:  { border: 'hover:border-indigo-500/40', text: 'text-indigo-400',  icon: 'bg-indigo-500/15'  },
    purple:  { border: 'hover:border-purple-500/40', text: 'text-purple-400',  icon: 'bg-purple-500/15'  },
    cyan:    { border: 'hover:border-cyan-500/40',   text: 'text-cyan-400',    icon: 'bg-cyan-500/15'    },
    emerald: { border: 'hover:border-emerald-500/40',text: 'text-emerald-400', icon: 'bg-emerald-500/15' },
  }

  const recentActivity = [
    { icon: CheckCircle, color: 'text-emerald-400', text: 'Graph scanned — ' + (stats?.nodes ?? 0) + ' nodes indexed', time: 'just now' },
    { icon: Activity,    color: 'text-indigo-400',  text: (connectedMcps) + ' MCP servers connected',                    time: '1m ago'  },
    { icon: Zap,         color: 'text-purple-400',  text: skills.length + ' skills registered and active',               time: '2m ago'  },
    { icon: Clock,       color: 'text-amber-400',   text: jobs.length + ' scheduled jobs loaded',                        time: '5m ago'  },
  ]

  return (
    <div className="space-y-5">
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
              <div className={`text-[10px] mt-1 ${cl.text}`}>{c.sub}</div>
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
                <div className="text-[10px] text-slate-500">{stats?.routes} routes · {stats?.libs} libs · {stats?.components} components · {stats?.jsxFiles} JSX files</div>
              </div>
            </div>
            <button onClick={() => onTabSwitch('graphify')} className="text-[11px] px-2.5 py-1 rounded-lg bg-indigo-500/10 text-indigo-400 hover:bg-indigo-500/20 transition-colors flex items-center gap-1">
              Open Full Graph <ChevronRight size={11} />
            </button>
          </div>
          <MiniGraph graph={graph} />
        </div>

        {/* Brain status + recent activity */}
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
            <div className="p-4 space-y-3">
              {[
                { label: 'Routes mapped',  value: stats?.routes     ?? '—', color: 'text-indigo-400' },
                { label: 'Lib modules',    value: stats?.libs       ?? '—', color: 'text-cyan-400'   },
                { label: 'Components',     value: stats?.components ?? '—', color: 'text-purple-400' },
                { label: 'Scheduled jobs', value: jobs.length        || '—', color: 'text-emerald-400'},
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
              <div className="text-sm font-semibold text-white">Recent Activity</div>
            </div>
            <div className="p-3 space-y-2">
              {recentActivity.map((a, i) => {
                const Icon = a.icon
                return (
                  <div key={i} className="flex items-start gap-2">
                    <Icon size={11} className={`mt-0.5 flex-shrink-0 ${a.color}`} />
                    <div className="flex-1 min-w-0">
                      <div className="text-[10px] text-slate-300 leading-tight">{a.text}</div>
                      <div className="text-[9px] text-slate-600 mt-0.5">{a.time}</div>
                    </div>
                  </div>
                )
              })}
            </div>
          </div>
        </div>
      </div>

      {/* Scheduled jobs */}
      <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
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
                const dotColor    = { done: 'bg-emerald-400',   running: 'bg-amber-400 animate-pulse', failed: 'bg-red-400', idle: 'bg-slate-600' }[status] || 'bg-slate-600'
                return (
                  <div key={j.id} className="flex items-center justify-between px-4 py-2.5 hover:bg-white/[0.02] transition-colors">
                    <div className="flex items-center gap-2.5">
                      <span className={`w-2 h-2 rounded-full ${dotColor}`} />
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
    </div>
  )
}
