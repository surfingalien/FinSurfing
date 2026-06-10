import {
  Rocket, BookOpen, Monitor, GitPullRequest, Image, Plus,
} from 'lucide-react'

// ── Plugins Tab ───────────────────────────────────────────────────────────────

const PLUGINS = [
  { id: 'superpowers',  name: 'Superpowers',    sub: 'Planning + subagents', icon: Rocket,        color: 'indigo',  status: 'active',  version: 'v1.4.2', platform: 'Claude Code', desc: 'Intelligent planning mode with subagent spawning. Asks better questions as it goes.' },
  { id: 'context7',     name: 'Context7',       sub: 'Doc search plugin',    icon: BookOpen,       color: 'purple',  status: 'active',  version: 'v2.1.0', platform: 'Universal',   desc: 'Documentation provider for AI agents. Find and read docs, use APIs properly.' },
  { id: 'browser',      name: 'Browser Agent',  sub: 'Web automation',       icon: Monitor,        color: 'cyan',    status: 'active',  version: 'v1.0.8', platform: 'MCP',         desc: 'Browser automation via Playwright. Navigate, scrape, interact with web pages.' },
  { id: 'pr-reviewer',  name: 'PR Reviewer',    sub: 'Code review AI',       icon: GitPullRequest, color: 'emerald', status: 'active',  version: 'v1.2.1', platform: 'GitHub',      desc: 'Automated PR review with impact analysis. Uses graph context for deeper insights.' },
  { id: 'vision',       name: 'Vision Extract', sub: 'Image to code',        icon: Image,          color: 'amber',   status: 'update',  version: 'v0.9.3', platform: 'Vision',      desc: 'Convert screenshots and mockups into working code. Figma to React component.' },
]

const pluginColors = {
  indigo:  { icon: 'bg-indigo-500/10 text-indigo-400', border: 'hover:border-indigo-500/30' },
  purple:  { icon: 'bg-purple-500/10 text-purple-400', border: 'hover:border-purple-500/30' },
  cyan:    { icon: 'bg-cyan-500/10 text-cyan-400',     border: 'hover:border-cyan-500/30'   },
  emerald: { icon: 'bg-emerald-500/10 text-emerald-400',border: 'hover:border-emerald-500/30'},
  amber:   { icon: 'bg-amber-500/10 text-amber-400',   border: 'hover:border-amber-500/30'  },
}

export default function PluginsTab() {
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">Plugins</h2>
          <p className="text-xs text-slate-500 mt-0.5">Agent extensions that modify behavior and add capabilities</p>
        </div>
        <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500 text-white text-xs hover:bg-indigo-600 transition-colors shadow-lg shadow-indigo-500/20">
          <Plus size={12} /> Install Plugin
        </button>
      </div>

      <div className="grid grid-cols-3 gap-3">
        {PLUGINS.map(p => {
          const Icon = p.icon
          const cl   = pluginColors[p.color] || pluginColors.indigo
          const statusBadge = p.status === 'active'
            ? 'bg-emerald-500/10 text-emerald-400'
            : 'bg-amber-500/10 text-amber-400'
          return (
            <div key={p.id} className={`rounded-xl border border-white/[0.06] bg-[#12121a] p-4 ${cl.border} transition-all ${p.status === 'update' ? 'opacity-70' : ''}`}>
              <div className="flex items-start justify-between mb-3">
                <div className="flex items-center gap-2.5">
                  <div className={`w-9 h-9 rounded-xl ${cl.icon.split(' ')[0]} flex items-center justify-center`}>
                    <Icon size={15} className={cl.icon.split(' ')[1]} />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-white">{p.name}</div>
                    <div className="text-[10px] text-slate-500">{p.sub}</div>
                  </div>
                </div>
                <span className={`text-[10px] px-2 py-0.5 rounded-full capitalize ${statusBadge}`}>{p.status}</span>
              </div>
              <p className="text-[10px] text-slate-400 mb-3 leading-relaxed">{p.desc}</p>
              <div className="flex items-center gap-1.5">
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/[0.04] text-slate-500 font-mono">{p.version}</span>
                <span className="text-[9px] px-1.5 py-0.5 rounded bg-white/[0.04] text-slate-500 font-mono">{p.platform}</span>
              </div>
            </div>
          )
        })}

        {/* Browse store */}
        <div className="rounded-xl border border-white/[0.06] border-dashed bg-[#12121a] p-4 flex flex-col items-center justify-center text-center cursor-pointer hover:border-indigo-500/30 transition-all group min-h-[160px]">
          <div className="w-9 h-9 rounded-xl bg-white/[0.04] group-hover:bg-indigo-500/10 flex items-center justify-center mb-2 transition-colors">
            <Plus size={15} className="text-slate-500 group-hover:text-indigo-400 transition-colors" />
          </div>
          <p className="text-sm text-slate-500 group-hover:text-slate-300 transition-colors">Browse Plugin Store</p>
          <p className="text-[10px] text-slate-600">Discover new agent extensions</p>
        </div>
      </div>
    </div>
  )
}
