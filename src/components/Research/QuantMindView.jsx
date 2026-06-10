import { useState, useCallback } from 'react'
import {
  BookOpen, Search, Brain, Loader2, Layers, Users, Plus, Compass,
} from 'lucide-react'
import SearchResultRow from './quantmind/SearchResultRow'
import PaperCard from './quantmind/PaperCard'

const PERSONAS = [
  { id: 'quant_analyst',    label: 'Quant Analyst',     color: 'text-violet-400' },
  { id: 'value_investor',   label: 'Value Investor',    color: 'text-emerald-400' },
  { id: 'risk_manager',     label: 'Risk Manager',      color: 'text-red-400' },
  { id: 'macro_strategist', label: 'Macro Strategist',  color: 'text-amber-400' },
  { id: 'alpha_seeker',     label: 'Alpha Seeker',      color: 'text-sky-400' },
]

const CATEGORIES = [
  { id: 'q-fin',    label: 'All Q-Fin' },
  { id: 'q-fin.PM', label: 'Portfolio Mgmt' },
  { id: 'q-fin.TR', label: 'Trading' },
  { id: 'q-fin.RM', label: 'Risk Mgmt' },
  { id: 'q-fin.ST', label: 'Statistics' },
  { id: 'q-fin.MF', label: 'Math Finance' },
  { id: 'q-fin.CP', label: 'Computational' },
  { id: 'stat.ML',  label: 'ML/Stats' },
]

// ── Main view ─────────────────────────────────────────────────────────────────
export default function QuantMindView() {
  const [activeTab, setActiveTab]       = useState('discover')  // 'discover' | 'library' | 'ask'

  // Discover state
  const [searchQuery, setSearchQuery]   = useState('')
  const [searchCat, setSearchCat]       = useState('q-fin')
  const [searchResults, setSearchResults] = useState([])
  const [searching, setSearching]       = useState(false)
  const [loadingId, setLoadingId]       = useState(null)

  // Manual entry state
  const [arxivInput, setArxivInput]     = useState('')
  const [batchInput, setBatchInput]     = useState('')
  const [manualLoading, setManualLoading]   = useState(false)
  const [batchLoading, setBatchLoading] = useState(false)

  // Library / Q&A state
  const [papers, setPapers]             = useState([])
  const [selectedIds, setSelectedIds]   = useState(new Set())
  const [question, setQuestion]         = useState('')
  const [persona, setPersona]           = useState('quant_analyst')
  const [answer, setAnswer]             = useState(null)
  const [askLoading, setAskLoading]     = useState(false)
  const [error, setError]               = useState(null)

  const apiBase = import.meta.env.VITE_API_URL || ''

  // ── Helpers ─────────────────────────────────────────────────────────────────
  const addPaperToLibrary = (paper) => {
    setPapers(prev => {
      if (prev.find(p => p.arxiv_id === paper.arxiv_id)) return prev
      return [paper, ...prev]
    })
    // Mark as loaded in search results
    setSearchResults(prev => prev.map(r =>
      r.arxiv_id === paper.arxiv_id ? { ...r, loaded: true } : r
    ))
  }

  // ── Discover: search arXiv ──────────────────────────────────────────────────
  const doSearch = useCallback(async (overrideQuery) => {
    const q = (overrideQuery ?? searchQuery).trim()
    setSearching(true); setError(null)
    try {
      const params = new URLSearchParams({ category: searchCat, max: 20 })
      if (q) params.set('q', q)
      const res = await fetch(`${apiBase}/api/quantmind/search?${params}`, { credentials: 'include' })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Search failed')
      setSearchResults(data.results || [])
    } catch (e) {
      setError(e.message)
    } finally {
      setSearching(false)
    }
  }, [searchQuery, searchCat, apiBase])

  // Load a search result into the library (fetch + Claude extract)
  const loadSearchResult = useCallback(async (arxivId) => {
    setLoadingId(arxivId); setError(null)
    try {
      const res = await fetch(`${apiBase}/api/quantmind/paper`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ arxiv_id: arxivId }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load paper')
      addPaperToLibrary(data.paper)
      if (activeTab === 'discover') setActiveTab('library')
    } catch (e) {
      setError(e.message)
    } finally {
      setLoadingId(null)
    }
  }, [apiBase, activeTab])

  // ── Manual entry ────────────────────────────────────────────────────────────
  const fetchPaper = useCallback(async () => {
    const id = arxivInput.trim()
    if (!id) return
    if (papers.find(p => p.arxiv_id === id.replace(/^arxiv:/i, ''))) {
      setError(`Paper ${id} is already loaded`); return
    }
    setManualLoading(true); setError(null)
    try {
      const res = await fetch(`${apiBase}/api/quantmind/paper`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ arxiv_id: id }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch paper')
      addPaperToLibrary(data.paper)
      setArxivInput('')
      setActiveTab('library')
    } catch (e) { setError(e.message) }
    finally { setManualLoading(false) }
  }, [arxivInput, papers, apiBase])

  const fetchBatch = useCallback(async () => {
    const ids = batchInput.split(/[\n,\s]+/).map(s => s.trim()).filter(Boolean)
    if (!ids.length) return
    setBatchLoading(true); setError(null)
    try {
      const res = await fetch(`${apiBase}/api/quantmind/batch`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ arxiv_ids: ids, max_concurrency: 4 }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Batch failed')
      data.results.filter(r => !r.error).forEach(r => addPaperToLibrary(r.paper))
      setBatchInput('')
      setActiveTab('library')
    } catch (e) { setError(e.message) }
    finally { setBatchLoading(false) }
  }, [batchInput, apiBase])

  // ── Ask ─────────────────────────────────────────────────────────────────────
  const askQuestion = useCallback(async () => {
    if (!question.trim()) return
    setAskLoading(true); setError(null); setAnswer(null)
    try {
      const res = await fetch(`${apiBase}/api/quantmind/ask`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'include',
        body: JSON.stringify({ question: question.trim(), arxiv_ids: [...selectedIds], persona }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Ask failed')
      setAnswer(data)
    } catch (e) { setError(e.message) }
    finally { setAskLoading(false) }
  }, [question, selectedIds, persona, apiBase])

  const toggleSelect = (id) => {
    setSelectedIds(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n })
  }
  const removePaper = (id) => {
    setPapers(prev => prev.filter(p => p.arxiv_id !== id))
    setSelectedIds(prev => { const n = new Set(prev); n.delete(id); return n })
  }

  const selectedPersona = PERSONAS.find(p => p.id === persona)

  return (
    <div className="space-y-5 max-w-4xl mx-auto">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="flex items-center gap-3">
        <div className="p-2 rounded-lg bg-violet-500/15 border border-violet-500/25">
          <Brain className="w-5 h-5 text-violet-400" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-slate-100">QuantMind Research</h2>
          <p className="text-xs text-slate-500">arXiv paper discovery · Claude-powered analysis</p>
        </div>
        {papers.length > 0 && (
          <span className="ml-auto px-2.5 py-1 rounded-full bg-slate-700 text-xs text-slate-300">
            {papers.length} paper{papers.length !== 1 ? 's' : ''} in library
          </span>
        )}
      </div>

      {/* ── Tabs ───────────────────────────────────────────────────────────── */}
      <div className="flex gap-1 border-b border-slate-700/50">
        {[
          { id: 'discover', label: 'Discover', icon: Compass },
          { id: 'library',  label: `Library${papers.length ? ` (${papers.length})` : ''}`, icon: BookOpen },
          { id: 'ask',      label: 'Ask AI',   icon: Brain },
        ].map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-1.5 px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
              activeTab === id
                ? 'border-violet-500 text-violet-400'
                : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            <Icon className="w-3.5 h-3.5" />
            {label}
          </button>
        ))}
      </div>

      {/* ── Error ──────────────────────────────────────────────────────────── */}
      {error && (
        <div className="px-4 py-3 rounded-lg bg-red-500/10 border border-red-500/30 text-red-400 text-sm">
          {error}
        </div>
      )}

      {/* ════════════════ DISCOVER TAB ════════════════════════════════════ */}
      {activeTab === 'discover' && (
        <div className="space-y-4">
          {/* Category tabs */}
          <div className="flex flex-wrap gap-1.5">
            {CATEGORIES.map(c => (
              <button
                key={c.id}
                onClick={() => { setSearchCat(c.id); setSearchResults([]) }}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  searchCat === c.id
                    ? 'border-violet-500/60 bg-violet-500/15 text-violet-300'
                    : 'border-slate-700 text-slate-500 hover:border-slate-500 hover:text-slate-300'
                }`}
              >
                {c.label}
              </button>
            ))}
          </div>

          {/* Search bar */}
          <div className="flex gap-2">
            <input
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && doSearch()}
              placeholder="Search by keyword (e.g. momentum, factor, volatility…) or browse latest"
              className="flex-1 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-violet-500 transition-colors"
            />
            <button
              onClick={() => doSearch()}
              disabled={searching}
              className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-sm font-medium transition-colors flex items-center gap-1.5"
            >
              {searching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Search className="w-3.5 h-3.5" />}
              {searchQuery.trim() ? 'Search' : 'Browse Latest'}
            </button>
          </div>

          {/* Manual ID entry (collapsible hint) */}
          <div className="rounded-xl bg-slate-800/30 border border-slate-700/40 p-3 space-y-2">
            <p className="text-xs text-slate-500 font-medium">Have a specific arXiv ID?</p>
            <div className="flex gap-2">
              <input
                value={arxivInput}
                onChange={e => setArxivInput(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && fetchPaper()}
                placeholder="e.g. 2312.04557"
                className="flex-1 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-violet-500 transition-colors"
              />
              <button
                onClick={fetchPaper}
                disabled={manualLoading || !arxivInput.trim()}
                className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 text-xs font-medium transition-colors flex items-center gap-1"
              >
                {manualLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Plus className="w-3 h-3" />}
                Load
              </button>
              <input
                value={batchInput}
                onChange={e => setBatchInput(e.target.value)}
                placeholder="Batch: 2312.04557, 2401.12345"
                className="flex-1 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-violet-500 transition-colors"
              />
              <button
                onClick={fetchBatch}
                disabled={batchLoading || !batchInput.trim()}
                className="px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-600 disabled:opacity-40 text-slate-200 text-xs font-medium transition-colors flex items-center gap-1"
              >
                {batchLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Layers className="w-3 h-3" />}
                Batch
              </button>
            </div>
          </div>

          {/* Search results */}
          {searchResults.length > 0 && (
            <div className="rounded-xl bg-slate-800/40 border border-slate-700/50 divide-y divide-slate-700/30 overflow-hidden">
              <div className="px-4 py-2 flex items-center justify-between">
                <p className="text-xs text-slate-500">{searchResults.length} papers found</p>
                <p className="text-xs text-slate-600">Click "Load" to extract with Claude</p>
              </div>
              <div className="px-4">
                {searchResults.map(r => (
                  <SearchResultRow
                    key={r.arxiv_id}
                    result={r}
                    onLoad={loadSearchResult}
                    loading={loadingId === r.arxiv_id}
                  />
                ))}
              </div>
            </div>
          )}

          {searchResults.length === 0 && !searching && (
            <div className="text-center py-10 text-slate-600">
              <Compass className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Pick a category and click "Browse Latest" to discover recent papers</p>
              <p className="text-xs mt-1">Or type keywords like <span className="text-violet-400/60">factor investing</span>, <span className="text-violet-400/60">deep hedging</span>, <span className="text-violet-400/60">momentum crash</span></p>
            </div>
          )}
        </div>
      )}

      {/* ════════════════ LIBRARY TAB ══════════════════════════════════════ */}
      {activeTab === 'library' && (
        <div className="space-y-3">
          {papers.length > 0 ? (
            <>
              <div className="flex items-center justify-between">
                <p className="text-xs text-slate-500">
                  {selectedIds.size > 0
                    ? `${selectedIds.size} selected for Q&A context`
                    : 'Select papers to use as context in Ask AI'}
                </p>
                {selectedIds.size > 0 && (
                  <div className="flex gap-3">
                    <button onClick={() => setSelectedIds(new Set())}
                      className="text-xs text-slate-500 hover:text-slate-300 transition-colors">
                      Clear selection
                    </button>
                    <button onClick={() => setActiveTab('ask')}
                      className="text-xs text-violet-400 hover:text-violet-300 transition-colors flex items-center gap-1">
                      <Brain className="w-3 h-3" /> Ask AI →
                    </button>
                  </div>
                )}
              </div>
              {papers.map(p => (
                <PaperCard
                  key={p.arxiv_id} paper={p}
                  selected={selectedIds.has(p.arxiv_id)}
                  onToggleSelect={toggleSelect} onRemove={removePaper}
                />
              ))}
            </>
          ) : (
            <div className="text-center py-12 text-slate-600">
              <BookOpen className="w-8 h-8 mx-auto mb-3 opacity-30" />
              <p className="text-sm">Your library is empty</p>
              <button onClick={() => setActiveTab('discover')}
                className="text-xs text-violet-400 hover:text-violet-300 mt-2 transition-colors">
                Discover papers →
              </button>
            </div>
          )}
        </div>
      )}

      {/* ════════════════ ASK TAB ══════════════════════════════════════════ */}
      {activeTab === 'ask' && (
        <div className="space-y-4">
          {/* Persona selector */}
          <div className="flex flex-wrap gap-1.5">
            {PERSONAS.map(p => (
              <button key={p.id} onClick={() => setPersona(p.id)}
                className={`px-3 py-1 rounded-full text-xs font-medium border transition-colors ${
                  persona === p.id
                    ? `border-violet-500/60 bg-violet-500/15 ${p.color}`
                    : 'border-slate-700 text-slate-500 hover:border-slate-500'
                }`}>
                {p.label}
              </button>
            ))}
          </div>

          {/* Context chips */}
          {selectedIds.size > 0 ? (
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-xs text-slate-500">Context:</span>
              {[...selectedIds].map(id => (
                <span key={id} className="px-2 py-0.5 rounded-full bg-violet-500/10 border border-violet-500/20 text-violet-400 text-xs font-mono">
                  {id}
                </span>
              ))}
              <button onClick={() => setActiveTab('library')}
                className="text-xs text-slate-600 hover:text-slate-400 transition-colors ml-1">
                edit
              </button>
            </div>
          ) : (
            <div className="px-3 py-2 rounded-lg bg-amber-500/10 border border-amber-500/20 text-amber-400/80 text-xs flex items-center gap-2">
              ⚠ No papers selected — answer will be from general knowledge.
              {papers.length > 0 && (
                <button onClick={() => setActiveTab('library')} className="underline hover:text-amber-300 transition-colors">
                  Select papers
                </button>
              )}
            </div>
          )}

          {/* Question input */}
          <div className="flex gap-2">
            <input
              value={question}
              onChange={e => setQuestion(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && askQuestion()}
              placeholder={`Ask the ${selectedPersona?.label}…`}
              className="flex-1 bg-slate-900/60 border border-slate-700 rounded-lg px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:outline-none focus:border-violet-500 transition-colors"
            />
            <button
              onClick={askQuestion}
              disabled={askLoading || !question.trim()}
              className="px-4 py-2 rounded-lg bg-violet-600 hover:bg-violet-500 disabled:opacity-40 text-white text-sm font-medium transition-colors flex items-center gap-1.5"
            >
              {askLoading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Brain className="w-3.5 h-3.5" />}
              Ask
            </button>
          </div>

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

          {!answer && !askLoading && (
            <div className="text-center py-8 text-slate-600">
              <Brain className="w-8 h-8 mx-auto mb-2 opacity-20" />
              <p className="text-xs">Type a question above and press Ask</p>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
