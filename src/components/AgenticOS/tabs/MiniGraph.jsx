import { useMemo } from 'react'
import { NODE_COLOR } from './shared'

export default function MiniGraph({ graph }) {
  const W = 620, H = 280

  const { nodes, edges, counts } = useMemo(() => {
    if (!graph?.nodes?.length) return { nodes: [], edges: [], counts: {} }

    const sample = graph.nodes
      .filter(n => n.type === 'route' || n.type === 'lib' || n.type === 'component')
      .slice(0, 60)
    const sampleIds   = new Set(sample.map(n => n.id))
    const sampleEdges = graph.edges.filter(e => sampleIds.has(e.source) && sampleIds.has(e.target))
    const groups      = { route: [], lib: [], component: [] }
    for (const n of sample) { if (groups[n.type]) groups[n.type].push(n) }

    const cx = W / 2, cy = H / 2
    const positioned = []

    // Routes → large ellipse at center
    groups.route.forEach((n, i) => {
      const a = (i / Math.max(groups.route.length, 1)) * 2 * Math.PI - Math.PI / 2
      positioned.push({ ...n, x: cx + 130 * Math.cos(a), y: cy - 10 + 105 * Math.sin(a) })
    })
    // Libs → bottom-left cluster
    groups.lib.forEach((n, i) => {
      const a = (i / Math.max(groups.lib.length, 1)) * 2 * Math.PI
      positioned.push({ ...n, x: cx - W * 0.22 + 52 * Math.cos(a), y: cy + 32 + 44 * Math.sin(a) })
    })
    // Components → bottom-right cluster
    groups.component.forEach((n, i) => {
      const a = (i / Math.max(groups.component.length, 1)) * 2 * Math.PI
      positioned.push({ ...n, x: cx + W * 0.22 + 52 * Math.cos(a), y: cy + 32 + 44 * Math.sin(a) })
    })

    const posMap = {}
    for (const n of positioned) posMap[n.id] = n

    return {
      nodes: positioned,
      edges: sampleEdges.map(e => {
        const s = posMap[e.source], t = posMap[e.target]
        return s && t ? { x1: s.x, y1: s.y, x2: t.x, y2: t.y } : null
      }).filter(Boolean),
      counts: {
        routes: groups.route.length,
        libs:   groups.lib.length,
        comps:  groups.component.length,
        edges:  sampleEdges.length,
      },
    }
  }, [graph])

  if (!nodes.length) return (
    <div className="h-64 flex items-center justify-center text-slate-600 text-xs">Loading graph data…</div>
  )

  return (
    <svg className="w-full h-64" viewBox={`0 0 ${W} ${H}`} style={{ background: 'transparent' }}>
      {/* Soft radial glow at center */}
      <defs>
        <radialGradient id="glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.06" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0" />
        </radialGradient>
      </defs>
      <ellipse cx={W/2} cy={H/2} rx={160} ry={130} fill="url(#glow)" />

      {/* Edges */}
      <g>
        {edges.map((e, i) => (
          <line key={i} x1={e.x1} y1={e.y1} x2={e.x2} y2={e.y2}
            stroke="rgba(99,102,241,0.16)" strokeWidth={0.8} />
        ))}
      </g>

      {/* Cluster group hint circles */}
      <circle cx={W/2 - W * 0.22} cy={H/2 + 32} r={56} fill="rgba(6,182,212,0.04)" stroke="rgba(6,182,212,0.08)" strokeWidth={0.8} strokeDasharray="3,3" />
      <circle cx={W/2 + W * 0.22} cy={H/2 + 32} r={56} fill="rgba(139,92,246,0.04)" stroke="rgba(139,92,246,0.08)" strokeWidth={0.8} strokeDasharray="3,3" />

      {/* Nodes */}
      <g>
        {nodes.map(n => {
          const col = NODE_COLOR[n.type] || '#6366f1'
          const r   = n.type === 'route' ? 5.5 : n.type === 'lib' ? 4.5 : 4
          return (
            <g key={n.id} transform={`translate(${n.x},${n.y})`}>
              <circle r={r + 3} fill={col} fillOpacity={0.1} />
              <circle r={r} fill={col} opacity={0.88} />
              {n.type === 'route' && n.label.length < 13 && (
                <text x={0} y={-r - 3} fontSize={6.5} fill="rgba(148,163,184,0.65)"
                  textAnchor="middle" fontFamily="monospace">{n.label}</text>
              )}
            </g>
          )
        })}
      </g>

      {/* Cluster labels */}
      <text x={W/2 - W * 0.22} y={H/2 + 32 + 62} fontSize={7} fill="rgba(6,182,212,0.5)" textAnchor="middle" fontFamily="monospace">lib modules</text>
      <text x={W/2 + W * 0.22} y={H/2 + 32 + 62} fontSize={7} fill="rgba(139,92,246,0.5)" textAnchor="middle" fontFamily="monospace">components</text>

      {/* Legend */}
      {[['routes','#6366f1'], ['libs','#06b6d4'], ['components','#8b5cf6']].map(([t, c], i) => (
        <g key={t} transform={`translate(14,${H - 36 + i * 12})`}>
          <circle r={3.5} fill={c} opacity={0.8} />
          <text x={9} y={4} fontSize={7} fill="rgba(148,163,184,0.5)" fontFamily="monospace">{t}</text>
        </g>
      ))}

      {/* Stats footer */}
      <text x={W - 8} y={H - 6} fontSize={7} fill="rgba(100,116,139,0.45)" textAnchor="end" fontFamily="monospace">
        {counts.routes}R · {counts.libs}L · {counts.comps}C · {counts.edges} edges
      </text>
    </svg>
  )
}
