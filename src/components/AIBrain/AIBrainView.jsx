/**
 * AIBrainView — Multi-agent AI stock analysis.
 * 5 specialized agents (Fundamental, Technical, Sentiment, Macro, Risk)
 * collaborate through a supervisor to produce ranked buy recommendations.
 *
 * Features: custom symbol search, buy/sell price targets, AI watchlist, PDF export.
 */

import { useState, useCallback } from 'react'
import {
  Brain, BarChart2, TrendingUp, Eye, Globe, Shield,
  Sparkles, RefreshCw, ChevronDown, ChevronUp, AlertTriangle,
  Target, Zap, Activity, Clock, CheckCircle2, Search,
  Bookmark, BookmarkCheck, Download, X, DollarSign,
  Cpu, HeartPulse, Zap as ZapEnergy, LineChart, Bitcoin,
} from 'lucide-react'
import { useAIWatchlist } from '../../hooks/useAIWatchlist'
import { exportAnalysisToPDF } from '../../utils/pdfExport'

/* ── scan mode definitions ────────────────────────────────── */
const SCAN_MODES = [
  { id: 'broad',      label: 'Broad Market',  icon: Globe,      color: 'text-mint-400',    bg: 'bg-mint-500/15',    border: 'border-mint-500/30'    },
  { id: 'tech',       label: 'Tech & AI',     icon: Cpu,        color: 'text-blue-400',    bg: 'bg-blue-500/15',    border: 'border-blue-500/30'    },
  { id: 'finance',    label: 'Finance',       icon: BarChart2,  color: 'text-amber-400',   bg: 'bg-amber-500/15',   border: 'border-amber-500/30'   },
  { id: 'healthcare', label: 'Healthcare',    icon: HeartPulse, color: 'text-rose-400',    bg: 'bg-rose-500/15',    border: 'border-rose-500/30'    },
  { id: 'energy',     label: 'Energy & Ind.', icon: ZapEnergy,  color: 'text-orange-400',  bg: 'bg-orange-500/15',  border: 'border-orange-500/30'  },
  { id: 'etfs',       label: 'ETFs',          icon: LineChart,  color: 'text-purple-400',  bg: 'bg-purple-500/15',  border: 'border-purple-500/30'  },
  { id: 'crypto',     label: 'Crypto',        icon: Bitcoin,    color: 'text-yellow-400',  bg: 'bg-yellow-500/15',  border: 'border-yellow-500/30'  },
]

/* ── helpers ──────────────────────────────────────────────── */
function getApiKeyHeaders() {
  try {
    const s = JSON.parse(localStorage.getItem('finsurf_api_keys') || '{}')
    const h = {}
    if (s.aisa?.trim())    h['x-aisa-key']    = s.aisa.trim()
    if (s.finnhub?.trim()) h['x-finnhub-key'] = s.finnhub.trim()
    if (s.fmp?.trim())     h['x-fmp-key']     = s.fmp.trim()
    if (s.td?.trim())      h['x-td-key']      = s.td.trim()
    if (s.av?.trim())      h['x-av-key']      = s.av.trim()
    return h
  } catch { return {} }
}

const DEFAULT_UNIVERSE_STR = 'NVDA,MSFT,AAPL,AMZN,GOOGL,META,AVGO,TSLA,JPM,V,LLY,UNH,COST,NFLX,MELI,CRWD,ANET,AMD,PLTR,ORCL'

/* ── agent config ─────────────────────────────────────────── */
const AGENTS = [
  { key: 'fundamental', label: 'Fundamental',  icon: BarChart2,  color: 'text-blue-400',   bg: 'bg-blue-500/15',   border: 'border-blue-500/25',   scoreKey: 'fundamentalScore', analysisKey: 'fundamentalAnalysis',  noteKey: 'fundamentalAnalyst'  },
  { key: 'technical',   label: 'Technical',    icon: TrendingUp, color: 'text-cyan-400',   bg: 'bg-cyan-500/15',   border: 'border-cyan-500/25',   scoreKey: 'technicalScore',   analysisKey: 'technicalAnalysis',   noteKey: 'technicalAnalyst'   },
  { key: 'sentiment',   label: 'Sentiment',    icon: Eye,        color: 'text-purple-400', bg: 'bg-purple-500/15', border: 'border-purple-500/25', scoreKey: 'sentimentScore',   analysisKey: 'sentimentAnalysis',   noteKey: 'sentimentAnalyst'   },
  { key: 'macro',       label: 'Macro',        icon: Globe,      color: 'text-amber-400',  bg: 'bg-amber-500/15',  border: 'border-amber-500/25',  scoreKey: 'macroScore',       analysisKey: 'macroAnalysis',       noteKey: 'macroEconomist'     },
  { key: 'risk',        label: 'Risk',         icon: Shield,     color: 'text-red-400',    bg: 'bg-red-500/15',    border: 'border-red-500/25',    scoreKey: 'riskScore',        analysisKey: 'riskNote',            noteKey: 'riskManager'        },
]

const VERDICT_CONFIG = {
  'Strong Buy':   { color: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30' },
  'Buy':          { color: 'text-mint-400',    bg: 'bg-mint-500/15',    border: 'border-mint-500/30'    },
  'Moderate Buy': { color: 'text-amber-400',   bg: 'bg-amber-500/15',   border: 'border-amber-500/25'   },
}

const CONFIDENCE_CONFIG = {
  'High':   { color: 'text-emerald-400', dot: 'bg-emerald-400' },
  'Medium': { color: 'text-amber-400',   dot: 'bg-amber-400'   },
  'Low':    { color: 'text-slate-400',   dot: 'bg-slate-400'   },
}

const HORIZON_OPTIONS = [
  { value: '3m',  label: '3 Month' },
  { value: '6m',  label: '6 Month' },
  { value: '12m', label: '12 Month' },
]

/* ── ScoreBar ──────────────────────────────────────────────── */
function ScoreBar({ agent, score }) {
  const Icon = agent.icon
  const pct  = Math.min(100, Math.max(0, score))
  const barColor = pct >= 75 ? 'bg-emerald-400' : pct >= 50 ? 'bg-amber-400' : 'bg-red-400'
  return (
    <div className="flex items-center gap-2">
      <div className={`flex items-center gap-1 w-[82px] shrink-0 ${agent.color}`}>
        <Icon className="w-3 h-3 shrink-0" />
        <span className="text-[10px] font-medium">{agent.label}</span>
      </div>
      <div className="flex-1 h-1.5 bg-white/[0.05] rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all ${barColor}`} style={{ width: `${pct}%` }} />
      </div>
      <span className="text-[10px] font-mono text-slate-400 w-6 text-right">{score}</span>
    </div>
  )
}

/* ── CompositeRing ─────────────────────────────────────────── */
function CompositeRing({ score }) {
  const r    = 20
  const circ = 2 * Math.PI * r
  const dash = (score / 100) * circ
  const color = score >= 75 ? '#34d399' : score >= 55 ? '#fbbf24' : '#f87171'
  return (
    <div className="relative w-14 h-14 shrink-0">
      <svg className="w-14 h-14 -rotate-90" viewBox="0 0 48 48">
        <circle cx="24" cy="24" r={r} fill="none" stroke="rgba(255,255,255,0.06)" strokeWidth="4" />
        <circle cx="24" cy="24" r={r} fill="none" stroke={color} strokeWidth="4" strokeLinecap="round" strokeDasharray={`${dash} ${circ}`} />
      </svg>
      <span className="absolute inset-0 flex items-center justify-center text-sm font-black text-white">{score}</span>
    </div>
  )
}

/* ── PriceLevels ───────────────────────────────────────────── */
function PriceLevels({ stock }) {
  if (!stock.entryPrice && !stock.takeProfitPrice && !stock.stopLossPrice) return null
  const fmt = (v) => v ? `$${v.toFixed(2)}` : '—'
  return (
    <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
      <div className="bg-blue-500/10 rounded-lg p-1.5 border border-blue-500/20">
        <div className="text-[9px] text-blue-400 font-medium mb-0.5">Entry</div>
        <div className="text-[11px] font-mono font-bold text-white">{fmt(stock.entryPrice)}</div>
      </div>
      <div className="bg-emerald-500/10 rounded-lg p-1.5 border border-emerald-500/20">
        <div className="text-[9px] text-emerald-400 font-medium mb-0.5">Take Profit</div>
        <div className="text-[11px] font-mono font-bold text-emerald-400">{fmt(stock.takeProfitPrice)}</div>
      </div>
      <div className="bg-red-500/10 rounded-lg p-1.5 border border-red-500/20">
        <div className="text-[9px] text-red-400 font-medium mb-0.5">Stop Loss</div>
        <div className="text-[11px] font-mono font-bold text-red-400">{fmt(stock.stopLossPrice)}</div>
      </div>
    </div>
  )
}

/* ── StockCard ─────────────────────────────────────────────── */
function StockCard({ stock, onAnalyze, horizon }) {
  const [expanded, setExpanded] = useState(false)
  const { addStock, removeStock, hasSymbol } = useAIWatchlist()
  const verdict    = VERDICT_CONFIG[stock.agentVerdict]   || VERDICT_CONFIG['Buy']
  const confidence = CONFIDENCE_CONFIG[stock.confidence]  || CONFIDENCE_CONFIG['Medium']
  const inWatchlist = hasSymbol(stock.symbol)

  const toggleWatchlist = () => {
    if (inWatchlist) {
      removeStock(stock.symbol)
    } else {
      addStock({
        symbol:          stock.symbol,
        name:            stock.name,
        sector:          stock.sector,
        addedFrom:       'ai-brain',
        entryPrice:      stock.entryPrice,
        takeProfitPrice: stock.takeProfitPrice,
        stopLossPrice:   stock.stopLossPrice,
        targetReturn:    stock.targetReturn,
        stopLoss:        stock.stopLoss,
        horizon:         horizon || stock.horizon || '6m',
        verdict:         stock.agentVerdict,
        compositeScore:  stock.compositeScore,
      })
    }
  }

  return (
    <div className="glass rounded-2xl border border-white/[0.07] overflow-hidden hover:border-white/[0.12] transition-all">
      <div className="p-4">
        <div className="flex items-start gap-3">
          <div className="flex flex-col items-center gap-1 shrink-0">
            <span className="text-[10px] text-slate-600 font-mono">#{stock.rank}</span>
            <CompositeRing score={stock.compositeScore} />
          </div>

          <div className="flex-1 min-w-0">
            <div className="flex items-start justify-between gap-2 mb-2">
              <div>
                <button
                  onClick={() => onAnalyze?.(stock.symbol)}
                  className="font-mono font-black text-white text-base hover:text-mint-400 transition-colors leading-none"
                >
                  {stock.symbol}
                </button>
                <div className="text-[11px] text-slate-500 mt-0.5 truncate max-w-[140px]">{stock.name}</div>
              </div>
              <div className="flex flex-col items-end gap-1 shrink-0">
                <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full border ${verdict.bg} ${verdict.color} ${verdict.border}`}>
                  {stock.agentVerdict}
                </span>
                <span className={`flex items-center gap-1 text-[10px] ${confidence.color}`}>
                  <span className={`w-1.5 h-1.5 rounded-full ${confidence.dot}`} />
                  {stock.confidence}
                </span>
              </div>
            </div>

            <div className="flex gap-3 mb-3">
              <div className="flex items-center gap-1 text-[11px]">
                <Target className="w-3 h-3 text-emerald-400" />
                <span className="text-emerald-400 font-mono font-bold">+{stock.targetReturn}%</span>
              </div>
              <div className="flex items-center gap-1 text-[11px]">
                <Shield className="w-3 h-3 text-red-400" />
                <span className="text-red-400 font-mono font-bold">-{stock.stopLoss}%</span>
              </div>
              {stock.sector && (
                <span className="text-[10px] text-slate-500 bg-white/[0.04] px-1.5 py-0.5 rounded">{stock.sector}</span>
              )}
            </div>

            <div className="space-y-1.5">
              {AGENTS.map(a => (
                <ScoreBar key={a.key} agent={a} score={stock[a.scoreKey] ?? 0} />
              ))}
            </div>

            {/* Price levels */}
            <PriceLevels stock={stock} />

            {stock.keyDrivers?.length > 0 && (
              <div className="flex flex-wrap gap-1 mt-3">
                {stock.keyDrivers.map((d, i) => (
                  <span key={i} className="text-[10px] px-1.5 py-0.5 rounded bg-white/[0.04] text-slate-400">{d}</span>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Watchlist + expand row */}
        <div className="flex items-center gap-2 mt-3">
          <button
            onClick={toggleWatchlist}
            className={`flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-[10px] font-medium border transition-all ${
              inWatchlist
                ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'
                : 'bg-white/[0.04] text-slate-500 border-white/[0.07] hover:text-indigo-400 hover:border-indigo-500/30'
            }`}
          >
            {inWatchlist ? <BookmarkCheck className="w-3 h-3" /> : <Bookmark className="w-3 h-3" />}
            {inWatchlist ? 'Saved' : 'Save'}
          </button>
          <button
            onClick={() => setExpanded(v => !v)}
            className="flex-1 flex items-center justify-center gap-1 text-[10px] text-slate-600 hover:text-slate-400 transition-colors py-1"
          >
            {expanded ? <><ChevronUp className="w-3 h-3" /> Less</> : <><ChevronDown className="w-3 h-3" /> Agent Analysis</>}
          </button>
        </div>
      </div>

      {expanded && (
        <div className="border-t border-white/[0.06] px-4 pb-4 space-y-3 pt-3">
          {AGENTS.map(a => (
            <div key={a.key} className={`rounded-xl p-3 ${a.bg} border ${a.border}`}>
              <div className={`flex items-center gap-1.5 mb-1 text-[11px] font-semibold ${a.color}`}>
                <a.icon className="w-3 h-3" />
                {a.label} Agent
                <span className="ml-auto text-[10px] font-mono opacity-70">{stock[a.scoreKey]}/100</span>
              </div>
              <p className="text-[11px] text-slate-300 leading-relaxed">{stock[a.analysisKey]}</p>
            </div>
          ))}

          <div className="rounded-xl p-3 bg-mint-500/8 border border-mint-500/20">
            <div className="flex items-center gap-1.5 mb-1 text-[11px] font-semibold text-mint-400">
              <Brain className="w-3 h-3" />
              Supervisor Synthesis
            </div>
            <p className="text-[11px] text-slate-300 leading-relaxed">{stock.supervisorSynthesis}</p>
          </div>

          {stock.dissentingView && (
            <div className="flex items-start gap-2 text-[11px] text-amber-400/80 bg-amber-500/8 rounded-lg px-3 py-2">
              <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
              <span>{stock.dissentingView}</span>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ── AgentOrb ─────────────────────────────────────────────── */
function AgentOrb({ agent, active }) {
  const Icon = agent.icon
  return (
    <div className="flex flex-col items-center gap-1.5">
      <div className={`
        w-10 h-10 rounded-full flex items-center justify-center border transition-all duration-500
        ${active
          ? `${agent.bg} ${agent.border} ${agent.color} animate-pulse ring-2 ring-offset-1 ring-offset-[#070b14]`
          : 'bg-white/[0.03] border-white/[0.06] text-slate-600'
        }
      `}>
        <Icon className="w-4 h-4" />
      </div>
      <span className={`text-[9px] font-medium transition-colors ${active ? agent.color : 'text-slate-600'}`}>
        {agent.label}
      </span>
    </div>
  )
}

/* ── AgentNotesPanel ──────────────────────────────────────── */
function AgentNotesPanel({ notes }) {
  return (
    <div className="glass rounded-xl p-4 border border-white/[0.06]">
      <div className="flex items-center gap-2 mb-3">
        <Brain className="w-3.5 h-3.5 text-mint-400" />
        <span className="text-xs font-semibold text-mint-400">Agent Market Views</span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2">
        {AGENTS.map(a => (
          <div key={a.key} className={`rounded-lg p-2.5 ${a.bg} border ${a.border}`}>
            <div className={`flex items-center gap-1 mb-1 text-[10px] font-semibold ${a.color}`}>
              <a.icon className="w-2.5 h-2.5" />{a.label}
            </div>
            <p className="text-[10px] text-slate-400 leading-relaxed">{notes?.[a.noteKey]}</p>
          </div>
        ))}
      </div>
    </div>
  )
}

/* ── SymbolSearchInput ─────────────────────────────────────── */
function SymbolSearchInput({ value, onChange, onSubmit, disabled }) {
  return (
    <div className="flex items-center gap-2 p-3 rounded-xl bg-white/[0.03] border border-white/[0.08]">
      <Search className="w-4 h-4 text-slate-500 shrink-0" />
      <input
        type="text"
        value={value}
        onChange={e => onChange(e.target.value.toUpperCase())}
        onKeyDown={e => e.key === 'Enter' && !disabled && value.trim() && onSubmit?.()}
        disabled={disabled}
        placeholder="Custom symbols (e.g. NVDA,TSLA,BTC-USD) — press Enter or leave blank for scan mode"
        className="flex-1 bg-transparent text-sm text-white placeholder-slate-600 focus:outline-none font-mono disabled:opacity-40"
      />
      {value.trim() && !disabled && (
        <button
          onClick={onSubmit}
          className="flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg bg-indigo-500/20 text-indigo-400 border border-indigo-500/30 hover:bg-indigo-500/30 transition-all font-medium shrink-0"
        >
          <Brain className="w-3 h-3" /> Analyze
        </button>
      )}
      {value && (
        <button onClick={() => onChange('')} disabled={disabled} className="text-slate-500 hover:text-slate-300 shrink-0">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  )
}

/* ── Main view ────────────────────────────────────────────── */
export default function AIBrainView({ portfolio, onAnalyze }) {
  const [analysis,      setAnalysis]      = useState(null)
  const [loading,       setLoading]       = useState(false)
  const [error,         setError]         = useState(null)
  const [horizon,       setHorizon]       = useState('6m')
  const [scanMode,      setScanMode]      = useState('broad')
  const [activeAgent,   setActiveAgent]   = useState(-1)
  const [customSymbols, setCustomSymbols] = useState('')

  const holdings = portfolio?.positions?.map(p => p.symbol) ?? []

  const parseSymbols = (str) =>
    str.split(/[,\s]+/)
      .map(s => s.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, ''))
      .filter(Boolean)
      .slice(0, 20)

  const runAnalysis = useCallback(async () => {
    setLoading(true)
    setError(null)
    setAnalysis(null)
    setActiveAgent(0)

    const cycle = setInterval(() => {
      setActiveAgent(prev => (prev + 1) % (AGENTS.length + 1))
    }, 1800)

    try {
      const body = { horizon, holdings, scanMode }
      if (customSymbols.trim()) {
        body.symbols = parseSymbols(customSymbols)
        delete body.scanMode  // custom symbols override scan mode
      }
      const res  = await fetch('/api/ai-brain/analyze', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders() },
        body:    JSON.stringify(body),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Analysis failed')
      setAnalysis(data)
    } catch (e) {
      setError(e.message)
    } finally {
      clearInterval(cycle)
      setActiveAgent(-1)
      setLoading(false)
    }
  }, [horizon, holdings, customSymbols, scanMode])

  return (
    <div className="space-y-6 animate-fade-in">

      {/* ── Header ── */}
      <div className="flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-center gap-3">
          <div className="p-2.5 rounded-xl bg-indigo-500/10 border border-indigo-500/20">
            <Brain className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white">AI Brain</h1>
            <p className="text-xs text-slate-500">
              5-agent collaborative analysis · Fundamental · Technical · Sentiment · Macro · Risk
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0">
          {analysis && (
            <button
              onClick={() => exportAnalysisToPDF(analysis, horizon)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium bg-white/[0.04] text-slate-400 hover:text-white border border-white/[0.07] hover:border-white/[0.15] transition-all"
            >
              <Download className="w-3.5 h-3.5" /> Export PDF
            </button>
          )}

          <div className="flex gap-1">
            {HORIZON_OPTIONS.map(o => (
              <button
                key={o.value}
                onClick={() => setHorizon(o.value)}
                disabled={loading}
                className={`flex items-center gap-1 px-3 py-1.5 rounded-lg text-xs font-medium transition-all disabled:opacity-40 ${
                  horizon === o.value
                    ? 'bg-indigo-500/20 text-indigo-400 border border-indigo-500/30'
                    : 'bg-white/[0.03] text-slate-400 hover:text-white border border-white/[0.06]'
                }`}
              >
                <Clock className="w-3 h-3" />{o.label}
              </button>
            ))}
          </div>

          <button
            onClick={runAnalysis}
            disabled={loading}
            className="btn-primary flex items-center gap-2 disabled:opacity-50"
          >
            {loading
              ? <><RefreshCw className="w-4 h-4 animate-spin" /> Analyzing…</>
              : <><Brain className="w-4 h-4" /> {analysis ? 'Re-analyze' : 'Activate AI Brain'}</>
            }
          </button>
        </div>
      </div>

      {/* ── Scan mode selector ── */}
      {!customSymbols.trim() && (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-hide">
          {SCAN_MODES.map(m => {
            const Icon = m.icon
            const active = scanMode === m.id
            return (
              <button
                key={m.id}
                onClick={() => setScanMode(m.id)}
                disabled={loading}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium border whitespace-nowrap transition-all shrink-0 disabled:opacity-40 ${
                  active
                    ? `${m.bg} ${m.color} ${m.border}`
                    : 'bg-white/[0.03] text-slate-400 border-white/[0.07] hover:text-white'
                }`}
              >
                <Icon className="w-3 h-3" />
                {m.label}
              </button>
            )
          })}
        </div>
      )}
      {customSymbols.trim() && (
        <div className="text-[11px] text-slate-500 px-1">
          <span className="text-amber-400 font-medium">Custom symbols active</span> — scan mode overridden. Clear the search to use scan modes.
        </div>
      )}

      {/* ── Symbol search ── */}
      <SymbolSearchInput value={customSymbols} onChange={setCustomSymbols} onSubmit={runAnalysis} disabled={loading} />

      {/* ── Error ── */}
      {error && (
        <div className="flex items-start gap-3 p-4 rounded-xl bg-red-500/10 border border-red-500/25 text-red-400 text-sm">
          <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
          <span>{error}</span>
        </div>
      )}

      {/* ── Loading state ── */}
      {loading && (
        <div className="glass rounded-2xl p-10 text-center space-y-6">
          <div className="flex items-center justify-center gap-6 flex-wrap">
            {AGENTS.map((a, i) => (
              <AgentOrb key={a.key} agent={a} active={activeAgent === i} />
            ))}
          </div>

          <div className={`flex flex-col items-center gap-1.5 transition-all duration-500 ${
            activeAgent === AGENTS.length ? 'opacity-100' : 'opacity-30'
          }`}>
            <div className={`w-12 h-12 rounded-full flex items-center justify-center border ${
              activeAgent === AGENTS.length
                ? 'bg-mint-500/15 border-mint-500/30 text-mint-400 animate-pulse'
                : 'bg-white/[0.03] border-white/[0.06] text-slate-600'
            }`}>
              <Sparkles className="w-5 h-5" />
            </div>
            <span className={`text-[9px] font-medium ${activeAgent === AGENTS.length ? 'text-mint-400' : 'text-slate-600'}`}>
              Supervisor
            </span>
          </div>

          <div>
            <p className="text-white font-semibold text-sm">AI Brain is analyzing your universe…</p>
            <p className="text-slate-500 text-xs mt-1">
              {activeAgent < AGENTS.length && activeAgent >= 0
                ? `${AGENTS[activeAgent].label} agent is evaluating…`
                : 'Supervisor is synthesizing agent findings…'}
            </p>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 mt-4">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="glass rounded-2xl p-4 space-y-3 animate-pulse">
                <div className="flex gap-3">
                  <div className="w-14 h-14 rounded-full bg-white/[0.05]" />
                  <div className="flex-1 space-y-2 pt-1">
                    <div className="h-4 bg-white/[0.05] rounded w-16" />
                    <div className="h-3 bg-white/[0.04] rounded w-24" />
                    <div className="h-3 bg-white/[0.04] rounded w-20" />
                  </div>
                </div>
                <div className="space-y-1.5">
                  {AGENTS.map(a => <div key={a.key} className="h-2 bg-white/[0.04] rounded" />)}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ── Empty state ── */}
      {!loading && !analysis && !error && (
        <div className="glass rounded-2xl p-16 text-center space-y-5">
          <div className="flex items-center justify-center gap-4 flex-wrap mb-2">
            {AGENTS.map(a => (
              <div key={a.key} className={`w-10 h-10 rounded-full flex items-center justify-center ${a.bg} ${a.color} border ${a.border} opacity-40`}>
                <a.icon className="w-4 h-4" />
              </div>
            ))}
          </div>
          <div>
            <p className="text-white font-semibold">5 Specialized AI Agents, One Consensus</p>
            <p className="text-slate-500 text-sm mt-1 max-w-lg mx-auto">
              Fundamental, Technical, Sentiment, Macro, and Risk agents collaborate through a supervisor
              to score and rank stocks. Search custom symbols or use the default universe.
            </p>
          </div>
          <button onClick={runAnalysis} className="btn-primary flex items-center gap-2 mx-auto">
            <Brain className="w-4 h-4" /> Activate AI Brain
          </button>
        </div>
      )}

      {/* ── Results ── */}
      {!loading && analysis && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="glass rounded-xl p-4 border border-white/[0.06]">
              <div className="flex items-center gap-2 mb-1">
                <Activity className="w-3.5 h-3.5 text-indigo-400" />
                <span className="text-xs font-semibold text-indigo-400">Market Regime</span>
                <span className="ml-auto flex items-center gap-2">
                  {analysis.dataSource === 'live'
                    ? <span className="flex items-center gap-1 text-[10px] text-emerald-400"><span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />Live data</span>
                    : <span className="flex items-center gap-1 text-[10px] text-amber-400"><span className="w-1.5 h-1.5 rounded-full bg-amber-400" />Knowledge only</span>
                  }
                  <span className="text-[10px] text-slate-600">{new Date(analysis.processedAt).toLocaleTimeString()}</span>
                </span>
              </div>
              <p className="text-sm font-bold text-white mb-1">{analysis.marketRegime}</p>
              <p className="text-xs text-slate-400 leading-relaxed">{analysis.macroOutlook}</p>
            </div>
            <div className="glass rounded-xl p-4 border border-mint-500/15">
              <div className="flex items-center gap-2 mb-1">
                <Sparkles className="w-3.5 h-3.5 text-mint-400" />
                <span className="text-xs font-semibold text-mint-400">Agent Consensus</span>
              </div>
              <p className="text-sm text-slate-200 leading-relaxed">{analysis.agentConsensusTheme}</p>
              <p className="text-[10px] text-slate-600 mt-2">Universe: {analysis.universeAnalyzed?.join(', ')}</p>
            </div>
          </div>

          {analysis.agentNotes && <AgentNotesPanel notes={analysis.agentNotes} />}

          <div>
            <div className="flex items-center gap-2 mb-3">
              <Zap className="w-3.5 h-3.5 text-amber-400" />
              <span className="text-sm font-semibold text-white">
                Ranked Picks — {HORIZON_OPTIONS.find(o => o.value === analysis.horizon)?.label} Horizon
              </span>
              <span className="text-xs text-slate-500 ml-auto flex items-center gap-2">
                <DollarSign className="w-3 h-3" /> Entry · Target · Stop shown on each card
                <span className="text-slate-600">·</span>
                {analysis.rankedStocks.length} recommendations
              </span>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {analysis.rankedStocks.map((stock, i) => (
                <StockCard key={`${stock.symbol}-${i}`} stock={stock} onAnalyze={onAnalyze} horizon={horizon} />
              ))}
            </div>
          </div>

          <div className="text-center text-[11px] text-slate-600 border-t border-white/[0.04] pt-3">
            AI Brain analysis is for informational purposes only. Not financial advice.
            Multi-agent scoring does not guarantee future returns. Always conduct independent research.
          </div>
        </>
      )}
    </div>
  )
}
