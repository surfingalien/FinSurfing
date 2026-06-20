import { useState, useEffect, useRef, useMemo } from 'react'
import { Network, Loader2, Code2, GitBranch, Layers, Zap, TrendingUp, TrendingDown, Minus } from 'lucide-react'
import { apiFetch, NODE_COLOR, NODE_ICON } from './shared'

// ── Graphify Tab ──────────────────────────────────────────────────────────────

// Status dot colours for provider nodes
const STATUS_COLOR = { connected: '#10b981', idle: '#6b7280', disconnected: '#ef4444' }

// Signal colours for the live overlay and Signals view
function sigColor(verdict) {
  if (!verdict) return null
  const u = String(verdict).toUpperCase()
  if (u.includes('STRONG') && u.includes('BUY'))  return '#10b981'
  if (u.includes('BUY') || u.includes('ACCUMULATE')) return '#34d399'
  if (u.includes('STRONG') && u.includes('SELL')) return '#ef4444'
  if (u.includes('SELL') || u.includes('AVOID') || u.includes('REDUCE')) return '#f87171'
  return '#f59e0b' // HOLD / NEUTRAL
}

// Tier colours for data-flow nodes
const TIER_COLOR = {
  0: '#f59e0b', // external providers — amber
  1: '#6366f1', // server routes — indigo
  2: '#06b6d4', // cache / persistence — cyan
  3: '#8b5cf6', // frontend components — violet
}
const TIER_LABEL = ['External Provider', 'API Route', 'Cache / Lib', 'UI Component']

export default function GraphifyTab({ graph, search, selectedNode, onSelectNode }) {
  const [nodeDetail,    setNodeDetail]    = useState(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [view,          setView]          = useState('graph')
  const [positions,     setPositions]     = useState([])
  const [links,         setLinks]         = useState([])
  const [zoom,          setZoom]          = useState(1)
  const [pan,           setPan]           = useState({ x: 0, y: 0 })
  const [dataFlow,      setDataFlow]      = useState(null)
  const [entities,      setEntities]      = useState(null)
  const [scanCache,     setScanCache]     = useState(null)
  const [dfLoading,     setDfLoading]     = useState(false)
  const [entLoading,    setEntLoading]    = useState(false)
  const [hoveredGraphNode, setHoveredGraphNode] = useState(null)

  const simRef    = useRef(null)
  const rafRef    = useRef(null)
  const svgRef    = useRef(null)
  const dragging  = useRef(null)
  const panStart  = useRef(null)
  const W = 860, H = 520

  // Load data-flow on demand
  useEffect(() => {
    if (view !== 'dataflow' || dataFlow) return
    setDfLoading(true)
    apiFetch('/api/agentic-os/data-flow').then(d => setDataFlow(d)).catch(() => {}).finally(() => setDfLoading(false))
  }, [view, dataFlow])

  // Load entities on demand
  useEffect(() => {
    if (view !== 'entities' || entities) return
    setEntLoading(true)
    apiFetch('/api/agentic-os/entities').then(d => setEntities(d)).catch(() => {}).finally(() => setEntLoading(false))
  }, [view, entities])

  // Load scan cache for signal overlay (entities + signals views)
  useEffect(() => {
    if (view !== 'entities' && view !== 'signals') return
    apiFetch('/api/scheduler/cache/scan').then(d => setScanCache(d)).catch(() => {})
  }, [view])

  const loadDetail = async (id) => {
    onSelectNode(id)
    // Only fetch /node detail for code-graph nodes (route:/lib:/component:/jsx:)
    if (!id.startsWith('route:') && !id.startsWith('lib:') && !id.startsWith('component:') && !id.startsWith('jsx:')) {
      setNodeDetail(null)
      return
    }
    setDetailLoading(true)
    try {
      const data = await apiFetch(`/api/agentic-os/node/${encodeURIComponent(id)}`)
      setNodeDetail(data)
    } catch { setNodeDetail(null) }
    finally { setDetailLoading(false) }
  }

  // ── Force simulation (code graph) ─────────────────────────────────────────
  useEffect(() => {
    if (view !== 'graph' || !graph?.nodes?.length) return

    const sample = graph.nodes
      .filter(n => !search || n.label.toLowerCase().includes(search.toLowerCase()))
      .slice(0, 100)
    const idSet = new Set(sample.map(n => n.id))
    const edgeList = graph.edges.filter(e => idSet.has(e.source) && idSet.has(e.target))

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
    const LINK_DIST = 80, REPEL = -180, CENTER_STR = 0.04, DAMP = 0.85
    let iter = 0

    function tick() {
      const { nodes, edgesIdx } = simRef.current
      const n = nodes.length
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y
          const dist2 = dx*dx + dy*dy + 1, dist = Math.sqrt(dist2)
          const force = REPEL / dist2
          const fx = (dx/dist)*force, fy = (dy/dist)*force
          nodes[i].vx -= fx; nodes[i].vy -= fy
          nodes[j].vx += fx; nodes[j].vy += fy
        }
      }
      for (const e of edgesIdx) {
        const a = nodes[e.si], b = nodes[e.ti]
        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.sqrt(dx*dx + dy*dy) || 1
        const force = (dist - LINK_DIST) * 0.05
        const fx = (dx/dist)*force, fy = (dy/dist)*force
        if (!a.fx) { a.vx += fx; a.vy += fy }
        if (!b.fx) { b.vx -= fx; b.vy -= fy }
      }
      for (const node of nodes) {
        if (node.fx !== null) { node.x = node.fx; node.y = node.fy; node.vx = 0; node.vy = 0; continue }
        node.vx = (node.vx + (W/2 - node.x)*CENTER_STR)*DAMP
        node.vy = (node.vy + (H/2 - node.y)*CENTER_STR)*DAMP
        node.x = Math.max(12, Math.min(W-12, node.x + node.vx))
        node.y = Math.max(12, Math.min(H-12, node.y + node.vy))
      }
      iter++
      setPositions(nodes.map(n => ({ id: n.id, x: n.x, y: n.y, type: n.type, label: n.label, file: n.file })))
      setLinks(edgesIdx.map(e => ({ x1: nodes[e.si].x, y1: nodes[e.si].y, x2: nodes[e.ti].x, y2: nodes[e.ti].y })))
      if (iter < 300) rafRef.current = requestAnimationFrame(tick)
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
    const { nodes, edgesIdx } = simRef.current
    cancelAnimationFrame(rafRef.current)
    let iter = 0
    function tick() {
      const n = nodes.length
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const dx = nodes[j].x - nodes[i].x, dy = nodes[j].y - nodes[i].y
          const dist2 = dx*dx + dy*dy + 1, dist = Math.sqrt(dist2)
          const force = -180 / dist2
          const fx = (dx/dist)*force, fy = (dy/dist)*force
          nodes[i].vx -= fx; nodes[i].vy -= fy
          nodes[j].vx += fx; nodes[j].vy += fy
        }
      }
      for (const e of edgesIdx) {
        const a = nodes[e.si], b = nodes[e.ti]
        const dx = b.x - a.x, dy = b.y - a.y
        const dist = Math.sqrt(dx*dx + dy*dy) || 1
        const force = (dist - 80) * 0.05
        const fx = (dx/dist)*force, fy = (dy/dist)*force
        if (!a.fx) { a.vx += fx; a.vy += fy }
        if (!b.fx) { b.vx -= fx; b.vy -= fy }
      }
      for (const node of nodes) {
        if (node.fx !== null) { node.x = node.fx; node.y = node.fy; node.vx = 0; node.vy = 0; continue }
        node.vx = (node.vx + (W/2 - node.x)*0.04)*0.85
        node.vy = (node.vy + (H/2 - node.y)*0.04)*0.85
        node.x = Math.max(12, Math.min(W-12, node.x + node.vx))
        node.y = Math.max(12, Math.min(H-12, node.y + node.vy))
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
  const onSvgMouseUp = () => {
    if (dragging.current && simRef.current) {
      const node = simRef.current.nodes.find(n => n.id === dragging.current)
      if (node) { node.fx = null; node.fy = null }
    }
    dragging.current = null
    panStart.current = null
  }
  const onSvgMouseDown = (e) => {
    if (!dragging.current) panStart.current = { x: e.clientX, y: e.clientY, panX: pan.x, panY: pan.y }
  }
  const onWheel = (e) => {
    e.preventDefault()
    setZoom(z => Math.max(0.3, Math.min(3, z * (e.deltaY < 0 ? 1.1 : 0.9))))
  }

  const rMap = { route: 8, lib: 6, component: 7, jsx: 4 }
  const filtered = graph?.nodes?.filter(n =>
    !search || n.label.toLowerCase().includes(search.toLowerCase()) || n.type.includes(search.toLowerCase())
  ) || []

  // ── Data-flow tier layout ─────────────────────────────────────────────────
  function buildDataFlowLayout(df) {
    if (!df?.nodes) return { dfNodes: [], dfEdges: [] }
    const tierGroups = [0, 1, 2, 3].map(t => df.nodes.filter(n => n.tier === t))
    const dfNodes = df.nodes.map(n => {
      const group = tierGroups[n.tier] || []
      const idx   = group.findIndex(g => g.id === n.id)
      const cols  = group.length
      const tW    = W - 80
      const x     = 40 + (cols > 1 ? (idx / (cols - 1)) * tW : tW / 2)
      const y     = 60 + n.tier * 120
      return { ...n, x, y }
    })
    const nodeMap = new Map(dfNodes.map(n => [n.id, n]))
    const dfEdges = (df.edges || []).map(e => {
      const s = nodeMap.get(e.source), t = nodeMap.get(e.target)
      if (!s || !t) return null
      return { ...e, x1: s.x, y1: s.y, x2: t.x, y2: t.y }
    }).filter(Boolean)
    return { dfNodes, dfEdges }
  }

  // ── Entity hierarchy layout ───────────────────────────────────────────────
  function buildEntityLayout(ent) {
    if (!ent?.nodes) return { entNodes: [], entEdges: [] }
    const tierGroups = [0, 1, 2].map(t => ent.nodes.filter(n => n.tier === t))
    const entNodes = ent.nodes.map(n => {
      const group = tierGroups[n.tier] || []
      const idx   = group.findIndex(g => g.id === n.id)
      const cols  = group.length
      const tW    = W - 80
      const x     = 40 + (cols > 1 ? (idx / (cols - 1)) * tW : tW / 2)
      const y     = 60 + n.tier * 180
      return { ...n, x, y }
    })
    const nodeMap  = new Map(entNodes.map(n => [n.id, n]))
    const entEdges = (ent.edges || []).map(e => {
      const s = nodeMap.get(e.source), t = nodeMap.get(e.target)
      if (!s || !t) return null
      return { ...e, x1: s.x, y1: s.y, x2: t.x, y2: t.y }
    }).filter(Boolean)
    return { entNodes, entEdges }
  }

  const { dfNodes, dfEdges } = buildDataFlowLayout(dataFlow)
  const { entNodes, entEdges } = buildEntityLayout(entities)

  // Map symbol → { verdict, compositeScore } from cached AI brain scan
  const signalMap = useMemo(() => {
    const map = {}
    for (const s of (scanCache?.broad?.rankedStocks ?? [])) {
      if (s.symbol) map[s.symbol] = { verdict: s.agentVerdict, score: s.compositeScore ?? 0 }
    }
    return map
  }, [scanCache])

  const [hoveredNode, setHoveredNode] = useState(null)

  return (
    <div className="space-y-4">
      {/* Stats bar + view switcher */}
      <div className="flex items-center gap-6 p-4 rounded-xl border border-white/[0.06] bg-[#12121a]">
        {[
          { label: 'Nodes',         value: graph?.nodes?.length ?? '—',  color: 'text-indigo-400'  },
          { label: 'Edges',         value: graph?.edges?.length ?? '—',  color: 'text-purple-400'  },
          { label: 'Providers',     value: dataFlow ? dataFlow.nodes.filter(n => n.tier === 0).length : '—', color: 'text-amber-400' },
          { label: 'Token Savings', value: '71.5×',                      color: 'text-emerald-400' },
        ].map((s, i) => (
          <div key={i} className="text-center">
            <div className={`text-xl font-bold font-mono ${s.color}`}>{s.value}</div>
            <div className="text-[10px] text-slate-500 mt-0.5">{s.label}</div>
          </div>
        ))}
        <div className="ml-auto flex items-center gap-1">
          {[
            { id: 'graph',    label: 'Code Graph',  Icon: Network   },
            { id: 'dataflow', label: 'Data Flow',   Icon: GitBranch },
            { id: 'entities', label: 'Entity Graph', Icon: Layers   },
            { id: 'signals',  label: 'Signal Net',  Icon: Zap       },
            { id: 'list',     label: 'Node List',   Icon: Code2     },
          ].map(({ id, label, Icon }) => (
            <button key={id} onClick={() => setView(id)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs transition-all ${view === id ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30' : 'text-slate-400 hover:text-white hover:bg-white/[0.04]'}`}>
              <Icon size={11} />{label}
            </button>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-4 gap-4">
        <div className="col-span-3">

          {/* ── Code Graph ── */}
          {view === 'graph' && (
            <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center gap-2 text-xs text-slate-500">
                <Network size={12} className="text-indigo-400" />
                <span>Drag nodes · Scroll to zoom · Click for details</span>
                <span className="ml-auto">{positions.length} nodes</span>
              </div>
              {graph?.nodes?.length ? (
                <svg ref={svgRef} width="100%" viewBox={`0 0 ${W} ${H}`}
                  style={{ height: 520, cursor: dragging.current ? 'grabbing' : 'grab', userSelect: 'none' }}
                  onMouseMove={onSvgMouseMove} onMouseUp={onSvgMouseUp}
                  onMouseLeave={onSvgMouseUp} onMouseDown={onSvgMouseDown} onWheel={onWheel}>
                  <g transform={`translate(${pan.x},${pan.y}) scale(${zoom})`}>
                    <g>{links.map((l, i) => <line key={i} x1={l.x1} y1={l.y1} x2={l.x2} y2={l.y2} stroke="rgba(99,102,241,0.18)" strokeWidth={1} />)}</g>
                    <g>
                      {positions.map(n => {
                        const col  = NODE_COLOR[n.type] || '#6366f1'
                        const r    = rMap[n.type] || 5
                        const sel  = selectedNode === n.id
                        const hov  = hoveredGraphNode === n.id
                        return (
                          <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: 'pointer' }}
                            onMouseDown={e => onNodeMouseDown(e, n.id)}
                            onMouseEnter={() => setHoveredGraphNode(n.id)}
                            onMouseLeave={() => setHoveredGraphNode(null)}
                            onClick={() => loadDetail(n.id)}>
                            {(sel || hov) && <circle r={r+4} fill={col} fillOpacity={0.12} stroke={col} strokeWidth={1.5} opacity={0.7} />}
                            <circle r={r} fill={col} opacity={hov ? 1 : 0.85} />
                            {n.type !== 'jsx' && <text x={r+3} y={4} fontSize={7} fill={hov ? 'rgba(255,255,255,0.9)' : 'rgba(148,163,184,0.85)'} fontFamily="monospace" style={{ pointerEvents: 'none' }}>{n.label}</text>}
                            {/* Inline hover tooltip */}
                            {hov && (
                              <g transform={`translate(0,${-r - 6})`} style={{ pointerEvents: 'none' }}>
                                <rect x={-35} y={-18} width={70} height={16} rx={3} fill="#1e1e2e" stroke={col} strokeWidth={0.5} strokeOpacity={0.6} />
                                <text x={0} y={-6} fontSize={6.5} fill={col} textAnchor="middle" fontFamily="monospace" fontWeight="600">{n.type}</text>
                                {n.file && <text x={0} y={3} fontSize={5.5} fill="rgba(148,163,184,0.7)" textAnchor="middle" fontFamily="monospace">{n.file.split('/').pop()}</text>}
                              </g>
                            )}
                          </g>
                        )
                      })}
                    </g>
                    {[['route','#6366f1'],['lib','#06b6d4'],['component','#8b5cf6'],['jsx','#a78bfa']].map(([t,c],i) => (
                      <g key={t} transform={`translate(12,${H - 52 + i * 13})`}>
                        <circle r={4} fill={c} /><text x={9} y={4} fontSize={8} fill="rgba(148,163,184,0.6)" fontFamily="monospace">{t}</text>
                      </g>
                    ))}
                  </g>
                </svg>
              ) : (
                <div className="h-64 flex items-center justify-center text-slate-600 text-xs">Loading graph data…</div>
              )}
            </div>
          )}

          {/* ── Data Flow ── */}
          {view === 'dataflow' && (
            <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center gap-2 text-xs text-slate-500">
                <GitBranch size={12} className="text-amber-400" />
                <span>Real-time data pipeline — sources to UI</span>
                {dataFlow && <span className="ml-auto text-[10px]">{dataFlow.nodes.length} nodes · {dataFlow.edges.length} flows</span>}
              </div>
              {dfLoading && <div className="h-64 flex items-center justify-center"><Loader2 size={16} className="text-amber-400 animate-spin" /></div>}
              {!dfLoading && dataFlow && (
                <svg width="100%" viewBox={`0 0 ${W} ${H + 60}`} style={{ height: 580 }}>
                  {/* Tier lane backgrounds */}
                  {[0,1,2,3].map(t => (
                    <rect key={t} x={0} y={20 + t * 120} width={W} height={110}
                      fill={TIER_COLOR[t]} fillOpacity={0.04} rx={0} />
                  ))}
                  {/* Tier labels */}
                  {[0,1,2,3].map(t => (
                    <text key={t} x={8} y={38 + t * 120} fontSize={8} fill={TIER_COLOR[t]} fontFamily="monospace" opacity={0.7}>{TIER_LABEL[t].toUpperCase()}</text>
                  ))}
                  {/* Edges + animated flow pulses */}
                  <g>
                    {dfEdges.map((e, i) => {
                      const mx   = (e.x1 + e.x2) / 2
                      const my   = (e.y1 + e.y2) / 2
                      const srcN = dataFlow.nodes.find(n => n.id === e.source)
                      const col  = TIER_COLOR[srcN?.tier ?? 0]
                      const isActive = srcN?.status === 'connected' || srcN?.tier === 1
                      const dur  = 1.8 + (i % 5) * 0.4
                      return (
                        <g key={i}>
                          <line x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                            stroke={col} strokeWidth={hoveredNode && (e.source === hoveredNode || e.target === hoveredNode) ? 1.8 : 1}
                            strokeOpacity={hoveredNode && (e.source === hoveredNode || e.target === hoveredNode) ? 0.55 : 0.2}
                            strokeDasharray={e.source.includes('cache') ? '3,3' : undefined} />
                          {/* Animated dot flowing along the edge */}
                          {isActive && (
                            <circle r={2.5} fill={col} fillOpacity={0.7}>
                              <animateMotion dur={`${dur}s`} repeatCount="indefinite"
                                path={`M${e.x1},${e.y1} L${e.x2},${e.y2}`} />
                            </circle>
                          )}
                          {hoveredNode && (e.source === hoveredNode || e.target === hoveredNode) && (
                            <text x={mx} y={my - 4} fontSize={7} fill="rgba(203,213,225,0.9)" textAnchor="middle" fontFamily="monospace" fontWeight="500">{e.dataType}</text>
                          )}
                        </g>
                      )
                    })}
                  </g>
                  {/* Nodes */}
                  <g>
                    {dfNodes.map(n => {
                      const col  = TIER_COLOR[n.tier]
                      const sc   = STATUS_COLOR[n.status] || '#6b7280'
                      const isHov = hoveredNode === n.id
                      return (
                        <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: 'pointer' }}
                          onMouseEnter={() => setHoveredNode(n.id)}
                          onMouseLeave={() => setHoveredNode(null)}
                          onClick={() => loadDetail(n.id)}>
                          <rect x={-28} y={-12} width={56} height={22} rx={4} fill={col} fillOpacity={isHov ? 0.25 : 0.12} stroke={col} strokeOpacity={isHov ? 0.6 : 0.25} strokeWidth={1} />
                          <text x={0} y={3} fontSize={7} fill={col} textAnchor="middle" fontFamily="monospace" fontWeight="500">{n.label}</text>
                          {/* Status dot (tier 0 only) */}
                          {n.tier === 0 && <circle cx={22} cy={-8} r={3} fill={sc} />}
                          {/* Transport badge (tier 0 WSS) */}
                          {n.transport === 'WSS' && <text x={0} y={16} fontSize={6} fill={col} textAnchor="middle" fontFamily="monospace" opacity={0.6}>WSS</text>}
                        </g>
                      )
                    })}
                  </g>
                  {/* Legend */}
                  <g transform={`translate(12,${H + 30})`}>
                    {Object.entries(STATUS_COLOR).map(([s, c], i) => (
                      <g key={s} transform={`translate(${i * 90},0)`}>
                        <circle r={4} fill={c} /><text x={8} y={4} fontSize={8} fill="rgba(148,163,184,0.6)" fontFamily="monospace">{s}</text>
                      </g>
                    ))}
                    <text x={290} y={4} fontSize={8} fill="rgba(148,163,184,0.4)" fontFamily="monospace">hover node to see data types on edges</text>
                  </g>
                </svg>
              )}
            </div>
          )}

          {/* ── Entity Graph ── */}
          {view === 'entities' && (
            <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
              <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center gap-2 text-xs text-slate-500">
                <Layers size={12} className="text-violet-400" />
                <span>Financial universe hierarchy — asset class → universe → symbol</span>
                {entities && <span className="ml-auto text-[10px]">{entities.symbolCount} symbols · {entities.universeCount} universes</span>}
              </div>
              {entLoading && <div className="h-64 flex items-center justify-center"><Loader2 size={16} className="text-violet-400 animate-spin" /></div>}
              {!entLoading && entities && (
                <svg width="100%" viewBox={`0 0 ${W} 580`} style={{ height: 580 }}>
                  {/* Edges */}
                  <g>
                    {entEdges.map((e, i) => {
                      const sn = entities.nodes.find(n => n.id === e.source)
                      return (
                        <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
                          stroke={sn?.color || '#6366f1'} strokeWidth={e.label === 'contains' ? 1.5 : 0.8}
                          strokeOpacity={e.label === 'contains' ? 0.3 : 0.15} />
                      )
                    })}
                  </g>
                  {/* Nodes */}
                  <g>
                    {entNodes.map(n => {
                      const isAC   = n.type === 'assetClass'
                      const isUni  = n.type === 'universe'
                      const isSym  = n.type === 'symbol'
                      const r      = isAC ? 14 : isUni ? 9 : 5
                      const isHov  = hoveredNode === n.id
                      const sig    = isSym ? signalMap[n.label] : null
                      const sCol   = sig ? sigColor(sig.verdict) : null
                      const fill   = sCol ?? n.color
                      return (
                        <g key={n.id} transform={`translate(${n.x},${n.y})`} style={{ cursor: 'pointer' }}
                          onMouseEnter={() => setHoveredNode(n.id)}
                          onMouseLeave={() => setHoveredNode(null)}>
                          {/* Signal glow ring for symbols with active AI signals */}
                          {sCol && <circle r={r + 4} fill={sCol} fillOpacity={0.12} stroke={sCol} strokeWidth={0.8} strokeOpacity={0.5} />}
                          <circle r={r} fill={fill} opacity={isHov ? 1 : isAC ? 0.85 : isUni ? 0.7 : sCol ? 0.85 : 0.45} />
                          {isHov && <circle r={r+3} fill="none" stroke={fill} strokeWidth={1} opacity={0.6} />}
                          <text x={0} y={r + 10} fontSize={isAC ? 9 : isUni ? 7 : 6}
                            fill={isAC ? n.color : sCol ? 'rgba(255,255,255,0.9)' : 'rgba(148,163,184,0.75)'}
                            textAnchor="middle" fontFamily="monospace" fontWeight={isAC || sCol ? '700' : '400'}>
                            {n.label}
                          </text>
                          {isUni && n.symbolCount && (
                            <text x={0} y={r + 18} fontSize={6} fill="rgba(100,116,139,0.7)" textAnchor="middle" fontFamily="monospace">{n.symbolCount} symbols</text>
                          )}
                        </g>
                      )
                    })}
                  </g>
                  {/* Tier labels */}
                  {[['Asset Classes', '#8b5cf6', 60], ['Scan Universes', '#6366f1', 240], ['Symbols', '#06b6d4', 420]].map(([lbl, col, y]) => (
                    <text key={lbl} x={8} y={y} fontSize={8} fill={col} fontFamily="monospace" opacity={0.6}>{lbl.toUpperCase()}</text>
                  ))}
                  {/* Signal legend */}
                  {Object.keys(signalMap).length > 0 && (
                    <g transform={`translate(12,560)`}>
                      {[['BUY', '#34d399'], ['STRONG BUY', '#10b981'], ['HOLD', '#f59e0b'], ['SELL', '#f87171']].map(([lbl, col], i) => (
                        <g key={lbl} transform={`translate(${i * 100},0)`}>
                          <circle r={4} fill={col} opacity={0.8} />
                          <text x={8} y={4} fontSize={7} fill="rgba(148,163,184,0.6)" fontFamily="monospace">{lbl}</text>
                        </g>
                      ))}
                      <text x={420} y={4} fontSize={7} fill="rgba(100,116,139,0.5)" fontFamily="monospace">{Object.keys(signalMap).length} live AI signals overlaid</text>
                    </g>
                  )}
                </svg>
              )}
            </div>
          )}

          {/* ── Signal Network ── */}
          {view === 'signals' && (() => {
            const stocks   = scanCache?.broad?.rankedStocks ?? []
            const regime   = scanCache?.broad?.marketRegime ?? null
            const updAt    = scanCache?.updatedAt
            if (!stocks.length) return (
              <div className="rounded-xl border border-white/[0.06] bg-[#12121a] h-64 flex items-center justify-center">
                <div className="text-center">
                  <Zap size={20} className="text-slate-600 mx-auto mb-2" />
                  <div className="text-xs text-slate-600">No scan data — brain fires at :05 each hour during market hours</div>
                </div>
              </div>
            )

            // Group by verdict tier for a radial-ish layout
            const buys  = stocks.filter(s => sigColor(s.agentVerdict) === '#10b981' || sigColor(s.agentVerdict) === '#34d399')
            const holds = stocks.filter(s => sigColor(s.agentVerdict) === '#f59e0b')
            const sells = stocks.filter(s => sigColor(s.agentVerdict) === '#f87171' || sigColor(s.agentVerdict) === '#ef4444')

            const SW = 860, SH = 520
            const cx = SW / 2, cy = SH / 2

            // Place regime node at center
            // Place buy nodes top-right arc, hold top-left, sell bottom
            function arcNodes(arr, startAngle, endAngle, radius) {
              return arr.map((s, i) => {
                const a = startAngle + (arr.length > 1 ? (endAngle - startAngle) * i / (arr.length - 1) : (startAngle + endAngle) / 2)
                return { ...s, nx: cx + radius * Math.cos(a), ny: cy + radius * Math.sin(a) }
              })
            }

            const PI = Math.PI
            const buyNodes  = arcNodes(buys,  -PI * 0.85, -PI * 0.15, 180)
            const holdNodes = arcNodes(holds, -PI * 0.1,   PI * 0.1,  210)
            const sellNodes = arcNodes(sells,  PI * 0.15,  PI * 0.85, 180)
            const allNodes  = [...buyNodes, ...holdNodes, ...sellNodes]

            return (
              <div className="rounded-xl border border-white/[0.06] bg-[#12121a] overflow-hidden">
                <div className="px-4 py-2.5 border-b border-white/[0.06] flex items-center gap-2 text-xs text-slate-500">
                  <Zap size={12} className="text-emerald-400" />
                  <span>Live AI signal network — brain scan results by verdict</span>
                  <span className="ml-auto text-[10px]">{stocks.length} signals{updAt ? ` · ${new Date(updAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : ''}</span>
                </div>
                <svg width="100%" viewBox={`0 0 ${SW} ${SH}`} style={{ height: 520 }}>
                  {/* Spokes from center to each node */}
                  {allNodes.map((s, i) => {
                    const col = sigColor(s.agentVerdict) ?? '#6b7280'
                    return <line key={i} x1={cx} y1={cy} x2={s.nx} y2={s.ny} stroke={col} strokeWidth={0.8} strokeOpacity={0.18} />
                  })}
                  {/* Score ring backgrounds */}
                  {[140, 180, 210].map(r => (
                    <circle key={r} cx={cx} cy={cy} r={r} fill="none" stroke="rgba(99,102,241,0.06)" strokeWidth={1} strokeDasharray="4,4" />
                  ))}
                  {/* Signal nodes */}
                  {allNodes.map((s, i) => {
                    const col   = sigColor(s.agentVerdict) ?? '#6b7280'
                    const r     = Math.max(8, Math.min(18, (s.compositeScore ?? 50) / 5))
                    const isHov = hoveredNode === s.symbol
                    return (
                      <g key={s.symbol} transform={`translate(${s.nx},${s.ny})`} style={{ cursor: 'pointer' }}
                        onMouseEnter={() => setHoveredNode(s.symbol)}
                        onMouseLeave={() => setHoveredNode(null)}>
                        <circle r={r + 4} fill={col} fillOpacity={0.1} />
                        <circle r={r} fill={col} fillOpacity={isHov ? 0.95 : 0.75} />
                        {isHov && <circle r={r + 6} fill="none" stroke={col} strokeWidth={1} strokeOpacity={0.4} />}
                        <text x={0} y={4} fontSize={r > 12 ? 8 : 6} fill="white" textAnchor="middle" fontFamily="monospace" fontWeight="700" style={{ pointerEvents: 'none' }}>{s.symbol}</text>
                        <text x={0} y={r + 11} fontSize={6} fill={col} textAnchor="middle" fontFamily="monospace">{s.compositeScore ?? '—'}</text>
                      </g>
                    )
                  })}
                  {/* Center regime node */}
                  <g transform={`translate(${cx},${cy})`}>
                    <circle r={38} fill="rgba(99,102,241,0.1)" stroke="rgba(99,102,241,0.3)" strokeWidth={1} />
                    <text x={0} y={-8} fontSize={9} fill="#818cf8" textAnchor="middle" fontFamily="monospace" fontWeight="700">REGIME</text>
                    <text x={0} y={5} fontSize={8} fill="white" textAnchor="middle" fontFamily="monospace">{regime ?? 'Unknown'}</text>
                    <text x={0} y={18} fontSize={7} fill="rgba(100,116,139,0.7)" textAnchor="middle" fontFamily="monospace">{stocks.length} picks</text>
                  </g>
                  {/* Group labels */}
                  <text x={cx} y={40} fontSize={8} fill="#34d399" textAnchor="middle" fontFamily="monospace" opacity={0.7}>BUY ZONE ({buys.length})</text>
                  <text x={SW - 60} y={cy + 4} fontSize={8} fill="#f59e0b" textAnchor="end" fontFamily="monospace" opacity={0.7}>HOLD ({holds.length})</text>
                  <text x={cx} y={SH - 18} fontSize={8} fill="#f87171" textAnchor="middle" fontFamily="monospace" opacity={0.7}>SELL ZONE ({sells.length})</text>
                  {/* Score ring labels */}
                  <text x={cx + 145} y={cy - 2} fontSize={6.5} fill="rgba(99,102,241,0.4)" fontFamily="monospace">score 50</text>
                  <text x={cx + 185} y={cy - 2} fontSize={6.5} fill="rgba(99,102,241,0.4)" fontFamily="monospace">70</text>
                  <text x={cx + 215} y={cy - 2} fontSize={6.5} fill="rgba(99,102,241,0.4)" fontFamily="monospace">90+</text>
                </svg>
              </div>
            )
          })()}

          {/* ── Node List ── */}
          {view === 'list' && (
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
              {!filtered.length && <div className="flex items-center justify-center h-40 text-slate-600 text-sm">No nodes match "{search}"</div>}
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
            {/* Data Flow hover tooltip */}
            {view === 'dataflow' && hoveredNode && (() => {
              const n = dfNodes.find(x => x.id === hoveredNode)
              if (!n) return null
              const flowsIn  = dfEdges.filter(e => e.target === hoveredNode)
              const flowsOut = dfEdges.filter(e => e.source === hoveredNode)
              return (
                <div className="space-y-3">
                  <div>
                    <div className="text-xs font-semibold" style={{ color: TIER_COLOR[n.tier] }}>{n.label}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">{TIER_LABEL[n.tier]}</div>
                    {n.status && <div className="flex items-center gap-1.5 mt-1"><div className="w-2 h-2 rounded-full" style={{ background: STATUS_COLOR[n.status] }} /><span className="text-[10px]" style={{ color: STATUS_COLOR[n.status] }}>{n.status}</span>{n.transport && <span className="text-[10px] text-slate-500">· {n.transport}</span>}</div>}
                    {n.description && <div className="text-[10px] text-slate-400 mt-1.5">{n.description}</div>}
                    {n.dataTypes && <div className="text-[10px] text-slate-500 mt-1">Provides: {n.dataTypes.join(' · ')}</div>}
                  </div>
                  {flowsIn.length > 0 && <div><div className="text-[9px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Receives ({flowsIn.length})</div>{flowsIn.map((e, i) => <div key={i} className="text-[10px] text-purple-300">← {dfNodes.find(x => x.id === e.source)?.label}: <span className="text-slate-500">{e.dataType}</span></div>)}</div>}
                  {flowsOut.length > 0 && <div><div className="text-[9px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Sends ({flowsOut.length})</div>{flowsOut.map((e, i) => <div key={i} className="text-[10px] text-indigo-300">→ {dfNodes.find(x => x.id === e.target)?.label}: <span className="text-slate-500">{e.dataType}</span></div>)}</div>}
                </div>
              )
            })()}

            {/* Entity hover tooltip */}
            {view === 'entities' && hoveredNode && (() => {
              const n = entNodes.find(x => x.id === hoveredNode)
              if (!n) return null
              const children = entEdges.filter(e => e.source === hoveredNode).map(e => entNodes.find(x => x.id === e.target)).filter(Boolean)
              return (
                <div className="space-y-3">
                  <div>
                    <div className="text-xs font-semibold" style={{ color: n.color }}>{n.label}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5 capitalize">{n.type}{n.assetClass ? ` · ${n.assetClass}` : ''}</div>
                    {n.symbolCount && <div className="text-[10px] text-slate-400 mt-0.5">{n.symbolCount} symbols</div>}
                  </div>
                  {children.length > 0 && (
                    <div>
                      <div className="text-[9px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Symbols ({children.length})</div>
                      <div className="flex flex-wrap gap-1">
                        {children.slice(0, 20).map((c, i) => {
                          const sig  = signalMap[c.label]
                          const sCol = sig ? sigColor(sig.verdict) : null
                          return (
                            <span key={i} className="text-[9px] px-1.5 py-0.5 rounded font-mono font-semibold"
                              style={{ background: (sCol ?? c.color ?? '#6366f1') + '22', color: sCol ?? c.color ?? '#6366f1', border: sCol ? `1px solid ${sCol}44` : undefined }}>
                              {c.label}{sig ? ` ${sig.verdict?.includes('Buy') ? '↑' : sig.verdict?.includes('Sell') ? '↓' : '–'}` : ''}
                            </span>
                          )
                        })}
                        {children.length > 20 && <span className="text-[9px] text-slate-600">+{children.length - 20}</span>}
                      </div>
                      {Object.keys(signalMap).length > 0 && (
                        <div className="text-[9px] text-slate-600 mt-1.5">↑/↓/– = AI signal from last brain scan</div>
                      )}
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Code graph node detail */}
            {(view === 'graph' || view === 'list') && (
              <>
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
              </>
            )}

            {/* Signals view hover detail */}
            {view === 'signals' && hoveredNode && (() => {
              const s = (scanCache?.broad?.rankedStocks ?? []).find(x => x.symbol === hoveredNode)
              if (!s) return null
              const col = sigColor(s.agentVerdict) ?? '#6b7280'
              return (
                <div className="space-y-3">
                  <div>
                    <div className="text-sm font-bold font-mono" style={{ color: col }}>{s.symbol}</div>
                    <div className="text-[10px] mt-0.5 font-semibold" style={{ color: col }}>{s.agentVerdict}</div>
                    <div className="text-[10px] text-slate-500 mt-0.5">Score: <span className="text-white font-mono">{s.compositeScore ?? '—'}</span></div>
                  </div>
                  {s.supervisorSynthesis && <div className="text-[10px] text-slate-400 leading-relaxed">{s.supervisorSynthesis.slice(0, 200)}</div>}
                  {s.highConviction && <div className="text-[9px] text-amber-400">⭐ High Conviction</div>}
                  {s.ensembleConfirmed && <div className="text-[9px] text-emerald-400">✓ Ensemble confirmed</div>}
                  {s.keyDrivers?.length > 0 && (
                    <div>
                      <div className="text-[9px] font-semibold text-slate-500 uppercase tracking-wider mb-1">Key Drivers</div>
                      {s.keyDrivers.slice(0, 3).map((d, i) => (
                        <div key={i} className="text-[9px] text-slate-400 leading-relaxed">· {d}</div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })()}

            {/* Default prompt for non-graph views */}
            {(view === 'dataflow' || view === 'entities' || view === 'signals') && !hoveredNode && (
              <div className="text-xs text-slate-600 text-center py-6">Hover a node to inspect</div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}
