import { useState, useEffect } from 'react'
import {
  MessageSquare, RefreshCw, X, ChevronDown, ChevronUp,
} from 'lucide-react'
import { useAuth } from '../../../contexts/AuthContext'

// ── Thinking Partner modal (Socratic dialogue) ────────────────────────────────
export default function ThinkingPartnerModal({ symbol, thesis, onClose }) {
  const { authFetch } = useAuth()
  const [questions,       setQuestions]       = useState([])
  const [answers,         setAnswers]         = useState([])
  const [synthesis,       setSynthesis]       = useState(null)
  const [loading,         setLoading]         = useState(false)
  const [error,           setError]           = useState(null)
  const [round,           setRound]           = useState(0)
  const [expandedQ,       setExpandedQ]       = useState(null)

  const fetchQuestions = async (prevQs = [], prevAs = []) => {
    setLoading(true); setError(null)
    try {
      const res  = await authFetch('/api/research-notes/thinking-partner', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ thesis, symbol, previousQuestions: prevQs, previousAnswers: prevAs }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setQuestions(data.questions || [])
      setSynthesis({ text: data.synthesis, strongest: data.strongest_point, blind_spot: data.blind_spot })
      setAnswers(new Array(data.questions?.length || 0).fill(''))
      setExpandedQ(0)
    } catch (e) { setError(e.message) }
    setLoading(false)
  }

  useEffect(() => { fetchQuestions() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const deeperDive = async () => {
    setRound(r => r + 1)
    await fetchQuestions(questions, answers)
  }

  if (!thesis?.trim()) return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-lg border border-emerald-500/25 shadow-2xl p-6 text-center">
        <MessageSquare className="w-8 h-8 text-emerald-400 mx-auto mb-3" />
        <p className="text-sm text-slate-300">Open a note with content first — the Thinking Partner needs a thesis to probe.</p>
        <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-4 mt-4">Close</button>
      </div>
    </div>
  )

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-2xl border border-emerald-500/25 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <MessageSquare className="w-4 h-4 text-emerald-400" />
          <span className="text-sm font-semibold text-white">Thinking Partner</span>
          {symbol && <span className="text-[11px] font-mono text-mint-400 ml-1">· {symbol}</span>}
          {round > 0 && <span className="text-[10px] text-slate-500">Round {round + 1}</span>}
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3 max-h-[75vh] overflow-y-auto">
          {loading && (
            <div className="flex items-center justify-center py-8 gap-2">
              <RefreshCw className="w-4 h-4 text-emerald-400 animate-spin" />
              <span className="text-xs text-slate-400">Generating probing questions…</span>
            </div>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}

          {!loading && synthesis && (
            <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.07] space-y-2">
              <p className="text-[11px] text-slate-300 leading-relaxed">{synthesis.text}</p>
              <div className="grid grid-cols-2 gap-2">
                <div className="p-2 rounded-lg bg-emerald-500/8 border border-emerald-500/20">
                  <div className="text-[9px] font-semibold text-emerald-400 uppercase tracking-wider mb-1">Strongest Point</div>
                  <p className="text-[11px] text-slate-300">{synthesis.strongest}</p>
                </div>
                <div className="p-2 rounded-lg bg-amber-500/8 border border-amber-500/20">
                  <div className="text-[9px] font-semibold text-amber-400 uppercase tracking-wider mb-1">Blind Spot</div>
                  <p className="text-[11px] text-slate-300">{synthesis.blind_spot}</p>
                </div>
              </div>
            </div>
          )}

          {!loading && questions.map((q, i) => (
            <div key={i} className="rounded-xl border border-white/[0.07] overflow-hidden">
              <button
                onClick={() => setExpandedQ(expandedQ === i ? null : i)}
                className="w-full flex items-start gap-2.5 p-3 text-left hover:bg-white/[0.02] transition-colors"
              >
                <span className="text-xs font-mono text-emerald-400 shrink-0 mt-0.5">Q{i+1}</span>
                <span className="text-xs text-slate-200 leading-snug flex-1">{q}</span>
                {expandedQ === i ? <ChevronUp className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" /> : <ChevronDown className="w-3.5 h-3.5 text-slate-500 shrink-0 mt-0.5" />}
              </button>
              {expandedQ === i && (
                <div className="px-3 pb-3">
                  <textarea
                    value={answers[i] || ''}
                    onChange={e => setAnswers(prev => { const a = [...prev]; a[i] = e.target.value; return a })}
                    placeholder="Your answer…"
                    className="input w-full h-20 resize-none text-xs"
                  />
                </div>
              )}
            </div>
          ))}

          {!loading && questions.length > 0 && (
            <div className="flex justify-between items-center pt-1">
              <span className="text-[11px] text-slate-600">Answer questions to go deeper</span>
              <div className="flex gap-2">
                <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Done</button>
                <button onClick={deeperDive} disabled={answers.every(a => !a?.trim())}
                  className="btn-primary flex items-center gap-1.5 text-xs py-1.5 disabled:opacity-50">
                  <MessageSquare className="w-3.5 h-3.5" /> Go Deeper
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
