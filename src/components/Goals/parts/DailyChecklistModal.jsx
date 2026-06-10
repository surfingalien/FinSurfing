import { useState } from 'react'
import { RefreshCw, X, Sun } from 'lucide-react'
import { useAuth } from '../../../contexts/AuthContext'
import { useApiKeys } from '../../../contexts/ApiKeysContext'

// ── Daily Checklist modal ──────────────────────────────────────────────────────
export function DailyChecklistModal({ goals, portfolio, onClose, onSave }) {
  const { authFetch }  = useAuth()
  const { getHeaders } = useApiKeys()
  const [generating, setGenerating] = useState(false)
  const [error,      setError]      = useState(null)

  const portfolioSymbols = portfolio?.positions?.map(p => p.symbol).filter(Boolean) || []

  const generate = async () => {
    setGenerating(true); setError(null)
    try {
      const res  = await authFetch('/api/research-notes/daily-checklist', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...getHeaders() },
        body:    JSON.stringify({ portfolioSymbols, goals, portfolioValue: portfolio?.totalValue }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
      onSave(data)
      onClose()
    } catch (e) { setError(e.message) }
    setGenerating(false)
  }

  const today = new Date().toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-md border border-amber-500/25 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <Sun className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-semibold text-white">Daily Checklist</span>
          <span className="text-[11px] text-slate-500 ml-1">· {today}</span>
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          <p className="text-xs text-slate-400">
            Generates a pre-market + evening checklist tailored to your portfolio holdings and stated goals.
          </p>
          <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06] space-y-1.5">
            {[
              'Morning focus tasks tied to goals',
              'Portfolio review items for each holding',
              'Research queue based on open questions',
              'Risk check for current positions',
              'Evening reflection prompts',
            ].map(item => (
              <div key={item} className="flex items-center gap-2 text-xs text-slate-300">
                <span className="w-1 h-1 rounded-full bg-amber-400 shrink-0" /> {item}
              </div>
            ))}
          </div>
          {portfolioSymbols.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {portfolioSymbols.slice(0, 8).map(s => (
                <span key={s} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-mint-500/10 text-mint-400 border border-mint-500/20">{s}</span>
              ))}
            </div>
          )}
          {error && <p className="text-xs text-red-400">{error}</p>}
          <div className="flex justify-end gap-2">
            <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
            <button onClick={generate} disabled={generating}
              className="btn-primary flex items-center gap-1.5 text-xs py-1.5 disabled:opacity-50">
              {generating ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Generating…</> : <><Sun className="w-3.5 h-3.5" /> Generate</>}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
