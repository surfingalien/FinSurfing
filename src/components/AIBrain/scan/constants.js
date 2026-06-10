import { Globe, TrendingUp, LineChart, Bitcoin, PieChart, BarChart2, Eye, Shield } from 'lucide-react'

/* ── scan modes ────────────────────────────────────────────── */
export const SCAN_MODES = [
  { id: 'broad',      label: 'Broad Market',  icon: Globe,      color: 'text-mint-400',    bg: 'bg-mint-500/15',    border: 'border-mint-500/30'    },
  { id: 'stocks',     label: 'Stocks',        icon: TrendingUp, color: 'text-sky-400',     bg: 'bg-sky-500/15',     border: 'border-sky-500/30'     },
  { id: 'etfs',       label: 'ETFs',          icon: LineChart,  color: 'text-purple-400',  bg: 'bg-purple-500/15',  border: 'border-purple-500/30'  },
  { id: 'crypto',     label: 'Crypto',        icon: Bitcoin,    color: 'text-yellow-400',  bg: 'bg-yellow-500/15',  border: 'border-yellow-500/30'  },
  { id: 'mutualfunds', label: 'Mutual Funds', icon: PieChart,   color: 'text-teal-400',    bg: 'bg-teal-500/15',    border: 'border-teal-500/30'    },
]

/* ── sub-category modes ────────────────────────────────────── */
export const FUND_SUBMODES = [
  { id: 'mutualfunds',          label: 'All Funds',     description: 'Broad top 20 across all categories'     },
  { id: 'mutualfunds_index',    label: 'Index',         description: 'FXAIX, VFIAX, VTSAX, FZROX…'           },
  { id: 'mutualfunds_growth',   label: 'Growth',        description: 'FCNTX, FDGRX, AGTHX, CGMFX…'           },
  { id: 'mutualfunds_value',    label: 'Value',         description: 'DODGX, VIVAX, VEIPX, FLPSX…'           },
  { id: 'mutualfunds_sector',   label: 'Sector',        description: 'FSELX, FBIOX, FSPHX, FBSOX…'           },
  { id: 'mutualfunds_bond',     label: 'Bond / Fixed',  description: 'VBTLX, PTTAX, MWTRX, DODIX…'           },
  { id: 'mutualfunds_intl',     label: 'International', description: 'DODFX, VGTSX, PRIDX, FDIVX…'           },
  { id: 'mutualfunds_balanced', label: 'Balanced',      description: 'PRWCX, VWELX, FPURX, TRRIX…'           },
]

export const STOCK_SUBMODES = [
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

export const ETF_SUBMODES = [
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

export const CRYPTO_SUBMODES = [
  { id: 'crypto',          label: 'All Crypto',    description: 'Broad top 20 cross-category'              },
  { id: 'crypto_l1',       label: 'Layer 1',       description: 'BTC, ETH, SOL, ADA, AVAX, ATOM, NEAR…'   },
  { id: 'crypto_l2',       label: 'Layer 2',       description: 'MATIC, ARB, OP, IMX, LRC, MNT, STRK…'    },
  { id: 'crypto_defi',     label: 'DeFi',          description: 'UNI, AAVE, MKR, CRV, DYDX, GMX, LDO…'    },
  { id: 'crypto_ai',       label: 'AI & Data',     description: 'FET, OCEAN, AGIX, RNDR, WLD, GRT, TAO…'  },
  { id: 'crypto_meme',     label: 'Meme',          description: 'DOGE, SHIB, PEPE, BONK, WIF, FLOKI…'     },
  { id: 'crypto_infra',    label: 'Infrastructure',description: 'LINK, FIL, HNT, AR, STORJ, THETA, RLC…'  },
  { id: 'crypto_exchange', label: 'Exchange',      description: 'BNB, CRO, XRP, XLM, LTC, BCH, NEXO…'     },
]

export function getApiKeyHeaders() {
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
export const AGENTS = [
  { key: 'fundamental', label: 'Fundamental',  icon: BarChart2,  color: 'text-blue-400',   bg: 'bg-blue-500/15',   border: 'border-blue-500/25',   scoreKey: 'fundamentalScore', analysisKey: 'fundamentalAnalysis' },
  { key: 'technical',   label: 'Technical',    icon: TrendingUp, color: 'text-cyan-400',   bg: 'bg-cyan-500/15',   border: 'border-cyan-500/25',   scoreKey: 'technicalScore',   analysisKey: 'technicalAnalysis'  },
  { key: 'sentiment',   label: 'Sentiment',    icon: Eye,        color: 'text-purple-400', bg: 'bg-purple-500/15', border: 'border-purple-500/25', scoreKey: 'sentimentScore',   analysisKey: 'sentimentAnalysis'  },
  { key: 'macro',       label: 'Macro',        icon: Globe,      color: 'text-amber-400',  bg: 'bg-amber-500/15',  border: 'border-amber-500/25',  scoreKey: 'macroScore',       analysisKey: 'macroAnalysis'      },
  { key: 'risk',        label: 'Risk',         icon: Shield,     color: 'text-red-400',    bg: 'bg-red-500/15',    border: 'border-red-500/25',    scoreKey: 'riskScore',        analysisKey: 'riskNote'           },
]

export const AGENT_MAP = Object.fromEntries(AGENTS.map(a => [a.label, a]))

export const VERDICT_CONFIG = {
  'Strong Buy':   { color: 'text-emerald-400', bg: 'bg-emerald-500/15', border: 'border-emerald-500/30' },
  'Buy':          { color: 'text-mint-400',    bg: 'bg-mint-500/15',    border: 'border-mint-500/30'    },
  'Moderate Buy': { color: 'text-amber-400',   bg: 'bg-amber-500/15',   border: 'border-amber-500/25'   },
}

export const CONFIDENCE_CONFIG = {
  'High':   { color: 'text-emerald-400', dot: 'bg-emerald-400' },
  'Medium': { color: 'text-amber-400',   dot: 'bg-amber-400'   },
  'Low':    { color: 'text-slate-400',   dot: 'bg-slate-400'   },
}

export const HORIZON_OPTIONS = [
  { value: '3m',  label: '3 Month' },
  { value: '6m',  label: '6 Month' },
  { value: '12m', label: '12 Month' },
]

export const VOLUME_SIGNAL = {
  Confirming: { color: 'text-emerald-400', bg: 'bg-emerald-500/10', label: '↑ Vol Confirming' },
  Weak:       { color: 'text-amber-400',   bg: 'bg-amber-500/10',   label: '↓ Vol Weak'       },
  Diverging:  { color: 'text-red-400',     bg: 'bg-red-500/10',     label: '⚡ Vol Diverging'  },
  Unknown:    { color: 'text-slate-500',   bg: 'bg-white/[0.03]',   label: 'Vol Unknown'      },
}
