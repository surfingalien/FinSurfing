import { useState } from 'react'
import { motion, AnimatePresence } from 'motion/react'
import {
  Brain, ChevronDown, ChevronUp, AlertTriangle,
  Target, Shield, Bookmark, BookmarkCheck,
} from 'lucide-react'
import { useAIWatchlist } from '../../../hooks/useAIWatchlist'
import { AGENTS, VERDICT_CONFIG, CONFIDENCE_CONFIG, VOLUME_SIGNAL } from './constants'
import { ScoreBar, CompositeRing, ConflictBanner, PriceZones, ThesisAssumptions } from './StockCardParts'

/* ── StockCard ─────────────────────────────────────────────── */
export default function StockCard({ stock, onAnalyze, horizon }) {
  const [expanded, setExpanded] = useState(false)
  const { addStock, removeStock, hasSymbol } = useAIWatchlist()
  const verdict    = VERDICT_CONFIG[stock.agentVerdict]   || VERDICT_CONFIG['Buy']
  const confidence = CONFIDENCE_CONFIG[stock.confidence]  || CONFIDENCE_CONFIG['Medium']
  const volSig     = VOLUME_SIGNAL[stock.volumeSignal]    || VOLUME_SIGNAL['Unknown']
  const inWatchlist = hasSymbol(stock.symbol)
  const conflictAgents = stock.agentConflict?.exists ? (stock.agentConflict.agents || []) : []

  const toggleWatchlist = () => {
    if (inWatchlist) {
      removeStock(stock.symbol)
    } else {
      addStock({
        symbol:          stock.symbol,
        name:            stock.name,
        sector:          stock.sector,
        addedFrom:       'ai-brain',
        entryZoneLow:    stock.entryZoneLow,
        entryZoneHigh:   stock.entryZoneHigh,
        targetZoneLow:   stock.targetZoneLow,
        targetZoneHigh:  stock.targetZoneHigh,
        targetReturn:    stock.targetReturn,
        stopLoss:        stock.stopLoss,
        horizon:         horizon || stock.horizon || '6m',
        verdict:         stock.agentVerdict,
        compositeScore:  stock.compositeScore,
      })
    }
  }

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="p-1 rounded-[1.5rem] bg-white/[0.015] ring-1 ring-white/[0.07] hover:ring-white/[0.12] transition-all"
    >
      <div className="glass rounded-[1.25rem] border border-white/[0.06] overflow-hidden shadow-[inset_0_1px_0_rgba(255,255,255,0.07)]">
      <div className="p-4">
        {/* Conflict banner inside card */}
        <ConflictBanner conflict={stock.agentConflict} />

        <div className={`flex items-start gap-3 ${stock.agentConflict?.exists ? 'mt-2.5' : ''}`}>
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

            <div className="flex gap-2 mb-3 flex-wrap">
              <div className="flex items-center gap-1 text-[11px]">
                <Target className="w-3 h-3 text-emerald-400" />
                <span className="text-emerald-400 font-mono font-bold">+{stock.targetReturn}%</span>
              </div>
              <div className="flex items-center gap-1 text-[11px]">
                <Shield className="w-3 h-3 text-red-400" />
                <span className="text-red-400 font-mono font-bold">-{stock.stopLoss}%</span>
              </div>
              {stock.volumeSignal && stock.volumeSignal !== 'Unknown' && (
                <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded ${volSig.bg} ${volSig.color}`}>
                  {volSig.label}
                </span>
              )}
              {stock.sector && (
                <span className="text-[10px] text-slate-500 bg-white/[0.04] px-1.5 py-0.5 rounded">{stock.sector}</span>
              )}
            </div>

            <div className="space-y-1.5">
              {AGENTS.map(a => (
                <ScoreBar key={a.key} agent={a} score={stock[a.scoreKey] ?? 0} conflictAgents={conflictAgents} />
              ))}
            </div>

            <PriceZones stock={stock} />

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
            {expanded ? <><ChevronUp className="w-3 h-3" /> Less</> : <><ChevronDown className="w-3 h-3" /> Full Analysis</>}
          </button>
        </div>
      </div>

      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            className="border-t border-white/[0.06] px-4 pb-4 space-y-3 pt-3 overflow-hidden"
          >
            {AGENTS.map(a => (
              <div key={a.key} className={`rounded-xl p-3 ${a.bg} border ${a.border}`}>
                <div className={`flex items-center gap-1.5 mb-1 text-[11px] font-semibold ${a.color}`}>
                  <a.icon className="w-3 h-3" />
                  {a.label} Agent
                  <span className="ml-auto text-[10px] font-mono opacity-70">{stock[a.scoreKey]}/100</span>
                  {conflictAgents.includes(a.label) && (
                    <span className="text-amber-400 text-[9px] px-1 rounded bg-amber-500/15 border border-amber-500/20">⚡ conflicted</span>
                  )}
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

            <ThesisAssumptions assumptions={stock.thesisAssumptions} />

            {stock.bearCase && (
              <div className="flex items-start gap-2 text-[11px] text-amber-400/80 bg-amber-500/8 rounded-lg px-3 py-2">
                <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-amber-400">Bear Case: </span>
                  <span>{stock.bearCase}</span>
                </div>
              </div>
            )}

            {stock.thesisBreaker && (
              <div className="flex items-start gap-2 text-[11px] text-red-400/80 bg-red-500/8 rounded-lg px-3 py-2">
                <Shield className="w-3 h-3 shrink-0 mt-0.5" />
                <div>
                  <span className="font-semibold text-red-400">Thesis Breaker: </span>
                  <span>{stock.thesisBreaker}</span>
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
      </div>
    </motion.div>
  )
}
