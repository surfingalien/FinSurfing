/**
 * ResearchNotesView — Self-maturing Second Brain for investment research.
 *
 * Layers:
 *   1. Auto-ingest: Braindump, Auto-Research (Finnhub→Claude), URL Scout
 *   2. Knowledge consolidation: merge notes → master thesis
 *   3. Daily brief: morning portfolio intelligence + opportunity watchlist
 *   4. Feedback loops: stale thesis detection (>30 days)
 */

import { useState, useEffect, useCallback, useRef } from 'react'
import {
  BookOpen, Plus, Trash2, Brain, Sparkles, Tag, Search,
  FileText, Lightbulb, Link, RefreshCw, Globe, Save, X,
  Map, Sun, Layers, AlertTriangle, Zap, ExternalLink, Lock,
  Compass, GitMerge, MessageSquare, ShieldCheck, Calendar,
  CheckCircle2, XCircle, Info, ChevronDown, ChevronUp,
} from 'lucide-react'
import { Transformer } from 'markmap-lib'
import { Markmap }      from 'markmap-view'
import { useAuth }      from '../../contexts/AuthContext'
import { useApiKeys }   from '../../contexts/ApiKeysContext'

const transformer = new Transformer()

const STALE_DAYS = 30

// ── helpers ──────────────────────────────────────────────────────────────────

const TYPE_CONFIG = {
  note:      { label: 'Note',      icon: FileText,  color: 'text-slate-400',  bg: 'bg-slate-500/15',  border: 'border-slate-500/25'  },
  thesis:    { label: 'Thesis',    icon: Lightbulb, color: 'text-amber-400',  bg: 'bg-amber-500/15',  border: 'border-amber-500/25'  },
  braindump: { label: 'Braindump', icon: Brain,     color: 'text-indigo-400', bg: 'bg-indigo-500/15', border: 'border-indigo-500/25' },
  url:       { label: 'URL Save',  icon: Link,      color: 'text-blue-400',   bg: 'bg-blue-500/15',   border: 'border-blue-500/25'   },
  think:     { label: 'Think',     icon: Compass,   color: 'text-violet-400', bg: 'bg-violet-500/15', border: 'border-violet-500/25' },
  synthesis: { label: 'Synthesis', icon: GitMerge,  color: 'text-rose-400',   bg: 'bg-rose-500/15',   border: 'border-rose-500/25'   },
}

function TypeBadge({ type }) {
  const cfg  = TYPE_CONFIG[type] || TYPE_CONFIG.note
  const Icon = cfg.icon
  return (
    <span className={`inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded border ${cfg.bg} ${cfg.color} ${cfg.border}`}>
      <Icon className="w-2.5 h-2.5" /> {cfg.label}
    </span>
  )
}

function timeSince(iso) {
  if (!iso) return ''
  const d = Math.floor((Date.now() - new Date(iso)) / 1000)
  if (d < 60)    return 'just now'
  if (d < 3600)  return `${Math.floor(d / 60)}m ago`
  if (d < 86400) return `${Math.floor(d / 3600)}h ago`
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

function isStale(iso) {
  if (!iso) return false
  return (Date.now() - new Date(iso)) > STALE_DAYS * 86400000
}

// ── Markmap live preview ──────────────────────────────────────────────────────
function MarkmapPreview({ content }) {
  const svgRef = useRef(null)
  const mmRef  = useRef(null)
  const [failed, setFailed] = useState(false)

  // Needs at least 2 headings OR 1 heading + 3 bullets to form a useful mindmap
  const hasOutline = Boolean(content?.trim() && (() => {
    const lines = content.split('\n')
    const headings = lines.filter(l => /^#{1,6}\s/.test(l)).length
    const bullets  = lines.filter(l => /^\s*[-*+]\s/.test(l)).length
    return headings >= 2 || (headings >= 1 && bullets >= 3)
  })())

  useEffect(() => {
    if (!hasOutline || !svgRef.current || failed) return
    if (!mmRef.current) {
      try {
        mmRef.current = Markmap.create(svgRef.current, {
          maxWidth: 300, duration: 200, paddingX: 12, zoom: true, pan: true,
        })
      } catch { setFailed(true); return }
    }
    if (!content) return
    try {
      const { root } = transformer.transform(content)
      mmRef.current.setData(root)
      setTimeout(() => { try { mmRef.current?.fit() } catch {} }, 150)
    } catch { setFailed(true) }
  }, [content, hasOutline, failed])

  if (!content?.trim()) {
    return (
      <div className="flex items-center justify-center h-full text-slate-600 text-xs">
        <div className="text-center">
          <Map className="w-6 h-6 mx-auto mb-2 opacity-30" />
          Start writing to see the mindmap
        </div>
      </div>
    )
  }

  if (!hasOutline || failed) {
    return (
      <div className="p-4 overflow-y-auto h-full">
        <div className="text-[10px] text-slate-600 mb-3 flex items-center gap-1.5 border-b border-white/[0.05] pb-2">
          <FileText className="w-3 h-3" />
          <span>Note preview</span>
          {failed && <span className="text-amber-500/60">· switch to Write for full edit</span>}
          {!failed && <span className="text-slate-700">· use headings (# H1) for mindmap</span>}
        </div>
        <pre className="text-[11px] text-slate-300 whitespace-pre-wrap font-mono leading-relaxed">{content.slice(0, 5000)}</pre>
      </div>
    )
  }

  return <svg ref={svgRef} className="w-full h-full" style={{ background: 'transparent' }} />
}

// ── Note list item ────────────────────────────────────────────────────────────
function NoteItem({ note, active, onClick }) {
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

// ── Braindump modal ───────────────────────────────────────────────────────────
function BraindumpModal({ symbol, onClose, onSave }) {
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

// ── URL Scout modal ───────────────────────────────────────────────────────────
function ScoutModal({ onClose, onSave }) {
  const { authFetch }  = useAuth()
  const { getHeaders } = useApiKeys()
  const [url,        setUrl]        = useState('')
  const [symbol,     setSymbol]     = useState('')
  const [processing, setProcessing] = useState(false)
  const [result,     setResult]     = useState(null)
  const [error,      setError]      = useState(null)

  const scout = async () => {
    if (!url.trim()) return
    setProcessing(true); setError(null)
    try {
      const res  = await authFetch('/api/research-notes/scout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...getHeaders() },
        body: JSON.stringify({ url: url.trim(), symbol: symbol.trim() || null }),
      })
      let data
      try { data = await res.json() } catch { throw new Error('Server returned an invalid response — please try again.') }
      if (!res.ok) throw new Error(data.error || `Request failed (HTTP ${res.status})`)
      setResult(data.note)
    } catch (e) { setError(e.message) }
    setProcessing(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-2xl border border-blue-500/25 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <Globe className="w-4 h-4 text-blue-400" />
          <span className="text-sm font-semibold text-white">URL Scout</span>
          <span className="text-[11px] text-slate-500 ml-1">— AI evaluates any article or research page</span>
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          {!result ? (
            <>
              <div className="flex gap-2">
                <input value={url} onChange={e => setUrl(e.target.value)} autoFocus
                  placeholder="https://example.com/article-about-nvda"
                  className="input flex-1 text-xs" />
                <input value={symbol} onChange={e => setSymbol(e.target.value.toUpperCase())}
                  placeholder="SYMBOL" className="input w-24 text-xs font-mono text-mint-400 text-center" />
              </div>
              {error && <p className="text-xs text-red-400">{error}</p>}
              <div className="flex justify-end gap-2">
                <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Cancel</button>
                <button onClick={scout} disabled={!url.trim() || processing}
                  className="btn-primary flex items-center gap-1.5 text-xs py-1.5 disabled:opacity-50">
                  {processing ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" /> Scouting…</> : <><Globe className="w-3.5 h-3.5" /> Scout URL</>}
                </button>
              </div>
            </>
          ) : (
            <>
              <div className="flex items-center gap-2"><Globe className="w-3.5 h-3.5 text-blue-400" /><span className="text-xs font-semibold text-blue-400">Scouted result</span><TypeBadge type="url" /></div>
              <div className="bg-white/[0.03] rounded-xl p-3 border border-white/[0.07]">
                <div className="text-xs font-semibold text-white mb-2">{result.title}</div>
                <pre className="text-[11px] text-slate-300 whitespace-pre-wrap font-mono leading-relaxed max-h-64 overflow-y-auto">{result.content}</pre>
              </div>
              <div className="flex justify-between items-center">
                <button onClick={() => setResult(null)} className="text-xs text-slate-500 hover:text-white">← Edit URL</button>
                <div className="flex gap-2">
                  <button onClick={onClose} className="btn-ghost text-xs py-1.5 px-3">Discard</button>
                  <button
                    onClick={() => { onSave({ title: result.title, content: result.content, tags: result.tags || [], note_type: 'url', symbol: result.symbol || null, source_url: url }); onClose() }}
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

const IMPACT_CONFIG = {
  HIGH:   { color: 'text-red-400',   bg: 'bg-red-500/10',   border: 'border-red-500/25'   },
  MEDIUM: { color: 'text-amber-400', bg: 'bg-amber-500/10', border: 'border-amber-500/25' },
  LOW:    { color: 'text-blue-400',  bg: 'bg-blue-500/10',  border: 'border-blue-500/25'  },
}

// ── Daily Brief modal ─────────────────────────────────────────────────────────
function DailyBriefModal({ portfolio, notes, onClose, onSave }) {
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

// ── Auto-Research result modal ────────────────────────────────────────────────
function AutoResearchModal({ symbol, onClose, onApply }) {
  const { authFetch }  = useAuth()
  const { getHeaders } = useApiKeys()
  const [loading, setLoading] = useState(true)
  const [result,  setResult]  = useState(null)
  const [error,   setError]   = useState(null)

  useEffect(() => {
    let cancelled = false
    async function run() {
      try {
        const res  = await authFetch('/api/research-notes/auto-research', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...getHeaders() },
          body: JSON.stringify({ symbol, save: false }),
        })
        const data = await res.json()
        if (cancelled) return
        if (!res.ok) throw new Error(data.error)
        setResult(data.note)
      } catch (e) { if (!cancelled) setError(e.message) }
      if (!cancelled) setLoading(false)
    }
    run()
    return () => { cancelled = true }
  }, [symbol, authFetch, getHeaders])

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-2xl border border-mint-500/25 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <Zap className="w-4 h-4 text-mint-400" />
          <span className="text-sm font-semibold text-white">Auto-Research</span>
          <span className="text-[11px] font-mono text-mint-400 ml-1">· {symbol}</span>
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-4 space-y-3">
          {loading && (
            <div className="flex items-center justify-center py-12 gap-3">
              <RefreshCw className="w-5 h-5 text-mint-400 animate-spin" />
              <span className="text-sm text-slate-400">Fetching market data & generating research…</span>
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

// ── Think modal (10-principle framework) ─────────────────────────────────────
function ThinkModal({ symbol, contextNotes, onClose, onSave }) {
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

// ── Thinking Partner modal (Socratic dialogue) ────────────────────────────────
function ThinkingPartnerModal({ symbol, thesis, onClose }) {
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

// ── Vault Lint modal (health check) ──────────────────────────────────────────
function LintModal({ portfolio, onClose, onSelectNote }) {
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

// ── Weekly Synthesis modal ────────────────────────────────────────────────────
function WeeklySynthesisModal({ onClose, onSave }) {
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

// ── Main view ─────────────────────────────────────────────────────────────────
export default function ResearchNotesView({ defaultSymbol, portfolio }) {
  const { authFetch }  = useAuth()
  const { getHeaders } = useApiKeys()

  const [notes,          setNotes]          = useState([])
  const [activeNote,     setActiveNote]     = useState(null)
  const [loading,        setLoading]        = useState(false)
  const [saving,         setSaving]         = useState(false)
  const [search,         setSearch]         = useState('')
  const [filterType,     setFilterType]     = useState('')
  const [viewMode,       setViewMode]       = useState('split')

  // Modal states
  const [showBraindump,       setShowBraindump]       = useState(false)
  const [showScout,           setShowScout]           = useState(false)
  const [showBrief,           setShowBrief]           = useState(false)
  const [showAutoResearch,    setShowAutoResearch]    = useState(false)
  const [showThink,           setShowThink]           = useState(false)
  const [showThinkingPartner, setShowThinkingPartner] = useState(false)
  const [showLint,            setShowLint]            = useState(false)
  const [showWeeklySynth,     setShowWeeklySynth]     = useState(false)
  const [deepResearchMode,    setDeepResearchMode]    = useState(false)
  const [consolidating,       setConsolidating]       = useState(false)

  const editorRef = useRef(null)

  const [draft, setDraft]           = useState({ title: '', content: '', symbol: '', tags: '' })
  const [noteError, setNoteError]   = useState(null)
  const [briefHighAlert, setBriefHighAlert] = useState(false)

  const fetchNotes = useCallback(async () => {
    setLoading(true)
    try {
      const res  = await authFetch('/api/research-notes?limit=100')
      const data = await res.json()
      if (res.ok) setNotes(Array.isArray(data) ? data : [])
    } catch {}
    setLoading(false)
  }, [authFetch])

  useEffect(() => { fetchNotes() }, [fetchNotes])

  useEffect(() => {
    if (activeNote) {
      setDraft({
        title:   activeNote.title || '',
        content: activeNote.content || '',
        symbol:  activeNote.symbol || (defaultSymbol || ''),
        tags:    (activeNote.tags || []).join(', '),
      })
    }
  }, [activeNote, defaultSymbol])

  const createNote = async (overrides = {}) => {
    setSaving(true)
    setNoteError(null)
    try {
      const body = {
        title:     overrides.title    || 'New Note',
        content:   overrides.content  || '',
        symbol:    overrides.symbol   || defaultSymbol || null,
        note_type: overrides.note_type || 'note',
        tags:      overrides.tags     || [],
        source_url: overrides.source_url || null,
      }
      const res  = await authFetch('/api/research-notes', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      let note
      try { note = await res.json() } catch { throw new Error('Server returned an invalid response.') }
      if (res.ok) {
        setNotes(prev => [note, ...prev])
        setActiveNote(note)
      } else {
        setNoteError(note.error || 'Failed to create note — please try again.')
      }
    } catch (e) {
      setNoteError(e.message || 'Failed to create note — please try again.')
    }
    setSaving(false)
  }

  const saveNote = async () => {
    if (!activeNote) return
    setSaving(true)
    try {
      const tags = draft.tags.split(',').map(t => t.trim()).filter(Boolean)
      const res  = await authFetch(`/api/research-notes/${activeNote.id}`, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: draft.title, content: draft.content, symbol: draft.symbol || null, tags }),
      })
      const updated = await res.json()
      if (res.ok) { setNotes(prev => prev.map(n => n.id === updated.id ? updated : n)); setActiveNote(updated) }
    } catch {}
    setSaving(false)
  }

  const deleteNote = async (id) => {
    await authFetch(`/api/research-notes/${id}`, { method: 'DELETE' })
    setNotes(prev => prev.filter(n => n.id !== id))
    if (activeNote?.id === id) setActiveNote(null)
  }

  const handleConsolidate = async () => {
    setConsolidating(true)
    try {
      const sym = filterType === '' ? undefined : activeNote?.symbol
      const res = await authFetch('/api/research-notes/consolidate', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ symbol: draft.symbol || sym || undefined }),
      })
      const note = await res.json()
      if (res.ok) { setNotes(prev => [note, ...prev]); setActiveNote(note) }
    } catch {}
    setConsolidating(false)
  }

  // Called when auto-research result should update the current note or be saved as new
  const handleAutoResearchApply = async (content, saveAsNew = false) => {
    if (saveAsNew) {
      await createNote({ title: `${draft.symbol || 'Stock'} — Auto-Research`, content, symbol: draft.symbol, note_type: 'thesis', tags: ['auto-research'] })
    } else {
      setDraft(d => ({ ...d, content }))
    }
  }

  // Called when daily brief is generated — note is already saved server-side
  const handleBriefReady = (note, topNews) => {
    setNotes(prev => {
      const exists = prev.find(n => n.id === note.id)
      return exists ? prev.map(n => n.id === note.id ? note : n) : [note, ...prev]
    })
    setActiveNote(note)
    if (topNews?.some(n => n.impact === 'HIGH')) setBriefHighAlert(true)
  }

  const filteredNotes = notes.filter(n => {
    if (filterType && n.note_type !== filterType) return false
    if (!search) return true
    const q = search.toLowerCase()
    return (
      n.title?.toLowerCase().includes(q) ||
      n.symbol?.toLowerCase().includes(q) ||
      n.content?.toLowerCase().includes(q) ||
      n.tags?.some(t => t.toLowerCase().includes(q))
    )
  })

  const isDirty = activeNote && (
    draft.title   !== (activeNote.title || '') ||
    draft.content !== (activeNote.content || '') ||
    draft.symbol  !== (activeNote.symbol || '') ||
    draft.tags    !== (activeNote.tags || []).join(', ')
  )

  const activeIsStale = activeNote?.note_type === 'thesis' && isStale(activeNote.updated_at)

  return (
    <div className="flex h-[calc(100vh-10rem)] gap-4 animate-fade-in">

      {/* ── Left: Note list ── */}
      <div className="w-64 shrink-0 flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-indigo-400" />
          <span className="text-sm font-semibold text-white">Second Brain</span>
          <span className="text-[10px] text-slate-500 ml-auto">{notes.length} notes</span>
        </div>

        {/* Morning Brief button — prominent, shows badge when HIGH-impact news exists */}
        <button
          onClick={() => { setShowBrief(true); setBriefHighAlert(false) }}
          className="relative flex items-center justify-center gap-2 py-2 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-400 hover:bg-amber-500/20 transition-all text-xs font-medium"
        >
          <Sun className="w-3.5 h-3.5" /> Morning Brief
          {briefHighAlert && (
            <span className="absolute top-1 right-1.5 flex items-center gap-0.5 text-[9px] font-bold text-red-400 bg-red-500/15 border border-red-500/30 rounded-full px-1 py-0.5 leading-none">
              ! NEWS
            </span>
          )}
        </button>

        {/* Note creation error */}
        {noteError && (
          <div className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg bg-red-500/10 border border-red-500/20">
            <span className="text-[10px] text-red-400 flex-1">{noteError}</span>
            <button onClick={() => setNoteError(null)} className="text-slate-600 hover:text-white"><X className="w-3 h-3" /></button>
          </div>
        )}

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search notes…" className="input pl-7 py-1.5 text-xs" />
        </div>

        {/* Type filter pills */}
        <div className="flex flex-wrap gap-1">
          {['', 'note', 'thesis', 'braindump', 'url', 'think', 'synthesis'].map(t => (
            <button key={t} onClick={() => setFilterType(t)}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                filterType === t ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30' : 'text-slate-500 border-white/[0.07] hover:text-white'
              }`}>
              {t || 'All'}
            </button>
          ))}
        </div>

        {/* Action buttons — 2×3 grid */}
        <div className="grid grid-cols-3 gap-1">
          <button onClick={() => createNote()}
            className="flex flex-col items-center gap-0.5 text-[10px] py-2 rounded-lg bg-white/[0.03] border border-white/[0.07] text-slate-400 hover:text-white hover:border-white/[0.15] transition-all">
            <Plus className="w-3 h-3" /> Note
          </button>
          <button onClick={() => setShowBraindump(true)}
            className="flex flex-col items-center gap-0.5 text-[10px] py-2 rounded-lg bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 hover:bg-indigo-500/20 transition-all">
            <Brain className="w-3 h-3" /> Dump
          </button>
          <button onClick={() => setShowScout(true)}
            className="flex flex-col items-center gap-0.5 text-[10px] py-2 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 hover:bg-blue-500/20 transition-all">
            <Globe className="w-3 h-3" /> Scout
          </button>
          <button onClick={() => setShowThink(true)}
            className="flex flex-col items-center gap-0.5 text-[10px] py-2 rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-400 hover:bg-violet-500/20 transition-all">
            <Compass className="w-3 h-3" /> Think
          </button>
          <button onClick={() => setShowWeeklySynth(true)}
            className="flex flex-col items-center gap-0.5 text-[10px] py-2 rounded-lg bg-rose-500/10 border border-rose-500/20 text-rose-400 hover:bg-rose-500/20 transition-all">
            <Calendar className="w-3 h-3" /> Weekly
          </button>
          <button onClick={() => setShowLint(true)}
            className="flex flex-col items-center gap-0.5 text-[10px] py-2 rounded-lg bg-teal-500/10 border border-teal-500/20 text-teal-400 hover:bg-teal-500/20 transition-all">
            <ShieldCheck className="w-3 h-3" /> Lint
          </button>
        </div>

        {/* Note list */}
        <div className="flex-1 overflow-y-auto space-y-0.5 pr-0.5">
          {loading && <div className="text-xs text-slate-600 text-center py-4">Loading…</div>}
          {!loading && filteredNotes.length === 0 && (
            <div className="text-xs text-slate-600 text-center py-8 px-2">
              {notes.length === 0 ? <>No notes yet.<br />Start with Morning Brief!</> : 'No notes match your filter.'}
            </div>
          )}
          {filteredNotes.map(note => (
            <NoteItem key={note.id} note={note} active={activeNote?.id === note.id} onClick={() => setActiveNote(note)} />
          ))}
        </div>
      </div>

      {/* ── Right: Editor + Mindmap ── */}
      <div className="flex-1 flex flex-col min-w-0 gap-2">
        {!activeNote ? (
          <div className="flex-1 glass rounded-2xl flex flex-col items-center justify-center text-center gap-4 p-8">
            <div className="w-16 h-16 rounded-2xl bg-indigo-500/10 border border-indigo-500/20 flex items-center justify-center">
              <BookOpen className="w-7 h-7 text-indigo-400" />
            </div>
            <div>
              <p className="text-white font-semibold">Your Self-Maturing Investment Brain</p>
              <p className="text-slate-500 text-sm mt-1 max-w-md">
                Generate daily briefs, auto-research any ticker with live market data, scout URLs for insights, and consolidate your knowledge into master theses.
              </p>
            </div>
            <div className="flex flex-wrap gap-2 justify-center">
              <button onClick={() => setShowBrief(true)} className="btn-primary flex items-center gap-2 text-sm">
                <Sun className="w-4 h-4" /> Morning Brief
              </button>
              <button onClick={() => createNote()} className="btn-ghost text-sm flex items-center gap-2">
                <Plus className="w-4 h-4" /> New Note
              </button>
              <button onClick={() => setShowBraindump(true)} className="btn-ghost text-sm flex items-center gap-2">
                <Brain className="w-4 h-4" /> Braindump
              </button>
            </div>
          </div>
        ) : (
          <>
            {/* Stale thesis banner */}
            {activeIsStale && (
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-xs">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
                <span className="text-amber-300">This thesis is over 30 days old — market conditions may have changed.</span>
                {activeNote.symbol && (
                  <button onClick={() => setShowAutoResearch(true)}
                    className="ml-auto flex items-center gap-1 text-[11px] text-mint-400 hover:text-mint-300 border border-mint-500/25 rounded px-2 py-0.5 hover:bg-mint-500/10 transition-all">
                    <Zap className="w-3 h-3" /> Refresh Research
                  </button>
                )}
              </div>
            )}

            {/* Toolbar */}
            <div className="flex items-center gap-2">
              <input value={draft.title} onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
                className="flex-1 bg-transparent text-sm font-semibold text-white focus:outline-none border-b border-transparent focus:border-white/[0.2] pb-0.5 transition-colors"
                placeholder="Note title…" />
              <input value={draft.symbol} onChange={e => setDraft(d => ({ ...d, symbol: e.target.value.toUpperCase() }))}
                className="w-20 text-xs font-mono text-mint-400 bg-transparent focus:outline-none border-b border-transparent focus:border-mint-500/40 pb-0.5 placeholder-slate-600 text-center"
                placeholder="SYMBOL" />

              {/* View mode */}
              <div className="flex gap-1">
                {['editor', 'split', 'mindmap'].map(m => (
                  <button key={m} onClick={() => setViewMode(m)}
                    className={`px-2 py-1 text-[10px] rounded-lg border transition-all capitalize ${
                      viewMode === m ? 'bg-indigo-500/15 text-indigo-400 border-indigo-500/30' : 'text-slate-500 border-white/[0.07] hover:text-white'
                    }`}>
                    {m === 'split' ? 'Split' : m === 'editor' ? 'Write' : <><Map className="w-3 h-3 inline" /> Map</>}
                  </button>
                ))}
              </div>

              {/* Auto-Research (when symbol set) */}
              {draft.symbol && (
                <div className="flex items-center rounded-lg bg-mint-500/10 border border-mint-500/20 overflow-hidden">
                  <button onClick={() => { setDeepResearchMode(false); setShowAutoResearch(true) }}
                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-mint-400 hover:bg-mint-500/20 transition-all">
                    <Zap className="w-3 h-3" /> Research
                  </button>
                  <button onClick={() => { setDeepResearchMode(true); setShowAutoResearch(true) }}
                    title="3-round deep research"
                    className="flex items-center gap-1 px-2 py-1 text-[10px] text-mint-400 border-l border-mint-500/20 hover:bg-mint-500/20 transition-all">
                    <Layers className="w-3 h-3" /> Deep
                  </button>
                </div>
              )}

              {/* Thinking Partner (when note has content) */}
              {draft.content?.trim() && (
                <button onClick={() => setShowThinkingPartner(true)}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 hover:bg-emerald-500/20 transition-all">
                  <MessageSquare className="w-3 h-3" /> Partner
                </button>
              )}

              {/* Think framework (when symbol set) */}
              {draft.symbol && (
                <button onClick={() => setShowThink(true)}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] rounded-lg bg-violet-500/10 border border-violet-500/20 text-violet-400 hover:bg-violet-500/20 transition-all">
                  <Compass className="w-3 h-3" /> Think
                </button>
              )}

              {/* Consolidate */}
              <button onClick={handleConsolidate} disabled={consolidating}
                className="flex items-center gap-1 px-2 py-1 text-[10px] rounded-lg bg-purple-500/10 border border-purple-500/20 text-purple-400 hover:bg-purple-500/20 disabled:opacity-50 transition-all">
                {consolidating ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Layers className="w-3 h-3" />}
                {consolidating ? 'Synthesizing…' : 'Synthesize'}
              </button>

              <button onClick={saveNote} disabled={!isDirty || saving}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-lg bg-mint-500/15 text-mint-400 border border-mint-500/25 hover:bg-mint-500/25 disabled:opacity-40 transition-all">
                {saving ? <RefreshCw className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                {saving ? 'Saving…' : isDirty ? 'Save*' : 'Saved'}
              </button>
              <button onClick={() => deleteNote(activeNote.id)} aria-label="Delete note"
                className="p-1.5 rounded-lg text-slate-600 hover:text-red-400 hover:bg-red-500/10 transition-all">
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Tags */}
            <div className="flex items-center gap-1.5">
              <Tag className="w-3 h-3 text-slate-600" />
              <input value={draft.tags} onChange={e => setDraft(d => ({ ...d, tags: e.target.value }))}
                placeholder="tags, comma, separated"
                className="flex-1 bg-transparent text-[11px] text-slate-400 placeholder-slate-600 focus:outline-none" />
              <TypeBadge type={activeNote.note_type} />
              {activeNote.source_url && (
                <a href={activeNote.source_url} target="_blank" rel="noopener noreferrer"
                  className="flex items-center gap-0.5 text-[10px] text-blue-400 hover:text-blue-300">
                  <ExternalLink className="w-3 h-3" /> Source
                </a>
              )}
            </div>

            {/* Editor / Mindmap / Split */}
            <div className="flex-1 flex gap-2 min-h-0">
              {(viewMode === 'editor' || viewMode === 'split') && (
                <textarea ref={editorRef} value={draft.content}
                  onChange={e => setDraft(d => ({ ...d, content: e.target.value }))}
                  placeholder={`# ${draft.symbol || 'Stock'}\n## Bull Case\n- \n## Bear Case\n- \n## Catalysts\n- \n## Thesis Breaker\n- `}
                  className="flex-1 bg-white/[0.02] border border-white/[0.06] rounded-xl p-3 text-xs font-mono text-slate-300 placeholder-slate-700 focus:outline-none focus:border-indigo-500/30 resize-none leading-relaxed"
                  style={{ minHeight: 0 }} />
              )}
              {(viewMode === 'mindmap' || viewMode === 'split') && (
                <div className={`${viewMode === 'split' ? 'flex-1' : 'w-full'} glass rounded-xl border border-white/[0.06] overflow-hidden relative`}>
                  <div className="absolute top-2 left-2 z-10 flex items-center gap-1 text-[10px] text-slate-600">
                    <Map className="w-2.5 h-2.5" /> Live Mindmap
                  </div>
                  <MarkmapPreview content={draft.content} />
                </div>
              )}
            </div>
          </>
        )}
      </div>

      {/* ── Modals ── */}
      {showBraindump && (
        <BraindumpModal symbol={draft.symbol || defaultSymbol} onClose={() => setShowBraindump(false)}
          onSave={async (data) => { await createNote(data) }} />
      )}
      {showScout && (
        <ScoutModal onClose={() => setShowScout(false)}
          onSave={async (data) => { await createNote(data) }} />
      )}
      {showBrief && (
        <DailyBriefModal portfolio={portfolio} notes={notes} onClose={() => setShowBrief(false)}
          onSave={handleBriefReady} />
      )}
      {showAutoResearch && draft.symbol && (
        <AutoResearchModal symbol={draft.symbol} deep={deepResearchMode}
          onClose={() => setShowAutoResearch(false)}
          onApply={handleAutoResearchApply} />
      )}
      {showThink && (
        <ThinkModal
          symbol={draft.symbol || defaultSymbol || null}
          contextNotes={activeNote ? `${activeNote.title}\n${activeNote.content?.slice(0, 1500)}` : null}
          onClose={() => setShowThink(false)}
          onSave={async (data) => { await createNote(data) }}
        />
      )}
      {showThinkingPartner && (
        <ThinkingPartnerModal
          symbol={draft.symbol || null}
          thesis={draft.content}
          onClose={() => setShowThinkingPartner(false)}
        />
      )}
      {showLint && (
        <LintModal
          portfolio={portfolio}
          onClose={() => setShowLint(false)}
          onSelectNote={(noteId) => { const n = notes.find(x => x.id === noteId); if (n) setActiveNote(n) }}
        />
      )}
      {showWeeklySynth && (
        <WeeklySynthesisModal
          onClose={() => setShowWeeklySynth(false)}
          onSave={(note) => {
            setNotes(prev => [note, ...prev])
            setActiveNote(note)
          }}
        />
      )}
    </div>
  )
}
