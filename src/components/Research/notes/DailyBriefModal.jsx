import { useState } from 'react'
import {
  BookOpen, Sun, RefreshCw, X, AlertTriangle, Zap, CheckCircle2,
} from 'lucide-react'
import { useAuth }    from '../../../contexts/AuthContext'
import { useApiKeys } from '../../../contexts/ApiKeysContext'

const IMPACT_CONFIG = {
  HIGH:   { color: 'text-red-400',   bg: 'bg-red-500/10',   border: 'border-red-500/25'   },
  MEDIUM: { color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/25' },
  LOW:    { color: 'text-blue-400',  bg: 'bg-blue-500/10',  border: 'border-blue-500/25'  },
}

// ── Daily Brief modal ─────────────────────────────────────────────────────────
export default function DailyBriefModal({ portfolio, notes, onClose, onSave }) {
  const { authFetch }  = useAuth()
  const { getHeaders } = useApiKeys()
  const [generating, setGenerating] = useState(false)
  const [error,      setError]      = useState(null)
  const [stage,      setStage]      = useState('config') // 'config' | 'results'
  const [generatedNote, setGeneratedNote] = useState(null)
  const [topNews,    setTopNews]    = useState([])

  // Check if today's brief already exists
  const todayStr   = new Date().toISOString().slice(0, 10)
  const existing   = notes.find(n => n.tags?.includes('daily-brief') && n.title?.includes(todayStr))

  const portfolioSymbols = portfolio?.positions?.map(p => p.symbol).filter(Boolean) || []

  const generate = async () => {
    if (portfolioSymbols.length === 0) {
      setError('No portfolio holdings found. Add stocks to your portfolio first.')
      return
    }
    setGenerating(true); setError(null)
    try {
      const params = new URLSearchParams({
        symbols:        portfolioSymbols.join(','),
        portfolioValue: portfolio?.totalValue || '0',
      })
      const res  = await authFetch(`/api/research-notes/daily-brief?${params}`, {
        headers: getHeaders(),
      })
      let data
      try { data = await res.json() } catch { throw new Error('Server returned an invalid response — please try again.') }
      if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`)
      const news = data._topNews || []
      setGeneratedNote(data)
      setTopNews(news)
      onSave(data, news)   // register note immediately so list updates
      setStage('results')
    } catch (e) { setError(e.message) }
    setGenerating(false)
  }

  const highCount   = topNews.filter(n => n.impact === 'HIGH').length
  const mediumCount = topNews.filter(n => n.impact === 'MEDIUM').length

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-lg border border-amber-500/25 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <Sun className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-semibold text-white">Morning Brief</span>
          <span className="text-[11px] text-slate-500 ml-1">· {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
          {stage === 'results' && highCount > 0 && (
            <span className="text-[10px] font-bold text-red-400 bg-red-500/15 border border-red-500/25 rounded px-1.5 py-0.5 ml-1">
              {highCount} HIGH impact
            </span>
          )}
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">

          {/* Stage: existing brief */}
          {stage === 'config' && existing ? (
            <>
              <div className="flex items-center gap-2 p-3 rounded-xl bg-amber-500/10 border border-amber-500/20">
                <Sun className="w-4 h-4 text-amber-400 shrink-0" />
                <div>
                  <p className="text-xs font-semibold text-amber-400">Today's brief is ready</p>
                  <p className="text-[11px] text-slate-400 mt-0.5">{existing.title}</p>
                </div>
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Close</button>
                <button onClick={() => { onSave(existing); onClose() }} className="btn-primary flex items-center gap-1.5 text-xs py-1.5">
                  <BookOpen className="w-3.5 h-3.5" /> Open Brief
                </button>
              </div>
            </>
          ) : stage === 'config' ? (
            /* Stage: config — generate */
            <>
              <div className="space-y-2">
                <p className="text-xs text-slate-400">
                  Generates a live market intelligence brief with Top 10 Portfolio Impact News using your holdings, Finnhub data, and Claude AI.
                </p>
                <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06] space-y-1.5">
                  <div className="text-[11px] text-slate-500 font-medium uppercase tracking-wider">Includes</div>
                  {[
                    'Morning routine checklist',
                    'Top 10 news ranked by portfolio impact (HIGH/MEDIUM/LOW)',
                    'Portfolio pulse — live prices + day change',
                    'Key catalysts & news for each holding',
                    '3–6 month thesis + opportunities to watch',
                  ].map(item => (
                    <div key={item} className="flex items-center gap-2 text-xs text-slate-300">
                      <span className="w-1 h-1 rounded-full bg-amber-400 shrink-0" /> {item}
                    </div>
                  ))}
                </div>
                {portfolioSymbols.length > 0 && (
                  <div className="flex flex-wrap gap-1">
                    {portfolioSymbols.slice(0, 10).map(s => (
                      <span key={s} className="text-[10px] font-mono px-1.5 py-0.5 rounded bg-mint-500/10 text-mint-400 border border-mint-500/20">{s}</span>
                    ))}
                    {portfolioSymbols.length > 10 && <span className="text-[10px] text-slate-500">+{portfolioSymbols.length - 10} more</span>}
                  </div>
                )}
                {portfolioSymbols.length === 0 && (
                  <p className="text-xs text-amber-500 flex items-center gap-1"><AlertTriangle className="w-3 h-3" /> No portfolio holdings found</p>
                )}
                {error && <p className="text-xs text-red-400">{error}</p>}
              </div>
              <div className="flex justify-end gap-2">
                <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
                <button onClick={generate} disabled={generating || portfolioSymbols.length === 0}
                  className="btn-primary flex items-center gap-1.5 text-xs py-1.5 disabled:opacity-50">
                  {generating ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Generating…</> : <><Sun className="w-3.5 h-3.5" /> Generate Brief</>}
                </button>
              </div>
            </>
          ) : (
            /* Stage: results — show top news */
            <>
              {topNews.length > 0 ? (
                <>
                  <div className="flex items-center gap-2">
                    <Zap className="w-3.5 h-3.5 text-amber-400" />
                    <span className="text-xs font-semibold text-white">Top Portfolio Impact News</span>
                    <div className="flex gap-1 ml-auto">
                      {highCount > 0 && <span className="text-[10px] font-bold text-red-400 bg-red-500/10 border border-red-500/20 rounded px-1.5 py-0.5">{highCount} HIGH</span>}
                      {mediumCount > 0 && <span className="text-[10px] font-bold text-amber-400 bg-amber-500/10 border border-amber-500/20 rounded px-1.5 py-0.5">{mediumCount} MEDIUM</span>}
                    </div>
                  </div>
                  <div className="space-y-1.5 max-h-64 overflow-y-auto">
                    {topNews.map((item, i) => {
                      const cfg = IMPACT_CONFIG[item.impact] || IMPACT_CONFIG.LOW
                      return (
                        <div key={i} className={`flex items-start gap-2 p-2.5 rounded-lg ${cfg.bg} ${cfg.border} border`}>
                          <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${cfg.bg} ${cfg.color} border ${cfg.border} shrink-0 mt-0.5`}>
                            {item.impact}
                          </span>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              <span className="text-[10px] font-bold font-mono text-white shrink-0">{item.symbol}</span>
                              <span className="text-[11px] text-slate-200 leading-snug truncate">{item.headline}</span>
                            </div>
                            <p className="text-[10px] text-slate-500 leading-snug">{item.reason}</p>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-2 p-3 rounded-xl bg-emerald-500/8 border border-emerald-500/20">
                  <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
                  <span className="text-xs text-emerald-300">Brief generated — no high-impact news for your portfolio today.</span>
                </div>
              )}
              <div className="flex justify-end gap-2">
                <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Close</button>
                <button onClick={onClose} className="btn-primary flex items-center gap-1.5 text-xs py-1.5">
                  <BookOpen className="w-3.5 h-3.5" /> View Full Brief
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
