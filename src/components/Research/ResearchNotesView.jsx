/**
 * ResearchNotesView — Self-maturing Second Brain for investment research.
 *
 * Layers:
 *   1. Auto-ingest: Braindump, Auto-Research (Finnhub→Claude), URL Scout
 *   2. Knowledge consolidation: merge notes → master thesis
 *   3. Daily brief: morning portfolio intelligence + opportunity watchlist
 *   4. Feedback loops: stale thesis detection (>30 days)
 *
 * Modals and shared note helpers live in ./notes/.
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  BookOpen, Plus, Trash2, Brain, Tag, Search,
  RefreshCw, Globe, Save, X, Map, Sun, Layers,
  AlertTriangle, Zap, ExternalLink, Compass,
  MessageSquare, ShieldCheck, Calendar,
} from 'lucide-react'
import { useAuth }      from '../../contexts/AuthContext'
import { useApiKeys }   from '../../contexts/ApiKeysContext'
import { TypeBadge, NoteItem, isStale } from './notes/noteHelpers'
import MarkmapPreview       from './notes/MarkmapPreview'
import BraindumpModal       from './notes/BraindumpModal'
import ScoutModal           from './notes/ScoutModal'
import DailyBriefModal      from './notes/DailyBriefModal'
import AutoResearchModal    from './notes/AutoResearchModal'
import ThinkModal           from './notes/ThinkModal'
import ThinkingPartnerModal from './notes/ThinkingPartnerModal'
import LintModal            from './notes/LintModal'
import WeeklySynthesisModal from './notes/WeeklySynthesisModal'

// ── Main view ─────────────────────────────────────────────────────────────────
export default function ResearchNotesView({ defaultSymbol, portfolio }) {
  const { authFetch }  = useAuth()
  const { getHeaders } = useApiKeys()

  const [notes,          setNotes]          = useState([])
  const [activeNote,     setActiveNote]     = useState(null)
  const [loading,        setLoading]        = useState(false)
  const [saving,         setSaving]         = useState(false)
  const [search,         setSearch]         = useState('')
  const [filterType,     setFilterType]     = useState('')
  const [viewMode,       setViewMode]       = useState('split')

  // Modal states
  const [showBraindump,       setShowBraindump]       = useState(false)
  const [showScout,           setShowScout]           = useState(false)
  const [showBrief,           setShowBrief]           = useState(false)
  const [showAutoResearch,    setShowAutoResearch]    = useState(false)
  const [showThink,           setShowThink]           = useState(false)
  const [showThinkingPartner, setShowThinkingPartner] = useState(false)
  const [showLint,            setShowLint]            = useState(false)
  const [showWeeklySynth,     setShowWeeklySynth]     = useState(false)
  const [deepResearchMode,    setDeepResearchMode]    = useState(false)
  const [consolidating,       setConsolidating]       = useState(false)

  const editorRef = useRef(null)

  const [draft, setDraft]           = useState({ title: '', content: '', symbol: '', tags: '' })
  const [noteError, setNoteError]   = useState(null)
  const [briefHighAlert, setBriefHighAlert] = useState(false)

  const fetchNotes = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await authFetch('/api/research-notes?limit=100')
      const data = await res.json()
      if (res.ok) setNotes(Array.isArray(data) ? data : [])
    } catch {}
    setLoading(false)
  }, [authFetch])

  useEffect(() => { fetchNotes() }, [fetchNotes])

  useEffect(() => {
    if (activeNote) {
      setDraft({
        title:   activeNote.title || '',
        content: activeNote.content || '',
        symbol:  activeNote.symbol || (defaultSymbol || ''),
        tags:    (activeNote.tags || []).join(', '),
      })
    }
  }, [activeNote, defaultSymbol])

  const createNote = async (overrides = {}) => {
    setSaving(true)
    setNoteError(null)
    try {
      const body = {
        title:     overrides.title    || 'New Note',
        content:   overrides.content  || '',
        symbol:    overrides.symbol   || defaultSymbol || null,
        note_type: overrides.note_type || 'note',
        tags:      overrides.tags     || [],
        source_url: overrides.source_url || null,
      }
      const res  = await authFetch('/api/research-notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      let note
      try { note = await res.json() } catch { throw new Error('Server returned an invalid response.') }
      if (res.ok) {
        setNotes(prev => [note, ...prev])
        setActiveNote(note)
      } else {
        setNoteError(note.error || 'Failed to create note — please try again.')
      }
    } catch (e) {
      setNoteError(e.message || 'Failed to create note — please try again.')
    }
    setSaving(false)
  }

  const saveNote = async () => {
    if (!activeNote) return
    setSaving(true)
    try {
      const tags = draft.tags.split(',').map(t => t.trim()).filter(Boolean)
      const res  = await authFetch(`/api/research-notes/${activeNote.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: draft.title, content: draft.content, symbol: draft.symbol || null, tags }),
      })
      const updated = await res.json()
      if (res.ok) { setNotes(prev => prev.map(n => n.id === updated.id ? updated : n)); setActiveNote(updated) }
    } catch {}
    setSaving(false)
  }

  const deleteNote = async (id) => {
    await authFetch(`/api/research-notes/${id}`, { method: 'DELETE' })
    setNotes(prev => prev.filter(n => n.id !== id))
    if (activeNote?.id === id) setActiveNote(null)
  }

  const handleConsolidate = async () => {
    setConsolidating(true)
    try {
      const sym = filterType === '' ? undefined : activeNote?.symbol
      const res = await authFetch('/api/research-notes/consolidate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: draft.symbol || sym || undefined }),
      })
      const note = await res.json()
      if (res.ok) { setNotes(prev => [note, ...prev]); setActiveNote(note) }
    } catch {}
    setConsolidating(false)
  }

  const handleSelectNote = (noteId) => {
    const n = notes.find(x => x.id === noteId)
    if (n) setActiveNote(n)
  }

  // Called when auto-research result should update the current note or be saved as new
  const handleAutoResearchApply = async (content, saveAsNew = false) => {
    if (saveAsNew) {
      await createNote({ title: `${draft.symbol || 'Stock'} — Auto-Research`, content, symbol: draft.symbol, note_type: 'thesis', tags: ['auto-research'] })
    } else {
      setDraft(d => ({ ...d, content }))
    }
  }

  // Called when daily brief is generated — note is already saved server-side
  const handleBriefReady = (note, topNews) => {
    setNotes(prev => {
      const exists = prev.find(n => n.id === note.id)
      return exists ? prev.map(n => n.id === note.id ? note : n) : [note, ...prev]
    })
    setActiveNote(note)
    if (topNews?.some(n => n.impact === 'HIGH')) setBriefHighAlert(true)
  }

  const filteredNotes = notes.filter(n => {
    if (filterType && n.note_type !== filterType) return false
    if (!search) return true
    const q = search.toLowerCase()
    return (
      n.title?.toLowerCase().includes(q) ||
      n.symbol?.toLowerCase().includes(q) ||
      n.content?.toLowerCase().includes(q) ||
      n.tags?.some(t => t.toLowerCase().includes(q))
    )
  })

  const isDirty = activeNote && (
    draft.title   !== (activeNote.title || '') ||
    draft.content !== (activeNote.content || '') ||
    draft.symbol  !== (activeNote.symbol || '') ||
    draft.tags    !== (activeNote.tags || []).join(', ')
  )

  const activeIsStale = activeNote?.note_type === 'thesis' && isStale(activeNote.updated_at)

  return (
    <div className="flex h-[calc(100vh-10rem)] gap-4 animate-fade-in">

      {/* ── Left: Note list ── */}
      <div className="w-64 shrink-0 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-semibold text-white">Second Brain</span>
          <span className="text-[10px] text-slate-500 ml-auto">{notes.length} notes</span>
        </div>

        {/* Morning Brief button — prominent, shows badge when HIGH-impact news exists */}
        <button
          onClick={() => { setShowBrief(true); setBriefHighAlert(false) }}
          className="relative flex items-center justify-center gap-2 py-2 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-400 hover:bg-amber-500/20 transition-all text-xs font-medium"
        >
          <Sun className="w-3.5 h-3.5" /> Morning Brief
          {briefHighAlert && (
            <span className="absolute top-1 right-1.5 flex items-center gap-0.5 text-[9px] font-bold text-red-400 bg-red-500/15 border border-red-500/30 rounded-full px-1 py-0.5 leading-none">
              ! NEWS
            </span>
          )}
        </button>

        {/* Note creation error */}
        {noteError && (
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20">
            <span className="text-[10px] text-red-400 flex-1">{noteError}</span>
            <button onClick={() => setNoteError(null)} className="text-slate-600 hover:text-white"><X className="w-3 h-3" /></button>
          </div>
        )}

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search notes…" className="input pl-7 py-1.5 text-xs" />
        </div>

        {/* Type filter pills */}
        <div className="flex flex-wrap gap-1">
          {['', 'note', 'thesis', 'braindump', 'url', 'think', 'synthesis'].map(t => (
            <button key={t} onClick={() => setFilterType(t)}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                filterType === t ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30' : 'text-slate-500 border-white/[0.07] hover:text-white'
              }`}>
              {t || 'All'}
            </button>
          ))}
        </div>

        {/* Action buttons — 2×3 grid */}
        <div className="grid grid-cols-3 gap-1">
          <button onClick={() => createNote()}
            className="flex flex-col items-center gap-0.5 text-[10px] py-2 rounded-lg bg-white/[0.03] border border-white/[0.07] text-slate-400 hover:text-white hover:border-white/[0.15] transition-all">
            <Plus className="w-3 h-3" /> Note
          </button>
          <button onClick={() => setShowBraindump(true)}
            className="flex flex-col items-center gap-0.5 text-[10px] py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/20 transition-all">
            <Brain className="w-3 h-3" /> Dump
          </button>
          <button onClick={() => setShowScout(true)}
            className="flex flex-col items-center gap-0.5 text-[10px] py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 transition-all">
            <Globe className="w-3 h-3" /> Scout
          </button>
          <button onClick={() => setShowThink(true)}
            className="flex flex-col items-center gap-0.5 text-[10px] py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-400 hover:bg-violet-500/20 transition-all">
            <Compass className="w-3 h-3" /> Think
          </button>
          <button onClick={() => setShowWeeklySynth(true)}
            className="flex flex-col items-center gap-0.5 text-[10px] py-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 hover:bg-rose-500/20 transition-all">
            <Calendar className="w-3 h-3" /> Weekly
          </button>
          <button onClick={() => setShowLint(true)}
            className="flex flex-col items-center gap-0.5 text-[10px] py-2 rounded-lg bg-teal-500/10 border border-teal-500/20 text-teal-400 hover:bg-teal-500/20 transition-all">
            <ShieldCheck className="w-3 h-3" /> Lint
          </button>
        </div>

        {/* Note list */}
        <div className="flex-1 overflow-y-auto space-y-0.5 pr-0.5">
          {loading && <div className="text-xs text-slate-600 text-center py-4">Loading…</div>}
          {!loading && filteredNotes.length === 0 && (
            <div className="text-xs text-slate-600 text-center py-8 px-2">
              {notes.length === 0 ? <>No notes yet.<br />Start with Morning Brief!</> : 'No notes match your filter.'}
            </div>
          )}
          {filteredNotes.map(note => (
            <NoteItem key={note.id} note={note} active={activeNote?.id === note.id} onClick={() => setActiveNote(note)} />
          ))}
        </div>
      </div>

      {/* ── Right: Editor + Mindmap ── */}
      <div className="flex-1 flex flex-col min-w-0 gap-2">
        {!activeNote ? (
          <div className="flex-1 glass rounded-2xl flex flex-col items-center justify-center text-center gap-4 p-8">
            <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
              <BookOpen className="w-7 h-7 text-indigo-400" />
            </div>
            <div>
              <p className="text-white font-semibold">Your Self-Maturing Investment Brain</p>
              <p className="text-slate-500 text-sm mt-1 max-w-md">
                Generate daily briefs, auto-research any ticker with live market data, scout URLs for insights, and consolidate your knowledge into master theses.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center">
              <button onClick={() => setShowBrief(true)} className="btn-primary flex items-center gap-2 text-sm">
                <Sun className="w-4 h-4" /> Morning Brief
              </button>
              <button onClick={() => createNote()} className="btn-ghost text-sm flex items-center gap-2">
                <Plus className="w-4 h-4" /> New Note
              </button>
              <button onClick={() => setShowBraindump(true)} className="btn-ghost text-sm flex items-center gap-2">
                <Brain className="w-4 h-4" /> Braindump
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Stale thesis banner */}
            {activeIsStale && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span className="text-amber-300">This thesis is over 30 days old — market conditions may have changed.</span>
                {activeNote.symbol && (
                  <button onClick={() => setShowAutoResearch(true)}
                    className="ml-auto flex items-center gap-1 text-[11px] text-mint-400 hover:text-mint-300 border border-mint-500/25 rounded px-2 py-0.5 hover:bg-mint-500/10 transition-all">
                    <Zap className="w-3 h-3" /> Refresh Research
                  </button>
                )}
              </div>
            )}

            {/* Toolbar */}
            <div className="flex items-center gap-2">
              <input value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
                className="flex-1 bg-transparent text-sm font-semibold text-white focus:outline-none border-b border-transparent focus:border-white/[0.2] pb-0.5 transition-colors"
                placeholder="Note title…" />
              <input value={draft.symbol} onChange={e => setDraft(d => ({ ...d, symbol: e.target.value.toUpperCase() }))}
                className="w-20 text-xs font-mono text-mint-400 bg-transparent focus:outline-none border-b border-transparent focus:border-mint-500/40 pb-0.5 placeholder-slate-600 text-center"
                placeholder="SYMBOL" />

              {/* View mode */}
              <div className="flex gap-1">
                {['editor', 'split', 'mindmap'].map(m => (
                  <button key={m} onClick={() => setViewMode(m)}
                    className={`px-2 py-1 text-[10px] rounded-lg border transition-all capitalize ${
                      viewMode === m ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30' : 'text-slate-500 border-white/[0.07] hover:text-white'
                    }`}>
                    {m === 'split' ? 'Split' : m === 'editor' ? 'Write' : <><Map className="w-3 h-3 inline" /> Map</>}
                  </button>
                ))}
              </div>

              {/* Auto-Research (when symbol set) */}
              {draft.symbol && (
                <div className="flex items-center rounded-lg bg-mint-500/10 border border-mint-500/20 overflow-hidden">
                  <button onClick={() => { setDeepResearchMode(false); setShowAutoResearch(true) }}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-mint-400 hover:bg-mint-500/20 transition-all">
                    <Zap className="w-3 h-3" /> Research
                  </button>
                  <button onClick={() => { setDeepResearchMode(true); setShowAutoResearch(true) }}
                    title="3-round deep research"
                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-mint-400 border-l border-mint-500/20 hover:bg-mint-500/20 transition-all">
                    <Layers className="w-3 h-3" /> Deep
                  </button>
                </div>
              )}

              {/* Thinking Partner (when note has content) */}
              {draft.content?.trim() && (
                <button onClick={() => setShowThinkingPartner(true)}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-all">
                  <MessageSquare className="w-3 h-3" /> Partner
                </button>
              )}

              {/* Think framework (when symbol set) */}
              {draft.symbol && (
                <button onClick={() => setShowThink(true)}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-400 hover:bg-violet-500/20 transition-all">
                  <Compass className="w-3 h-3" /> Think
                </button>
              )}

              {/* Consolidate */}
              <button onClick={handleConsolidate} disabled={consolidating}
                className="flex items-center gap-1 px-2 py-1 text-[10px] rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-400 hover:bg-purple-500/20 disabled:opacity-50 transition-all">
                {consolidating ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Layers className="w-3 h-3" />}
                {consolidating ? 'Synthesizing…' : 'Synthesize'}
              </button>

              <button onClick={saveNote} disabled={!isDirty || saving}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg bg-mint-500/15 text-mint-400 border border-mint-500/25 hover:bg-mint-500/25 disabled:opacity-40 transition-all">
                {saving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                {saving ? 'Saving…' : isDirty ? 'Save*' : 'Saved'}
              </button>
              <button onClick={() => deleteNote(activeNote.id)} aria-label="Delete note"
                className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-all">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Tags */}
            <div className="flex items-center gap-1.5">
              <Tag className="w-3 h-3 text-slate-600" />
              <input value={draft.tags} onChange={e => setDraft(d => ({ ...d, tags: e.target.value }))}
                placeholder="tags, comma, separated"
                className="flex-1 bg-transparent text-[11px] text-slate-400 placeholder-slate-600 focus:outline-none" />
              <TypeBadge type={activeNote.note_type} />
              {activeNote.source_url && (
                <a href={activeNote.source_url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-0.5 text-[10px] text-blue-400 hover:text-blue-300">
                  <ExternalLink className="w-3 h-3" /> Source
                </a>
              )}
            </div>

            {/* Editor / Mindmap / Split */}
            <div className="flex-1 flex gap-2 min-h-0">
              {(viewMode === 'editor' || viewMode === 'split') && (
                <textarea ref={editorRef} value={draft.content}
                  onChange={e => setDraft(d => ({ ...d, content: e.target.value }))}
                  placeholder={`# ${draft.symbol || 'Stock'}\n## Bull Case\n- \n## Bear Case\n- \n## Catalysts\n- \n## Thesis Breaker\n- `}
                  className="flex-1 bg-white/[0.02] border border-white/[0.06] rounded-xl p-3 text-xs font-mono text-slate-300 placeholder-slate-700 focus:outline-none focus:border-indigo-500/30 resize-none leading-relaxed"
                  style={{ minHeight: 0 }} />
              )}
              {(viewMode === 'mindmap' || viewMode === 'split') && (
                <div className={`${viewMode === 'split' ? 'flex-1' : 'w-full'} glass rounded-xl border border-white/[0.06] overflow-hidden relative`}>
                  <div className="absolute top-2 left-2 z-10 flex items-center gap-1 text-[10px] text-slate-600">
                    <Map className="w-2.5 h-2.5" /> Live Mindmap
                  </div>
                  <MarkmapPreview content={draft.content} />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Modals ── */}
      {showBraindump && (
        <BraindumpModal symbol={draft.symbol || defaultSymbol} onClose={() => setShowBraindump(false)}
          onSave={async (data) => { await createNote(data) }} />
      )}
      {showScout && (
        <ScoutModal onClose={() => setShowScout(false)}
          onSave={async (data) => { await createNote(data) }} />
      )}
      {showBrief && (
        <DailyBriefModal portfolio={portfolio} notes={notes} onClose={() => setShowBrief(false)}
          onSave={handleBriefReady} />
      )}
      {showAutoResearch && draft.symbol && (
        <AutoResearchModal symbol={draft.symbol} deep={deepResearchMode}
          onClose={() => setShowAutoResearch(false)}
          onApply={handleAutoResearchApply} />
      )}
      {showThink && (
        <ThinkModal
          symbol={draft.symbol || defaultSymbol || null}
          contextNotes={activeNote ? `${activeNote.title}\n${activeNote.content?.slice(0, 1500)}` : null}
          onClose={() => setShowThink(false)}
          onSave={async (data) => { await createNote(data) }}
        />
      )}
      {showThinkingPartner && (
        <ThinkingPartnerModal
          symbol={draft.symbol || null}
          thesis={draft.content}
          onClose={() => setShowThinkingPartner(false)}
        />
      )}
      {showLint && (
        <LintModal
          portfolio={portfolio}
          onClose={() => setShowLint(false)}
          onSelectNote={handleSelectNote}
        />
      )}
      {showWeeklySynth && (
        <WeeklySynthesisModal
          onClose={() => setShowWeeklySynth(false)}
          onSave={(note) => {
            setNotes(prev => [note, ...prev])
            setActiveNote(note)
          }}
        />
      )}
    </div>
  )
}
