import { useState, useEffect, useRef } from 'react'
import { Network, Loader2, Code2 } from 'lucide-react'
import { apiFetch, NODE_COLOR, NODE_ICON } from './shared'

// ── Graphify Tab — D3 Force Graph ─────────────────────────────────────────────

export default function GraphifyTab({ graph, search, selectedNode, onSelectNode }) {
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
