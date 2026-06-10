import { useState } from 'react'
import { Calendar, RefreshCw, X } from 'lucide-react'
import { useAuth } from '../../../contexts/AuthContext'

// ── Weekly Synthesis modal ────────────────────────────────────────────────────
export default function WeeklySynthesisModal({ onClose, onSave }) {
  const { authFetch } = useAuth()
  const [generating, setGenerating] = useState(false)
  const [error,      setError]      = useState(null)

  const generate = async () => {
    setGenerating(true); setError(null)
    try {
      const res  = await authFetch('/api/research-notes/weekly-synthesis', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      })
      let note
      try { note = await res.json() } catch { throw new Error('Server returned an invalid response — please try again.') }
      if (!res.ok) throw new Error(note.error || `Request failed (HTTP ${res.status})`)
      onSave(note)
      onClose()
    } catch (e) { setError(e.message) }
    setGenerating(false)
  }

  const weekStart = new Date(Date.now() - 7 * 86400000).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
  const today     = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-md border border-rose-500/25 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <Calendar className="w-4 h-4 text-rose-400" />
          <span className="text-sm font-semibold text-white">Weekly Synthesis</span>
          <span className="text-[11px] text-slate-500 ml-1">· {weekStart} – {today}</span>
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-slate-400">
            Reviews all notes from the past 7 days and surfaces emerging themes, conviction changes, cross-stock patterns, and the sharpest insight of the week.
          </p>
          <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06] space-y-1.5">
            <div className="text-[11px] text-slate-500 font-medium uppercase tracking-wider">Output</div>
            {[
              'Emerging themes across your research',
              'Conviction changes (stronger / weaker)',
              'Cross-stock & macro patterns',
              'Sharpest insight of the week',
              'Open questions & next week watchlist',
            ].map(item => (
              <div key={item} className="flex items-center gap-2 text-xs text-slate-300">
                <span className="w-1 h-1 rounded-full bg-rose-400 shrink-0" /> {item}
              </div>
            ))}
          </div>
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
            <button onClick={generate} disabled={generating}
              className="btn-primary flex items-center gap-1.5 text-xs py-1.5 disabled:opacity-50">
              {generating ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Synthesizing…</> : <><Calendar className="w-3.5 h-3.5" /> Generate</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
