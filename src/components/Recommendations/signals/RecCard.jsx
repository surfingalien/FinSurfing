import {
  AlertTriangle, Target, Shield, Zap, BarChart2,
  Bookmark, BookmarkCheck,
} from 'lucide-react'
import { useAIWatchlist } from '../../../hooks/useAIWatchlist'
import { TYPE_CONFIG } from './config'

const RISK_CONFIG = {
  Low:    { color: 'text-emerald-400', bg: 'bg-emerald-500/10', dot: 'bg-emerald-400' },
  Medium: { color: 'text-amber-400',   bg: 'bg-amber-500/10',   dot: 'bg-amber-400'   },
  High:   { color: 'text-red-400',     bg: 'bg-red-500/10',     dot: 'bg-red-400'     },
}

const PERIOD_CONFIG = {
  '3m': { label: '3-Month Hold', color: 'text-cyan-400',  bg: 'bg-cyan-500/10',  border: 'border-cyan-500/20'  },
  '6m': { label: '6-Month Hold', color: 'text-violet-400', bg: 'bg-violet-500/10', border: 'border-violet-500/20' },
}

/* ── Single recommendation card ─────────────────── */
export function RecCard({ rec, onAnalyze, liveQuote }) {
  const { addStock, removeStock, hasSymbol } = useAIWatchlist()
  const type     = TYPE_CONFIG[rec.type]    || TYPE_CONFIG.Stock
  const risk     = RISK_CONFIG[rec.risk]    || RISK_CONFIG.Medium
  const period   = PERIOD_CONFIG[rec.period] || PERIOD_CONFIG['3m']
  const inWatchlist = hasSymbol(rec.symbol)

  const toggleWatchlist = () => {
    if (inWatchlist) {
      removeStock(rec.symbol)
    } else {
      addStock({
        symbol:          rec.symbol,
        name:            rec.name,
        sector:          rec.sector,
        addedFrom:       rec.type === 'Fund' ? 'mutual-fund' : 'buy-signals',
        entryPrice:      rec.entryPrice      ?? null,
        takeProfitPrice: rec.takeProfitPrice ?? null,
        stopLossPrice:   rec.stopLossPrice   ?? null,
        targetReturn:    rec.targetReturn,
        stopLoss:        rec.stopLoss,
        horizon:         rec.period,
        verdict:         rec.risk + ' Risk',
      })
    }
  }

  return (
    <div className={`glass rounded-2xl p-4 border ${type.border} hover:brightness-105 transition-all`}>
      {/* Top row */}
      <div className="flex items-start justify-between gap-2 mb-3">
        <div className="flex items-center gap-2 min-w-0">
          <span className="text-lg">{type.emoji}</span>
          <div>
            <button
              onClick={() => onAnalyze?.(rec.symbol)}
              className="font-mono font-black text-white text-base hover:text-mint-400 transition-colors leading-none"
            >
              {rec.symbol}
            </button>
            <div className="text-xs text-slate-400 truncate max-w-[140px] mt-0.5">{rec.name}</div>
          </div>
        </div>
        <div className="flex flex-col items-end gap-1 shrink-0">
          <span className={`text-xs font-semibold px-2 py-0.5 rounded-full ${period.bg} ${period.color} border ${period.border}`}>
            {period.label}
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded-full flex items-center gap-1 ${risk.bg} ${risk.color}`}>
            <span className={`w-1.5 h-1.5 rounded-full ${risk.dot}`} />
            {rec.risk} Risk
          </span>
        </div>
      </div>

      {/* Live market price */}
      {liveQuote?.price != null && (
        <div className="flex items-center justify-between text-xs bg-white/[0.03] rounded-lg px-2.5 py-1.5 mb-3 border border-white/[0.05]">
          <span className="text-slate-500 text-[10px]">Live Price</span>
          <div className="flex items-center gap-2">
            <span className="font-mono font-bold text-white text-[11px]">${liveQuote.price.toFixed(2)}</span>
            {liveQuote.changePct != null && (
              <span className={`text-[10px] font-mono font-semibold ${liveQuote.changePct >= 0 ? 'text-emerald-400' : 'text-red-400'}`}>
                {liveQuote.changePct >= 0 ? '+' : ''}{liveQuote.changePct.toFixed(2)}%
              </span>
            )}
          </div>
        </div>
      )}

      {/* Return targets */}
      <div className="grid grid-cols-2 gap-2 mb-3">
        <div className="bg-white/[0.03] rounded-lg p-2 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5 flex items-center justify-center gap-1">
            <Target className="w-2.5 h-2.5" /> Target
          </div>
          <div className="text-emerald-400 font-mono font-bold text-sm">+{rec.targetReturn}%</div>
        </div>
        <div className="bg-white/[0.03] rounded-lg p-2 text-center">
          <div className="text-[10px] text-slate-500 mb-0.5 flex items-center justify-center gap-1">
            <Shield className="w-2.5 h-2.5" /> Stop Loss
          </div>
          <div className="text-red-400 font-mono font-bold text-sm">{rec.stopLoss}%</div>
        </div>
      </div>

      {/* Price targets */}
      {(rec.entryPrice || rec.takeProfitPrice || rec.stopLossPrice) && (
        <div className="grid grid-cols-3 gap-1.5 mt-2 text-center">
          <div className="bg-blue-500/10 rounded-lg p-1.5 border border-blue-500/20">
            <div className="text-[9px] text-blue-400 font-medium mb-0.5">Entry</div>
            <div className="text-[11px] font-mono font-bold text-white">{rec.entryPrice ? `$${rec.entryPrice.toFixed(2)}` : '—'}</div>
          </div>
          <div className="bg-emerald-500/10 rounded-lg p-1.5 border border-emerald-500/20">
            <div className="text-[9px] text-emerald-400 font-medium mb-0.5">Take Profit</div>
            <div className="text-[11px] font-mono font-bold text-emerald-400">{rec.takeProfitPrice ? `$${rec.takeProfitPrice.toFixed(2)}` : '—'}</div>
          </div>
          <div className="bg-red-500/10 rounded-lg p-1.5 border border-red-500/20">
            <div className="text-[9px] text-red-400 font-medium mb-0.5">Stop Loss</div>
            <div className="text-[11px] font-mono font-bold text-red-400">{rec.stopLossPrice ? `$${rec.stopLossPrice.toFixed(2)}` : '—'}</div>
          </div>
        </div>
      )}

      {/* Thesis */}
      <p className="text-xs text-slate-400 leading-relaxed mb-2">{rec.thesis}</p>

      {/* Catalyst + technical */}
      <div className="space-y-1">
        {rec.catalyst && (
          <div className="flex items-start gap-1.5 text-[11px]">
            <Zap className="w-3 h-3 text-mint-400 shrink-0 mt-0.5" />
            <span className="text-slate-400"><span className="text-mint-400 font-medium">Catalyst:</span> {rec.catalyst}</span>
          </div>
        )}
        {rec.technicalSignal && (
          <div className="flex items-start gap-1.5 text-[11px]">
            <BarChart2 className="w-3 h-3 text-indigo-400 shrink-0 mt-0.5" />
            <span className="text-slate-500">{rec.technicalSignal}</span>
          </div>
        )}
        {rec.bearCase && (
          <div className="flex items-start gap-1.5 text-[11px]">
            <AlertTriangle className="w-3 h-3 text-amber-400 shrink-0 mt-0.5" />
            <span className="text-slate-400"><span className="text-amber-400 font-medium">Bear: </span>{rec.bearCase}</span>
          </div>
        )}
        {rec.thesisBreaker && (
          <div className="flex items-start gap-1.5 text-[11px]">
            <Shield className="w-3 h-3 text-red-400 shrink-0 mt-0.5" />
            <span className="text-slate-400"><span className="text-red-400 font-medium">Breaker: </span>{rec.thesisBreaker}</span>
          </div>
        )}
      </div>

      {/* Footer: sector + watchlist */}
      <div className="flex items-center justify-between mt-3">
        {rec.sector
          ? <span className={`text-[10px] px-2 py-0.5 rounded-full ${type.bg} ${type.color}`}>{rec.sector}</span>
          : <span />
        }
        <button
          onClick={toggleWatchlist}
          className={`flex items-center gap-1 px-2 py-0.5 rounded-lg text-[10px] font-medium border transition-all ${
            inWatchlist
              ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30'
              : 'bg-white/[0.04] text-slate-500 border-white/[0.07] hover:text-indigo-400 hover:border-indigo-500/30'
          }`}
        >
          {inWatchlist ? <BookmarkCheck className="w-3 h-3" /> : <Bookmark className="w-3 h-3" />}
          {inWatchlist ? 'Saved' : 'Save'}
        </button>
      </div>
    </div>
  )
}
