import { useState, useEffect, useRef } from 'react'
import { Map, FileText } from 'lucide-react'
import { Transformer } from 'markmap-lib'
import { Markmap }      from 'markmap-view'

const transformer = new Transformer()

// ── Markmap live preview ──────────────────────────────────────────────────────
export default function MarkmapPreview({ content }) {
  const svgRef = useRef(null)
  const mmRef  = useRef(null)
  const [failed, setFailed] = useState(false)

  // Needs at least 2 headings OR 1 heading + 3 bullets to form a useful mindmap
  const hasOutline = Boolean(content?.trim() && (() => {
    const lines = content.split('\n')
    const headings = lines.filter(l => /^#{1,6}\s/.test(l)).length
    const bullets  = lines.filter(l => /^\s*[-*+]\s/.test(l)).length
    return headings >= 2 || (headings >= 1 && bullets >= 3)
  })())

  useEffect(() => {
    if (!hasOutline || !svgRef.current || failed) return
    if (!mmRef.current) {
      try {
        mmRef.current = Markmap.create(svgRef.current, {
          maxWidth: 300, duration: 200, paddingX: 12, zoom: true, pan: true,
        })
      } catch { setFailed(true); return }
    }
    if (!content) return
    try {
      const { root } = transformer.transform(content)
      mmRef.current.setData(root)
      setTimeout(() => { try { mmRef.current?.fit() } catch {} }, 150)
    } catch { setFailed(true) }
  }, [content, hasOutline, failed])

  if (!content?.trim()) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600 text-xs">
        <div className="text-center">
          <Map className="w-6 h-6 mx-auto mb-2 opacity-30" />
          Start writing to see the mindmap
        </div>
      </div>
    )
  }

  if (!hasOutline || failed) {
    return (
      <div className="p-4 overflow-y-auto h-full">
        <div className="text-[10px] text-slate-600 mb-3 flex items-center gap-1.5 border-b border-white/[0.05] pb-2">
          <FileText className="w-3 h-3" />
          <span>Note preview</span>
          {failed && <span className="text-amber-500/60">· switch to Write for full edit</span>}
          {!failed && <span className="text-slate-700">· use headings (# H1) for mindmap</span>}
        </div>
        <pre className="text-[11px] text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">{content.slice(0, 5000)}</pre>
      </div>
    )
  }

  return <svg ref={svgRef} className="w-full h-full" style={{ background: 'transparent' }} />
}
