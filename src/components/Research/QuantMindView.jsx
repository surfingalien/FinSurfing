import { useState, useCallback } from 'react'
import {
  BookOpen, Search, Brain, Loader2, ChevronDown, ChevronUp,
  ExternalLink, Tag, Star, Trash2, Layers, RefreshCw, Users,
} from 'lucide-react'

const PERSONAS = [
  { id: 'quant_analyst',    label: 'Quant Analyst',     color: 'text-violet-400' },
  { id: 'value_investor',   label: 'Value Investor',    color: 'text-emerald-400' },
  { id: 'risk_manager',     label: 'Risk Manager',      color: 'text-red-400' },
  { id: 'macro_strategist', label: 'Macro Strategist',  color: 'text-amber-400' },
  { id: 'alpha_seeker',     label: 'Alpha Seeker',      color: 'text-sky-400' },
]

function RelevanceDot({ score }) {
  const pct = Math.round((score || 0) * 100)
  const color = pct >= 75 ? 'bg-emerald-400' : pct >= 50 ? 'bg-amber-400' : 'bg-slate-500'
  return (
    <span className="flex items-center gap-1.5">
      <span className={`w-2 h-2 rounded-full ${color}`} />
      <span className="text-xs text-slate-400">{pct}%</span>
    </span>
  )
}

function TagPill({ label }) {
  return (
    <span className="px-2 py-0.5 rounded-full bg-violet-500/15 text-violet-300 text-xs border border-violet-500/25">
      {label}
    </span>
  )
}

function PaperCard({ paper, onRemove, selected, onToggleSelect }) {
  const [expanded, setExpanded] = useState(false)
  return (
    <div className={`rounded-xl border transition-colors ${
      selected ? 'border-violet-500/60 bg-violet-500/5' : 'border-slate-700/50 bg-slate-800/40'
    }`}>
      <div className="p-4">
        <div className="flex items-start gap-3">
          {/* Select checkbox */}
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
              {(paper.authors?.length > 3) ? ' et al.' : ''}
              {' · '}
              {paper.published?.slice(0, 10)}
            </p>

            {paper.quant_applicability && (
              <p className="text-xs text-violet-300/80 italic mb-2">
                "{paper.quant_applicability}"
              </p>
            )}

            <div className="flex flex-wrap gap-1 mb-3">
              {(paper.tags || []).slice(0, 5).map(t => <TagPill key={t} label={t} />)}
            </div>

            {/* Key contributions — collapsible */}
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
            <a
              href={paper.source_url} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-violet-300 transition-colors"
            >
              <ExternalLink className="w-3 h-3" /> Abstract
            </a>
            <a
              href={paper.pdf_url} target="_blank" rel="noreferrer"
              className="flex items-center gap-1 text-xs text-slate-400 hover:text-violet-300 transition-colors"
            >
              <BookOpen className="w-3 h-3" /> PDF
            </a>
          </div>
          <button
            onClick={() => onRemove(paper.arxiv_id)}
            className="flex items-center gap-1 text-xs text-slate-600 hover:text-red-400 transition-colors"
          >
            <Trash2 className="w-3 h-3" /> Remove
          </button>
        </div>
      </div>
    </div>
  )
}

export default function QuantMindView() {
  const [arxivInput, setArxivInput]     = useState('')
  const [batchInput, setBatchInput]     = useState('')
  const [papers, setPapers]             = useState([])
  const [selectedIds, setSelectedIds]   = useState(new Set())
  const [question, setQuestion]         = useState('')
  const [persona, setPersona]           = useState('quant_analyst')
  const [answer, setAnswer]             = useState(null)
  const [loading, setLoading]           = useState(false)
  const [batchLoading, setBatchLoading] = useState(false)
  const [askLoading, setAskLoading]     = useState(false)
  const [error, setError]               = useState(null)

  const apiBase = import.meta.env.VITE_API_URL || ''

  // ── Fetch single paper ──────────────────────────────────────────────────────
  const fetchPaper = useCallback(async () => {
    const id = arxivInput.trim()
    if (!id) return
    if (papers.find(p => p.arxiv_id === id.replace(/^arxiv:/i, ''))) {
      setError(`Paper ${id} is already loaded`)
      return
    }
    setLoading(true); setError(null)
    try {
      const res = await fetch(`${apiBase}/api/quantmind/paper`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ arxiv_id: id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch paper')
      setPapers(prev => [data.paper, ...prev])
      setArxivInput('')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [arxivInput, papers, apiBase])

  // ── Batch fetch ─────────────────────────────────────────────────────────────
  const fetchBatch = useCallback(async () => {
    const ids = batchInput.split(/[\n,\s]+/).map(s => s.trim()).filter(Boolean)
    if (!ids.length) return
    setBatchLoading(true); setError(null)
    try {
      const res = await fetch(`${apiBase}/api/quantmind/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ arxiv_ids: ids, max_concurrency: 4 }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Batch failed')
      const newPapers = data.results.filter(r => !r.error).map(r => r.paper)
      setPapers(prev => {
        const existingIds = new Set(prev.map(p => p.arxiv_id))
        return [...newPapers.filter(p => !existingIds.has(p.arxiv_id)), ...prev]
      })
      setBatchInput('')
    } catch (e) {
      setError(e.message)
    } finally {
      setBatchLoading(false)
    }
  }, [batchInput, apiBase])

  // ── Ask question ────────────────────────────────────────────────────────────
  const askQuestion = useCallback(async () => {
    if (!question.trim()) return
    setAskLoading(true); setError(null); setAnswer(null)
    try {
      const res = await fetch(`${apiBase}/api/quantmind/ask`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({
          question: question.trim(),
          arxiv_ids: [...selectedIds],
          persona,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Ask failed')
      setAnswer(data)
    } catch (e) {
      setError(e.message)
    } finally {
      setAskLoading(false)
    }
  }, [question, selectedIds, persona, apiBase])

  const toggleSelect = (id) => {
    setSelectedIds(prev => {
      const next = new Set(prev)
      next.has(id) ? next.delete(id) : next.add(id)
      return next
    })
  }

  const removePaper = (id) => {
    setPapers(prev => prev.filter(p => p.arxiv_id !== id))
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const selectedPersona = PERSONAS.find(p => p.id === persona)

  return (
    <div className="space-y-6 max-w-4xl mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-violet-500/15 border border-violet-500/25">
          <Brain className="w-5 h-5 text-violet-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-slate-100">QuantMind Research</h2>
          <p className="text-xs text-slate-500">arXiv paper extraction · Claude-powered analysis</p>
        </div>
        {papers.length > 0 && (
          <span className="ml-auto px-2.5 py-1 rounded-full bg-slate-700 text-xs text-slate-300">
            {papers.length} paper{papers.length !== 1 ? 's' : ''} loaded
          </span>
        )}
      </div>

      {/* ── Fetch controls ─────────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {/* Single paper */}
        <div className="rounded-xl bg-slate-800/50 border border-slate-700/50 p-4 space-y-3">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Single paper</p>
          <div className="flex gap-2">
            <input
              value={arxivInput}
              onChange={e => setArxivInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && fetchPaper()}
              placeholder="2312.04557"
              className="flex-1 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-violet-500 transition-colors"
            />
            <button
              onClick={fetchPaper}
              disabled={loading || !arxivInput.trim()}
              className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors flex items-center gap-1.5"
            >
              {loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              Fetch
            </button>
          </div>
        </div>

        {/* Batch */}
        <div className="rounded-xl bg-slate-800/50 border border-slate-700/50 p-4 space-y-3">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Batch (comma or newline)</p>
          <div className="flex gap-2">
            <input
              value={batchInput}
              onChange={e => setBatchInput(e.target.value)}
              placeholder="2312.04557, 2401.12345"
              className="flex-1 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-violet-500 transition-colors"
            />
            <button
              onClick={fetchBatch}
              disabled={batchLoading || !batchInput.trim()}
              className="px-4 py-2 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40 disabled:cursor-not-allowed text-slate-200 text-sm font-medium transition-colors flex items-center gap-1.5"
            >
              {batchLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Layers className="w-3.5 h-3.5" />}
              Batch
            </button>
          </div>
        </div>
      </div>

      {/* ── Error ──────────────────────────────────────────────────────────── */}
      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* ── Paper list ─────────────────────────────────────────────────────── */}
      {papers.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="text-xs text-slate-500">
              {selectedIds.size > 0
                ? `${selectedIds.size} selected for Q&A context`
                : 'Select papers to use as context for questions below'}
            </p>
            {selectedIds.size > 0 && (
              <button
                onClick={() => setSelectedIds(new Set())}
                className="text-xs text-slate-500 hover:text-slate-300 transition-colors"
              >
                Clear selection
              </button>
            )}
          </div>
          {papers.map(p => (
            <PaperCard
              key={p.arxiv_id}
              paper={p}
              selected={selectedIds.has(p.arxiv_id)}
              onToggleSelect={toggleSelect}
              onRemove={removePaper}
            />
          ))}
        </div>
      )}

      {/* ── Ask a question ─────────────────────────────────────────────────── */}
      <div className="rounded-xl bg-slate-800/50 border border-slate-700/50 p-4 space-y-4">
        <div className="flex items-center justify-between">
          <p className="text-xs font-medium text-slate-400 uppercase tracking-wider">Ask a question</p>
          {/* Persona selector */}
          <div className="flex gap-1.5">
            {PERSONAS.map(p => (
              <button
                key={p.id}
                onClick={() => setPersona(p.id)}
                className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-colors ${
                  persona === p.id
                    ? `border-violet-500/60 bg-violet-500/15 ${p.color}`
                    : 'border-slate-700 text-slate-500 hover:border-slate-500'
                }`}
              >
                {p.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex gap-2">
          <input
            value={question}
            onChange={e => setQuestion(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !e.shiftKey && askQuestion()}
            placeholder={`Ask the ${selectedPersona?.label} about the selected papers…`}
            className="flex-1 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-violet-500 transition-colors"
          />
          <button
            onClick={askQuestion}
            disabled={askLoading || !question.trim()}
            className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors flex items-center gap-1.5"
          >
            {askLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Brain className="w-3.5 h-3.5" />}
            Ask
          </button>
        </div>

        {selectedIds.size === 0 && papers.length > 0 && (
          <p className="text-xs text-amber-400/80">
            ⚠ No papers selected — answer will be from general knowledge only
          </p>
        )}

        {/* Answer */}
        {answer && (
          <div className="rounded-lg bg-slate-900/60 border border-slate-700/50 p-4 space-y-2">
            <div className="flex items-center gap-2 mb-3">
              <Users className="w-3.5 h-3.5 text-slate-500" />
              <span className={`text-xs font-medium ${PERSONAS.find(p => p.id === answer.persona)?.color || 'text-slate-400'}`}>
                {PERSONAS.find(p => p.id === answer.persona)?.label}
              </span>
              {answer.usage && (
                <span className="ml-auto text-xs text-slate-600">
                  {answer.usage.input_tokens}↓ {answer.usage.output_tokens}↑ tokens
                </span>
              )}
            </div>
            <p className="text-sm text-slate-300 leading-relaxed whitespace-pre-wrap">{answer.answer}</p>
          </div>
        )}
      </div>

      {papers.length === 0 && !loading && !batchLoading && (
        <div className="text-center py-12 text-slate-600">
          <Brain className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Enter an arXiv ID to start building your research context</p>
          <p className="text-xs mt-1">Try <code className="text-violet-400/70">2312.04557</code> or <code className="text-violet-400/70">2401.12345</code></p>
        </div>
      )}
    </div>
  )
}
