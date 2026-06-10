import { useState, useEffect } from 'react'
import {
  RefreshCw, Save, X, Layers, AlertTriangle, Zap, ExternalLink,
} from 'lucide-react'
import { useAuth }    from '../../../contexts/AuthContext'
import { useApiKeys } from '../../../contexts/ApiKeysContext'
import { TypeBadge }  from './noteHelpers'

// ── Auto-Research result modal ────────────────────────────────────────────────
export default function AutoResearchModal({ symbol, deep = false, onClose, onApply }) {
  const { authFetch }  = useAuth()
  const { getHeaders } = useApiKeys()
  const [loading,   setLoading]  = useState(true)
  const [result,    setResult]   = useState(null)
  const [error,     setError]    = useState(null)
  const [progress,  setProgress] = useState(deep ? 'Round 1 — gathering data…' : null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      try {
        if (deep) {
          setProgress('Round 1 — gathering market data…')
          const res  = await authFetch('/api/research-notes/deep-research', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getHeaders() },
            body: JSON.stringify({ symbol }),
          })
          const data = await res.json()
          if (cancelled) return
          if (!res.ok) throw new Error(data.error)
          setResult(data.note)
          setProgress(null)
        } else {
          const res  = await authFetch('/api/research-notes/auto-research', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...getHeaders() },
            body: JSON.stringify({ symbol, save: false }),
          })
          const data = await res.json()
          if (cancelled) return
          if (!res.ok) throw new Error(data.error)
          setResult(data.note)
        }
      } catch (e) { if (!cancelled) setError(e.message) }
      if (!cancelled) setLoading(false)
    }
    run()
    return () => { cancelled = true }
  }, [symbol, deep, authFetch, getHeaders])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-2xl border border-mint-500/25 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          {deep ? <Layers className="w-4 h-4 text-mint-400" /> : <Zap className="w-4 h-4 text-mint-400" />}
          <span className="text-sm font-semibold text-white">{deep ? 'Deep Research' : 'Auto-Research'}</span>
          <span className="text-[11px] font-mono text-mint-400 ml-1">· {symbol}</span>
          {deep && <span className="text-[10px] text-slate-500 bg-white/[0.04] border border-white/[0.07] rounded px-1.5 py-0.5">3 rounds</span>}
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          {loading && (
            <div className="flex items-center justify-center py-12 gap-3 flex-col">
              <RefreshCw className="w-5 h-5 text-mint-400 animate-spin" />
              <span className="text-sm text-slate-400">{progress || 'Fetching market data & generating research…'}</span>
              {deep && (
                <div className="flex gap-2 text-[10px] text-slate-600">
                  <span className="px-2 py-0.5 rounded bg-white/[0.03] border border-white/[0.06]">Round 1: Data</span>
                  <span className="px-2 py-0.5 rounded bg-white/[0.03] border border-white/[0.06]">Round 2: Analysis</span>
                  <span className="px-2 py-0.5 rounded bg-white/[0.03] border border-white/[0.06]">Round 3: Synthesis</span>
                </div>
              )}
            </div>
          )}
          {error && (
            <>
              <p className="text-xs text-red-400 flex items-center gap-1.5"><AlertTriangle className="w-3.5 h-3.5" />{error}</p>
              <div className="flex justify-end"><button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Close</button></div>
            </>
          )}
          {result && (
            <>
              <div className="flex items-center gap-2"><Zap className="w-3.5 h-3.5 text-mint-400" /><span className="text-xs font-semibold text-mint-400">Research generated</span><TypeBadge type="thesis" /></div>
              <div className="bg-white/[0.03] rounded-xl p-3 border border-white/[0.07]">
                <div className="text-xs font-semibold text-white mb-2">{result.title}</div>
                <pre className="text-[11px] text-slate-300 whitespace-pre-wrap font-mono leading-relaxed max-h-72 overflow-y-auto">{result.content}</pre>
              </div>
              <div className="flex justify-between items-center">
                <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Discard</button>
                <div className="flex gap-2">
                  <button onClick={() => onApply(result.content)} className="btn-ghost text-xs py-1.5 px-3 flex items-center gap-1">
                    <ExternalLink className="w-3 h-3" /> Apply to current note
                  </button>
                  <button onClick={() => { onApply(result.content, true); onClose() }}
                    className="btn-primary flex items-center gap-1.5 text-xs py-1.5">
                    <Save className="w-3.5 h-3.5" /> Save as new note
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
