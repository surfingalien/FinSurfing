import { useState, useEffect } from 'react'
import {
  ShieldCheck, RefreshCw, X, AlertTriangle, CheckCircle2, XCircle, Info,
} from 'lucide-react'
import { useAuth } from '../../../contexts/AuthContext'

// ── Vault Lint modal (health check) ──────────────────────────────────────────
export default function LintModal({ portfolio, onClose, onSelectNote }) {
  const { authFetch } = useAuth()
  const [running,  setRunning]  = useState(false)
  const [result,   setResult]   = useState(null)
  const [error,    setError]    = useState(null)

  const portfolioSymbols = portfolio?.positions?.map(p => p.symbol).filter(Boolean) || []

  const runLint = async () => {
    setRunning(true); setError(null)
    try {
      const res  = await authFetch('/api/research-notes/lint', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ portfolioSymbols }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      setResult(data)
    } catch (e) { setError(e.message) }
    setRunning(false)
  }

  useEffect(() => { runLint() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const SEVERITY_CONFIG = {
    error:   { color: 'text-red-400',   bg: 'bg-red-500/8',   border: 'border-red-500/20',   Icon: XCircle },
    warning: { color: 'text-amber-400', bg: 'bg-amber-500/8', border: 'border-amber-500/20', Icon: AlertTriangle },
    info:    { color: 'text-blue-400',  bg: 'bg-blue-500/8',  border: 'border-blue-500/20',  Icon: Info },
  }

  const scoreColor = result ? (result.score >= 80 ? 'text-emerald-400' : result.score >= 50 ? 'text-amber-400' : 'text-red-400') : 'text-slate-400'

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-xl border border-teal-500/25 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <ShieldCheck className="w-4 h-4 text-teal-400" />
          <span className="text-sm font-semibold text-white">Vault Health Check</span>
          {result && (
            <span className={`ml-2 text-sm font-bold ${scoreColor}`}>{result.score}/100</span>
          )}
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3 max-h-[65vh] overflow-y-auto">
          {running && (
            <div className="flex items-center justify-center py-8 gap-2">
              <RefreshCw className="w-4 h-4 text-teal-400 animate-spin" />
              <span className="text-xs text-slate-400">Auditing vault…</span>
            </div>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}

          {result && (
            <>
              <div className="flex items-center gap-4 p-3 rounded-xl bg-white/[0.03] border border-white/[0.07]">
                <div className="text-center">
                  <div className={`text-2xl font-bold ${scoreColor}`}>{result.score}</div>
                  <div className="text-[10px] text-slate-500">Score</div>
                </div>
                <div className="flex-1 grid grid-cols-3 gap-2 text-center text-[11px]">
                  <div><span className="text-red-400 font-bold">{result.issues.filter(i=>i.severity==='error').length}</span><div className="text-slate-600">Critical</div></div>
                  <div><span className="text-amber-400 font-bold">{result.issues.filter(i=>i.severity==='warning').length}</span><div className="text-slate-600">Warnings</div></div>
                  <div><span className="text-blue-400 font-bold">{result.issues.filter(i=>i.severity==='info').length}</span><div className="text-slate-600">Info</div></div>
                </div>
                <div className="text-[11px] text-slate-500 text-right">
                  <div>{result.noteCount} notes</div>
                  <div>{result.coveredSymbols?.length || 0} symbols</div>
                </div>
              </div>

              {result.issues.length === 0 ? (
                <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-500/8 border border-emerald-500/20">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="text-xs text-emerald-300">Vault is healthy — no issues found!</span>
                </div>
              ) : (
                <div className="space-y-1.5">
                  {['error', 'warning', 'info'].map(sev =>
                    result.issues.filter(i => i.severity === sev).map((issue, idx) => {
                      const { color, bg, border, Icon } = SEVERITY_CONFIG[sev]
                      return (
                        <div key={`${sev}-${idx}`} className={`flex items-start gap-2 p-2.5 rounded-lg ${bg} ${border} border`}>
                          <Icon className={`w-3.5 h-3.5 ${color} shrink-0 mt-0.5`} />
                          <div className="flex-1 min-w-0">
                            <span className={`text-[11px] font-semibold ${color} mr-1.5`}>{issue.title}</span>
                            <span className="text-[11px] text-slate-400">{issue.message}</span>
                          </div>
                          {issue.noteId && (
                            <button onClick={() => { onSelectNote(issue.noteId); onClose() }}
                              className={`text-[10px] ${color} hover:opacity-80 shrink-0 border border-current/30 rounded px-1.5 py-0.5`}>
                              Open
                            </button>
                          )}
                        </div>
                      )
                    })
                  )}
                </div>
              )}
            </>
          )}

          <div className="flex justify-end gap-2 pt-1">
            <button onClick={runLint} disabled={running} className="btn-ghost flex items-center gap-1.5 text-xs py-1.5">
              <RefreshCw className={`w-3.5 h-3.5 ${running ? 'animate-spin' : ''}`} /> Re-run
            </button>
            <button onClick={onClose} className="btn-primary text-xs py-1.5 px-4">Done</button>
          </div>
        </div>
      </div>
    </div>
  )
}
