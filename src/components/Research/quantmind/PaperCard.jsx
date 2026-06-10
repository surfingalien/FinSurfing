import { useState } from 'react'
import {
  BookOpen, ChevronDown, ChevronUp, ExternalLink, Trash2,
} from 'lucide-react'
import { RelevanceDot, TagPill } from './PaperWidgets'

// ── Loaded paper card ─────────────────────────────────────────────────────────
export default function PaperCard({ paper, onRemove, selected, onToggleSelect }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={`rounded-xl border transition-colors ${
      selected ? 'border-violet-500/60 bg-violet-500/5' : 'border-slate-700/50 bg-slate-800/40'
    }`}>
      <div className="p-4">
        <div className="flex items-start gap-3">
          <button
            onClick={() => onToggleSelect(paper.arxiv_id)}
            className={`mt-0.5 w-4 h-4 rounded border flex-shrink-0 transition-colors ${
              selected ? 'bg-violet-500 border-violet-500' : 'border-slate-600 hover:border-violet-400'
            }`}
          >
            {selected && <span className="block w-full h-full text-white text-[10px] text-center leading-4">✓</span>}
          </button>

          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2 mb-1">
              <h3 className="text-sm font-medium text-slate-200 leading-snug">{paper.title}</h3>
              <RelevanceDot score={paper.relevance_score} />
            </div>

            <p className="text-xs text-slate-500 mb-2">
              {(paper.authors || []).slice(0, 3).join(', ')}
              {paper.authors?.length > 3 ? ' et al.' : ''}
              {' · '}{paper.published?.slice(0, 10)}
            </p>

            {paper.quant_applicability && (
              <p className="text-xs text-violet-300/80 italic mb-2">"{paper.quant_applicability}"</p>
            )}

            <div className="flex flex-wrap gap-1 mb-3">
              {(paper.tags || []).slice(0, 5).map(t => <TagPill key={t} label={t} />)}
            </div>

            {(paper.key_contributions || []).length > 0 && (
              <div>
                <button
                  onClick={() => setExpanded(e => !e)}
                  className="flex items-center gap-1 text-xs text-slate-400 hover:text-slate-200 transition-colors mb-1"
                >
                  {expanded ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
                  {expanded ? 'Hide' : 'Show'} key contributions
                </button>
                {expanded && (
                  <ul className="space-y-1 pl-3 border-l border-slate-700">
                    {paper.key_contributions.map((kc, i) => (
                      <li key={i} className="text-xs text-slate-400">{kc}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-700/50">
          <div className="flex gap-2">
            <a href={paper.source_url} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-violet-300 transition-colors">
              <ExternalLink className="w-3 h-3" /> Abstract
            </a>
            <a href={paper.pdf_url} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-violet-300 transition-colors">
              <BookOpen className="w-3 h-3" /> PDF
            </a>
          </div>
          <button onClick={() => onRemove(paper.arxiv_id)}
            className="flex items-center gap-1 text-xs text-slate-600 hover:text-red-400 transition-colors">
            <Trash2 className="w-3 h-3" /> Remove
          </button>
        </div>
      </div>
    </div>
  )
}
