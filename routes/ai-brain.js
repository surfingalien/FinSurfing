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
const { getSocialSentiment } = require('../lib/social-sentiment')

const router   = express.Router()
const aiRouter = getRouter('ai-brain')

const PREDICTION_LOG = path.join(__dirname, '../data/ai-brain-predictions.jsonl')

const brainLimit = rateLimit({
  windowMs: 5 * 60 * 1000, max: 4,
  skip:    (req) => req.headers['x-internal'] === '1',
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
  const price = q.regularMarketPrice
  const chg   = q.regularMarketChangePercent
  const sign  = (chg ?? 0) >= 0 ? '+' : ''
  const pe    = q.trailingPE
  const hi    = q.fiftyTwoWeekHigh
  const lo    = q.fiftyTwoWeekLow
  const cap   = q.marketCap
  const vol   = q.regularMarketVolume
  const avgVol = q.averageDailyVolume3Month
  const chgStr = chg != null ? ` (${sign}${chg.toFixed(2)}%)` : ''
  const volRatio = (vol && avgVol) ? ` Vol=${(vol/avgVol).toFixed(2)}x avg` : ''
  return (
    `${q.symbol}: $${price.toFixed(price >= 1 ? 2 : 6)}${chgStr}` +
    ` MktCap=${cap ? '$' + (cap / 1e9).toFixed(0) + 'B' : 'N/A'}` +
    ` P/E=${pe ? pe.toFixed(1) : 'N/A'}` +
    ` 52w=$${lo?.toFixed(0) ?? '?'}-$${hi?.toFixed(0) ?? '?'}` +
    volRatio
  )
}

// Write a prediction record for future win-rate tracking
function logPrediction(symbol, agents, zones, generatedAt) {
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
      entryZoneMid:      zones?.entryZoneLow != null ? (zones.entryZoneLow + zones.entryZoneHigh) / 2 : null,
      targetZoneMid:     zones?.targetZoneLow != null ? (zones.targetZoneLow + zones.targetZoneHigh) / 2 : null,
      verdict:           agents.agentVerdict,
      thesisAssumptions: agents.thesisAssumptions ?? [],
      agentConflict:     agents.agentConflict ?? null,
      supervisorNote:    agents.supervisorSynthesis ?? null,
      // outcome fields filled later by a scheduled job
      price7d: null, price30d: null, price90d: null,
    })
    fs.appendFileSync(PREDICTION_LOG, record + '\n')
  } catch { /* non-fatal */ }
}

router.post('/analyze', brainLimit, async (req, res) => {
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

  // ── Sub-agent 1: data fetch — live quotes + social sentiment in parallel ─────
  let marketSnippet   = ''
  let liveQuotes      = []
  let socialSnippet   = ''

  const [quoteResult, socialResult] = await Promise.allSettled([
    (async () => {
      const port = process.env.PORT || 3001
      const r    = await fetch(
        `http://127.0.0.1:${port}/api/quote?symbols=${universe.join(',')}`,
        { headers: fwdKeys(req), signal: AbortSignal.timeout(30_000) }
      )
      const qd = await r.json()
      return qd?.quoteResponse?.result ?? []
    })(),
    getSocialSentiment(universe.slice(0, 5)),
  ])

  if (quoteResult.status === 'fulfilled') {
    liveQuotes = quoteResult.value
  } else {
    console.warn('[ai-brain] Quote fetch failed, knowledge-only mode:', quoteResult.reason?.message)
  }

  if (socialResult.status === 'fulfilled') {
    socialSnippet = socialResult.value
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
  const prompt = `You are a 5-agent investment AI with a Supervisor whose job is to SURFACE CONTRADICTIONS, not average scores.
${socialSnippet}

CRITICAL: When two agents disagree by 25+ points, that spread IS the primary signal. Do not smooth it. Surface it.

Analyze this universe for a ${horizonLabel} horizon. Today is late May 2026.
Universe: ${universe.join(', ')}
Avoid holdings: ${holdingStr}
${scanMode.startsWith('mutualfunds') ? `\nNOTE: This universe contains mutual funds (category: ${scanMode === 'mutualfunds' ? 'Broad All-Category' : scanMode.replace('mutualfunds_','').toUpperCase()}). Score each fund on: (1) Fundamental = portfolio holdings quality, manager tenure & track record, alpha vs benchmark, (2) Technical = NAV trend, momentum, and performance relative to category peers, (3) Sentiment = fund flows, retail/institutional demand, manager commentary, (4) Macro = asset-class fit for current rate/growth/inflation regime, (5) Risk = expense ratio, max drawdown, concentration risk, redemption risk. Price targets refer to NAV zones. Omit stop-loss precision — use downside risk zones only.` : ''}${scanMode.startsWith('etfs_') ? `\nNOTE: This is an ETF sub-category scan (${scanMode.replace('etfs_','').toUpperCase()}). Scoring focus: (1) Fundamental = underlying index quality, holdings composition, expense ratio vs peers, (2) Technical = ETF price trend & momentum, discount/premium to NAV, options flow if available, (3) Sentiment = fund flows, AUM trend, institutional rotation signals, (4) Macro = how well this ETF category fits the current rate/sector/growth regime, (5) Risk = liquidity, tracking error, concentration, leverage if any.` : ''}${scanMode.startsWith('crypto_') ? `\nNOTE: This is a crypto sub-category scan (${scanMode.replace('crypto_','').toUpperCase()}). Scoring focus: (1) Fundamental = protocol TVL, revenue, developer activity, tokenomics, (2) Technical = price trend vs BTC, momentum, on-chain volume signal, (3) Sentiment = social dominance, whale flows, exchange inflows/outflows, (4) Macro = correlation to BTC cycle stage, risk-on/off regime, regulatory climate, (5) Risk = smart contract risk, liquidity depth, centralization risk. Consider current crypto market cycle phase.` : ''}${scanMode.startsWith('stocks_') ? `\nNOTE: This is a stock sector scan (GICS Sector: ${scanMode.replace('stocks_','').replace(/_/g,' ').toUpperCase()}). Scoring focus: (1) Fundamental = earnings growth, margins, valuation vs sector peers, balance sheet quality, (2) Technical = price trend, relative strength vs S&P 500, breakout/breakdown levels, (3) Sentiment = analyst upgrades/downgrades, short interest, insider activity, (4) Macro = sector-specific tailwinds/headwinds in the current rate/growth regime, (5) Risk = concentration risk, regulatory exposure, competitive moat strength.` : ''}
${marketSnippet}

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
- agentConflict.exists = true when ANY two agent scores differ by ≥25 points
- agentConflict.agents = the two most-divergent agents
- Price zones: entryZoneLow/High = ±2% around ideal entry; targetZoneLow/High = ±3% around target; stopZoneLow/High = ±1.5% around stop
- volumeSignal: "Confirming" if vol > 1.1x avg and price trending up; "Weak" if vol < 0.8x; "Diverging" if vol rising but price falling (or vice versa); "Unknown" if no data
- thesisAssumptions: 3 specific, falsifiable conditions that must hold for the bull case to play out
- dataSource: "live" if snapshot provided, else "knowledge"
- STRICTLY respect all ≤N word limits`

  // ── Sub-agent 2: signal generation via ai-router (Claude + Groq fallback) ────
  let raw     = ''
  let llmUsed = 'claude'

  try {
    const result = await aiRouter.call({ prompt, maxTokens: 16000, symbols: universe })
    raw     = result.text
    llmUsed = result.llmUsed
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

    // Log each prediction for win-rate tracking
    for (const stock of data.rankedStocks) {
      logPrediction(stock.symbol, stock, {
        entryZoneLow:   stock.entryZoneLow,
        entryZoneHigh:  stock.entryZoneHigh,
        targetZoneLow:  stock.targetZoneLow,
        targetZoneHigh: stock.targetZoneHigh,
      }, generatedAt)
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
      agentsUsed: ['Fundamental Analyst','Technical Analyst','Sentiment Agent','Macro Economist','Risk Manager','Supervisor'],
    })
  } catch (err) {
    console.error('[ai-brain]', err.message)
    return res.status(500).json({ error: 'AI Brain analysis failed: ' + err.message })
  }
})

module.exports = router
