'use strict'
/**
 * routes/ai-brain.js
 *
 * POST /api/ai-brain/analyze
 * body: { symbols?, scanMode?, horizon?, holdings? }
 *
 * Council improvements applied (2026-05-31):
 * - Supervisor rebuilt as contradiction engine (surfaces agent disagreements)
 * - Price targets output as confidence zones, not false-precision numbers
 * - Agent reasoning expanded to 20 words with plain-language prose
 * - Thesis assumptions extracted (3 falsifiable conditions) for assumption-based staleness
 * - Prediction logging for future win-rate tracking
 */

const express             = require('express')
const rateLimit           = require('express-rate-limit')
const fs                  = require('fs')
const path                = require('path')
const { getRouter }       = require('../lib/ai-router')
const { CircuitOpenError } = require('../lib/circuit-breaker')
const { getSocialSentiment, getCryptoFearGreed } = require('../lib/social-sentiment')
const { getAltDataSnippet }  = require('../lib/alt-data')
const { getIndicators }      = require('./macro')
const { requireAuth }     = require('../middleware/auth')
const { getLearningsBlock } = require('../lib/brain-learnings')
const { compactTaLine }     = require('../lib/technical-indicators')
const { fetchDailyBars }    = require('../lib/internal-api')
const { tryParseAiJson }    = require('../lib/ai-json')
const { baselineFromBars }  = require('../lib/ml-baseline')

const router   = express.Router()
const aiRouter = getRouter('ai-brain')

const PREDICTION_LOG = path.join(__dirname, '../data/ai-brain-predictions.jsonl')

const brainLimit = rateLimit({
  windowMs: 5 * 60 * 1000, max: 4,
  skip:    (req) => {
    const addr = req.socket?.remoteAddress || ''
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  },
  message: { error: 'Too many AI Brain requests — wait a few minutes' },
})

// ── Curated universe per scan mode ───────────────────────────────────────────
const SCAN_UNIVERSES = {
  broad: [
    'NVDA','MSFT','AAPL','AMZN','GOOGL','META','TSLA','JPM','LLY','CRWD',
    'PLTR','AVGO','SPY','QQQ','GLD','ARKK','BTC-USD','ETH-USD','SOL-USD','BNB-USD',
  ],
  // ── Stock sector aliases (kept for backward compat, also used as sub-modes) ──
  tech: [
    'NVDA','MSFT','AAPL','GOOGL','META','AMZN','AMD','AVGO','CRM','ADBE',
    'SNOW','PLTR','CRWD','ANET','TSLA','SMCI','ARM','INTC','QCOM','MU',
  ],
  finance: [
    'JPM','BAC','WFC','GS','MS','V','MA','BRK-B','SCHW','AXP',
    'C','BLK','KKR','APO','SPGI','ICE','CME','PGR','CB','MET',
  ],
  healthcare: [
    'LLY','UNH','JNJ','ABBV','MRK','PFE','AMGN','ISRG','VRTX','REGN',
    'BMY','MRNA','CVS','CI','HUM','MDT','ABT','TMO','DHR','BSX',
  ],
  energy: [
    'XOM','CVX','COP','SLB','EOG','PXD','HAL','VLO','PSX','MPC',
    'DVN','FANG','OXY','HES','BKR','MRO','APA','NOV','FTI','CHK',
  ],
  // ── Stocks parent + all 11 GICS sectors ─────────────────────────────────────
  stocks: [
    // All-sector top 20 US equities
    'NVDA','MSFT','AAPL','AMZN','GOOGL','META','TSLA','JPM','LLY','CRWD',
    'BRK-B','UNH','JNJ','XOM','V','AVGO','MA','PG','HD','ABBV',
  ],
  stocks_tech: [
    'NVDA','MSFT','AAPL','GOOGL','META','AMZN','AMD','AVGO','CRM','ADBE',
    'SNOW','PLTR','CRWD','ANET','TSLA','SMCI','ARM','INTC','QCOM','MU',
  ],
  stocks_finance: [
    'JPM','BAC','WFC','GS','MS','V','MA','BRK-B','SCHW','AXP',
    'C','BLK','KKR','APO','SPGI','ICE','CME','PGR','CB','MET',
  ],
  stocks_healthcare: [
    'LLY','UNH','JNJ','ABBV','MRK','PFE','AMGN','ISRG','VRTX','REGN',
    'BMY','MRNA','CVS','CI','HUM','MDT','ABT','TMO','DHR','BSX',
  ],
  stocks_energy: [
    'XOM','CVX','COP','SLB','EOG','PXD','HAL','VLO','PSX','MPC',
    'DVN','FANG','OXY','HES','BKR','MRO','APA','NOV','FTI','CHK',
  ],
  stocks_consumer_disc: [
    // Consumer Discretionary
    'AMZN','TSLA','HD','MCD','NKE','TGT','SBUX','BKNG','LOW','CMG',
    'ABNB','ROST','TJX','YUM','DHI','LEN','F','GM','EBAY','ETSY',
  ],
  stocks_consumer_stap: [
    // Consumer Staples
    'PG','KO','PEP','WMT','COST','PM','MO','CL','EL','CHD',
    'GIS','K','CPB','HRL','SJM','MKC','CAG','HSY','TSN','KHC',
  ],
  stocks_industrials: [
    // Industrials
    'CAT','DE','HON','RTX','GE','BA','UPS','LMT','UNP','CSX',
    'NSC','FDX','ETN','ITW','PH','EMR','ROK','IEX','CARR','OTIS',
  ],
  stocks_materials: [
    // Materials
    'LIN','APD','ECL','FCX','NUE','VMC','MLM','IFF','PPG','EMN',
    'DD','DOW','CF','MOS','ALB','WRK','IP','PKG','SEE','BLL',
  ],
  stocks_utilities: [
    // Utilities
    'NEE','DUK','SO','D','AEE','AWK','WEC','EXC','PEG','ES',
    'EIX','PCG','AES','ETR','FE','CMS','NI','EVRG','PNW','ATO',
  ],
  stocks_realestate: [
    // Real Estate REITs
    'AMT','PLD','CCI','EQIX','PSA','DLR','O','WY','VTR','SPG',
    'AVB','EQR','ARE','VICI','NNN','EXR','INVH','MAA','UDR','CPT',
  ],
  stocks_comms: [
    // Communication Services
    'GOOGL','META','DIS','NFLX','CMCSA','T','VZ','CHTR','TMUS','EA',
    'TTWO','ATVI','WBD','FOXA','FOX','PARA','SNAP','PINS','MTCH','ZG',
  ],
  etfs: [
    'SPY','QQQ','GLD','TLT','IWM','VTI','ARKK','XLK','XLE','XLF',
    'XLV','XLI','XLY','AGG','HYG','EEM','EFA','VNQ','XLP','IBIT',
  ],
  // ── ETF sub-categories ──────────────────────────────────────
  etfs_sector: [
    // SPDR sector + specialty sector ETFs
    'XLK','XLE','XLF','XLV','XLI','XLY','XLP','XLU','XLB','XLRE',
    'XLC','XBI','XHB','XRT','XOP','KIE','XSD','XPH','XES','XNTK',
  ],
  etfs_broad: [
    // Broad market, size, and style index ETFs
    'SPY','QQQ','VTI','IWM','DIA','MDY','VUG','VTV','VO','VB',
    'SCHB','ITOT','SCHA','SCHX','SCHG','SCHV','MGK','MGV','SPMD','SPSM',
  ],
  etfs_bond: [
    // Investment-grade, high-yield, TIPS, duration
    'TLT','AGG','BND','HYG','LQD','SHY','IEF','TIP','VCIT','VCSH',
    'BKLN','JNK','VGSH','VGIT','VGLT','MBB','EMB','IAGG','SGOV','STIP',
  ],
  etfs_intl: [
    // Developed + emerging market international ETFs
    'EEM','EFA','VEA','VWO','FXI','EWJ','EWZ','IEMG','MCHI','ASHR',
    'EWU','EWG','EWY','EWT','EWA','EWC','EPOL','EWI','EWS','EDEN',
  ],
  etfs_commodity: [
    // Gold, silver, oil, agriculture, miners
    'GLD','SLV','USO','DBA','IAU','GDX','GDXJ','COPX','PDBC','UNG',
    'CORN','SOYB','WEAT','CPER','REMX','PICK','SLX','MOO','PALL','DBB',
  ],
  etfs_thematic: [
    // Innovation, AI, clean energy, cybersecurity, robotics
    'ARKK','ARKQ','ARKG','ARKF','ARKX','ICLN','BOTZ','HACK','DRIV','ROBO',
    'PAVE','KOMP','BLOK','FINX','IHAK','EDOC','MOON','BUZZ','METV','UFO',
  ],
  etfs_dividend: [
    // Dividend growth, high yield, income
    'VYM','SCHD','HDV','DVY','NOBL','DGRW','DGRO','VIG','SDY','SPYD',
    'SPHD','FVD','CDL','PFF','PFFD','IDV','REET','VNQ','O','MORT',
  ],
  etfs_bitcoin: [
    // Spot Bitcoin + Ethereum ETFs and crypto-linked
    'IBIT','FBTC','GBTC','ARKB','HODL','EZBC','BTCO','BRRR','BITO','BITI',
    'ETHA','FETH','CETH','ETHV','DEFI','WGMI','MSTR','COIN','CLSK','MARA',
  ],
  crypto: [
    'BTC-USD','ETH-USD','SOL-USD','BNB-USD','ADA-USD','DOGE-USD','XRP-USD',
    'AVAX-USD','DOT-USD','LINK-USD','MATIC-USD','UNI-USD',
  ],
  // ── Crypto sub-categories ───────────────────────────────────
  crypto_l1: [
    // Layer 1 smart-contract chains
    'BTC-USD','ETH-USD','SOL-USD','BNB-USD','ADA-USD','AVAX-USD','DOT-USD',
    'ATOM-USD','NEAR-USD','APT-USD','SUI-USD','TON-USD','ICP-USD','ALGO-USD',
    'FTM-USD','EGLD-USD','ONE-USD','WAVES-USD','HBAR-USD','EOS-USD',
  ],
  crypto_l2: [
    // Layer 2 scaling solutions and rollups
    'MATIC-USD','ARB-USD','OP-USD','IMX-USD','LRC-USD','MNT-USD',
    'STRK-USD','ZK-USD','METIS-USD','MANTA-USD','BOBA-USD','KAVA-USD',
    'CELO-USD','MOVR-USD','GLMR-USD','ROSE-USD','ASTR-USD','SCRT-USD',
    'CFG-USD','ACA-USD',
  ],
  crypto_defi: [
    // Decentralized finance protocols
    'UNI-USD','AAVE-USD','MKR-USD','COMP-USD','CRV-USD','SNX-USD',
    'YFI-USD','BAL-USD','SUSHI-USD','1INCH-USD','RUNE-USD','DYDX-USD',
    'GMX-USD','PENDLE-USD','CVX-USD','FXS-USD','LDO-USD','RPL-USD',
    'OSMO-USD','CAKE-USD',
  ],
  crypto_ai: [
    // AI, data, and machine-learning tokens
    'FET-USD','OCEAN-USD','AGIX-USD','RNDR-USD','WLD-USD','GRT-USD',
    'NMR-USD','TAO-USD','AKT-USD','ALT-USD','AIOZ-USD','CTXC-USD',
    'MATRIX-USD','DBC-USD','CLORE-USD','PAAL-USD','TURBO-USD','ARKM-USD',
    'MYRIA-USD','NGL-USD',
  ],
  crypto_meme: [
    // Meme and community-driven coins — major exchanges only
    'DOGE-USD','SHIB-USD','PEPE-USD','BONK-USD','FLOKI-USD','WIF-USD',
    'MEME-USD','TURBO-USD','BOME-USD','ORDI-USD','SATS-USD','NEIRO-USD',
    'BRETT-USD','APE-USD','BLUR-USD','GALA-USD','GMT-USD','LUNC-USD',
    'MANA-USD','SAND-USD',
  ],
  crypto_infra: [
    // Infrastructure, storage, DePIN, and oracle networks
    'LINK-USD','FIL-USD','HNT-USD','AR-USD','STORJ-USD','IOTX-USD',
    'RLC-USD','ANKR-USD','BAND-USD','API3-USD','RPL-USD','FLUX-USD',
    'COTI-USD','GLM-USD','CTSI-USD','NKN-USD','THETA-USD','TFUEL-USD',
    'AKT-USD','AIOZ-USD',
  ],
  crypto_exchange: [
    // Exchange tokens, payments, and major settlement networks
    'BNB-USD','CRO-USD','XRP-USD','XLM-USD','LTC-USD','BCH-USD',
    'XMR-USD','ZEC-USD','DASH-USD','WAVES-USD','OMG-USD','ZRX-USD',
    'BAT-USD','ENJ-USD','CHZ-USD','GAS-USD','NEXO-USD','STX-USD',
    'CFX-USD','NANO-USD',
  ],
  // ── Mutual fund category universes ──────────────────────────
  mutualfunds: [
    // Broad: top 20 across all categories
    'FXAIX','VFIAX','VTSAX','FCNTX','FDGRX','PRGFX','AGTHX',
    'PRWCX','DODGX','FSELX','FBIOX','DODFX','VBTLX','PTTAX',
    'VWELX','FPURX','TRBCX','VWUSX','CGMFX','OAKMX',
  ],
  mutualfunds_index: [
    // Best passive index funds — low cost, broad market
    'FXAIX','VFIAX','VTSAX','FSKAX','SWTSX','SWPPX','VEXAX',
    'FSMAX','FZROX','FZILX','FNILX','VITSX','VINIX','VBTLX',
    'FXNAX','SWAGX','SWISX','FBIIX','VGIT','VGSH',
  ],
  mutualfunds_growth: [
    // Top active growth managers
    'FCNTX','FDGRX','FBGRX','AGTHX','PRGFX','TRBCX','VWUSX',
    'CGMFX','FGRTX','RPMGX','MSEGX','VPMAX','AMRMX','SPECX',
    'ANCFX','GQEPX','MXXVX','PARNX','SEQUX','BIAWX',
  ],
  mutualfunds_value: [
    // Dividend-focused, deep value, and quality value
    'DODGX','FLPSX','VIVAX','VEIPX','VDIGX','DFDVX','FVDFX',
    'USAWX','BUFVX','AIVSX','MFVFX','VWNDX','RWGRX','HAINX',
    'TWVLX','PYVLX','AEPGX','CWGIX','DODFX','VEIRX',
  ],
  mutualfunds_sector: [
    // Sector-specific funds across all industries
    'FSELX','FBIOX','FSUTX','FSENX','FRESX','FSCPX','FSRPX',
    'FSCSX','FSPHX','FBSOX','FSHCX','FNARX','FSAIX','FSDCX',
    'FSNGX','FTRNX','FWWFX','FAGIX','RYREX','FSAVX',
  ],
  mutualfunds_bond: [
    // Investment-grade, high-yield, TIPS, and short-duration
    'VBTLX','VBMFX','FBNDX','PTTAX','PTTRX','LSBRX','MWTRX',
    'VWESX','OSTIX','DODIX','VWEAX','FBIDX','FXNAX','SWAGX',
    'MWTIX','PTRAX','FGOVX','FLTMX','FSTFX','VFIIX',
  ],
  mutualfunds_intl: [
    // Developed and emerging market international equity
    'DODFX','VGTSX','VFWIX','FSPSX','VTMGX','PRIDX','TBGVX',
    'FOSFX','FDIVX','FSIIX','VEUSX','VWILX','MGIEX','HAINX',
    'AEPGX','FIENX','MSFAX','CWGIX','VIHAX','PREMX',
  ],
  mutualfunds_balanced: [
    // Multi-asset allocation and balanced funds
    'PRWCX','VWELX','VWINX','FPURX','FBALX','TRRIX','DODBX',
    'BERIX','ABALX','PRSIX','TIBIX','GLRBX','MALOX','FMSDX',
    'VTHRX','VFORX','VFFVX','VTIVX','VTENX','FFNOX',
  ],
}

function fwdKeys(req) {
  const h = {}
  for (const k of ['x-aisa-key','x-finnhub-key','x-fmp-key','x-td-key','x-av-key']) {
    if (req.headers[k]) h[k] = req.headers[k]
  }
  return h
}

function fmtQuote(q) {
  if (!q?.regularMarketPrice) return null
  const price  = q.regularMarketPrice
  const chg    = q.regularMarketChangePercent
  const sign   = (chg ?? 0) >= 0 ? '+' : ''
  const pe     = q.trailingPE
  const fwdPe  = q.forwardPE
  const hi     = q.fiftyTwoWeekHigh
  const lo     = q.fiftyTwoWeekLow
  const cap    = q.marketCap
  const vol    = q.regularMarketVolume
  const avgVol = q.averageDailyVolume3Month
  const target = q.targetMedianPrice   // analyst consensus price target
  const recMean = q.recommendationMean // 1=Strong Buy → 5=Strong Sell
  const analysts = q.numberOfAnalystOpinions

  const chgStr    = chg != null ? ` (${sign}${chg.toFixed(2)}%)` : ''
  const volRatio  = (vol && avgVol) ? ` Vol=${(vol/avgVol).toFixed(2)}x avg` : ''
  const analystStr = target != null
    ? ` AnalystTarget=$${target.toFixed(0)}${analysts ? `(${analysts}×)` : ''}${recMean != null ? ` Rec=${recMean.toFixed(1)}` : ''}`
    : ''
  const peStr = fwdPe ? `fwdP/E=${fwdPe.toFixed(1)}` : pe ? `P/E=${pe.toFixed(1)}` : 'P/E=N/A'

  return (
    `${q.symbol}: $${price.toFixed(price >= 1 ? 2 : 6)}${chgStr}` +
    ` MktCap=${cap ? '$' + (cap / 1e9).toFixed(0) + 'B' : 'N/A'}` +
    ` ${peStr}` +
    ` 52w=$${lo?.toFixed(0) ?? '?'}-$${hi?.toFixed(0) ?? '?'}` +
    volRatio + analystStr
  )
}

// Fetch daily bars per symbol and compute one-line TA summaries for the prompt,
// plus the mechanical ML-baseline direction call from the same bars (logged with
// each prediction so calibration can compare AI picks against a dumb benchmark).
// Concurrency-limited so a 20-symbol scan doesn't stampede the data providers.
async function fetchTaSnapshot(universe, headers) {
  const bySymbol  = new Map()
  const baselines = new Map()
  const queue = [...universe]
  const workers = Array.from({ length: 5 }, async () => {
    while (queue.length) {
      const sym = queue.shift()
      // Missing TA for one symbol is non-fatal — fetchDailyBars returns [] on failure
      const bars = await fetchDailyBars(sym, { headers, timeoutMs: 12_000 })
      if (bars.length < 30) continue
      const line = compactTaLine(
        sym,
        bars.map(b => b.o ?? b.c), bars.map(b => b.h ?? b.c),
        bars.map(b => b.l ?? b.c), bars.map(b => b.c), bars.map(b => b.v),
      )
      if (line) bySymbol.set(sym, line)
      const baseline = baselineFromBars(bars)
      if (baseline) baselines.set(sym, baseline)
    }
  })
  // Overall time budget: return whatever resolved by 20s rather than letting a
  // slow provider stall the whole user-facing scan
  await Promise.race([
    Promise.all(workers),
    new Promise(resolve => setTimeout(resolve, 20_000)),
  ])
  // Preserve universe order for deterministic prompts
  return { lines: universe.map(s => bySymbol.get(s)).filter(Boolean), baselines }
}

// Write a prediction record for future win-rate tracking
function logPrediction(symbol, agents, zones, generatedAt, baseline = null) {
  try {
    const dir = path.dirname(PREDICTION_LOG)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const record = JSON.stringify({
      symbol, generatedAt,
      fundamentalScore:  agents.fundamentalScore,
      technicalScore:    agents.technicalScore,
      sentimentScore:    agents.sentimentScore,
      macroScore:        agents.macroScore,
      riskScore:         agents.riskScore,
      compositeScore:    agents.compositeScore,
      confidence:        agents.confidence ?? null,
      priceAtPrediction: agents.currentPrice ?? null,
      // true = both models picked it with matching verdict; false = primary-only
      // pick during an ensemble scan; null = no ensemble ran
      ensembleConfirmed: agents.ensemble ? (agents.ensemble.confirmed && agents.ensemble.verdictMatch === true) : null,
      entryZoneLow:      zones?.entryZoneLow  ?? null,
      entryZoneHigh:     zones?.entryZoneHigh ?? null,
      entryZoneMid:      zones?.entryZoneLow != null ? (zones.entryZoneLow + zones.entryZoneHigh) / 2 : null,
      targetZoneMid:     zones?.targetZoneLow != null ? (zones.targetZoneLow + zones.targetZoneHigh) / 2 : null,
      verdict:           agents.agentVerdict,
      thesisAssumptions: agents.thesisAssumptions ?? [],
      agentConflict:     agents.agentConflict ?? null,
      supervisorNote:    agents.supervisorSynthesis ?? null,
      // Signals logged for future calibration analysis
      volumeSignal:      agents.volumeSignal ?? null,
      daysToEarnings:    agents.daysToEarnings ?? null,
      catalyst:          agents.catalyst ?? null,
      // Mechanical ML-baseline 7d direction call from the same bars the scan
      // saw (lib/ml-baseline.js) — lets calibration compare AI vs baseline
      baselineProb:     baseline?.prob ?? null,
      baselineDir:      baseline?.dir ?? null,
      baselineFeatures: baseline?.features ?? null,
      // outcome fields filled later by a scheduled job
      price7d: null, price30d: null, price90d: null,
    })
    fs.appendFileSync(PREDICTION_LOG, record + '\n')
  } catch { /* non-fatal */ }
}

router.post('/analyze', requireAuth, brainLimit, async (req, res) => {
  if (process.env.AI_BRAIN_DISABLED === 'true')
    return res.status(503).json({ error: 'AI Brain is temporarily disabled (kill switch active)', killSwitch: true })

  const {
    symbols,
    scanMode = 'broad',
    horizon  = '6m',
    holdings = [],
  } = req.body

  if (!['3m','6m','12m'].includes(horizon))
    return res.status(400).json({ error: 'horizon must be 3m, 6m, or 12m' })

  const baseList = (symbols?.length && Array.isArray(symbols))
    ? symbols.map(s => String(s).toUpperCase().replace(/[^A-Z0-9.-]/g, '')).filter(Boolean)
    : (SCAN_UNIVERSES[scanMode] || SCAN_UNIVERSES.broad)

  const universe     = [...new Set(baseList)].slice(0, 20)
  const holdingStr   = holdings.length ? holdings.join(', ') : 'none'
  const horizonLabel = { '3m': '3-month', '6m': '6-month', '12m': '12-month' }[horizon]
  const generatedAt  = new Date().toISOString()
  const todayLabel   = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  // ── Sub-agent 1: data fetch — all sources in parallel ────────────────────────
  let marketSnippet   = ''
  let liveQuotes      = []
  let socialSnippet   = ''

  const port = process.env.PORT || 3001
  const isCryptoScan = scanMode.startsWith('crypto')
  const isStockScan  = !isCryptoScan && !scanMode.startsWith('etfs') && !scanMode.startsWith('mutualfunds')
  const stockSyms    = universe.filter(s => !s.includes('-') && !s.includes('='))

  const [quoteResult, socialResult, earningsResult, taResult, macroResult, altDataResult, fngResult] = await Promise.allSettled([
    (async () => {
      const r = await fetch(
        `http://127.0.0.1:${port}/api/quote?symbols=${universe.join(',')}`,
        { headers: fwdKeys(req), signal: AbortSignal.timeout(30_000) }
      )
      const qd = await r.json()
      return qd?.quoteResponse?.result ?? []
    })(),
    getSocialSentiment(universe.slice(0, 8)),
    // Fetch upcoming earnings dates for stock symbols only (not crypto/ETFs)
    (async () => {
      if (!stockSyms.length) return null
      const r = await fetch(
        `http://127.0.0.1:${port}/api/earnings/calendar?symbols=${stockSyms.join(',')}`,
        { headers: fwdKeys(req), signal: AbortSignal.timeout(10_000) }
      )
      return r.json()
    })(),
    fetchTaSnapshot(universe, fwdKeys(req)),
    // FRED macro indicators — gracefully skipped when FRED_API_KEY not set
    getIndicators().catch(() => null),
    // Alt-data (OpenInsider + FINRA short interest) for stock scans only
    isStockScan && stockSyms.length
      ? Promise.all(stockSyms.slice(0, 15).map(s => getAltDataSnippet(s).catch(() => null)))
      : Promise.resolve(null),
    // Crypto Fear & Greed Index for crypto scans
    isCryptoScan ? getCryptoFearGreed().catch(() => null) : Promise.resolve(null),
  ])

  if (quoteResult.status === 'fulfilled') {
    liveQuotes = quoteResult.value
  } else {
    console.warn('[ai-brain] Quote fetch failed, knowledge-only mode:', quoteResult.reason?.message)
  }

  if (socialResult.status === 'fulfilled') {
    socialSnippet = socialResult.value
  }

  // Server-computed technical indicators (RSI/MACD/EMA/S-R/volume per symbol)
  let taSnippet = ''
  const taBaselines = (taResult.status === 'fulfilled' && taResult.value.baselines) || new Map()
  if (taResult.status === 'fulfilled' && taResult.value.lines.length) {
    taSnippet = '\n\nCOMPUTED TECHNICALS (server-calculated from daily bars — authoritative; base technicalScore on these, do not invent indicator values):\n'
      + taResult.value.lines.join('\n')
  }

  // FRED macro regime snapshot
  let macroSnippet = ''
  if (macroResult.status === 'fulfilled' && macroResult.value?.macroSummary) {
    macroSnippet = '\n\nMACRO REGIME (FRED live data — use to anchor macroScore and macroAnalysis):\n' + macroResult.value.macroSummary
  }

  // Alt-data: OpenInsider + FINRA short interest
  let altDataSnippet = ''
  if (altDataResult.status === 'fulfilled' && Array.isArray(altDataResult.value)) {
    const parts = altDataResult.value.filter(Boolean)
    if (parts.length) altDataSnippet = '\n' + parts.join('\n')
  }

  // Crypto Fear & Greed Index
  if (fngResult.status === 'fulfilled' && fngResult.value?.snippet) {
    macroSnippet = (macroSnippet || '\n\nMACRO REGIME:') + '\n  ' + fngResult.value.snippet
  }

  // Build earnings catalyst snippet
  let earningsSnippet = ''
  if (earningsResult.status === 'fulfilled' && earningsResult.value?.upcoming?.length) {
    const upcoming = earningsResult.value.upcoming.slice(0, 8)
    earningsSnippet = '\n\nUPCOMING EARNINGS CATALYSTS (use to weight near-term risk/reward):\n'
      + upcoming.map(e => {
          const days = Math.round((new Date(e.nextEarningsDate) - Date.now()) / 86400000)
          const urgency = days <= 7 ? '⚠️ IMMINENT' : days <= 21 ? '📅 Soon' : '📅'
          const eps = e.epsEstimate ? ` · EPS est $${e.epsEstimate}` : ''
          return `  ${urgency} ${e.symbol}: ${e.nextEarningsDate} (${days}d)${eps}`
        }).join('\n')
  }

  const validQuotes = liveQuotes.filter(q => q?.regularMarketPrice != null && q.regularMarketPrice > 0)
  const missingSyms = universe.filter(s => !validQuotes.find(q => q.symbol === s))
  const dataAge     = validQuotes.length ? 'live' : 'knowledge'

  if (validQuotes.length > 0) {
    marketSnippet = '\n\nLIVE SNAPSHOT (prices + volume ratio vs 3-month avg — use as primary source):\n'
      + validQuotes.map(fmtQuote).join('\n')
    if (missingSyms.length)
      marketSnippet += `\n\nNo live data for: ${missingSyms.join(', ')} — use training knowledge.`
  } else {
    marketSnippet = '\n\nNote: No live market data available — use training knowledge for prices.'
  }

  // ── Step 2: prompt — contradiction engine + zones + assumptions ────────────
  const learningsBlock = getLearningsBlock()
  const prompt = `You are a 5-agent investment AI with a Supervisor whose job is to SURFACE CONTRADICTIONS, not average scores.${learningsBlock}
${socialSnippet}

CRITICAL: When two agents disagree by 25+ points, that spread IS the primary signal. Do not smooth it. Surface it.

Analyze this universe for a ${horizonLabel} horizon. Today is ${todayLabel}.
Universe: ${universe.join(', ')}
Avoid holdings: ${holdingStr}
${scanMode.startsWith('mutualfunds') ? `\nNOTE: This universe contains mutual funds (category: ${scanMode === 'mutualfunds' ? 'Broad All-Category' : scanMode.replace('mutualfunds_','').toUpperCase()}). Score each fund on: (1) Fundamental = portfolio holdings quality, manager tenure & track record, alpha vs benchmark, (2) Technical = NAV trend, momentum, and performance relative to category peers, (3) Sentiment = fund flows, retail/institutional demand, manager commentary, (4) Macro = asset-class fit for current rate/growth/inflation regime, (5) Risk = expense ratio, max drawdown, concentration risk, redemption risk. Price targets refer to NAV zones. Omit stop-loss precision — use downside risk zones only.` : ''}${scanMode.startsWith('etfs_') ? `\nNOTE: This is an ETF sub-category scan (${scanMode.replace('etfs_','').toUpperCase()}). Scoring focus: (1) Fundamental = underlying index quality, holdings composition, expense ratio vs peers, (2) Technical = ETF price trend & momentum, discount/premium to NAV, options flow if available, (3) Sentiment = fund flows, AUM trend, institutional rotation signals, (4) Macro = how well this ETF category fits the current rate/sector/growth regime, (5) Risk = liquidity, tracking error, concentration, leverage if any.` : ''}${scanMode.startsWith('crypto_') ? `\nNOTE: This is a crypto sub-category scan (${scanMode.replace('crypto_','').toUpperCase()}). Scoring focus: (1) Fundamental = protocol TVL, revenue, developer activity, tokenomics, (2) Technical = price trend vs BTC, momentum, on-chain volume signal, (3) Sentiment = social dominance, whale flows, exchange inflows/outflows, (4) Macro = correlation to BTC cycle stage, risk-on/off regime, regulatory climate, (5) Risk = smart contract risk, liquidity depth, centralization risk. Consider current crypto market cycle phase.` : ''}${scanMode.startsWith('stocks_') ? `\nNOTE: This is a stock sector scan (GICS Sector: ${scanMode.replace('stocks_','').replace(/_/g,' ').toUpperCase()}). Scoring focus: (1) Fundamental = earnings growth, margins, valuation vs sector peers, balance sheet quality, (2) Technical = price trend, relative strength vs S&P 500, breakout/breakdown levels, (3) Sentiment = analyst upgrades/downgrades, short interest, insider activity, (4) Macro = sector-specific tailwinds/headwinds in the current rate/growth regime, (5) Risk = concentration risk, regulatory exposure, competitive moat strength.` : ''}
${marketSnippet}${macroSnippet}${taSnippet}${earningsSnippet}${altDataSnippet}

⚠️ STRICT TOKEN BUDGET — respect every word limit or the response will be truncated.

Respond ONLY with valid JSON (no markdown, no text outside the JSON object):
{
  "marketRegime": "≤5 words",
  "macroOutlook": "≤15 words",
  "agentConsensusTheme": "≤12 words",
  "dataSource": "live|knowledge",
  "rankedStocks": [
    {
      "rank": 1,
      "symbol": "TICKER",
      "name": "Company name",
      "sector": "Sector",
      "type": "Stock|ETF|Crypto",
      "currentPrice": 0.0,
      "compositeScore": 0,
      "confidence": "High|Medium|Low",
      "agentVerdict": "Strong Buy|Buy|Moderate Buy",
      "targetReturn": 0,
      "stopLoss": 0,
      "entryZoneLow": 0.0,
      "entryZoneHigh": 0.0,
      "targetZoneLow": 0.0,
      "targetZoneHigh": 0.0,
      "stopZoneLow": 0.0,
      "stopZoneHigh": 0.0,
      "fundamentalScore": 0,
      "technicalScore": 0,
      "sentimentScore": 0,
      "macroScore": 0,
      "riskScore": 0,
      "fundamentalAnalysis": "≤20 words plain prose — specific valuation/earnings reasoning",
      "technicalAnalysis": "≤20 words plain prose — specific price/volume/momentum reasoning",
      "sentimentAnalysis": "≤20 words plain prose — specific news/flow/positioning reasoning",
      "macroAnalysis": "≤20 words plain prose — specific macro/sector tailwind or headwind",
      "riskNote": "≤20 words plain prose — specific downside scenario",
      "supervisorSynthesis": "≤20 words — if agents agree, say so; if they conflict, say which two and why it matters",
      "agentConflict": {
        "exists": true,
        "agents": ["Agent1","Agent2"],
        "spread": 0,
        "meaning": "≤15 words — what this disagreement signals for timing/sizing"
      },
      "thesisAssumptions": [
        "≤10 words — falsifiable assumption 1",
        "≤10 words — falsifiable assumption 2",
        "≤10 words — falsifiable assumption 3"
      ],
      "volumeSignal": "Confirming|Weak|Diverging|Unknown",
      "highConviction": false,
      "catalyst": "≤10 words — specific near-term event or trigger driving the thesis NOW",
      "keyDrivers": ["≤4 words","≤4 words"],
      "bearCase": "≤10 words — primary downside risk",
      "thesisBreaker": "≤8 words — event that invalidates this pick"
    }
  ],
  "agentNotes": {
    "fundamentalAnalyst": "≤15 words",
    "technicalAnalyst": "≤15 words",
    "sentimentAnalyst": "≤15 words",
    "macroEconomist": "≤15 words",
    "riskManager": "≤15 words"
  }
}

Rules:
- Include up to 20 top picks ranked by compositeScore; prefer symbols NOT already in holdings
- compositeScore = weighted avg (fundamental 25%, technical 20%, sentiment 15%, macro 20%, risk 20%)
- All scores 0-100; riskScore: higher = safer
- fundamentalScore: boost +10 when AnalystTarget from LIVE SNAPSHOT is >15% above current price with ≥5 analysts (shown as "AnalystTarget=$xxx(Nx)"); cut -10 when analyst target is below current price
- sentimentScore: boost +8 when INSIDER ACTIVITY shows "🟢 net buying"; cut -8 when it shows "🔴 net selling"; boost +5 when Reddit/social sentiment is bullish (>55% bullish posts by upvote weight); cut -5 when FINRA short ratio >15%
- riskScore: cut -15 when earnings ≤7 days away (binary binary event); cut -8 when earnings 8–21 days away; cut -10 for IMMINENT short squeeze risk (high short interest + rising price)
- macroScore: use FRED regime context — cut -10 in rate-rising / credit-spread-widening regime for rate-sensitive sectors
- agentConflict.exists = true when ANY two agent scores differ by ≥25 points
- agentConflict.agents = the two most-divergent agents
- Price zones: entryZoneLow/High = ±2% around ideal entry; targetZoneLow/High = ±3% around target; stopZoneLow/High = ±1.5% around stop
- volumeSignal: "Confirming" if vol > 1.1x avg and price trending up; "Weak" if vol < 0.8x; "Diverging" if vol rising but price falling (or vice versa); "Unknown" if no data
- highConviction: set true ONLY when ≥3 of these independent confirming signals are present: (1) net insider buying in last 90d, (2) analyst target >15% upside with ≥5 analysts, (3) volumeSignal=Confirming, (4) compositeScore ≥ 80, (5) ensemble cross-model confirmed, (6) macroScore ≥ 75 (clear macro tailwind); otherwise false
- catalyst: the single most time-sensitive trigger for this pick (e.g. "earnings beat expected next week", "Fed pivot boosts rate-sensitive sector", "breakout above 200-day MA"); required for all picks
- thesisAssumptions: 3 specific, falsifiable conditions that must hold for the bull case to play out
- dataSource: "live" if snapshot provided, else "knowledge"
- STRICTLY respect all ≤N word limits`

  // ── Sub-agent 2: signal generation ───────────────────────────────────────────
  // When Groq is configured, both models scan INDEPENDENTLY in parallel and
  // cross-model agreement becomes a signal (logged for calibration tracking).
  // Claude remains primary; a failed second opinion never fails the scan.
  let raw        = ''
  let llmUsed    = 'claude'
  let secondText = null

  try {
    if (process.env.GROQ_API_KEY) {
      const [pri, sec] = await Promise.allSettled([
        aiRouter.call({ prompt, maxTokens: 16000, symbols: universe }),
        aiRouter.callGroq({ prompt, maxTokens: 16000, symbols: universe }),
      ])
      if (pri.status === 'rejected') throw pri.reason
      raw     = pri.value.text
      llmUsed = pri.value.llmUsed
      // If Claude was overloaded and fell back to Groq, the "second opinion"
      // is the same model — agreement would be meaningless, so skip it.
      if (sec.status === 'fulfilled' && llmUsed !== 'groq') secondText = sec.value.text
    } else {
      const result = await aiRouter.call({ prompt, maxTokens: 16000, symbols: universe })
      raw     = result.text
      llmUsed = result.llmUsed
    }
  } catch (err) {
    if (err instanceof CircuitOpenError) return res.status(503).json({ error: err.message, circuitOpen: true })
    if (err.status === 503)             return res.status(503).json({ error: err.message })
    console.error('[ai-brain]', err.message)
    return res.status(500).json({ error: 'AI Brain analysis failed: ' + err.message })
  }

  try {
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      const m = raw.match(/\{[\s\S]*\}/)
      if (!m) {
        console.error('[ai-brain] No JSON found in response. First 300 chars:', raw.slice(0, 300))
        return res.status(500).json({ error: 'AI Brain returned no parseable JSON — try again' })
      }
      try {
        data = JSON.parse(m[0])
      } catch {
        console.error('[ai-brain] JSON parse failed (likely truncated). raw length:', raw.length)
        return res.status(500).json({ error: 'AI Brain response was truncated — reduce symbols or try again' })
      }
    }

    if (!Array.isArray(data.rankedStocks) || !data.rankedStocks.length)
      return res.status(500).json({ error: 'AI Brain returned no ranked stocks — try again' })

    // ── Cross-model agreement — annotate each pick with the second opinion ────
    let ensemble = null
    if (secondText) {
      const second = tryParseAiJson(secondText)
      if (Array.isArray(second?.rankedStocks) && second.rankedStocks.length) {
        const secMap = new Map(second.rankedStocks.map(s => [s.symbol, s]))
        let overlap = 0
        for (const stock of data.rankedStocks) {
          const m = secMap.get(stock.symbol)
          if (m) {
            overlap++
            stock.ensemble = {
              confirmed:     true,
              secondVerdict: m.agentVerdict ?? null,
              verdictMatch:  !!m.agentVerdict && m.agentVerdict === stock.agentVerdict,
              scoreDelta:    (m.compositeScore != null && stock.compositeScore != null)
                               ? Math.abs(m.compositeScore - stock.compositeScore) : null,
              secondRank:    m.rank ?? null,
            }
          } else {
            stock.ensemble = { confirmed: false }
          }
        }
        ensemble = {
          secondModel:  'llama-3.3-70b-versatile',
          overlapCount: overlap,
          overlapPct:   Math.round((overlap / data.rankedStocks.length) * 100),
        }
      }
    }

    // Annotate each stock with earnings proximity from already-fetched earnings data
    if (earningsResult.status === 'fulfilled' && earningsResult.value?.upcoming?.length) {
      const earningsMap = new Map(
        earningsResult.value.upcoming.map(e => [
          e.symbol,
          Math.round((new Date(e.nextEarningsDate) - Date.now()) / 86400000),
        ])
      )
      for (const stock of data.rankedStocks) {
        const d = earningsMap.get(stock.symbol)
        if (d != null) stock.daysToEarnings = d
      }
    }

    // Log each prediction for win-rate tracking
    for (const stock of data.rankedStocks) {
      logPrediction(stock.symbol, stock, {
        entryZoneLow:   stock.entryZoneLow,
        entryZoneHigh:  stock.entryZoneHigh,
        targetZoneLow:  stock.targetZoneLow,
        targetZoneHigh: stock.targetZoneHigh,
      }, generatedAt, taBaselines.get(stock.symbol))
    }

    return res.json({
      ...data,
      horizon,
      scanMode,
      processedAt:      generatedAt,
      dataAge,
      universeAnalyzed: universe,
      liveDataSymbols:  liveQuotes.map(q => q.symbol),
      llmUsed,
      modelUsed: llmUsed === 'claude' ? 'claude-sonnet-4-6' : 'llama-3.3-70b-versatile',
      ensemble,
      agentsUsed: ['Fundamental Analyst','Technical Analyst','Sentiment Agent','Macro Economist','Risk Manager','Supervisor'],
    })
  } catch (err) {
    console.error('[ai-brain]', err.message)
    return res.status(500).json({ error: 'AI Brain analysis failed: ' + err.message })
  }
})

// GET /api/ai-brain/learnings — returns current self-improvement state for UI display
router.get('/learnings', (req, res) => {
  try {
    const fs   = require('fs')
    const path = require('path')
    const file = path.join(__dirname, '../data/brain-learnings.json')
    if (!fs.existsSync(file)) return res.json({ available: false })
    const data = JSON.parse(fs.readFileSync(file, 'utf8'))
    res.json({ available: true, ...data })
  } catch { res.json({ available: false }) }
})

module.exports = router
