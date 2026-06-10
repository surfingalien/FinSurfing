/**
 * Shared helpers for ResearchNotesView and its modals:
 * note-type badge config, staleness checks, and the note list item.
 */

import {
  FileText, Lightbulb, Brain, Link, Compass, GitMerge,
} from 'lucide-react'

export const STALE_DAYS = 30

export const TYPE_CONFIG = {
  note:      { label: 'Note',      icon: FileText,   color: 'text-slate-400',  bg: 'bg-slate-500/15',  border: 'border-slate-500/25'  },
  thesis:    { label: 'Thesis',    icon: Lightbulb,  color: 'text-amber-400',  bg: 'bg-amber-500/15',  border: 'border-amber-500/25'  },
  braindump: { label: 'Braindump', icon: Brain,      color: 'text-indigo-400', bg: 'bg-indigo-500/15', border: 'border-indigo-500/25' },
  url:       { label: 'URL Save',  icon: Link,       color: 'text-blue-400',   bg: 'bg-blue-500/15',   border: 'border-blue-500/25'   },
  think:     { label: 'Think',     icon: Compass,    color: 'text-violet-400', bg: 'bg-violet-500/15', border: 'border-violet-500/25' },
  synthesis: { label: 'Synthesis', icon: GitMerge,   color: 'text-rose-400',   bg: 'bg-rose-500/15',   border: 'border-rose-500/25'   },
}

export function TypeBadge({ type }) {
  const cfg  = TYPE_CONFIG[type] || TYPE_CONFIG.note
  const Icon = cfg.icon
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${cfg.bg} ${cfg.color} ${cfg.border}`}>
      <Icon className="w-2.5 h-2.5" /> {cfg.label}
    </span>
  )
}

export function timeSince(iso) {
  if (!iso) return ''
  const d = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (d < 60)    return 'just now'
  if (d < 3600)  return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

export function isStale(iso) {
  if (!iso) return false
  return (Date.now() - new Date(iso)) > STALE_DAYS * 86400000
}

// ── Note list item ────────────────────────────────────────────────────────────
export function NoteItem({ note, active, onClick }) {
  const stale = note.note_type === 'thesis' && isStale(note.updated_at)

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
        {stale && (
          <span className="flex items-center gap-0.5 text-[9px] font-medium text-amber-500 bg-amber-500/10 border border-amber-500/20 px-1 py-0.5 rounded">
            <span className="w-1.5 h-1.5 rounded-full bg-amber-500 inline-block" />
            Stale
          </span>
        )}
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
