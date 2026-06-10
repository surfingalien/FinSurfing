/**
 * AIBrainView — Multi-agent AI stock analysis.
 *
 * Council improvements (2026-05-31):
 * - Supervisor rebuilt as contradiction engine — surfaces agent disagreements
 * - Confidence zones replace false-precision price targets
 * - Thesis assumptions shown in expanded view
 * - Volume signal indicator
 * - Data freshness displayed
 * - Prediction instrumentation (backend)
 */

import { useState, useCallback } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import {
  Brain, TrendingUp, RefreshCw, AlertTriangle,
  Zap, Activity, Clock, Download,
  LineChart, Bitcoin, GitFork, Layers, PieChart,
} from 'lucide-react'
import { exportAnalysisToPDF } from '../../utils/pdfExport'
import TrackRecordPanel from './TrackRecordPanel'
import {
  SCAN_MODES, FUND_SUBMODES, STOCK_SUBMODES, ETF_SUBMODES, CRYPTO_SUBMODES,
  getApiKeyHeaders, AGENTS, HORIZON_OPTIONS,
} from './scan/constants'
import StockCard from './scan/StockCard'
import AgentOrb from './scan/AgentOrb'
import AgentNotesPanel from './scan/AgentNotesPanel'
import SymbolSearchInput from './scan/SymbolSearchInput'

/* ── Main view ────────────────────────────────────────────── */
export default function AIBrainView({ portfolio, onAnalyze }) {
  const { accessToken } = useAuth()
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
        delete body.scanMode
      }
      const authHeader = accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
      const res  = await fetch('/api/ai-brain/analyze', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', ...getApiKeyHeaders(), ...authHeader },
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
  }, [horizon, holdings, customSymbols, scanMode, accessToken])

  // Count stocks with agent conflicts
  const conflictCount = analysis?.rankedStocks?.filter(s => s.agentConflict?.exists).length ?? 0

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
              Contradiction engine · Fundamental · Technical · Sentiment · Macro · Risk
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap">
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

      {/* ── Track record — measured accuracy, calibration, ensemble ── */}
      <TrackRecordPanel />

      {/* ── Scan mode selector ── */}
      {!customSymbols.trim() && (
        <div className="flex gap-1.5 overflow-x-auto pb-0.5 scrollbar-hide">
          {SCAN_MODES.map(m => {
            const Icon = m.icon
            const active = scanMode === m.id
              || (m.id === 'stocks'      && scanMode.startsWith('stocks'))
              || (m.id === 'etfs'        && scanMode.startsWith('etfs_'))
              || (m.id === 'crypto'      && scanMode.startsWith('crypto_'))
              || (m.id === 'mutualfunds' && scanMode.startsWith('mutualfunds'))
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

      {/* ── Sub-category pickers ── */}
      {(scanMode.startsWith('stocks') || scanMode.startsWith('mutualfunds') || scanMode.startsWith('etfs') || scanMode.startsWith('crypto')) && !customSymbols.trim() && (() => {
        const isStock  = scanMode === 'stocks' || scanMode.startsWith('stocks_')
        const isFund   = scanMode.startsWith('mutualfunds')
        const isEtf    = scanMode === 'etfs' || scanMode.startsWith('etfs_')
        const isCrypto = scanMode === 'crypto' || scanMode.startsWith('crypto_')
        const submodes = isStock ? STOCK_SUBMODES : isFund ? FUND_SUBMODES : isEtf ? ETF_SUBMODES : CRYPTO_SUBMODES
        const Icon     = isStock ? TrendingUp : isFund ? PieChart : isEtf ? LineChart : Bitcoin
        const label    = isStock ? 'Stock Sector (GICS)' : isFund ? 'Fund Category' : isEtf ? 'ETF Category' : 'Crypto Sector'
        const activeColor = isStock
          ? 'bg-sky-500/20 text-sky-300 border-sky-500/40'
          : isFund
            ? 'bg-teal-500/20 text-teal-300 border-teal-500/40'
            : isEtf
              ? 'bg-purple-500/20 text-purple-300 border-purple-500/40'
              : 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40'
        const hoverColor = isStock
          ? 'hover:text-sky-300 hover:border-sky-500/25'
          : isFund
            ? 'hover:text-teal-300 hover:border-teal-500/25'
            : isEtf
              ? 'hover:text-purple-300 hover:border-purple-500/25'
              : 'hover:text-yellow-300 hover:border-yellow-500/25'
        const panelStyle = isStock
          ? 'bg-sky-500/5 border-sky-500/15'
          : isFund
            ? 'bg-teal-500/5 border-teal-500/15'
            : isEtf
              ? 'bg-purple-500/5 border-purple-500/15'
              : 'bg-yellow-500/5 border-yellow-500/15'
        const headerColor = isStock ? 'text-sky-400/70' : isFund ? 'text-teal-400/70' : isEtf ? 'text-purple-400/70' : 'text-yellow-400/70'
        const activeSub = submodes.find(s => s.id === scanMode)
        return (
          <div className={`flex flex-col gap-2 p-3 rounded-xl border ${panelStyle}`}>
            <div className={`flex items-center gap-1.5 text-[10px] font-medium uppercase tracking-wider ${headerColor}`}>
              <Icon className="w-3 h-3" />
              {label}
            </div>
            <div className="flex gap-1.5 flex-wrap">
              {submodes.map(sub => (
                <button
                  key={sub.id}
                  onClick={() => setScanMode(sub.id)}
                  disabled={loading}
                  title={sub.description}
                  className={`px-3 py-1 rounded-lg text-xs font-medium border whitespace-nowrap transition-all disabled:opacity-40 ${
                    scanMode === sub.id
                      ? activeColor
                      : `bg-white/[0.03] text-slate-400 border-white/[0.07] ${hoverColor}`
                  }`}
                >
                  {sub.label}
                </button>
              ))}
            </div>
            {activeSub && (
              <div className="text-[10px] text-slate-500">{activeSub.description}</div>
            )}
          </div>
        )
      })()}

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
              <GitFork className="w-5 h-5" />
            </div>
            <span className={`text-[9px] font-medium ${activeAgent === AGENTS.length ? 'text-mint-400' : 'text-slate-600'}`}>
              Contradiction Engine
            </span>
          </div>

          <div>
            <p className="text-white font-semibold text-sm">AI Brain is analyzing your universe…</p>
            <p className="text-slate-500 text-xs mt-1">
              {activeAgent < AGENTS.length && activeAgent >= 0
                ? `${AGENTS[activeAgent].label} agent is evaluating…`
                : 'Contradiction engine is surfacing disagreements…'}
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
            <p className="text-white font-semibold">5 Specialized Agents · Contradiction Engine · Confidence Zones</p>
            <p className="text-slate-500 text-sm mt-1 max-w-lg mx-auto">
              When agents disagree, the spread is the signal. Agent conflicts, volume confirmation,
              thesis assumptions, and confidence zones — not false-precision price targets.
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
                  {analysis.dataAge === 'live'
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
                <GitFork className="w-3.5 h-3.5 text-mint-400" />
                <span className="text-xs font-semibold text-mint-400">Agent Consensus</span>
                {conflictCount > 0 && (
                  <span className="ml-auto text-[10px] text-amber-400 bg-amber-500/10 px-2 py-0.5 rounded border border-amber-500/20">
                    ⚡ {conflictCount} conflict{conflictCount > 1 ? 's' : ''} detected
                  </span>
                )}
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
                <Layers className="w-3 h-3" /> Zones · Assumptions · Conflicts
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
            Confidence zones and conflict signals do not guarantee future returns. Always conduct independent research.
            Predictions are logged for win-rate tracking.
          </div>
        </>
      )}
    </div>
  )
}
