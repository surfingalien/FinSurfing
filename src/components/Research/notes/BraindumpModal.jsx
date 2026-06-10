import { useState } from 'react'
import {
  Brain, Sparkles, RefreshCw, Save, X, Layers, AlertTriangle,
} from 'lucide-react'
import { useAuth } from '../../../contexts/AuthContext'

// ── Braindump modal ───────────────────────────────────────────────────────────
export default function BraindumpModal({ symbol, onClose, onSave }) {
  const { authFetch } = useAuth()
  const [raw,        setRaw]        = useState('')
  const [processing, setProcessing] = useState(false)
  const [result,     setResult]     = useState(null)
  const [error,      setError]      = useState(null)
  const [tab,        setTab]        = useState('thesis') // 'thesis' | 'devil' | 'assumptions'

  const structureThoughts = async () => {
    if (!raw.trim()) return
    setProcessing(true); setError(null)
    try {
      const res  = await authFetch('/api/research-notes/braindump', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw, symbol }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResult(data)
      setTab('thesis')
    } catch (e) { setError(e.message) }
    setProcessing(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-2xl border border-indigo-500/25 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <Brain className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-semibold text-white">Braindump → Structured Thesis</span>
          {symbol && <span className="text-[11px] font-mono text-mint-400 ml-1">· {symbol}</span>}
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          {!result ? (
            <>
              <p className="text-xs text-slate-500">Dump your raw thoughts — AI will structure them, surface counterarguments, and extract falsifiable assumptions.</p>
              <textarea
                value={raw} onChange={e => setRaw(e.target.value)} autoFocus
                placeholder="NVDA is crazy expensive but the data center demand is real. AI capex still accelerating..."
                className="input h-40 resize-none font-mono text-xs"
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
                <button onClick={structureThoughts} disabled={!raw.trim() || processing}
                  className="btn-primary flex items-center gap-1.5 text-xs py-1.5 disabled:opacity-50">
                  {processing ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Structuring…</> : <><Sparkles className="w-3.5 h-3.5" /> Structure + Pressure-Test</>}
                </button>
              </div>
            </>
          ) : (
            <>
              {/* Tabs */}
              <div className="flex gap-1 p-1 rounded-lg bg-white/[0.04] border border-white/[0.06]">
                {[
                  { id: 'thesis',      label: 'Structured Thesis', icon: Sparkles },
                  { id: 'devil',       label: 'Devil\'s Advocate',  icon: AlertTriangle },
                  { id: 'assumptions', label: 'Assumptions',        icon: Layers },
                ].map(t => {
                  const Icon = t.icon
                  return (
                    <button
                      key={t.id}
                      onClick={() => setTab(t.id)}
                      className={`flex-1 flex items-center justify-center gap-1.5 px-2 py-1.5 rounded-md text-[11px] font-medium transition-all ${
                        tab === t.id
                          ? t.id === 'devil'
                            ? 'bg-amber-500/20 text-amber-400'
                            : t.id === 'assumptions'
                              ? 'bg-indigo-500/20 text-indigo-400'
                              : 'bg-mint-500/15 text-mint-400'
                          : 'text-slate-500 hover:text-slate-300'
                      }`}
                    >
                      <Icon className="w-3 h-3" /> {t.label}
                    </button>
                  )
                })}
              </div>

              {tab === 'thesis' && (
                <div className="bg-white/[0.03] rounded-xl p-3 border border-white/[0.07]">
                  <div className="text-xs font-semibold text-white mb-2">{result.title}</div>
                  <pre className="text-[11px] text-slate-300 whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-y-auto">{result.content}</pre>
                </div>
              )}

              {tab === 'devil' && (
                <div className="bg-amber-500/8 rounded-xl p-3 border border-amber-500/20 space-y-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-amber-400 mb-1">
                    <AlertTriangle className="w-3 h-3" /> Devil's Advocate — reasons this thesis could be wrong
                  </div>
                  {result.counterarguments?.length > 0 ? (
                    <ul className="space-y-2">
                      {result.counterarguments.map((c, i) => (
                        <li key={i} className="flex items-start gap-2 text-[11px] text-slate-300">
                          <span className="text-amber-500 shrink-0 mt-0.5 font-mono">{i + 1}.</span>
                          <span>{c}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[11px] text-slate-500">No counterarguments extracted — the backend may need updating to return this field.</p>
                  )}
                </div>
              )}

              {tab === 'assumptions' && (
                <div className="bg-indigo-500/8 rounded-xl p-3 border border-indigo-500/20 space-y-2">
                  <div className="flex items-center gap-1.5 text-[11px] font-semibold text-indigo-400 mb-1">
                    <Layers className="w-3 h-3" /> Falsifiable Assumptions — thesis breaks if these fail
                  </div>
                  {result.assumptions?.length > 0 ? (
                    <ul className="space-y-2">
                      {result.assumptions.map((a, i) => (
                        <li key={i} className="flex items-start gap-2 text-[11px] text-slate-300">
                          <span className="text-indigo-400 shrink-0 mt-0.5 font-mono">{i + 1}.</span>
                          <span>{a}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="text-[11px] text-slate-500">No assumptions extracted — the backend may need updating to return this field.</p>
                  )}
                </div>
              )}

              <div className="flex justify-between items-center">
                <button onClick={() => setResult(null)} className="text-xs text-slate-500 hover:text-white">← Edit raw</button>
                <div className="flex gap-2">
                  <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Discard</button>
                  <button onClick={() => { onSave({ title: result.title, content: result.content, tags: result.tags || [], note_type: result.note_type || 'braindump', symbol, assumptions: result.assumptions, counterarguments: result.counterarguments }); onClose() }}
                    className="btn-primary flex items-center gap-1.5 text-xs py-1.5">
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
