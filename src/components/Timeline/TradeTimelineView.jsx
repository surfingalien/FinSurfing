import { useState, useEffect, useCallback } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import { Clock, AlertTriangle, TrendingUp, TrendingDown, Minus, ChevronDown, ChevronUp, RefreshCw, Filter } from 'lucide-react'

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso) {
  if (!iso) return '—'
  const d = new Date(iso)
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) +
    ' · ' + d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })
}

function ScoreBar({ label, score, color = '#00ffcc' }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-20 text-slate-500 shrink-0">{label}</span>
      <div className="flex-1 h-1.5 bg-white/[0.06] rounded-full overflow-hidden">
        <div className="h-full rounded-full transition-all" style={{ width: `${score ?? 0}%`, background: color }} />
      </div>
      <span className="w-6 text-right text-slate-400">{score ?? '—'}</span>
    </div>
  )
}

function VerdictBadge({ verdict, color, changed, prev }) {
  const Icon = verdict?.includes('Buy') ? TrendingUp : verdict?.includes('Sell') ? TrendingDown : Minus
  return (
    <div className="flex items-center gap-1.5">
      <span
        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-semibold border"
        style={{ color, borderColor: color + '40', background: color + '15' }}
      >
        <Icon size={10} />
        {verdict || 'Unknown'}
      </span>
      {changed && prev && (
        <span className="text-[10px] text-slate-500">← was {prev}</span>
      )}
    </div>
  )
}

// ── Timeline event card ───────────────────────────────────────────────────────

function TimelineCard({ event, isLast }) {
  const [expanded, setExpanded] = useState(false)
  const hasConflict = event.agentConflict?.exists
  const hasAssumptions = Array.isArray(event.thesisAssumptions) && event.thesisAssumptions.length > 0

  return (
    <div className="relative pl-6">
      {/* Connector line */}
      {!isLast && (
        <div className="absolute left-2.5 top-8 bottom-0 w-px bg-white/[0.06]" />
      )}
      {/* Dot */}
      <div
        className="absolute left-0 top-5 w-5 h-5 rounded-full border-2 flex items-center justify-center"
        style={{ borderColor: event.verdictColor || '#94a3b8', background: (event.verdictColor || '#94a3b8') + '20' }}
      >
        <div className="w-1.5 h-1.5 rounded-full" style={{ background: event.verdictColor || '#94a3b8' }} />
      </div>

      <motion.div
        initial={{ opacity: 0, x: -8 }}
        animate={{ opacity: 1, x: 0 }}
        className="mb-4 ml-2 glass rounded-xl border border-white/[0.06] overflow-hidden"
      >
        {/* Card header */}
        <div className="px-4 pt-3 pb-2">
          <div className="flex items-start justify-between gap-2 flex-wrap">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="font-bold text-white text-sm">{event.symbol}</span>
              <VerdictBadge
                verdict={event.verdict}
                color={event.verdictColor}
                changed={event.verdictChanged}
                prev={event.prevVerdict}
              />
              {hasConflict && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-amber-500/10 border border-amber-500/20 text-amber-400">
                  <AlertTriangle size={9} />
                  Agent conflict
                </span>
              )}
            </div>
            <span className="text-[11px] text-slate-500 flex items-center gap-1">
              <Clock size={10} />
              {fmtDate(event.generatedAt)}
            </span>
          </div>

          {/* Composite score + entry/target */}
          <div className="flex items-center gap-4 mt-2 text-xs text-slate-400">
            <span>
              Score: <span className="font-semibold" style={{ color: event.verdictColor }}>{event.compositeScore ?? '—'}</span>/100
            </span>
            {event.entryZoneMid != null && (
              <span>Entry ~<span className="text-white">${event.entryZoneMid?.toFixed(2)}</span></span>
            )}
            {event.targetZoneMid != null && (
              <span>Target ~<span className="text-white">${event.targetZoneMid?.toFixed(2)}</span></span>
            )}
          </div>
        </div>

        {/* Expandable detail */}
        {(hasAssumptions || hasConflict || event.supervisorNote) && (
          <>
            <button
              onClick={() => setExpanded(e => !e)}
              className="w-full flex items-center justify-between px-4 py-1.5 text-xs text-slate-500 hover:text-slate-300 border-t border-white/[0.04] transition-colors"
            >
              <span>Score breakdown + thesis</span>
              {expanded ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
            </button>

            <AnimatePresence>
              {expanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  className="px-4 pb-3 space-y-3 overflow-hidden"
                >
                  {/* Score bars */}
                  <div className="space-y-1.5">
                    <ScoreBar label="Fundamental" score={event.fundamentalScore} color="#4ade80" />
                    <ScoreBar label="Technical"   score={event.technicalScore}   color="#60a5fa" />
                    <ScoreBar label="Sentiment"   score={event.sentimentScore}   color="#f472b6" />
                    <ScoreBar label="Macro"       score={event.macroScore}       color="#a78bfa" />
                    <ScoreBar label="Risk"        score={event.riskScore}        color="#00ffcc" />
                  </div>

                  {/* Supervisor note */}
                  {event.supervisorNote && (
                    <p className="text-[11px] text-slate-400 italic border-l-2 border-[#00ffcc]/30 pl-2">
                      {event.supervisorNote}
                    </p>
                  )}

                  {/* Agent conflict detail */}
                  {hasConflict && event.agentConflict?.meaning && (
                    <div className="flex gap-2 text-[11px] text-amber-400 bg-amber-500/5 rounded-lg px-2.5 py-2">
                      <AlertTriangle size={11} className="shrink-0 mt-0.5" />
                      <span>{event.agentConflict.meaning}</span>
                    </div>
                  )}

                  {/* Thesis assumptions */}
                  {hasAssumptions && (
                    <div>
                      <p className="text-[10px] text-slate-500 mb-1.5 uppercase tracking-wide">Thesis assumptions</p>
                      <ol className="space-y-1">
                        {event.thesisAssumptions.map((a, i) => (
                          <li key={i} className="flex gap-2 text-[11px] text-slate-400">
                            <span className="text-[#00ffcc]/50 font-mono">{i + 1}.</span>
                            {a}
                          </li>
                        ))}
                      </ol>
                    </div>
                  )}
                </motion.div>
              )}
            </AnimatePresence>
          </>
        )}
      </motion.div>
    </div>
  )
}

// ── Main view ─────────────────────────────────────────────────────────────────

export default function TradeTimelineView({ portfolio }) {
  const [events, setEvents]       = useState([])
  const [symbols, setSymbols]     = useState([])
  const [activeSyms, setActiveSyms] = useState([])
  const [filter, setFilter]       = useState('all') // all | conflicts | changed
  const [loading, setLoading]     = useState(true)
  const [total, setTotal]         = useState(0)
  const [offset, setOffset]       = useState(0)
  const LIMIT = 40

  const load = useCallback(async (sym = activeSyms, off = 0) => {
    setLoading(true)
    try {
      const params = new URLSearchParams({ limit: LIMIT, offset: off })
      if (sym.length) params.set('symbols', sym.join(','))
      const r = await fetch(`/api/timeline?${params}`)
      const data = await r.json()
      if (off === 0) {
        setEvents(data.events || [])
        setSymbols(data.symbols || [])
        setTotal(data.total || 0)
      } else {
        setEvents(e => [...e, ...(data.events || [])])
      }
      setOffset(off)
    } catch (err) {
      console.error('[timeline]', err)
    } finally {
      setLoading(false)
    }
  }, [activeSyms])

  useEffect(() => { load() }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const toggleSymbol = (sym) => {
    const next = activeSyms.includes(sym)
      ? activeSyms.filter(s => s !== sym)
      : [...activeSyms, sym]
    setActiveSyms(next)
    load(next, 0)
  }

  const clearSymbols = () => { setActiveSyms([]); load([], 0) }

  // Client-side filter
  const visible = events.filter(e => {
    if (filter === 'conflicts') return e.agentConflict?.exists
    if (filter === 'changed')   return e.verdictChanged
    return true
  })

  const hasMore = offset + LIMIT < total

  return (
    <div className="max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white flex items-center gap-2">
            <Clock size={20} className="text-[#00ffcc]" />
            Trade Thesis Timeline
          </h2>
          <p className="text-sm text-slate-500 mt-0.5">
            AI Brain prediction history — signal changes, agent conflicts, thesis assumptions
          </p>
        </div>
        <button
          onClick={() => load(activeSyms, 0)}
          disabled={loading}
          className="p-2 rounded-lg bg-white/[0.04] border border-white/[0.06] text-slate-400 hover:text-white disabled:opacity-40 transition-colors"
        >
          <RefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>

      {/* Symbol chips */}
      {symbols.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {activeSyms.length > 0 && (
            <button
              onClick={clearSymbols}
              className="px-2.5 py-1 rounded-full text-xs border border-white/10 text-slate-400 hover:text-white transition-colors"
            >
              Clear
            </button>
          )}
          {symbols.slice(0, 20).map(s => (
            <button
              key={s.symbol}
              onClick={() => toggleSymbol(s.symbol)}
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs border transition-all ${
                activeSyms.includes(s.symbol)
                  ? 'border-[#00ffcc]/40 bg-[#00ffcc]/10 text-[#00ffcc]'
                  : 'border-white/[0.06] text-slate-400 hover:text-white hover:border-white/20'
              }`}
            >
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: s.verdictColor }} />
              {s.symbol}
              <span className="opacity-50">{s.count}</span>
            </button>
          ))}
        </div>
      )}

      {/* Event type filter */}
      <div className="flex items-center gap-2">
        <Filter size={13} className="text-slate-500" />
        {[
          { id: 'all',       label: 'All events' },
          { id: 'conflicts', label: '⚠️ Conflicts only' },
          { id: 'changed',   label: '🔄 Signal changes' },
        ].map(f => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={`px-3 py-1 rounded-full text-xs border transition-all ${
              filter === f.id
                ? 'border-[#00ffcc]/40 bg-[#00ffcc]/10 text-[#00ffcc]'
                : 'border-white/[0.06] text-slate-400 hover:text-white'
            }`}
          >
            {f.label}
          </button>
        ))}
        <span className="ml-auto text-xs text-slate-600">{visible.length} events</span>
      </div>

      {/* Timeline */}
      {loading && events.length === 0 ? (
        <div className="flex items-center justify-center py-20 text-slate-500">
          <RefreshCw size={20} className="animate-spin mr-2" />
          Loading predictions…
        </div>
      ) : visible.length === 0 ? (
        <div className="glass rounded-xl border border-white/[0.06] p-10 text-center text-slate-500">
          <Clock size={32} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No timeline events yet.</p>
          <p className="text-xs mt-1">Run an AI Brain scan to start building your thesis history.</p>
        </div>
      ) : (
        <div className="pt-2">
          {visible.map((event, i) => (
            <TimelineCard
              key={`${event.symbol}-${event.generatedAt}`}
              event={event}
              isLast={i === visible.length - 1}
            />
          ))}

          {hasMore && filter === 'all' && (
            <button
              onClick={() => load(activeSyms, offset + LIMIT)}
              disabled={loading}
              className="w-full py-2.5 text-sm text-slate-500 hover:text-white border border-white/[0.06] rounded-xl transition-colors disabled:opacity-40"
            >
              {loading ? 'Loading…' : `Load more (${total - events.length} remaining)`}
            </button>
          )}
        </div>
      )}
    </div>
  )
}
