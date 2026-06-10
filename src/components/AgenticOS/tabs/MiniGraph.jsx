import { useEffect, useRef } from 'react'
import { NODE_COLOR } from './shared'

// ── Mini SVG Graph ────────────────────────────────────────────────────────────

export default function MiniGraph({ graph }) {
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
