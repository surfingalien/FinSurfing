import { useState, useEffect } from 'react'
import { RefreshCw, X, Sparkles, Save } from 'lucide-react'
import { useAuth } from '../../../contexts/AuthContext'

// ── Goal Aligner modal ─────────────────────────────────────────────────────────
export function GoalAlignerModal({ goals, onClose, onSave }) {
  const { authFetch } = useAuth()
  const [running,  setRunning]  = useState(false)
  const [result,   setResult]   = useState(null)
  const [error,    setError]    = useState(null)

  const run = async () => {
    setRunning(true); setError(null)
    try {
      const res  = await authFetch('/api/research-notes/goal-align', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ goals }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResult(data)
    } catch (e) { setError(e.message) }
    setRunning(false)
  }

  useEffect(() => { run() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const scoreColor = result
    ? result.score >= 75 ? 'text-emerald-400' : result.score >= 50 ? 'text-amber-400' : 'text-red-400'
    : 'text-slate-400'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-xl border border-violet-500/25 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <Sparkles className="w-4 h-4 text-violet-400" />
          <span className="text-sm font-semibold text-white">Goal Aligner</span>
          {result && <span className={`ml-2 text-sm font-bold ${scoreColor}`}>{result.score}/100</span>}
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3 max-h-[65vh] overflow-y-auto">
          {running && (
            <div className="flex items-center justify-center py-8 gap-2">
              <RefreshCw className="w-4 h-4 text-violet-400 animate-spin" />
              <span className="text-xs text-slate-400">Auditing last 7 days against your goals…</span>
            </div>
          )}
          {error && (
            <div className="p-3 rounded-xl bg-red-500/10 border border-red-500/20 text-xs text-red-400">
              {error}
            </div>
          )}

          {result && (
            <>
              {result.recommendation && (
                <div className="p-3 rounded-xl bg-violet-500/8 border border-violet-500/20">
                  <div className="text-[10px] font-semibold text-violet-400 uppercase tracking-wider mb-1">This Week's Recommendation</div>
                  <p className="text-xs text-slate-200">{result.recommendation}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-2">
                {(result.aligned || []).length > 0 && (
                  <div className="p-2.5 rounded-lg bg-emerald-500/8 border border-emerald-500/20">
                    <div className="text-[9px] font-semibold text-emerald-400 uppercase tracking-wider mb-1.5">Aligned ✓</div>
                    <ul className="space-y-1">
                      {result.aligned.map((a, i) => <li key={i} className="text-[11px] text-slate-300">{a}</li>)}
                    </ul>
                  </div>
                )}
                {(result.misaligned || []).length > 0 && (
                  <div className="p-2.5 rounded-lg bg-amber-500/8 border border-amber-500/20">
                    <div className="text-[9px] font-semibold text-amber-400 uppercase tracking-wider mb-1.5">Gaps ⚠</div>
                    <ul className="space-y-1">
                      {result.misaligned.map((m, i) => <li key={i} className="text-[11px] text-slate-300">{m}</li>)}
                    </ul>
                  </div>
                )}
              </div>
              {result.note && (
                <div className="bg-white/[0.02] rounded-xl p-3 border border-white/[0.06] max-h-48 overflow-y-auto">
                  <pre className="text-[11px] text-slate-400 whitespace-pre-wrap font-mono leading-relaxed">{result.note.content}</pre>
                </div>
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={run} disabled={running} className="btn-ghost flex items-center gap-1.5 text-xs py-1.5">
              <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} /> Re-run
            </button>
            {result?.note && (
              <button onClick={() => { onSave(result.note); onClose() }}
                className="btn-primary flex items-center gap-1.5 text-xs py-1.5">
                <Save className="w-3.5 h-3.5" /> Save to Second Brain
              </button>
            )}
            <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Close</button>
          </div>
        </div>
      </div>
    </div>
  )
}
