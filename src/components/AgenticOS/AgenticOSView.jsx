import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
  LayoutDashboard, Network, Plug, Zap, Puzzle, Cpu,
  Settings, BrainCircuit, RefreshCw, Search, GitBranch,
  ChevronRight, Loader2, Database, Bot, Clock,
  Activity, Code2, FileCode, Package, Layers, ZapOff,
  Rocket, BookOpen, Monitor, GitPullRequest, Image, Plus,
  Brain, Users, ArrowRight, MessageSquare, Route, Shield,
  Server, CheckSquare, BarChart3, TrendingUp, CheckCircle,
} from 'lucide-react'

async function apiFetch(path) {
  const r = await fetch(path)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

const TABS = [
  { id: 'dashboard', label: 'Dashboard',    icon: LayoutDashboard },
  { id: 'graphify',  label: 'Graphify',     icon: Network,   badge: 'LIVE' },
  { id: 'mcp',       label: 'MCP Servers',  icon: Plug },
  { id: 'skills',    label: 'Skills',       icon: Zap },
  { id: 'plugins',   label: 'Plugins',      icon: Puzzle },
  { id: 'brain',     label: 'Agentic Brain',icon: Cpu },
]

const NODE_COLOR = {
  route:     '#6366f1',
  lib:       '#06b6d4',
  component: '#8b5cf6',
  jsx:       '#a78bfa',
}

const NODE_ICON = {
  route:     Code2,
  lib:       Package,
  component: Layers,
  jsx:       FileCode,
}

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

// ── Dashboard Tab ─────────────────────────────────────────────────────────────

function DashboardTab({ stats, graph, jobs, mcps, skills, onTabSwitch }) {
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

// ── Mini SVG Graph ────────────────────────────────────────────────────────────

function MiniGraph({ graph }) {
  const svgRef = useRef(null)

  useEffect(() => {
    if (!graph?.nodes?.length || !svgRef.current) return
    const svg    = svgRef.current
    const width  = svg.clientWidth  || 600
    const height = svg.clientHeight || 280
    while (svg.firstChild) svg.removeChild(svg.firstChild)

    const sample = graph.nodes
      .filter(n => n.type === 'route' || n.type === 'lib' || n.type === 'component')
      .slice(0, 60)
    const sampleIds   = new Set(sample.map(n => n.id))
    const sampleEdges = graph.edges.filter(e => sampleIds.has(e.source) && sampleIds.has(e.target))
    const nodesCopy   = sample.map(n => ({ ...n }))
    const groups      = { route: [], lib: [], component: [] }
    for (const n of nodesCopy) { if (groups[n.type]) groups[n.type].push(n) }

    const cx = width / 2, cy = height / 2
    const place = (nodes, x, y, r) => nodes.forEach((n, i) => {
      const a = (i / nodes.length) * 2 * Math.PI
      n.x = x + r * Math.cos(a); n.y = y + r * Math.sin(a)
    })
    place(groups.route,     cx,               cy - 20, Math.min(height * 0.38, 130))
    place(groups.lib,       cx - width * 0.22, cy + 30, Math.min(height * 0.2,  60))
    place(groups.component, cx + width * 0.22, cy + 30, Math.min(height * 0.2,  60))

    const posMap = {}
    for (const n of nodesCopy) posMap[n.id] = { x: n.x, y: n.y }

    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    svg.appendChild(g)

    for (const e of sampleEdges) {
      const s = posMap[e.source], t = posMap[e.target]
      if (!s || !t) continue
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', s.x); line.setAttribute('y1', s.y)
      line.setAttribute('x2', t.x); line.setAttribute('y2', t.y)
      line.setAttribute('stroke', 'rgba(99,102,241,0.18)')
      line.setAttribute('stroke-width', '1')
      g.appendChild(line)
    }

    for (const n of nodesCopy) {
      if (!n.x) continue
      const col    = NODE_COLOR[n.type] || '#6366f1'
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      circle.setAttribute('cx', n.x); circle.setAttribute('cy', n.y)
      circle.setAttribute('r', n.type === 'route' ? 5 : n.type === 'lib' ? 4 : 3.5)
      circle.setAttribute('fill', col); circle.setAttribute('opacity', '0.85')
      g.appendChild(circle)

      if (n.type === 'route' && n.label.length < 14) {
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        text.setAttribute('x', n.x); text.setAttribute('y', n.y - 7)
        text.setAttribute('text-anchor', 'middle'); text.setAttribute('font-size', '7')
        text.setAttribute('fill', 'rgba(148,163,184,0.7)'); text.setAttribute('font-family', 'monospace')
        text.textContent = n.label
        g.appendChild(text)
      }
    }

    const leg = [['route', '#6366f1'], ['lib', '#06b6d4'], ['component', '#8b5cf6']]
    leg.forEach(([label, color], i) => {
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      circle.setAttribute('cx', 14); circle.setAttribute('cy', height - 28 + i * 12)
      circle.setAttribute('r', 4); circle.setAttribute('fill', color)
      svg.appendChild(circle)
      const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
      text.setAttribute('x', 22); text.setAttribute('y', height - 24 + i * 12)
      text.setAttribute('font-size', '8'); text.setAttribute('fill', 'rgba(148,163,184,0.6)')
      text.setAttribute('font-family', 'monospace')
      text.textContent = label
      svg.appendChild(text)
    })
  }, [graph])

  return (
    graph?.nodes?.length
      ? <svg ref={svgRef} className="w-full h-64" style={{ background: 'transparent' }} />
      : <div className="h-64 flex items-center justify-center text-slate-600 text-xs">Loading graph data…</div>
  )
}

// ── Graphify Tab — D3 Force Graph ─────────────────────────────────────────────

function GraphifyTab({ graph, search, selectedNode, onSelectNode }) {
  const [nodeDetail,    setNodeDetail]    = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [view,          setView]          = useState('graph')
  const [positions,     setPositions]     = useState([])
  const [links,         setLinks]         = useState([])
  const [zoom,          setZoom]          = useState(1)
  const [pan,           setPan]           = useState({ x: 0, y: 0 })
  const simRef    = useRef(null)
  const rafRef    = useRef(null)
  const svgRef    = useRef(null)
  const dragging  = useRef(null)
  const panStart  = useRef(null)
  const W = 860, H = 520

  const loadDetail = async (id) => {
    onSelectNode(id)
    setDetailLoading(true)
    try {
      const data = await apiFetch(`/api/agentic-os/node/${encodeURIComponent(id)}`)
      setNodeDetail(data)
    } catch { setNodeDetail(null) }
    finally { setDetailLoading(false) }
  }

  // ── Pure-JS force simulation (no D3/CDN) ──────────────────────────────────
  useEffect(() => {
    if (view !== 'graph' || !graph?.nodes?.length) return

    const sample = graph.nodes
      .filter(n => !search || n.label.toLowerCase().includes(search.toLowerCase()))
      .slice(0, 100)
    const idSet = new Set(sample.map(n => n.id))
    const edgeList = graph.edges.filter(e => idSet.has(e.source) && idSet.has(e.target))

    // Initialise node positions in a circle
    const nodes = sample.map((n, i) => {
      const angle = (i / sample.length) * 2 * Math.PI
      const r = Math.min(W, H) * 0.35
      return { ...n, x: W / 2 + r * Math.cos(angle), y: H / 2 + r * Math.sin(angle), vx: 0, vy: 0, fx: null, fy: null }
    })
    const idxMap = {}
    nodes.forEach((n, i) => { idxMap[n.id] = i })

    const edgesIdx = edgeList.map(e => ({ si: idxMap[e.source], ti: idxMap[e.target], label: e.label }))
      .filter(e => e.si !== undefined && e.ti !== undefined)

    simRef.current = { nodes, edgesIdx }

    const LINK_DIST   = 80
    const REPEL       = -180
    const CENTER_STR  = 0.04
    const DAMP        = 0.85
    const ITER_LIMIT  = 300
    let iter = 0

    function tick() {
      const { nodes, edgesIdx } = simRef.current
      const n = nodes.length

      // Repulsion between all pairs (Barnes-Hut approximation: just cap at 50 pairs per node)
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = nodes[j].x - nodes[i].x
          const dy = nodes[j].y - nodes[i].y
          const dist2 = dx * dx + dy * dy + 1
          const dist  = Math.sqrt(dist2)
          const force = REPEL / dist2
          const fx = (dx / dist) * force
          const fy = (dy / dist) * force
          nodes[i].vx -= fx; nodes[i].vy -= fy
          nodes[j].vx += fx; nodes[j].vy += fy
        }
      }

      // Link attraction
      for (const e of edgesIdx) {
        const a = nodes[e.si], b = nodes[e.ti]
        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = (dist - LINK_DIST) * 0.05
        const fx = (dx / dist) * force, fy = (dy / dist) * force
        if (!a.fx) { a.vx += fx; a.vy += fy }
        if (!b.fx) { b.vx -= fx; b.vy -= fy }
      }

      // Center pull + damping + integrate
      for (const node of nodes) {
        if (node.fx !== null) { node.x = node.fx; node.y = node.fy; node.vx = 0; node.vy = 0; continue }
        node.vx = (node.vx + (W / 2 - node.x) * CENTER_STR) * DAMP
        node.vy = (node.vy + (H / 2 - node.y) * CENTER_STR) * DAMP
        node.x = Math.max(12, Math.min(W - 12, node.x + node.vx))
        node.y = Math.max(12, Math.min(H - 12, node.y + node.vy))
      }

      iter++
      // Snapshot positions for React state
      setPositions(nodes.map(n => ({ id: n.id, x: n.x, y: n.y, type: n.type, label: n.label, file: n.file })))
      setLinks(edgesIdx.map(e => ({ x1: nodes[e.si].x, y1: nodes[e.si].y, x2: nodes[e.ti].x, y2: nodes[e.ti].y })))

      if (iter < ITER_LIMIT) rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => { cancelAnimationFrame(rafRef.current) }
  }, [graph, view, search])

  // Drag handlers
  const onNodeMouseDown = (e, id) => {
    e.stopPropagation()
    dragging.current = id
    if (!simRef.current) return
    const node = simRef.current.nodes.find(n => n.id === id)
    if (node) { node.fx = node.x; node.fy = node.y }
    // Restart sim
    const { nodes, edgesIdx } = simRef.current
    cancelAnimationFrame(rafRef.current)
    let iter = 0
    function tick() {
      const n = nodes.length
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y
          const dist2 = dx * dx + dy * dy + 1, dist = Math.sqrt(dist2)
          const force = -180 / dist2
          const fx = (dx / dist) * force, fy = (dy / dist) * force
          nodes[i].vx -= fx; nodes[i].vy -= fy
          nodes[j].vx += fx; nodes[j].vy += fy
        }
      }
      for (const e of edgesIdx) {
        const a = nodes[e.si], b = nodes[e.ti]
        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const force = (dist - 80) * 0.05
        const fx = (dx / dist) * force, fy = (dy / dist) * force
        if (!a.fx) { a.vx += fx; a.vy += fy }
        if (!b.fx) { b.vx -= fx; b.vy -= fy }
      }
      for (const node of nodes) {
        if (node.fx !== null) { node.x = node.fx; node.y = node.fy; node.vx = 0; node.vy = 0; continue }
        node.vx = (node.vx + (W / 2 - node.x) * 0.04) * 0.85
        node.vy = (node.vy + (H / 2 - node.y) * 0.04) * 0.85
        node.x = Math.max(12, Math.min(W - 12, node.x + node.vx))
        node.y = Math.max(12, Math.min(H - 12, node.y + node.vy))
      }
      iter++
      setPositions(nodes.map(n => ({ id: n.id, x: n.x, y: n.y, type: n.type, label: n.label, file: n.file })))
      setLinks(edgesIdx.map(e => ({ x1: nodes[e.si].x, y1: nodes[e.si].y, x2: nodes[e.ti].x, y2: nodes[e.ti].y })))
      if (iter < 200) rafRef.current = requestAnimationFrame(tick)
    }
    rafRef.current = requestAnimationFrame(tick)
  }

  const onSvgMouseMove = (e) => {
    if (dragging.current && simRef.current) {
      const svg = svgRef.current
      const rect = svg.getBoundingClientRect()
      const x = (e.clientX - rect.left - pan.x) / zoom
      const y = (e.clientY - rect.top  - pan.y) / zoom
      const node = simRef.current.nodes.find(n => n.id === dragging.current)
      if (node) { node.fx = x; node.fy = y; node.x = x; node.y = y }
    } else if (panStart.current) {
      const dx = e.clientX - panStart.current.x
      const dy = e.clientY - panStart.current.y
      setPan({ x: panStart.current.panX + dx, y: panStart.current.panY + dy })
    }
  }

  const onSvgMouseUp = (e) => {
    if (dragging.current && simRef.current) {
      const node = simRef.current.nodes.find(n => n.id === dragging.current)
      if (node) { node.fx = null; node.fy = null }
    }
    dragging.current = null
    panStart.current = null
  }

  const onSvgMouseDown = (e) => {
    if (!dragging.current) {
      panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
    }
  }

  const onWheel = (e) => {
    e.preventDefault()
    setZoom(z => Math.max(0.3, Math.min(3, z * (e.deltaY < 0 ? 1.1 : 0.9))))
  }

  const rMap = { route: 8, lib: 6, component: 7, jsx: 4 }

  const filtered = graph?.nodes?.filter(n =>
    !search || n.label.toLowerCase().includes(search.toLowerCase()) || n.type.includes(search.toLowerCase())
  ) || []

  return (
    <div className="space-y-4">
      {/* Stats bar */}
      <div className="flex items-center gap-6 p-4 rounded-xl border border-white/[0.06] bg-[#12121a]">
        {[
          { label: 'Nodes',         value: graph?.nodes?.length ?? '—', color: 'text-indigo-400'  },
          { label: 'Edges',         value: graph?.edges?.length ?? '—', color: 'text-purple-400'  },
          { label: 'Showing',       value: positions.length || '—',     color: 'text-cyan-400'    },
          { label: 'Token Savings', value: '71.5×',                     color: 'text-emerald-400' },
        ].map((s, i) => (
          <div key={i} className="text-center">
            <div className={`text-xl font-bold font-mono ${s.color}`}>{s.value}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">{s.label}</div>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-2">
          <button onClick={() => setView('graph')} className={`px-3 py-1.5 rounded-lg text-xs transition-all ${view === 'graph' ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'}`}>
            Force Graph
          </button>
          <button onClick={() => setView('list')} className={`px-3 py-1.5 rounded-lg text-xs transition-all ${view === 'list' ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'}`}>
            Node List
          </button>
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <div className="col-span-3">
          {view === 'graph' ? (
            <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center gap-2 text-xs text-slate-500">
                <Network size={12} className="text-indigo-400" />
                <span>Drag nodes · Scroll to zoom · Click for details</span>
                <span className="ml-auto">{positions.length} nodes</span>
              </div>
              {graph?.nodes?.length ? (
                <svg
                  ref={svgRef}
                  width="100%" viewBox={`0 0 ${W} ${H}`}
                  style={{ height: 520, cursor: dragging.current ? 'grabbing' : 'grab', userSelect: 'none' }}
                  onMouseMove={onSvgMouseMove}
                  onMouseUp={onSvgMouseUp}
                  onMouseLeave={onSvgMouseUp}
                  onMouseDown={onSvgMouseDown}
                  onWheel={onWheel}
                >
                  <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
                    {/* Edges */}
                    <g>
                      {links.map((l, i) => (
                        <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2}
                          stroke="rgba(99,102,241,0.18)" strokeWidth={1} />
                      ))}
                    </g>
                    {/* Nodes */}
                    <g>
                      {positions.map(n => {
                        const col = NODE_COLOR[n.type] || '#6366f1'
                        const r   = rMap[n.type] || 5
                        const isSelected = selectedNode === n.id
                        return (
                          <g key={n.id} transform={`translate(${n.x},${n.y})`}
                            style={{ cursor: 'pointer' }}
                            onMouseDown={e => onNodeMouseDown(e, n.id)}
                            onClick={() => loadDetail(n.id)}>
                            {isSelected && <circle r={r + 4} fill="none" stroke={col} strokeWidth={1.5} opacity={0.5} />}
                            <circle r={r} fill={col} opacity={0.85} />
                            {n.type !== 'jsx' && (
                              <text x={r + 3} y={4} fontSize={7} fill="rgba(148,163,184,0.85)"
                                fontFamily="monospace" style={{ pointerEvents: 'none' }}>
                                {n.label}
                              </text>
                            )}
                          </g>
                        )
                      })}
                    </g>
                    {/* Legend */}
                    {[['route','#6366f1'],['lib','#06b6d4'],['component','#8b5cf6'],['jsx','#a78bfa']].map(([t,c],i) => (
                      <g key={t} transform={`translate(12,${H - 52 + i * 13})`}>
                        <circle r={4} fill={c} />
                        <text x={9} y={4} fontSize={8} fill="rgba(148,163,184,0.6)" fontFamily="monospace">{t}</text>
                      </g>
                    ))}
                  </g>
                </svg>
              ) : (
                <div className="h-64 flex items-center justify-center text-slate-600 text-xs">Loading graph data…</div>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {['route', 'lib', 'component', 'jsx'].map(type => {
                const nodes = filtered.filter(n => n.type === type)
                if (!nodes.length) return null
                const col  = NODE_COLOR[type] || '#6366f1'
                const Icon = NODE_ICON[type]  || Code2
                return (
                  <div key={type} className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
                    <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center gap-2">
                      <Icon size={13} style={{ color: col }} />
                      <span className="text-xs font-semibold capitalize" style={{ color: col }}>{type}s</span>
                      <span className="ml-auto text-[10px] text-slate-500">{nodes.length} nodes</span>
                    </div>
                    <div className="grid grid-cols-2 gap-px p-1">
                      {nodes.map(n => (
                        <button key={n.id} onClick={() => loadDetail(n.id)}
                          className={`flex items-start gap-2 px-3 py-2 rounded-lg text-left transition-all hover:bg-white/[0.05] ${selectedNode === n.id ? 'bg-indigo-500/10 border border-indigo-500/20' : ''}`}>
                          <Icon size={11} className="mt-0.5 flex-shrink-0" style={{ color: col }} />
                          <div className="min-w-0">
                            <div className="text-xs text-white font-medium truncate">{n.label}</div>
                            {n.file && <div className="text-[10px] text-slate-600 truncate font-mono">{n.file}</div>}
                          </div>
                        </button>
                      ))}
                    </div>
                  </div>
                )
              })}
              {!filtered.length && (
                <div className="flex items-center justify-center h-40 text-slate-600 text-sm">No nodes match "{search}"</div>
              )}
            </div>
          )}
        </div>

        {/* Node detail panel */}
        <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden self-start sticky top-0">
          <div className="px-4 py-3 border-b border-white/[0.06]">
            <div className="text-sm font-semibold text-white">Node Detail</div>
            <div className="text-[10px] text-slate-500">Click a node to inspect</div>
          </div>
          <div className="p-4">
            {detailLoading && <Loader2 size={16} className="text-indigo-400 animate-spin mx-auto" />}
            {!detailLoading && !nodeDetail && <div className="text-xs text-slate-600 text-center py-6">Select a node</div>}
            {!detailLoading && nodeDetail && (
              <div className="space-y-3">
                <div>
                  <div className="text-xs font-semibold text-white">{nodeDetail.node.label}</div>
                  <div className="text-[10px] text-slate-500 font-mono mt-0.5">{nodeDetail.node.id}</div>
                  {nodeDetail.node.description && <div className="text-[10px] text-slate-400 mt-1">{nodeDetail.node.description}</div>}
                  {nodeDetail.node.file && <div className="text-[10px] text-indigo-400 font-mono mt-1">{nodeDetail.node.file}</div>}
                  {nodeDetail.node.lineCount && <div className="text-[10px] text-slate-600 mt-0.5">{nodeDetail.node.lineCount} lines</div>}
                </div>
                {nodeDetail.neighbours.length > 0 && (
                  <div>
                    <div className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-1.5">Connections ({nodeDetail.neighbours.length})</div>
                    <div className="space-y-1 max-h-64 overflow-y-auto">
                      {nodeDetail.neighbours.map((nb, i) => (
                        <div key={i} className="flex items-center gap-2 text-[10px]">
                          <span className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${nb.direction === 'out' ? 'bg-indigo-500/15 text-indigo-400' : 'bg-purple-500/15 text-purple-400'}`}>
                            {nb.direction === 'out' ? '→' : '←'} {nb.relation}
                          </span>
                          <span className="text-slate-300 truncate">{nb.label}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// ── MCP Servers Tab ───────────────────────────────────────────────────────────

function MCPTab({ mcps }) {
  const statusColor = { connected: 'bg-emerald-400', idle: 'bg-amber-400', disconnected: 'bg-red-400' }
  const statusText  = { connected: 'text-emerald-400', idle: 'text-amber-400', disconnected: 'text-red-400' }
  const statusBg    = { connected: 'bg-emerald-500/10', idle: 'bg-amber-500/10', disconnected: 'bg-red-500/10' }

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">MCP Servers</h2>
          <p className="text-xs text-slate-500 mt-0.5">Model Context Protocol data providers</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="text-[10px] text-slate-500">{mcps.filter(m => m.status === 'connected').length} / {mcps.length} connected</div>
          <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs hover:bg-indigo-500/20 transition-all">
            <Plus size={12} /> Add Server
          </button>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3">
        {mcps.map(m => (
          <div key={m.id} className="rounded-xl border border-white/[0.06] bg-[#12121a] p-4 hover:border-white/[0.12] transition-all">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-white/[0.04] border border-white/[0.06] flex items-center justify-center">
                  <Server size={15} className="text-slate-400" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white">{m.name}</div>
                  <div className="text-[10px] text-slate-500 font-mono">{m.transport}</div>
                </div>
              </div>
              <span className={`text-[10px] px-2 py-0.5 rounded-full font-mono ${statusBg[m.status] || 'bg-slate-500/10'} ${statusText[m.status] || 'text-slate-500'}`}>
                {m.status}
              </span>
            </div>
            <div className="text-[10px] text-slate-400 mb-2">{m.purpose}</div>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-1.5">
                <span className={`w-1.5 h-1.5 rounded-full ${statusColor[m.status] || 'bg-slate-600'} ${m.status === 'connected' ? 'shadow-sm shadow-emerald-400/50' : ''}`} />
                <span className="text-[10px] text-slate-600 font-mono">{m.tool}</span>
              </div>
              <span className="text-[10px] text-slate-600">{m.toolCount} tools</span>
            </div>
          </div>
        ))}

        {/* Add new */}
        <div className="rounded-xl border border-white/[0.06] border-dashed bg-[#12121a] p-4 flex flex-col items-center justify-center text-center cursor-pointer hover:border-indigo-500/30 transition-all min-h-[120px]">
          <div className="w-9 h-9 rounded-xl bg-white/[0.04] flex items-center justify-center mb-2">
            <Plus size={15} className="text-slate-500" />
          </div>
          <p className="text-sm text-slate-500">Add MCP Server</p>
          <p className="text-[10px] text-slate-600 mt-0.5">Connect a new provider</p>
        </div>
      </div>
    </div>
  )
}

// ── Skills Tab ────────────────────────────────────────────────────────────────

function SkillsTab({ skills }) {
  const [filter, setFilter] = useState('all')
  const [search, setSearch] = useState('')

  const filtered = skills.filter(s =>
    (!search || s.name.toLowerCase().includes(search.toLowerCase()) || s.description?.toLowerCase().includes(search.toLowerCase()))
  )

  const tagColors = ['text-indigo-400 bg-indigo-500/10', 'text-purple-400 bg-purple-500/10', 'text-cyan-400 bg-cyan-500/10', 'text-emerald-400 bg-emerald-500/10']

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-bold text-white">FinSurfing Skills</h2>
          <p className="text-xs text-slate-500 mt-0.5">AI capabilities registered in the system</p>
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
        {filtered.map((s, idx) => (
          <div key={s.id} className="rounded-xl border border-white/[0.06] bg-[#12121a] p-4 hover:border-indigo-500/25 transition-all group">
            <div className="flex items-start justify-between mb-3">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-xl bg-indigo-500/10 flex items-center justify-center">
                  <Zap size={15} className="text-indigo-400" />
                </div>
                <div>
                  <div className="text-sm font-medium text-white">{s.name}</div>
                  <div className="text-[10px] text-slate-500 font-mono truncate max-w-[140px]">{s.endpoint}</div>
                </div>
              </div>
              <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400">{s.status}</span>
            </div>
            <div className="text-[10px] text-slate-400 mb-3">{s.description}</div>
            {s.tags && (
              <div className="flex flex-wrap gap-1">
                {s.tags.map((tag, ti) => (
                  <span key={tag} className={`text-[9px] px-1.5 py-0.5 rounded font-mono ${tagColors[ti % tagColors.length]}`}>{tag}</span>
                ))}
              </div>
            )}
          </div>
        ))}

        {/* Create new */}
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

function PluginsTab() {
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

// ── Agentic Brain Tab ─────────────────────────────────────────────────────────

function BrainTab({ jobs, stats, mcps, onRefresh }) {
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
