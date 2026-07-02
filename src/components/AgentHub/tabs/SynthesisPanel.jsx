import { AlertTriangle, Zap } from 'lucide-react'

// Escape HTML special chars BEFORE the markdown-lite regexes run — this text
// is AI-synthesized from multiple agent outputs, which can include untrusted
// external content, so only the fixed set of tags below can ever appear.
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export default function SynthesisPanel({ text, llmUsed, error }) {
  if (error) return (
    <div className="p-4 rounded-xl bg-red-500/10 border border-red-500/20 text-red-400 text-sm">
      <AlertTriangle className="w-4 h-4 inline mr-2" />Synthesis error: {error}
    </div>
  )
  if (!text) return null

  const html = escapeHtml(text)
    .replace(/^##\s+(.+)$/gm, '<div class="text-sm font-bold text-white mt-3 mb-1">$1</div>')
    .replace(/\*\*(.+?)\*\*/g, '<strong class="text-white">$1</strong>')
    .replace(/\n/g, '<br />')

  return (
    <div className="bg-white/[0.02] border border-white/[0.06] rounded-xl p-5">
      <div className="flex items-center gap-2 mb-3">
        <Zap className="w-4 h-4 text-mint-400" />
        <span className="text-sm font-semibold text-white">AI Synthesis</span>
        {llmUsed && <span className="ml-auto text-[10px] text-slate-600 px-2 py-0.5 bg-white/[0.04] rounded-full">via {llmUsed}</span>}
      </div>
      <div className="text-sm text-slate-300 leading-relaxed" dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  )
}
