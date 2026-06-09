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
import { motion, AnimatePresence } from 'motion/react'
import {
  Brain, BarChart2, TrendingUp, Eye, Globe, Shield,
  Sparkles, RefreshCw, ChevronDown, ChevronUp, AlertTriangle,
  Target, Zap, Activity, Clock, CheckCircle2, Search,
  Bookmark, BookmarkCheck, Download, X, DollarSign,
  Cpu, HeartPulse, Zap as ZapEnergy, LineChart, Bitcoin,
  GitFork, Layers, Lock, TrendingDown, Volume2, PieChart,
} from 'lucide-react'
import { useAIWatchlist } from '../../hooks/useAIWatchlist'
import { exportAnalysisToPDF } from '../../utils/pdfExport'

/* ── scan modes ────────────────────────────────────────────── */
const SCAN_MODES = [
  { id: 'broad',      label: 'Broad Market',  icon: Globe,      color: 'text-mint-400',    bg: 'bg-mint-500/15',    border: 'border-mint-500/30'    },
  { id: 'stocks',     label: 'Stocks',        icon: TrendingUp, color: 'text-sky-400',     bg: 'bg-sky-500/15',     border: 'border-sky-500/30'     },
  { id: 'etfs',       label: 'ETFs',          icon: LineChart,  color: 'text-purple-400',  bg: 'bg-purple-500/15',  border: 'border-purple-500/30'  },
  { id: 'crypto',     label: 'Crypto',        icon: Bitcoin,    color: 'text-yellow-400',  bg: 'bg-yellow-500/15',  border: 'border-yellow-500/30'  },
  { id: 'mutualfunds', label: 'Mutual Funds', icon: PieChart,   color: 'text-teal-400',    bg: 'bg-teal-500/15',    border: 'border-teal-500/30'    },
]

/* ── sub-category modes ────────────────────────────────────── */
const FUND_SUBMODES = [
  { id: 'mutualfunds',          label: 'All Funds',     description: 'Broad top 20 across all categories'     },
  { id: 'mutualfunds_index',    label: 'Index',         description: 'FXAIX, VFIAX, VTSAX, FZROX…'           },
  { id: 'mutualfunds_growth',   label: 'Growth',        description: 'FCNTX, FDGRX, AGTHX, CGMFX…'           },
  { id: 'mutualfunds_value',    label: 'Value',         description: 'DODGX, VIVAX, VEIPX, FLPSX…'           },
  { id: 'mutualfunds_sector',   label: 'Sector',        description: 'FSELX, FBIOX, FSPHX, FBSOX…'           },
  { id: 'mutualfunds_bond',     label: 'Bond / Fixed',  description: 'VBTLX, PTTAX, MWTRX, DODIX…'           },
  { id: 'mutualfunds_intl',     label: 'International', description: 'DODFX, VGTSX, PRIDX, FDIVX…'           },
  { id: 'mutualfunds_balanced', label: 'Balanced',      description: 'PRWCX, VWELX, FPURX, TRRIX…'           },
]

const STOCK_SUBMODES = [
  { id: 'stocks',                label: 'All Sectors',       description: 'Top 20 US equities across all GICS sectors'   },
  { id: 'stocks_tech',           label: 'Technology',        description: 'NVDA, MSFT, AAPL, AMD, CRWD, ARM, AVGO…'      },
  { id: 'stocks_finance',        label: 'Financials',        description: 'JPM, GS, BAC, V, MA, BRK-B, BLK, KKR…'       },
  { id: 'stocks_healthcare',     label: 'Healthcare',        description: 'LLY, UNH, JNJ, ABBV, ISRG, VRTX, AMGN…'      },
  { id: 'stocks_energy',         label: 'Energy',            description: 'XOM, CVX, COP, SLB, EOG, HAL, VLO…'           },
  { id: 'stocks_consumer_disc',  label: 'Consumer Discr.',   description: 'AMZN, TSLA, HD, MCD, NKE, BKNG, SBUX…'        },
  { id: 'stocks_consumer_stap',  label: 'Consumer Staples',  description: 'PG, KO, PEP, WMT, COST, PM, CL, GIS…'         },
  { id: 'stocks_industrials',    label: 'Industrials',       description: 'CAT, DE, HON, RTX, GE, BA, UPS, LMT…'         },
  { id: 'stocks_materials',      label: 'Materials',         description: 'LIN, APD, ECL, FCX, NUE, VMC, PPG, DD…'        },
  { id: 'stocks_utilities',      label: 'Utilities',         description: 'NEE, DUK, SO, AWK, WEC, EXC, PEG, AES…'        },
  { id: 'stocks_realestate',     label: 'Real Estate',       description: 'AMT, PLD, EQIX, PSA, DLR, O, VICI, SPG…'      },
  { id: 'stocks_comms',          label: 'Communication',     description: 'GOOGL, META, DIS, NFLX, T, VZ, TMUS, EA…'     },
]

const ETF_SUBMODES = [
  { id: 'etfs',          label: 'All ETFs',      description: 'Broad cross-asset top 20'                  },
  { id: 'etfs_sector',   label: 'Sector',        description: 'XLK, XLE, XLF, XLV, XLI, XLY, XLU…'      },
  { id: 'etfs_broad',    label: 'Broad Market',  description: 'SPY, QQQ, VTI, IWM, VUG, VTV, SCHB…'      },
  { id: 'etfs_bond',     label: 'Bond / Fixed',  description: 'TLT, AGG, HYG, LQD, SHY, TIP, EMB…'       },
  { id: 'etfs_intl',     label: 'International', description: 'EEM, EFA, VEA, FXI, EWJ, IEMG, VWO…'      },
  { id: 'etfs_commodity',label: 'Commodities',   description: 'GLD, SLV, USO, DBA, GDX, PDBC, COPX…'     },
  { id: 'etfs_thematic', label: 'Thematic',      description: 'ARKK, ICLN, BOTZ, HACK, DRIV, PAVE…'      },
  { id: 'etfs_dividend', label: 'Dividend',      description: 'VYM, SCHD, HDV, DVY, NOBL, DGRW, VIG…'    },
  { id: 'etfs_bitcoin',  label: 'Bitcoin ETFs',  description: 'IBIT, FBTC, GBTC, ARKB, ETHA, BITO…'      },
]

const CRYPTO_SUBMODES = [
  { id: 'crypto',          label: 'All Crypto',    description: 'Broad top 20 cross-category'              },
  { id: 'crypto_l1',       label: 'Layer 1',       description: 'BTC, ETH, SOL, ADA, AVAX, ATOM, NEAR…'   },
  { id: 'crypto_l2',       label: 'Layer 2',       description: 'MATIC, ARB, OP, IMX, LRC, MNT, STRK…'    },
  { id: 'crypto_defi',     label: 'DeFi',          description: 'UNI, AAVE, MKR, CRV, DYDX, GMX, LDO…'    },
  { id: 'crypto_ai',       label: 'AI & Data',     description: 'FET, OCEAN, AGIX, RNDR, WLD, GRT, TAO…'  },
  { id: 'crypto_meme',     label: 'Meme',          description: 'DOGE, SHIB, PEPE, BONK, WIF, FLOKI…'     },
  { id: 'crypto_infra',    label: 'Infrastructure',description: 'LINK, FIL, HNT, AR, STORJ, THETA, RLC…'  },
  { id: 'crypto_exchange', label: 'Exchange',      description: 'BNB, CRO, XRP, XLM, LTC, BCH, NEXO…'     },
]

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

/* ── agent config ─────────────────────────────────────────── */
const AGENTS = [
  { key: 'fundamental', label: 'Fundamental',  icon: BarChart2,  color: 'text-blue-400',   bg: 'bg-blue-500/15',   border: 'border-blue-500/25',   scoreKey: 'fundamentalScore', analysisKey: 'fundamentalAnalysis' },
  { key: 'technical',   label: 'Technical',    icon: TrendingUp, color: 'text-cyan-400',   bg: 'bg-cyan-500/15',   border: 'border-cyan-500/25',   scoreKey: 'technicalScore',   analysisKey: 'technicalAnalysis'  },
  { key: 'sentiment',   label: 'Sentiment',    icon: Eye,        color: 'text-purple-400', bg: 'bg-purple-500/15', border: 'border-purple-500/25', scoreKey: 'sentimentScore',   analysisKey: 'sentimentAnalysis'  },
  { key: 'macro',       label: 'Macro',        icon: Globe,      color: 'text-amber-400',  bg: 'bg-amber-500/15',  border: 'border-amber-500/25',  scoreKey: 'macroScore',       analysisKey: 'macroAnalysis'      },
  { key: 'risk',        label: 'Risk',         icon: Shield,     color: 'text-red-400',    bg: 'bg-red-500/15',    border: 'border-red-500/25',    scoreKey: 'riskScore',        analysisKey: 'riskNote'           },
]

const AGENT_MAP = Object.fromEntries(AGENTS.map(a => [a.label, a]))

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

const VOLUME_SIGNAL = {
  Confirming: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', label: '↑ Vol Confirming' },
  Weak:       { color: 'text-amber-400',   bg: 'bg-amber-500/10',   label: '↓ Vol Weak'       },
  Diverging:  { color: 'text-red-400',     bg: 'bg-red-500/10',     label: '⚡ Vol Diverging'  },
  Unknown:    { color: 'text-slate-500',   bg: 'bg-white/[0.03]',   label: 'Vol Unknown'      },
}

/* ── ScoreBar ──────────────────────────────────────────────── */
function ScoreBar({ agent, score, conflictAgents = [] }) {
  const Icon = agent.icon
  const pct  = Math.min(100, Math.max(0, score))
  const barColor = pct >= 75 ? 'bg-emerald-400' : pct >= 50 ? 'bg-amber-400' : 'bg-red-400'
  const inConflict = conflictAgents.includes(agent.label)
  return (
    <div className={`flex items-center gap-2 ${inConflict ? 'ring-1 ring-amber-500/30 rounded px-1 -mx-1' : ''}`}>
      <div className={`flex items-center gap-1 w-[82px] shrink-0 ${agent.color}`}>
        <Icon className="w-3 h-3 shrink-0" />
        <span className="text-[10px] font-medium">{agent.label}</span>
        {inConflict && <span className="text-amber-400 text-[9px] ml-0.5">⚡</span>}
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

/* ── ConflictBanner ─────────────────────────────────────────── */
function ConflictBanner({ conflict }) {
  if (!conflict?.exists || conflict.spread < 25) return null
  const severity = conflict.spread >= 40 ? 'high' : 'medium'
  return (
    <motion.div
      initial={{ opacity: 0, y: -4 }}
      animate={{ opacity: 1, y: 0 }}
      className={`flex items-start gap-3 p-3 rounded-xl border text-xs ${
        severity === 'high'
          ? 'bg-amber-500/10 border-amber-500/30 text-amber-300'
          : 'bg-blue-500/8 border-blue-500/20 text-blue-300'
      }`}
    >
      <GitFork className={`w-3.5 h-3.5 shrink-0 mt-0.5 ${severity === 'high' ? 'text-amber-400' : 'text-blue-400'}`} />
      <div className="min-w-0">
        <span className={`font-bold ${severity === 'high' ? 'text-amber-400' : 'text-blue-400'}`}>
          Agent Conflict ({conflict.spread}pt spread):
        </span>{' '}
        <span className="font-medium">{conflict.agents?.[0]} vs {conflict.agents?.[1]}</span>
        {conflict.meaning && <span className="text-slate-400"> — {conflict.meaning}</span>}
      </div>
    </motion.div>
  )
}

/* ── PriceZones ────────────────────────────────────────────── */
function PriceZones({ stock }) {
  const hasZones = stock.entryZoneLow || stock.entryZoneHigh
  const hasFallback = stock.entryPrice
  if (!hasZones && !hasFallback) return null

  const fmt = (v) => v ? `$${Number(v).toFixed(2)}` : null

  if (hasZones) {
    return (
      <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
        <div className="bg-blue-500/10 rounded-lg p-1.5 border border-blue-500/20">
          <div className="text-[9px] text-blue-400 font-medium mb-0.5">Entry Zone</div>
          <div className="text-[10px] font-mono font-bold text-white leading-tight">
            {fmt(stock.entryZoneLow)}<br/><span className="text-slate-500">—</span><br/>{fmt(stock.entryZoneHigh)}
          </div>
        </div>
        <div className="bg-emerald-500/10 rounded-lg p-1.5 border border-emerald-500/20">
          <div className="text-[9px] text-emerald-400 font-medium mb-0.5">Target Zone</div>
          <div className="text-[10px] font-mono font-bold text-emerald-400 leading-tight">
            {fmt(stock.targetZoneLow)}<br/><span className="text-slate-500">—</span><br/>{fmt(stock.targetZoneHigh)}
          </div>
        </div>
        <div className="bg-red-500/10 rounded-lg p-1.5 border border-red-500/20">
          <div className="text-[9px] text-red-400 font-medium mb-0.5">Stop Zone</div>
          <div className="text-[10px] font-mono font-bold text-red-400 leading-tight">
            {fmt(stock.stopZoneLow)}<br/><span className="text-slate-500">—</span><br/>{fmt(stock.stopZoneHigh)}
          </div>
        </div>
      </div>
    )
  }

  // Fallback to legacy exact prices (older responses)
  return (
    <div className="mt-3 grid grid-cols-3 gap-1.5 text-center">
      <div className="bg-blue-500/10 rounded-lg p-1.5 border border-blue-500/20">
        <div className="text-[9px] text-blue-400 font-medium mb-0.5">Entry</div>
        <div className="text-[11px] font-mono font-bold text-white">{fmt(stock.entryPrice)}</div>
      </div>
      <div className="bg-emerald-500/10 rounded-lg p-1.5 border border-emerald-500/20">
        <div className="text-[9px] text-emerald-400 font-medium mb-0.5">Target</div>
        <div className="text-[11px] font-mono font-bold text-emerald-400">{fmt(stock.takeProfitPrice)}</div>
      </div>
      <div className="bg-red-500/10 rounded-lg p-1.5 border border-red-500/20">
        <div className="text-[9px] text-red-400 font-medium mb-0.5">Stop</div>
        <div className="text-[11px] font-mono font-bold text-red-400">{fmt(stock.stopLossPrice)}</div>
      </div>
    </div>
  )
}

/* ── ThesisAssumptions ─────────────────────────────────────── */
function ThesisAssumptions({ assumptions }) {
  if (!assumptions?.length) return null
  return (
    <div className="rounded-xl p-3 bg-indigo-500/8 border border-indigo-500/20">
      <div className="flex items-center gap-1.5 mb-2 text-[11px] font-semibold text-indigo-400">
        <Lock className="w-3 h-3" />
        Bull Case Assumptions
        <span className="text-[9px] text-slate-500 font-normal ml-1">— thesis breaks if these fail</span>
      </div>
      <ul className="space-y-1">
        {assumptions.map((a, i) => (
          <li key={i} className="flex items-start gap-2 text-[11px] text-slate-300">
            <span className="text-indigo-500 shrink-0 mt-0.5 font-mono">{i + 1}.</span>
            <span>{a}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

/* ── StockCard ─────────────────────────────────────────────── */
function StockCard({ stock, onAnalyze, horizon }) {
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
            <p className="text-[10px] text-slate-400 leading-relaxed">{notes?.[a.key === 'fundamental' ? 'fundamentalAnalyst' : a.key === 'technical' ? 'technicalAnalyst' : a.key === 'sentiment' ? 'sentimentAnalyst' : a.key === 'macro' ? 'macroEconomist' : 'riskManager']}</p>
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
