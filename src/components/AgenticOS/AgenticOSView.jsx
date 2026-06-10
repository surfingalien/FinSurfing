import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
  LayoutDashboard, Network, Plug, Zap, Puzzle, Cpu,
  BrainCircuit, RefreshCw, Search, GitBranch, Loader2,
} from 'lucide-react'
import { apiFetch }  from './tabs/shared'
import DashboardTab  from './tabs/DashboardTab'
import GraphifyTab   from './tabs/GraphifyTab'
import MCPTab        from './tabs/MCPTab'
import SkillsTab     from './tabs/SkillsTab'
import PluginsTab    from './tabs/PluginsTab'
import BrainTab      from './tabs/BrainTab'

const TABS = [
  { id: 'dashboard', label: 'Dashboard',    icon: LayoutDashboard },
  { id: 'graphify',  label: 'Graphify',     icon: Network,   badge: 'LIVE' },
  { id: 'mcp',       label: 'MCP Servers',  icon: Plug },
  { id: 'skills',    label: 'Skills',       icon: Zap },
  { id: 'plugins',   label: 'Plugins',      icon: Puzzle },
  { id: 'brain',     label: 'Agentic Brain',icon: Cpu },
]

export default function AgenticOSView() {
  const [tab,    setTab]    = useState('dashboard')
  const [stats,  setStats]  = useState(null)
  const [graph,  setGraph]  = useState(null)
  const [skills, setSkills] = useState([])
  const [mcps,   setMcps]   = useState([])
  const [jobs,   setJobs]   = useState([])
  const [search, setSearch] = useState('')
  const [loading,setLoading]= useState(false)
  const [selectedNode, setSelectedNode] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [s, g, sk, m, j] = await Promise.allSettled([
        apiFetch('/api/agentic-os/stats'),
        apiFetch('/api/agentic-os/graph'),
        apiFetch('/api/agentic-os/skills'),
        apiFetch('/api/agentic-os/mcps'),
        apiFetch('/api/scheduler/jobs'),
      ])
      if (s.status === 'fulfilled') setStats(s.value)
      if (g.status === 'fulfilled') setGraph(g.value)
      if (sk.status === 'fulfilled') setSkills(sk.value.skills || [])
      if (m.status === 'fulfilled') setMcps(m.value.servers || [])
      if (j.status === 'fulfilled') setJobs(j.value || [])
    } finally { setLoading(false) }
  }, [])

  useEffect(() => { load() }, [load])

  const connectedMcps = mcps.filter(m => m.status === 'connected').length
  const activeJobs    = jobs.filter(j => j.result?.status === 'running').length

  return (
    <div className="flex h-full overflow-hidden bg-[#0a0a0f] text-slate-200">
      <div className="fixed inset-0 pointer-events-none opacity-30"
        style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(99,102,241,0.15) 1px, transparent 0)', backgroundSize: '40px 40px' }} />

      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 flex flex-col border-r border-white/[0.06] bg-[#12121a]/90 backdrop-blur-xl z-10">
        <div className="p-4 border-b border-white/[0.06]">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/20">
              <BrainCircuit size={17} className="text-white" />
            </div>
            <div>
              <div className="font-bold text-sm tracking-tight text-white">Agentic OS</div>
              <div className="text-[10px] text-slate-500 font-mono">FinSurfing v1.0</div>
            </div>
          </div>
        </div>

        <nav className="flex-1 p-2 space-y-0.5">
          <div className="text-[10px] font-semibold text-slate-600 uppercase tracking-wider px-3 py-2">Command Center</div>
          {TABS.map(t => {
            const Icon = t.icon
            const active = tab === t.id
            return (
              <button key={t.id} onClick={() => setTab(t.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm font-medium transition-all ${
                  active
                    ? 'bg-indigo-500/15 border border-indigo-500/25 text-indigo-300'
                    : 'text-slate-400 hover:bg-white/[0.04] hover:text-white'
                }`}>
                <Icon size={15} />
                {t.label}
                {t.badge && <span className="ml-auto text-[9px] bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded-full">{t.badge}</span>}
                {t.id === 'mcp'    && <span className="ml-auto text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded-full">{connectedMcps}</span>}
                {t.id === 'skills' && <span className="ml-auto text-[10px] bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded-full">{skills.length}</span>}
                {t.id === 'brain'  && activeJobs > 0 && <span className="ml-auto w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />}
              </button>
            )
          })}
        </nav>

        <div className="p-3 border-t border-white/[0.06] space-y-2">
          <div className="flex justify-between text-[10px]">
            <span className="text-slate-500">Graph Nodes</span>
            <span className="text-indigo-400 font-mono">{stats?.nodes ?? '—'}</span>
          </div>
          <div className="flex justify-between text-[10px]">
            <span className="text-slate-500">Scheduled Jobs</span>
            <span className="text-emerald-400 font-mono">{jobs.length} active</span>
          </div>
          <button onClick={load} className="w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg text-[10px] text-slate-500 hover:text-slate-300 hover:bg-white/[0.04] transition-all">
            <RefreshCw size={10} className={loading ? 'animate-spin' : ''} />
            Refresh
          </button>
        </div>
      </aside>

      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        <header className="h-12 flex-shrink-0 flex items-center justify-between px-5 border-b border-white/[0.06] bg-[#12121a]/70 backdrop-blur-xl">
          <div className="flex items-center gap-3">
            <div className="relative">
              <Search size={13} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-slate-500" />
              <input value={search} onChange={e => setSearch(e.target.value)}
                placeholder="Search graph nodes, skills, MCPs…"
                className="w-72 bg-white/[0.04] border border-white/[0.06] rounded-lg pl-8 pr-3 py-1.5 text-xs text-white placeholder-slate-600 outline-none focus:border-indigo-500/40 transition-colors" />
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <GitBranch size={11} />
              <span className="font-mono">main</span>
              <span className="text-emerald-400">●</span>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {loading && <Loader2 size={13} className="text-indigo-400 animate-spin" />}
            <div className="text-[10px] text-slate-500 font-mono">{stats?.generatedAt ? new Date(stats.generatedAt).toLocaleTimeString() : ''}</div>
          </div>
        </header>

        <div className="flex-1 overflow-y-auto p-5">
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {tab === 'dashboard' && <DashboardTab stats={stats} graph={graph} jobs={jobs} mcps={mcps} skills={skills} onTabSwitch={setTab} />}
              {tab === 'graphify'  && <GraphifyTab graph={graph} search={search} selectedNode={selectedNode} onSelectNode={setSelectedNode} />}
              {tab === 'mcp'       && <MCPTab mcps={mcps} />}
              {tab === 'skills'    && <SkillsTab skills={skills} />}
              {tab === 'plugins'   && <PluginsTab />}
              {tab === 'brain'     && <BrainTab jobs={jobs} stats={stats} mcps={mcps} onRefresh={load} />}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
    </div>
  )
}
