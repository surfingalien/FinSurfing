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

  useEffect(() => {
    if (!svgRef.current) return
    if (!mmRef.current) {
      mmRef.current = Markmap.create(svgRef.current, {
        maxWidth: 320, duration: 200, paddingX: 16, zoom: true, pan: true,
      })
    }
  }, [])

  useEffect(() => {
    if (!mmRef.current || !content) return
    try {
      const { root } = transformer.transform(content || '# Empty\n')
      mmRef.current.setData(root)
      mmRef.current.fit()
    } catch {}
  }, [content])

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
      const data = await res.json()
      if (!res.ok) throw new Error(data.error)
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

// ── Daily Brief modal ─────────────────────────────────────────────────────────
function DailyBriefModal({ portfolio, notes, onClose, onSave }) {
  const { authFetch }  = useAuth()
  const { getHeaders } = useApiKeys()
  const [generating, setGenerating] = useState(false)
  const [error,      setError]      = useState(null)

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
      const note = await res.json()
      if (!res.ok) throw new Error(note.error)
      onSave(note)
      onClose()
    } catch (e) { setError(e.message) }
    setGenerating(false)
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
      <div className="glass rounded-2xl w-full max-w-lg border border-amber-500/25 shadow-2xl">
        <div className="flex items-center gap-2 px-4 py-3 border-b border-white/[0.06]">
          <Sun className="w-4 h-4 text-amber-400" />
          <span className="text-sm font-semibold text-white">Morning Brief</span>
          <span className="text-[11px] text-slate-500 ml-1">· {new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</span>
          <button onClick={onClose} className="ml-auto text-slate-500 hover:text-white"><X className="w-4 h-4" /></button>
        </div>
        <div className="p-5 space-y-4">
          {existing ? (
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
          ) : (
            <>
              <div className="space-y-2">
                <p className="text-xs text-slate-400">
                  Generates a live market intelligence brief using your portfolio positions, Finnhub data, and Claude AI.
                </p>
                <div className="p-3 rounded-xl bg-white/[0.03] border border-white/[0.06] space-y-1.5">
                  <div className="text-[11px] text-slate-500 font-medium uppercase tracking-wider">Includes</div>
                  {[
                    'Portfolio pulse — live prices + day change',
                    'Key catalysts & news for each holding',
                    '3–6 month thesis per position',
                    '5 new stock/ETF opportunities to watch',
                    'Action items for today',
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
  const [showBraindump,   setShowBraindump]   = useState(false)
  const [showScout,       setShowScout]       = useState(false)
  const [showBrief,       setShowBrief]       = useState(false)
  const [showAutoResearch, setShowAutoResearch] = useState(false)
  const [consolidating,   setConsolidating]   = useState(false)

  const editorRef = useRef(null)

  const [draft, setDraft] = useState({ title: '', content: '', symbol: '', tags: '' })

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
      const note = await res.json()
      if (res.ok) { setNotes(prev => [note, ...prev]); setActiveNote(note) }
    } catch {}
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
  const handleBriefReady = (note) => {
    setNotes(prev => {
      const exists = prev.find(n => n.id === note.id)
      return exists ? prev.map(n => n.id === note.id ? note : n) : [note, ...prev]
    })
    setActiveNote(note)
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

        {/* Morning Brief button — prominent */}
        <button
          onClick={() => setShowBrief(true)}
          className="flex items-center justify-center gap-2 py-2 rounded-xl bg-amber-500/10 border border-amber-500/25 text-amber-400 hover:bg-amber-500/20 transition-all text-xs font-medium"
        >
          <Sun className="w-3.5 h-3.5" /> Morning Brief
        </button>

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
          <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search notes…" className="input pl-7 py-1.5 text-xs" />
        </div>

        {/* Type filter pills */}
        <div className="flex flex-wrap gap-1">
          {['', 'note', 'thesis', 'braindump', 'url'].map(t => (
            <button key={t} onClick={() => setFilterType(t)}
              className={`text-[10px] px-2 py-0.5 rounded-full border transition-all ${
                filterType === t ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30' : 'text-slate-500 border-white/[0.07] hover:text-white'
              }`}>
              {t || 'All'}
            </button>
          ))}
        </div>

        {/* Action buttons */}
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
                <button onClick={() => setShowAutoResearch(true)}
                  className="flex items-center gap-1 px-2 py-1 text-[10px] rounded-lg bg-mint-500/10 border border-mint-500/20 text-mint-400 hover:bg-mint-500/20 transition-all">
                  <Zap className="w-3 h-3" /> Auto-Research
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
        <AutoResearchModal symbol={draft.symbol} onClose={() => setShowAutoResearch(false)}
          onApply={handleAutoResearchApply} />
      )}
    </div>
  )
}
