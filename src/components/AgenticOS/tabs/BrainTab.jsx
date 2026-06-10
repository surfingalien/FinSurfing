import {
  Brain, Database, Users, Code2, Search, CheckSquare,
  MessageSquare, Route, CheckCircle, ArrowRight, RefreshCw,
} from 'lucide-react'

// ── Agentic Brain Tab ─────────────────────────────────────────────────────────

export default function BrainTab({ jobs, stats, mcps, onRefresh }) {
  const connected = mcps.filter(m => m.status === 'connected')

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold bg-gradient-to-r from-indigo-400 to-purple-400 bg-clip-text text-transparent">Agentic Brain</h2>
          <p className="text-xs text-slate-500 mt-0.5">Core reasoning engine, memory, and orchestration layer</p>
        </div>
        <div className="flex items-center gap-3">
          <span className="flex items-center gap-1.5 text-xs text-emerald-400">
            <span className="w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />
            Online
          </span>
          <button onClick={onRefresh} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs hover:bg-indigo-500/20 transition-all">
            <RefreshCw size={12} /> Sync Brain
          </button>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-4">
        {/* Reasoning Engine */}
        <div className="rounded-xl border border-white/[0.06] bg-[#12121a] p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-xl bg-indigo-500/10 flex items-center justify-center">
              <Brain size={22} className="text-indigo-400" />
            </div>
            <div>
              <div className="font-semibold text-white">Reasoning Engine</div>
              <div className="text-[10px] text-slate-500">System-2 Thinking</div>
            </div>
          </div>
          <div className="space-y-3">
            {[
              { label: 'Chain-of-Thought', value: 100, text: 'Enabled', color: 'bg-indigo-500' },
              { label: 'Self-Reflection',  value: 100, text: 'Enabled', color: 'bg-indigo-500' },
              { label: 'Tool Learning',    value: 85,  text: 'Active',  color: 'bg-purple-500' },
            ].map(m => (
              <div key={m.label}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-400">{m.label}</span>
                  <span className="text-indigo-400">{m.text}</span>
                </div>
                <div className="w-full h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                  <div className={`h-full ${m.color} rounded-full`} style={{ width: `${m.value}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Memory Layer */}
        <div className="rounded-xl border border-white/[0.06] bg-[#12121a] p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-xl bg-purple-500/10 flex items-center justify-center">
              <Database size={22} className="text-purple-400" />
            </div>
            <div>
              <div className="font-semibold text-white">Memory Layer</div>
              <div className="text-[10px] text-slate-500">Graph + Vector Hybrid</div>
            </div>
          </div>
          <div className="space-y-3">
            {[
              { label: 'Graph Memory',        value: 92, text: `${stats?.nodes ?? 0} nodes`,  color: 'bg-purple-500' },
              { label: 'Conversation History', value: 65, text: '847 turns',                   color: 'bg-purple-500' },
              { label: 'Skill Cache',          value: 100, text: `${stats?.libs ?? 0} loaded`, color: 'bg-emerald-500' },
            ].map(m => (
              <div key={m.label}>
                <div className="flex justify-between text-xs mb-1">
                  <span className="text-slate-400">{m.label}</span>
                  <span className="text-purple-400">{m.text}</span>
                </div>
                <div className="w-full h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
                  <div className={`h-full ${m.color} rounded-full`} style={{ width: `${m.value}%` }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Agent Team */}
        <div className="rounded-xl border border-white/[0.06] bg-[#12121a] p-5">
          <div className="flex items-center gap-3 mb-4">
            <div className="w-12 h-12 rounded-xl bg-cyan-500/10 flex items-center justify-center">
              <Users size={22} className="text-cyan-400" />
            </div>
            <div>
              <div className="font-semibold text-white">Agent Team</div>
              <div className="text-[10px] text-slate-500">3 Active Agents</div>
            </div>
          </div>
          <div className="space-y-2">
            {[
              { icon: Code2,       color: 'text-indigo-400 bg-indigo-500/20', name: 'Coder Agent',    desc: 'Implementing features',  dot: 'bg-emerald-400' },
              { icon: Search,      color: 'text-purple-400 bg-purple-500/20', name: 'Research Agent', desc: 'Searching Graphify docs', dot: 'bg-emerald-400' },
              { icon: CheckSquare, color: 'text-cyan-400 bg-cyan-500/20',     name: 'Review Agent',   desc: 'Idle — awaiting PR',     dot: 'bg-amber-400'   },
            ].map(a => {
              const Icon = a.icon
              return (
                <div key={a.name} className="flex items-center gap-2 p-2.5 rounded-lg bg-white/[0.03] border border-white/[0.04]">
                  <div className={`w-7 h-7 rounded-full ${a.color.split(' ')[1]} flex items-center justify-center flex-shrink-0`}>
                    <Icon size={12} className={a.color.split(' ')[0]} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-xs font-medium text-white">{a.name}</div>
                    <div className="text-[10px] text-slate-500 truncate">{a.desc}</div>
                  </div>
                  <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${a.dot}`} />
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Brain Architecture */}
      <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.06] flex items-center justify-between">
          <div className="text-sm font-semibold text-white">Brain Architecture</div>
          <span className="text-[10px] text-slate-500 font-mono">claude-sonnet-4-6 + Graphify Context</span>
        </div>
        <div className="p-6 flex items-center justify-center gap-6 flex-wrap">
          {[
            { icon: MessageSquare, label: 'User Input',    sub: 'Natural language', color: 'bg-white/[0.04] border-white/[0.06]' },
            { icon: Route,         label: 'Skill Router',  sub: 'Pattern matching', color: 'bg-indigo-500/10 border-indigo-500/30' },
            { icon: Brain,         label: 'LLM Reasoning', sub: 'claude-sonnet-4-6',  color: 'bg-purple-500/10 border-purple-500/30' },
            { icon: Database,      label: 'Graph Context', sub: 'Graphify 71.5×',  color: 'bg-cyan-500/10 border-cyan-500/30'    },
            { icon: CheckCircle,   label: 'Action Output', sub: 'Code, data, plans',color: 'bg-emerald-500/10 border-emerald-500/30'},
          ].map((step, i, arr) => {
            const Icon = step.icon
            return (
              <div key={step.label} className="flex items-center gap-4">
                <div className="text-center">
                  <div className={`w-14 h-14 rounded-2xl ${step.color} border flex items-center justify-center mb-2 mx-auto`}>
                    <Icon size={22} className="text-slate-400" />
                  </div>
                  <div className="text-xs font-medium text-white">{step.label}</div>
                  <div className="text-[10px] text-slate-500">{step.sub}</div>
                </div>
                {i < arr.length - 1 && <ArrowRight size={16} className="text-slate-600 flex-shrink-0" />}
              </div>
            )
          })}
        </div>
      </div>

      {/* Tool registry */}
      <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.06]">
          <div className="text-sm font-semibold text-white">Copilot Tool Registry</div>
          <div className="text-[10px] text-slate-500">Tools the MarketPulse brain can invoke</div>
        </div>
        <div className="divide-y divide-white/[0.04]">
          {[
            { name: 'scan_market',         desc: 'AI Brain 5-agent broad scan',           latency: '~90s',  color: '#6366f1' },
            { name: 'get_recommendations', desc: 'Investor persona buy signals',          latency: '~60s',  color: '#8b5cf6' },
            { name: 'analyze_symbol',      desc: 'Deep TA + alt data for ticker',         latency: '~35s',  color: '#06b6d4' },
            { name: 'get_social_sentiment',desc: 'Reddit WSB/stocks/investing sentiment', latency: '~8s',   color: '#10b981' },
            { name: 'get_macro',           desc: '14 FRED series + regime assessment',    latency: '~15s',  color: '#f59e0b' },
          ].map(t => (
            <div key={t.name} className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.02]">
              <div className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: t.color, boxShadow: `0 0 6px ${t.color}80` }} />
              <code className="text-xs font-mono text-white flex-1">{t.name}</code>
              <span className="text-[10px] text-slate-400 flex-1">{t.desc}</span>
              <span className="text-[10px] text-slate-600 font-mono">{t.latency}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Scheduler */}
      <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.06]">
          <div className="text-sm font-semibold text-white">Background Agent Jobs</div>
        </div>
        {jobs.length === 0
          ? <div className="p-6 text-center text-xs text-slate-600">No scheduler data available</div>
          : (
            <div className="divide-y divide-white/[0.04]">
              {jobs.map(j => {
                const status = j.result?.status || 'idle'
                const dot    = { done: 'bg-emerald-400', running: 'bg-amber-400 animate-pulse', failed: 'bg-red-400', idle: 'bg-slate-600' }[status] || 'bg-slate-600'
                const txt    = { done: 'text-emerald-400', running: 'text-amber-400', failed: 'text-red-400', idle: 'text-slate-600' }[status] || 'text-slate-600'
                return (
                  <div key={j.id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-white/[0.02]">
                    <span className={`w-2 h-2 rounded-full flex-shrink-0 ${dot}`} />
                    <div className="flex-1">
                      <div className="text-xs text-white">{j.name}</div>
                      <div className="text-[10px] text-slate-500">{j.description}</div>
                    </div>
                    <div className="text-right">
                      <div className={`text-[10px] font-mono ${txt}`}>{status}</div>
                      <div className="text-[10px] text-slate-600">{j.scheduleText}</div>
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
