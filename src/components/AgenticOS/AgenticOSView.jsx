import { useState, useEffect, useRef, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
  LayoutDashboard, Network, Plug, Zap, Puzzle, Cpu, Terminal,
  Settings, BrainCircuit, RefreshCw, Play, Search, GitBranch,
  TrendingUp, CheckCircle, Activity, ZapOff, ChevronRight,
  AlertCircle, Loader2, Database, Globe, Bot, Clock,
  BarChart2, Shield, Layers, Code2, FileCode, Package,
} from 'lucide-react'

// ── API helpers ───────────────────────────────────────────────────────────────

async function apiFetch(path) {
  const r = await fetch(path)
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// ── Tab definitions ───────────────────────────────────────────────────────────

const TABS = [
  { id: 'dashboard', label: 'Dashboard',    icon: LayoutDashboard },
  { id: 'graphify',  label: 'Graphify',     icon: Network,   badge: 'LIVE' },
  { id: 'mcp',       label: 'MCP Servers',  icon: Plug },
  { id: 'skills',    label: 'Skills',       icon: Zap },
  { id: 'brain',     label: 'Agentic Brain',icon: Cpu },
]

// ── Node type colours ─────────────────────────────────────────────────────────

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

// ── Main view ─────────────────────────────────────────────────────────────────

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
      {/* Dot grid background */}
      <div className="fixed inset-0 pointer-events-none opacity-30"
        style={{ backgroundImage: 'radial-gradient(circle at 1px 1px, rgba(99,102,241,0.15) 1px, transparent 0)', backgroundSize: '40px 40px' }} />

      {/* Sidebar */}
      <aside className="w-56 flex-shrink-0 flex flex-col border-r border-white/[0.06] bg-[#12121a]/90 backdrop-blur-xl z-10">
        {/* Logo */}
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

        {/* Nav */}
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
                {t.id === 'mcp'   && <span className="ml-auto text-[10px] bg-emerald-500/20 text-emerald-400 px-1.5 py-0.5 rounded-full">{connectedMcps}</span>}
                {t.id === 'skills'&& <span className="ml-auto text-[10px] bg-purple-500/20 text-purple-400 px-1.5 py-0.5 rounded-full">{skills.length}</span>}
                {t.id === 'brain' && activeJobs > 0 && <span className="ml-auto w-2 h-2 rounded-full bg-emerald-400 animate-pulse" />}
              </button>
            )
          })}
        </nav>

        {/* Footer stats */}
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
        {/* Header */}
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

        {/* Tab content */}
        <div className="flex-1 overflow-y-auto p-5">
          <AnimatePresence mode="wait">
            <motion.div key={tab} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: 0.15 }}>
              {tab === 'dashboard' && <DashboardTab stats={stats} graph={graph} jobs={jobs} mcps={mcps} skills={skills} onTabSwitch={setTab} />}
              {tab === 'graphify'  && <GraphifyTab graph={graph} search={search} selectedNode={selectedNode} onSelectNode={setSelectedNode} />}
              {tab === 'mcp'       && <MCPTab mcps={mcps} />}
              {tab === 'skills'    && <SkillsTab skills={skills} />}
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
    indigo:  { bg: 'bg-indigo-500/10', border: 'hover:border-indigo-500/40', text: 'text-indigo-400', icon: 'bg-indigo-500/15' },
    purple:  { bg: 'bg-purple-500/10', border: 'hover:border-purple-500/40', text: 'text-purple-400', icon: 'bg-purple-500/15' },
    cyan:    { bg: 'bg-cyan-500/10',   border: 'hover:border-cyan-500/40',   text: 'text-cyan-400',   icon: 'bg-cyan-500/15'   },
    emerald: { bg: 'bg-emerald-500/10',border: 'hover:border-emerald-500/40',text: 'text-emerald-400',icon: 'bg-emerald-500/15'},
  }

  return (
    <div className="space-y-5">
      {/* Stat cards */}
      <div className="grid grid-cols-4 gap-4">
        {statCards.map(c => {
          const Icon = c.icon
          const cl   = colorMap[c.color]
          return (
            <div key={c.label} className={`rounded-xl p-4 border border-white/[0.06] ${cl.border} bg-[#12121a] transition-all group cursor-default`}>
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

      {/* Graph preview + Brain status */}
      <div className="grid grid-cols-3 gap-4">
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
              { label: 'Routes mapped',   value: stats?.routes      ?? '—', icon: Code2,   color: 'text-indigo-400' },
              { label: 'Lib modules',     value: stats?.libs        ?? '—', icon: Package,  color: 'text-cyan-400'   },
              { label: 'Components',      value: stats?.components  ?? '—', icon: Layers,   color: 'text-purple-400' },
              { label: 'Scheduled jobs',  value: jobs.length         || '—', icon: Clock,    color: 'text-emerald-400'},
              { label: 'Jobs running',    value: activeJobs          || 0,   icon: Activity, color: activeJobs ? 'text-amber-400' : 'text-slate-600' },
            ].map(r => {
              const Icon = r.icon
              return (
                <div key={r.label} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Icon size={12} className={r.color} />
                    <span className="text-xs text-slate-400">{r.label}</span>
                  </div>
                  <span className={`text-xs font-mono font-semibold ${r.color}`}>{r.value}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* Scheduled jobs */}
      <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.06]">
          <div className="text-sm font-semibold text-white">Scheduled Jobs</div>
        </div>
        <div className="divide-y divide-white/[0.04]">
          {jobs.map(j => {
            const status = j.result?.status || 'idle'
            const statusColor = status === 'done' ? 'text-emerald-400' : status === 'running' ? 'text-amber-400' : status === 'failed' ? 'text-red-400' : 'text-slate-600'
            const dotColor    = status === 'done' ? 'bg-emerald-400' : status === 'running' ? 'bg-amber-400 animate-pulse' : status === 'failed' ? 'bg-red-400' : 'bg-slate-600'
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
      </div>
    </div>
  )
}

// ── Mini D3 Graph ─────────────────────────────────────────────────────────────

function MiniGraph({ graph }) {
  const svgRef = useRef(null)

  useEffect(() => {
    if (!graph?.nodes?.length || !svgRef.current) return

    const svg    = svgRef.current
    const width  = svg.clientWidth  || 600
    const height = svg.clientHeight || 280

    // Clear
    while (svg.firstChild) svg.removeChild(svg.firstChild)

    // Sample nodes for readability (max 60)
    const sample = graph.nodes
      .filter(n => n.type === 'route' || n.type === 'lib' || n.type === 'component')
      .slice(0, 60)
    const sampleIds = new Set(sample.map(n => n.id))
    const sampleEdges = graph.edges.filter(e => sampleIds.has(e.source) && sampleIds.has(e.target))

    const nodesCopy = sample.map(n => ({ ...n }))
    const edgesCopy = sampleEdges.map(e => ({ ...e }))

    // Simple force simulation without d3 import — use manual positioning
    // Group by type for layout
    const groups = { route: [], lib: [], component: [] }
    for (const n of nodesCopy) {
      if (groups[n.type]) groups[n.type].push(n)
    }

    const cx = width / 2, cy = height / 2
    const place = (nodes, cx, cy, r) => {
      nodes.forEach((n, i) => {
        const angle = (i / nodes.length) * 2 * Math.PI
        n.x = cx + r * Math.cos(angle)
        n.y = cy + r * Math.sin(angle)
      })
    }
    place(groups.route,     cx,                 cy - 20, Math.min(height * 0.38, 130))
    place(groups.lib,       cx - width * 0.22,  cy + 30, Math.min(height * 0.2, 60))
    place(groups.component, cx + width * 0.22,  cy + 30, Math.min(height * 0.2, 60))

    const posMap = {}
    for (const n of nodesCopy) posMap[n.id] = { x: n.x, y: n.y }

    // Draw edges
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g')
    svg.appendChild(g)

    for (const e of edgesCopy) {
      const s = posMap[e.source], t = posMap[e.target]
      if (!s || !t) continue
      const line = document.createElementNS('http://www.w3.org/2000/svg', 'line')
      line.setAttribute('x1', s.x); line.setAttribute('y1', s.y)
      line.setAttribute('x2', t.x); line.setAttribute('y2', t.y)
      line.setAttribute('stroke', 'rgba(99,102,241,0.18)')
      line.setAttribute('stroke-width', '1')
      g.appendChild(line)
    }

    // Draw nodes
    for (const n of nodesCopy) {
      if (!n.x) continue
      const col = NODE_COLOR[n.type] || '#6366f1'
      const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
      circle.setAttribute('cx', n.x); circle.setAttribute('cy', n.y)
      circle.setAttribute('r', n.type === 'route' ? 5 : n.type === 'lib' ? 4 : 3.5)
      circle.setAttribute('fill', col)
      circle.setAttribute('opacity', '0.85')
      g.appendChild(circle)

      // Label for routes only
      if (n.type === 'route' && n.label.length < 14) {
        const text = document.createElementNS('http://www.w3.org/2000/svg', 'text')
        text.setAttribute('x', n.x); text.setAttribute('y', n.y - 7)
        text.setAttribute('text-anchor', 'middle')
        text.setAttribute('font-size', '7')
        text.setAttribute('fill', 'rgba(148,163,184,0.7)')
        text.setAttribute('font-family', 'monospace')
        text.textContent = n.label
        g.appendChild(text)
      }
    }

    // Legend
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

  return <svg ref={svgRef} className="w-full h-64" style={{ background: 'transparent' }} />
}

// ── Graphify Tab ──────────────────────────────────────────────────────────────

function GraphifyTab({ graph, search, selectedNode, onSelectNode }) {
  const [nodeDetail, setNodeDetail] = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const filtered = graph?.nodes?.filter(n =>
    !search || n.label.toLowerCase().includes(search.toLowerCase()) || n.type.includes(search.toLowerCase())
  ) || []

  const loadDetail = async (id) => {
    onSelectNode(id)
    setDetailLoading(true)
    try {
      const data = await apiFetch(`/api/agentic-os/node/${encodeURIComponent(id)}`)
      setNodeDetail(data)
    } catch { setNodeDetail(null) }
    finally { setDetailLoading(false) }
  }

  const groups = ['route', 'lib', 'component', 'jsx']

  return (
    <div className="grid grid-cols-3 gap-4 h-full">
      {/* Node list */}
      <div className="col-span-2 space-y-4">
        {groups.map(type => {
          const nodes = filtered.filter(n => n.type === type)
          if (!nodes.length) return null
          const col = NODE_COLOR[type] || '#6366f1'
          const Icon = NODE_ICON[type] || Code2
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

      {/* Node detail */}
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
  )
}

// ── MCP Servers Tab ───────────────────────────────────────────────────────────

function MCPTab({ mcps }) {
  const statusColor = { connected: 'bg-emerald-400', idle: 'bg-amber-400', disconnected: 'bg-red-400' }
  const statusText  = { connected: 'text-emerald-400', idle: 'text-amber-400', disconnected: 'text-red-400' }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">MCP Servers</h2>
        <div className="text-[10px] text-slate-500">{mcps.filter(m => m.status === 'connected').length} / {mcps.length} connected</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {mcps.map(m => (
          <div key={m.id} className="rounded-xl border border-white/[0.06] bg-[#12121a] p-4 hover:border-white/[0.12] transition-all">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2">
                <span className={`w-2 h-2 rounded-full flex-shrink-0 ${statusColor[m.status] || 'bg-slate-600'} ${m.status === 'connected' ? 'shadow-sm shadow-emerald-400/50' : ''}`} />
                <span className="text-sm font-medium text-white">{m.name}</span>
              </div>
              <span className={`text-[10px] font-mono ${statusText[m.status] || 'text-slate-500'}`}>{m.status}</span>
            </div>
            <div className="text-[10px] text-slate-400 mb-1">{m.purpose}</div>
            <div className="text-[10px] text-slate-600 font-mono">{m.tool}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Skills Tab ────────────────────────────────────────────────────────────────

function SkillsTab({ skills }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-white">FinSurfing Skills</h2>
        <div className="text-[10px] text-slate-500">{skills.length} capabilities registered</div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {skills.map(s => (
          <div key={s.id} className="rounded-xl border border-white/[0.06] bg-[#12121a] p-4 hover:border-indigo-500/25 transition-all group">
            <div className="flex items-start justify-between mb-2">
              <div className="flex items-center gap-2">
                <div className="w-6 h-6 rounded-lg bg-indigo-500/15 flex items-center justify-center">
                  <Zap size={11} className="text-indigo-400" />
                </div>
                <span className="text-sm font-medium text-white">{s.name}</span>
              </div>
              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-500/10 text-emerald-400">{s.status}</span>
            </div>
            <div className="text-[10px] text-slate-400 mb-2">{s.description}</div>
            <div className="text-[10px] text-slate-600 font-mono truncate">{s.endpoint}</div>
          </div>
        ))}
      </div>
    </div>
  )
}

// ── Agentic Brain Tab ─────────────────────────────────────────────────────────

function BrainTab({ jobs, stats, mcps, onRefresh }) {
  const connected = mcps.filter(m => m.status === 'connected')

  return (
    <div className="space-y-4">
      {/* Brain header */}
      <div className="rounded-xl border border-indigo-500/20 bg-gradient-to-br from-indigo-500/5 to-purple-500/5 p-5">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-purple-600 flex items-center justify-center shadow-lg shadow-indigo-500/30 animate-pulse">
              <BrainCircuit size={20} className="text-white" />
            </div>
            <div>
              <div className="font-bold text-white">Agentic Brain — Active</div>
              <div className="text-[11px] text-emerald-400 flex items-center gap-1">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 inline-block" />
                claude-sonnet-4-6 · Groq fallback · Tool-use enabled
              </div>
            </div>
          </div>
          <button onClick={onRefresh} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs hover:bg-indigo-500/20 transition-all">
            <RefreshCw size={12} />
            Refresh
          </button>
        </div>

        {/* Brain metrics */}
        <div className="grid grid-cols-4 gap-3">
          {[
            { label: 'Routes mapped',    value: stats?.routes      ?? '—', color: 'text-indigo-400' },
            { label: 'AI tools',         value: stats?.libs        ?? '—', color: 'text-purple-400' },
            { label: 'Graph nodes',      value: stats?.nodes       ?? '—', color: 'text-cyan-400'   },
            { label: 'Live data feeds',  value: connected.length   || '—', color: 'text-emerald-400'},
          ].map(m => (
            <div key={m.label} className="rounded-lg bg-white/[0.03] border border-white/[0.06] p-3 text-center">
              <div className={`text-xl font-bold font-mono ${m.color}`}>{m.value}</div>
              <div className="text-[10px] text-slate-500 mt-0.5">{m.label}</div>
            </div>
          ))}
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
            { name: 'scan_market',        desc: 'AI Brain 5-agent broad scan',           latency: '~90s',  color: '#6366f1' },
            { name: 'get_recommendations',desc: 'Investor persona buy signals',          latency: '~60s',  color: '#8b5cf6' },
            { name: 'analyze_symbol',     desc: 'Deep TA + alt data for ticker',         latency: '~35s',  color: '#06b6d4' },
            { name: 'get_social_sentiment',desc: 'Reddit WSB/stocks/investing sentiment', latency: '~8s',   color: '#10b981' },
            { name: 'get_macro',          desc: '14 FRED series + regime assessment',    latency: '~15s',  color: '#f59e0b' },
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

      {/* Scheduler status */}
      <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
        <div className="px-4 py-3 border-b border-white/[0.06]">
          <div className="text-sm font-semibold text-white">Background Agent Jobs</div>
        </div>
        <div className="divide-y divide-white/[0.04]">
          {jobs.map(j => {
            const status  = j.result?.status || 'idle'
            const dot     = { done: 'bg-emerald-400', running: 'bg-amber-400 animate-pulse', failed: 'bg-red-400', idle: 'bg-slate-600' }[status] || 'bg-slate-600'
            const txt     = { done: 'text-emerald-400', running: 'text-amber-400', failed: 'text-red-400', idle: 'text-slate-600' }[status] || 'text-slate-600'
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
      </div>
    </div>
  )
}
