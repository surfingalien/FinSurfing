import { useState } from 'react'
import { Compass, RefreshCw, Save, X } from 'lucide-react'
import { useAuth }   from '../../../contexts/AuthContext'
import { TypeBadge } from './noteHelpers'

// ── Think modal (10-principle framework) ─────────────────────────────────────
export default function ThinkModal({ symbol, contextNotes, onClose, onSave }) {
  const { authFetch }  = useAuth()
  const [problem,    setProblem]    = useState('')
  const [processing, setProcessing] = useState(false)
  const [result,     setResult]     = useState(null)
  const [error,      setError]      = useState(null)

  const run = async () => {
    if (!problem.trim()) return
    setProcessing(true); setError(null)
    try {
      const res  = await authFetch('/api/research-notes/think', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ problem, symbol, contextNotes }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResult(data)
    } catch (e) { setError(e.message) }
    setProcessing(false)
  }

  const SIGNAL_COLOR = { BUY: 'text-emerald-400', SELL: 'text-red-400', HOLD: 'text-amber-400', WAIT: 'text-blue-400', INVESTIGATE: 'text-violet-400' }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-2xl border border-violet-500/25 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <Compass className="w-4 h-4 text-violet-400" />
          <span className="text-sm font-semibold text-white">Think Framework</span>
          {symbol && <span className="text-[11px] font-mono text-mint-400 ml-1">· {symbol}</span>}
          <span className="text-[10px] text-slate-500 ml-2">10-principle investment analysis</span>
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          {!result ? (
            <>
              <p className="text-xs text-slate-500">Describe the investment decision or problem. Claude will apply 10 thinking frameworks: first principles, inversion, second-order effects, base rates, pre-mortem, Bayesian update, and more.</p>
              <textarea
                value={problem} onChange={e => setProblem(e.target.value)} autoFocus
                placeholder={symbol ? `Should I buy ${symbol} at current levels? Consider that...` : 'What investment decision are you trying to make?'}
                className="input h-32 resize-none text-xs font-mono"
              />
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
                <button onClick={run} disabled={!problem.trim() || processing}
                  className="btn-primary flex items-center gap-1.5 text-xs py-1.5 disabled:opacity-50">
                  {processing ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Thinking…</> : <><Compass className="w-3.5 h-3.5" /> Apply Framework</>}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-3">
                <span className={`text-xs font-bold px-2 py-1 rounded border ${SIGNAL_COLOR[result.recommendation] || 'text-slate-400'} bg-white/[0.04] border-white/[0.1]`}>
                  {result.recommendation}
                </span>
                <span className="text-[11px] text-slate-400">Confidence: <span className="text-white font-medium">{result.confidence}%</span></span>
                <TypeBadge type="think" />
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2.5 rounded-lg bg-red-500/8 border border-red-500/20">
                  <div className="text-[10px] font-semibold text-red-400 mb-1">Top Risk</div>
                  <p className="text-[11px] text-slate-300">{result.top_risk}</p>
                </div>
                <div className="p-2.5 rounded-lg bg-violet-500/8 border border-violet-500/20">
                  <div className="text-[10px] font-semibold text-violet-400 mb-1">Key Question</div>
                  <p className="text-[11px] text-slate-300">{result.key_question}</p>
                </div>
              </div>
              <div className="bg-white/[0.03] rounded-xl p-3 border border-white/[0.07] max-h-64 overflow-y-auto">
                <div className="text-xs font-semibold text-white mb-2">{result.title}</div>
                <pre className="text-[11px] text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">{result.content}</pre>
              </div>
              <div className="flex justify-between items-center">
                <button onClick={() => setResult(null)} className="text-xs text-slate-500 hover:text-white">← Edit problem</button>
                <div className="flex gap-2">
                  <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Discard</button>
                  <button onClick={() => { onSave({ title: result.title, content: result.content, tags: result.tags || [], note_type: 'think', symbol }); onClose() }}
                    className="btn-primary flex items-center gap-1.5 text-xs py-1.5">
                    <Save className="w-3.5 h-3.5" /> Save Analysis
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
