/**
 * ResearchNotesView — Second Brain for investment research.
 *
 * COG patterns applied:
 *   - braindump → AI structures raw thoughts into investment thesis
 *   - note types: note | thesis | braindump | url
 *   - per-symbol tagging + search
 *   - live Markmap mindmap preview
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  BookOpen, Plus, Trash2, Brain, Sparkles, Tag, Search,
  FileText, Lightbulb, Link, ChevronRight, RefreshCw,
  Globe, Save, X, Zap, Map,
} from 'lucide-react'
import { Transformer } from 'markmap-lib'
import { Markmap }      from 'markmap-view'
import { useAuth }      from '../../contexts/AuthContext'

const transformer = new Transformer()

// ── helpers ──────────────────────────────────────────────────────────────────

const TYPE_CONFIG = {
  note:      { label: 'Note',      icon: FileText,  color: 'text-slate-400',  bg: 'bg-slate-500/15',  border: 'border-slate-500/25'  },
  thesis:    { label: 'Thesis',    icon: Lightbulb, color: 'text-amber-400',  bg: 'bg-amber-500/15',  border: 'border-amber-500/25'  },
  braindump: { label: 'Braindump', icon: Brain,     color: 'text-indigo-400', bg: 'bg-indigo-500/15', border: 'border-indigo-500/25' },
  url:       { label: 'URL Save',  icon: Link,      color: 'text-blue-400',   bg: 'bg-blue-500/15',   border: 'border-blue-500/25'   },
}

function TypeBadge({ type }) {
  const cfg  = TYPE_CONFIG[type] || TYPE_CONFIG.note
  const Icon = cfg.icon
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${cfg.bg} ${cfg.color} ${cfg.border}`}>
      <Icon className="w-2.5 h-2.5" /> {cfg.label}
    </span>
  )
}

function timeSince(iso) {
  if (!iso) return ''
  const d = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (d < 60)   return 'just now'
  if (d < 3600) return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

// ── Markmap live preview ──────────────────────────────────────────────────────
function MarkmapPreview({ content }) {
  const svgRef = useRef(null)
  const mmRef  = useRef(null)

  useEffect(() => {
    if (!svgRef.current) return
    if (!mmRef.current) {
      mmRef.current = Markmap.create(svgRef.current, {
        maxWidth: 320,
        duration: 200,
        paddingX: 16,
        zoom: true,
        pan: true,
      })
    }
  }, [])

  useEffect(() => {
    if (!mmRef.current || !content) return
    try {
      const { root } = transformer.transform(content || '# Empty\n')
      mmRef.current.setData(root)
      mmRef.current.fit()
    } catch {}
  }, [content])

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

  return (
    <svg
      ref={svgRef}
      className="w-full h-full"
      style={{ background: 'transparent' }}
    />
  )
}

// ── Note list item ────────────────────────────────────────────────────────────
function NoteItem({ note, active, onClick }) {
  return (
    <button
      onClick={onClick}
      className={`w-full text-left px-3 py-2.5 rounded-lg transition-all border ${
        active
          ? 'bg-indigo-500/15 border-indigo-500/30'
          : 'border-transparent hover:bg-white/[0.04] hover:border-white/[0.06]'
      }`}
    >
      <div className="flex items-center gap-2 mb-1">
        {note.symbol && (
          <span className="text-[10px] font-mono font-bold text-mint-400 shrink-0">{note.symbol}</span>
        )}
        <TypeBadge type={note.note_type} />
        <span className="text-[10px] text-slate-600 ml-auto shrink-0">{timeSince(note.updated_at)}</span>
      </div>
      <div className="text-xs font-medium text-slate-200 leading-snug truncate">{note.title}</div>
      {note.tags?.length > 0 && (
        <div className="flex flex-wrap gap-1 mt-1">
          {note.tags.slice(0, 3).map(t => (
            <span key={t} className="text-[9px] px-1 py-0.5 rounded bg-white/[0.04] text-slate-500">{t}</span>
          ))}
        </div>
      )}
    </button>
  )
}

// ── Braindump modal ───────────────────────────────────────────────────────────
function BraindumpModal({ symbol, onClose, onSave }) {
  const { authFetch } = useAuth()
  const [raw,        setRaw]        = useState('')
  const [processing, setProcessing] = useState(false)
  const [result,     setResult]     = useState(null)
  const [error,      setError]      = useState(null)

  const structureThoughts = async () => {
    if (!raw.trim()) return
    setProcessing(true)
    setError(null)
    try {
      const res  = await authFetch('/api/research-notes/braindump', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ raw, symbol }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResult(data)
    } catch (e) {
      setError(e.message)
    }
    setProcessing(false)
  }

  const handleSave = async () => {
    if (!result) return
    await onSave({
      title:     result.title,
      content:   result.content,
      tags:      result.tags || [],
      note_type: result.note_type || 'braindump',
      symbol,
    })
    onClose()
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-2xl border border-indigo-500/25 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <Brain className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-semibold text-white">Braindump → Structured Thesis</span>
          {symbol && <span className="text-[11px] font-mono text-mint-400 ml-1">· {symbol}</span>}
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-white transition-colors">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-4 space-y-3">
          {!result ? (
            <>
              <p className="text-xs text-slate-500">
                Dump your raw thoughts — market observations, stock ideas, risks, anything. AI will structure it into a clean research note.
              </p>
              <textarea
                value={raw}
                onChange={e => setRaw(e.target.value)}
                placeholder="NVDA is crazy expensive but the data center demand is real. AI capex from hyperscalers still accelerating. AMD is a risk but honestly their software stack sucks. The blackwell ramp looks legit. China export controls are the wildcard. I think it still goes higher but need a pullback to buy more..."
                className="input h-40 resize-none font-mono text-xs"
                autoFocus
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
                <button
                  onClick={structureThoughts}
                  disabled={!raw.trim() || processing}
                  className="btn-primary flex items-center gap-1.5 text-xs py-1.5 disabled:opacity-50"
                >
                  {processing
                    ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Structuring…</>
                    : <><Sparkles className="w-3.5 h-3.5" /> Structure with AI</>
                  }
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2 mb-1">
                <Sparkles className="w-3.5 h-3.5 text-mint-400" />
                <span className="text-xs font-semibold text-mint-400">Structured result</span>
                <TypeBadge type={result.note_type} />
              </div>
              <div className="bg-white/[0.03] rounded-xl p-3 border border-white/[0.07]">
                <div className="text-xs font-semibold text-white mb-2">{result.title}</div>
                <pre className="text-[11px] text-slate-300 whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-y-auto">
                  {result.content}
                </pre>
              </div>
              <div className="flex justify-between items-center">
                <button onClick={() => setResult(null)} className="text-xs text-slate-500 hover:text-white transition-colors">
                  ← Edit raw
                </button>
                <div className="flex gap-2">
                  <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Discard</button>
                  <button onClick={handleSave} className="btn-primary flex items-center gap-1.5 text-xs py-1.5">
                    <Save className="w-3.5 h-3.5" /> Save Note
                  </button>
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────
export default function ResearchNotesView({ defaultSymbol }) {
  const { authFetch }  = useAuth()
  const [notes,        setNotes]        = useState([])
  const [activeNote,   setActiveNote]   = useState(null)
  const [loading,      setLoading]      = useState(false)
  const [saving,       setSaving]       = useState(false)
  const [search,       setSearch]       = useState('')
  const [filterType,   setFilterType]   = useState('')
  const [showBraindump, setShowBraindump] = useState(false)
  const [viewMode,     setViewMode]     = useState('split') // 'editor' | 'mindmap' | 'split'
  const editorRef = useRef(null)

  // Draft state — tracks unsaved edits to active note
  const [draft, setDraft] = useState({ title: '', content: '', symbol: '', tags: '' })

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

  // Sync draft when active note changes
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
    try {
      const body = {
        title:     overrides.title    || 'New Note',
        content:   overrides.content  || '',
        symbol:    overrides.symbol   || defaultSymbol || null,
        note_type: overrides.note_type || 'note',
        tags:      overrides.tags     || [],
      }
      const res  = await authFetch('/api/research-notes', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      const note = await res.json()
      if (res.ok) {
        setNotes(prev => [note, ...prev])
        setActiveNote(note)
      }
    } catch {}
    setSaving(false)
  }

  const saveNote = async () => {
    if (!activeNote) return
    setSaving(true)
    try {
      const tags = draft.tags.split(',').map(t => t.trim()).filter(Boolean)
      const body = {
        title:   draft.title,
        content: draft.content,
        symbol:  draft.symbol || null,
        tags,
      }
      const res  = await authFetch(`/api/research-notes/${activeNote.id}`, {
        method:  'PUT',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      const updated = await res.json()
      if (res.ok) {
        setNotes(prev => prev.map(n => n.id === updated.id ? updated : n))
        setActiveNote(updated)
      }
    } catch {}
    setSaving(false)
  }

  const deleteNote = async (id) => {
    await authFetch(`/api/research-notes/${id}`, { method: 'DELETE' })
    setNotes(prev => prev.filter(n => n.id !== id))
    if (activeNote?.id === id) setActiveNote(null)
  }

  const handleBraindumpSave = async (data) => {
    await createNote(data)
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

  return (
    <div className="flex h-[calc(100vh-10rem)] gap-4 animate-fade-in">

      {/* ── Left: Note list ── */}
      <div className="w-64 shrink-0 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-semibold text-white">Second Brain</span>
          <span className="text-[10px] text-slate-500 ml-auto">{notes.length} notes</span>
        </div>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search notes…"
            className="input pl-7 py-1.5 text-xs"
          />
        </div>

        {/* Type filter pills */}
        <div className="flex flex-wrap gap-1">
          {['', 'note', 'thesis', 'braindump', 'url'].map(t => (
            <button
              key={t}
              onClick={() => setFilterType(t)}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                filterType === t
                  ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'
                  : 'text-slate-500 border-white/[0.07] hover:text-white'
              }`}
            >
              {t || 'All'}
            </button>
          ))}
        </div>

        {/* New note buttons */}
        <div className="flex gap-1">
          <button
            onClick={() => createNote()}
            className="flex-1 flex items-center justify-center gap-1 text-[11px] py-1.5 rounded-lg bg-white/[0.04] border border-white/[0.07] text-slate-400 hover:text-white hover:border-white/[0.15] transition-all"
          >
            <Plus className="w-3 h-3" /> Note
          </button>
          <button
            onClick={() => setShowBraindump(true)}
            className="flex-1 flex items-center justify-center gap-1 text-[11px] py-1.5 rounded-lg bg-indigo-500/15 border border-indigo-500/25 text-indigo-400 hover:bg-indigo-500/25 transition-all"
          >
            <Brain className="w-3 h-3" /> Braindump
          </button>
        </div>

        {/* Note list */}
        <div className="flex-1 overflow-y-auto space-y-0.5 pr-0.5">
          {loading && (
            <div className="text-xs text-slate-600 text-center py-4">Loading…</div>
          )}
          {!loading && filteredNotes.length === 0 && (
            <div className="text-xs text-slate-600 text-center py-8 px-2">
              {notes.length === 0
                ? <>No notes yet.<br />Start with a Braindump!</>
                : 'No notes match your filter.'}
            </div>
          )}
          {filteredNotes.map(note => (
            <NoteItem
              key={note.id}
              note={note}
              active={activeNote?.id === note.id}
              onClick={() => setActiveNote(note)}
            />
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
              <p className="text-white font-semibold">Your Investment Second Brain</p>
              <p className="text-slate-500 text-sm mt-1 max-w-sm">
                Capture raw thoughts, build investment theses, save research URLs. Visualize any note as an interactive mindmap.
              </p>
            </div>
            <div className="flex gap-3">
              <button onClick={() => createNote()} className="btn-ghost text-sm flex items-center gap-2">
                <Plus className="w-4 h-4" /> New Note
              </button>
              <button onClick={() => setShowBraindump(true)} className="btn-primary flex items-center gap-2">
                <Brain className="w-4 h-4" /> Start Braindump
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Toolbar */}
            <div className="flex items-center gap-2">
              <input
                value={draft.title}
                onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
                className="flex-1 bg-transparent text-sm font-semibold text-white focus:outline-none border-b border-transparent focus:border-white/[0.2] pb-0.5 transition-colors"
                placeholder="Note title…"
              />
              <input
                value={draft.symbol}
                onChange={e => setDraft(d => ({ ...d, symbol: e.target.value.toUpperCase() }))}
                className="w-20 text-xs font-mono text-mint-400 bg-transparent focus:outline-none border-b border-transparent focus:border-mint-500/40 pb-0.5 placeholder-slate-600 text-center"
                placeholder="SYMBOL"
              />
              <div className="flex gap-1">
                {['editor','split','mindmap'].map(m => (
                  <button
                    key={m}
                    onClick={() => setViewMode(m)}
                    className={`px-2 py-1 text-[10px] rounded-lg border transition-all capitalize ${
                      viewMode === m
                        ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30'
                        : 'text-slate-500 border-white/[0.07] hover:text-white'
                    }`}
                  >
                    {m === 'split' ? 'Split' : m === 'editor' ? 'Write' : <><Map className="w-3 h-3 inline" /> Map</>}
                  </button>
                ))}
              </div>
              <button
                onClick={saveNote}
                disabled={!isDirty || saving}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg bg-mint-500/15 text-mint-400 border border-mint-500/25 hover:bg-mint-500/25 disabled:opacity-40 transition-all"
              >
                {saving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                {saving ? 'Saving…' : isDirty ? 'Save*' : 'Saved'}
              </button>
              <button
                onClick={() => deleteNote(activeNote.id)}
                aria-label="Delete note"
                className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-all"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Tags */}
            <div className="flex items-center gap-1.5">
              <Tag className="w-3 h-3 text-slate-600" />
              <input
                value={draft.tags}
                onChange={e => setDraft(d => ({ ...d, tags: e.target.value }))}
                placeholder="tags, comma, separated"
                className="flex-1 bg-transparent text-[11px] text-slate-400 placeholder-slate-600 focus:outline-none"
              />
              <TypeBadge type={activeNote.note_type} />
            </div>

            {/* Editor / Mindmap / Split */}
            <div className="flex-1 flex gap-2 min-h-0">
              {(viewMode === 'editor' || viewMode === 'split') && (
                <textarea
                  ref={editorRef}
                  value={draft.content}
                  onChange={e => setDraft(d => ({ ...d, content: e.target.value }))}
                  placeholder={`# ${draft.symbol || 'Stock'}\n## Bull Case\n- \n## Bear Case\n- \n## Catalysts\n- \n## Thesis Breaker\n- `}
                  className="flex-1 bg-white/[0.02] border border-white/[0.06] rounded-xl p-3 text-xs font-mono text-slate-300 placeholder-slate-700 focus:outline-none focus:border-indigo-500/30 resize-none leading-relaxed"
                  style={{ minHeight: 0 }}
                />
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

      {/* Braindump modal */}
      {showBraindump && (
        <BraindumpModal
          symbol={defaultSymbol}
          onClose={() => setShowBraindump(false)}
          onSave={handleBraindumpSave}
        />
      )}
    </div>
  )
}
