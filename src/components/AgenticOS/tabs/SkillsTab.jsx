import { useState } from 'react'
import { Search, Zap, BarChart2, Brain, TrendingUp, Shield, Database, Globe, Radio, Plus } from 'lucide-react'

// Enrich server-side skill list with client-side metadata from the copilot TOOLS registry
const SKILL_META = {
  'Market Scanner':      { icon: Radio,     color: '#6366f1', cat: 'scan',      latency: '~120s' },
  'AI Buy Signals':      { icon: TrendingUp, color: '#8b5cf6', cat: 'advisory',  latency: '~60s'  },
  'Symbol Analysis':     { icon: BarChart2,  color: '#06b6d4', cat: 'analysis',  latency: '~35s'  },
  'Earnings Catalyst':   { icon: Zap,        color: '#f59e0b', cat: 'catalyst',  latency: '~10s'  },
  'Options Flow':        { icon: BarChart2,  color: '#f97316', cat: 'flow',      latency: '~8s'   },
  'Analyst Consensus':   { icon: Brain,      color: '#84cc16', cat: 'analysis',  latency: '~8s'   },
  'Insider Activity':    { icon: Shield,     color: '#ec4899', cat: 'flow',      latency: '~12s'  },
  'Social Sentiment':    { icon: Globe,      color: '#10b981', cat: 'sentiment', latency: '~8s'   },
  'Macro Indicators':    { icon: Database,   color: '#64748b', cat: 'macro',     latency: '~15s'  },
  'Copilot Streaming':   { icon: Radio,      color: '#a78bfa', cat: 'chat',      latency: 'stream' },
  'Portfolio Risk':      { icon: Shield,     color: '#22d3ee', cat: 'risk',      latency: '~45s'  },
}

const CAT_COLOR = {
  scan:      'text-indigo-400  bg-indigo-500/10',
  advisory:  'text-purple-400  bg-purple-500/10',
  analysis:  'text-cyan-400    bg-cyan-500/10',
  catalyst:  'text-amber-400   bg-amber-500/10',
  flow:      'text-orange-400  bg-orange-500/10',
  sentiment: 'text-emerald-400 bg-emerald-500/10',
  macro:     'text-slate-400   bg-slate-500/10',
  chat:      'text-violet-400  bg-violet-500/10',
  risk:      'text-sky-400     bg-sky-500/10',
}
const TAG_COLORS = ['text-indigo-400 bg-indigo-500/10', 'text-purple-400 bg-purple-500/10', 'text-cyan-400 bg-cyan-500/10', 'text-emerald-400 bg-emerald-500/10']

export default function SkillsTab({ skills }) {
  const [search, setSearch] = useState('')

  const filtered = skills.filter(s =>
    !search || s.name.toLowerCase().includes(search.toLowerCase()) || s.description?.toLowerCase().includes(search.toLowerCase())
  )

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">FinSurfing Skills</h2>
          <p className="text-xs text-slate-500 mt-0.5">AI capabilities registered in the agentic system</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <Search size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
            <input value={search} onChange={e => setSearch(e.target.value)}
              placeholder="Search skills…"
              className="w-48 bg-white/[0.04] border border-white/[0.06] rounded-lg pl-7 pr-3 py-1.5 text-xs text-white placeholder-slate-600 outline-none focus:border-indigo-500/40 transition-colors" />
          </div>
          <span className="text-[10px] text-slate-500">{filtered.length} capabilities</span>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {filtered.map(s => {
          const meta    = SKILL_META[s.name] || {}
          const Icon    = meta.icon ?? Zap
          const col     = meta.color ?? '#6366f1'
          const catCls  = CAT_COLOR[meta.cat] ?? 'text-indigo-400 bg-indigo-500/10'
          return (
            <div key={s.id} className="rounded-xl border border-white/[0.06] bg-[#12121a] p-4 hover:border-white/[0.12] transition-all group">
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: col + '18', border: `1px solid ${col}30` }}>
                    <Icon size={15} style={{ color: col }} />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-white">{s.name}</div>
                    <div className="text-[10px] text-slate-600 font-mono truncate max-w-[150px]">{s.endpoint}</div>
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1">
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 font-mono">{s.status}</span>
                  {meta.latency && <span className="text-[9px] text-slate-600 font-mono">{meta.latency}</span>}
                </div>
              </div>
              <div className="text-[10px] text-slate-400 mb-2.5 leading-relaxed">{s.description}</div>
              <div className="flex items-center justify-between">
                <div className="flex flex-wrap gap-1">
                  {s.tags?.map((tag, ti) => (
                    <span key={tag} className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${TAG_COLORS[ti % TAG_COLORS.length]}`}>{tag}</span>
                  ))}
                </div>
                {meta.cat && (
                  <span className={`text-[9px] px-2 py-0.5 rounded-full font-mono ${catCls}`}>{meta.cat}</span>
                )}
              </div>
            </div>
          )
        })}

        <div className="rounded-xl border border-white/[0.06] border-dashed bg-[#12121a] p-4 flex flex-col items-center justify-center text-center cursor-pointer hover:border-indigo-500/30 transition-all min-h-[140px]">
          <div className="w-9 h-9 rounded-xl bg-white/[0.04] flex items-center justify-center mb-2">
            <Plus size={15} className="text-slate-500" />
          </div>
          <p className="text-sm text-slate-500">Add New Skill</p>
          <p className="text-[10px] text-slate-600 mt-0.5">Register a capability</p>
        </div>
      </div>
    </div>
  )
}
