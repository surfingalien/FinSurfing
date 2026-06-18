'use strict'
/**
 * routes/trading-analysis.js
 *
 * AI-powered trading analysis routes:
 *   POST /analyze — fetch OHLCV, compute TA indicators, call Claude for structured signal
 *   POST /chat    — SSE streaming chat with chart context memory
 *   GET  /memory/:symbol — prior analyses for a symbol (authenticated)
 */

const express   = require('express')
const { getRouter } = require('../lib/ai-router')
const { optionalAuth, requireAuth } = require('../middleware/auth')
const { recallMemory, saveMemory, searchMemory } = require('../db/ai_memory')
const {
  computeRSI, computeEMA, computeEMAArray, computeMACD, computeBB, computeATR,
  computeStochRSI, computeVWAP, computeOBV, findSR, detectPatterns, volumeAnalysis,
} = require('../lib/technical-indicators')

const { getSocialSentiment } = require('../lib/social-sentiment')

const aiRouter = getRouter('trading-analysis')

const router = express.Router()

// Attach user context when a valid JWT is present (never rejects guests)
router.use(optionalAuth)

// ── Crypto detection (mirrors server.js isCryptoSymbol) ───────────────────────
const CRYPTO_TICKERS = new Set([
  // Layer 1
  'BTC','ETH','SOL','BNB','XRP','ADA','DOGE','AVAX','DOT','MATIC','LINK',
  'UNI','LTC','BCH','TRX','NEAR','SHIB','APT','SUI','SEI','INJ','TIA','JUP',
  'TON','ATOM','FIL','ICP','XLM','XMR','DASH','ZEC','ETC','FTM','ONE','WAVES',
  'HBAR','FLOW','EOS','XTZ','THETA','ALGO','VET','EGLD','KAVA','CELO',
  // Layer 2
  'ARB','OP','IMX','LRC','MNT','STRK','ZK','METIS','MANTA','MOVR','GLMR',
  'BOBA','ROSE','ASTR','SCRT','CFG','ACA',
  // DeFi
  'AAVE','MKR','COMP','SNX','YFI','SUSHI','CRV','DYDX','GMX','PENDLE',
  'CVX','FXS','LDO','RPL','RUNE','BAL','1INCH','OSMO','CAKE',
  // AI & Data
  'FET','OCEAN','AGIX','RNDR','WLD','GRT','NMR','TAO','AKT','ALT','AIOZ','ARKM',
  // Meme
  'WIF','BONK','PEPE','FLOKI','MEME','BOME','TURBO','ORDI','SATS','BRETT','NEIRO',
  // Infrastructure
  'HNT','AR','STORJ','IOTX','RLC','ANKR','BAND','API3','FLUX','COTI','GLM',
  'CTSI','NKN','TFUEL',
  // Exchange & payments
  'CRO','STX','CFX','GALA','GMT','APE','LUNC','PYTH','JTO',
  'ZETA','BLUR','BAT','MANA','SAND','AXS',
])
function isCryptoSymbol(s) {
  if (!s) return false
  const u = s.toUpperCase()
  return /^[A-Z0-9.]+-[A-Z]{3,4}$/.test(u) || CRYPTO_TICKERS.has(u)
}

// ── Symbol conversion: TradingView → Yahoo Finance ────────────────────────────

const CRYPTO_MAP = {
  // Major L1
  'BTCUSD':'BTC-USD',   'BTCUSDT':'BTC-USD',
  'ETHUSD':'ETH-USD',   'ETHUSDT':'ETH-USD',
  'SOLUSD':'SOL-USD',   'SOLUSDT':'SOL-USD',
  'XRPUSD':'XRP-USD',   'XRPUSDT':'XRP-USD',
  'BNBUSD':'BNB-USD',   'BNBUSDT':'BNB-USD',
  'ADAUSD':'ADA-USD',   'ADAUSDT':'ADA-USD',
  'DOGEUSD':'DOGE-USD', 'DOGEUSDT':'DOGE-USD',
  'AVAXUSD':'AVAX-USD', 'AVAXUSDT':'AVAX-USD',
  'LINKUSD':'LINK-USD', 'LINKUSDT':'LINK-USD',
  'MATICUSD':'MATIC-USD','MATICUSDT':'MATIC-USD',
  'DOTUSD':'DOT-USD',   'DOTUSDT':'DOT-USD',
  'LTCUSD':'LTC-USD',   'LTCUSDT':'LTC-USD',
  'ATOMUSD':'ATOM-USD', 'ATOMUSDT':'ATOM-USD',
  'UNIUSD':'UNI-USD',   'UNIUSDT':'UNI-USD',
  'SHIBUSD':'SHIB-USD', 'SHIBUSDT':'SHIB-USD',
  'PEPEUSD':'PEPE-USD', 'PEPEUSDT':'PEPE-USD',
  'NEARUSD':'NEAR-USD', 'NEARUSDT':'NEAR-USD',
  'APTUSD':'APT-USD',   'APTUSDT':'APT-USD',
  'SUIUSD':'SUI-USD',   'SUIUSDT':'SUI-USD',
  'INJUSD':'INJ-USD',   'INJUSDT':'INJ-USD',
  'TONUSD':'TON-USD',   'TONUSDT':'TON-USD',
  'FILUSD':'FIL-USD',   'FILUSDT':'FIL-USD',
  'ICPUSD':'ICP-USD',   'ICPUSDT':'ICP-USD',
  'TRXUSD':'TRX-USD',   'TRXUSDT':'TRX-USD',
  'XLMUSD':'XLM-USD',   'XLMUSDT':'XLM-USD',
  'XMRUSD':'XMR-USD',
  'TIAUSD':'TIA-USD',   'TIAUSDT':'TIA-USD',
  'JUPUSD':'JUP-USD',   'JUPUSDT':'JUP-USD',
  'HBARUSD':'HBAR-USD', 'HBARUSDT':'HBAR-USD',
  'FTMUSD':'FTM-USD',   'FTMUSDT':'FTM-USD',
  'ALGOUSD':'ALGO-USD', 'ALGOUSDT':'ALGO-USD',
  'VETUSD':'VET-USD',   'VETUSDT':'VET-USD',
  'EOSUSD':'EOS-USD',   'EOSUSDT':'EOS-USD',
  'ZECUSD':'ZEC-USD',   'ZECUSDT':'ZEC-USD',
  'ETCUSD':'ETC-USD',   'ETCUSDT':'ETC-USD',
  'EGLDUSDT':'EGLD-USD',
  'KAVAUSD':'KAVA-USD', 'KAVAUSDT':'KAVA-USD',
  'CELOUSDT':'CELO-USD',
  // Layer 2
  'ARBUSD':'ARB-USD',   'ARBUSDT':'ARB-USD',
  'OPUSD':'OP-USD',     'OPUSDT':'OP-USD',
  'IMXUSD':'IMX-USD',   'IMXUSDT':'IMX-USD',
  'LRCUSD':'LRC-USD',   'LRCUSDT':'LRC-USD',
  'MNTUSDT':'MNT-USD',
  'STRKUSDT':'STRK-USD',
  'ZKUSDT':'ZK-USD',
  'METISUSDT':'METIS-USD',
  'MANTAUSDT':'MANTA-USD',
  'MOVRUSDT':'MOVR-USD',
  'ROSEUSD':'ROSE-USD', 'ROSEUSDT':'ROSE-USD',
  // DeFi
  'AAVEUSD':'AAVE-USD', 'AAVEUSDT':'AAVE-USD',
  'MKRUSDT':'MKR-USD',
  'COMPUSD':'COMP-USD', 'COMPUSDT':'COMP-USD',
  'SNXUSD':'SNX-USD',   'SNXUSDT':'SNX-USD',
  'YFIUSDT':'YFI-USD',
  'SUSHIUSD':'SUSHI-USD','SUSHIUSDT':'SUSHI-USD',
  'CRVUSD':'CRV-USD',   'CRVUSDT':'CRV-USD',
  'DYDXUSDT':'DYDX-USD',
  'GMXUSDT':'GMX-USD',
  'PENDLEUSDT':'PENDLE-USD',
  'CVXUSDT':'CVX-USD',
  'FXSUSDT':'FXS-USD',
  'LDOUSDT':'LDO-USD',
  'RPLUSDT':'RPL-USD',
  'RUNEUSDT':'RUNE-USD',
  'BALUSDT':'BAL-USD',
  '1INCHUSDT':'1INCH-USD',
  'CAKEUSDT':'CAKE-USD',
  // AI & Data
  'FETUSD':'FET-USD',   'FETUSDT':'FET-USD',
  'OCEANUSDT':'OCEAN-USD',
  'AGIXUSDT':'AGIX-USD',
  'RNDRUSDT':'RNDR-USD',
  'WLDUSDT':'WLD-USD',
  'GRTUSD':'GRT-USD',   'GRTUSDT':'GRT-USD',
  'TAOUSDT':'TAO-USD',
  'AKTUSDT':'AKT-USD',
  'ARKMUSDT':'ARKM-USD',
  // Meme
  'WIFUSD':'WIF-USD',   'WIFUSDT':'WIF-USD',
  'BONKUSDT':'BONK-USD',
  'FLOKIUSDT':'FLOKI-USD',
  'MEMEUSDT':'MEME-USD',
  'BOMEUSDT':'BOME-USD',
  'TURBOUSDT':'TURBO-USD',
  'ORDIUSDT':'ORDI-USD',
  'BRETTUSDT':'BRETT-USD',
  'NEIROUSDT':'NEIRO-USD',
  // Infrastructure
  'HNTUSD':'HNT-USD',   'HNTUSDT':'HNT-USD',
  'ARUSDT':'AR-USD',
  'STORJUSDT':'STORJ-USD',
  'ANKRUSDT':'ANKR-USD',
  'BANDUSD':'BAND-USD', 'BANDUSDT':'BAND-USD',
  'THETAUSD':'THETA-USD','THETAUSDT':'THETA-USD',
  'GLMUSDT':'GLM-USD',
  'CTSIUSDT':'CTSI-USD',
  // Exchange & payments
  'CROUSD':'CRO-USD',   'CROUSDT':'CRO-USD',
  'STXUSD':'STX-USD',   'STXUSDT':'STX-USD',
  'GALAUSDT':'GALA-USD',
  'MANAUSDT':'MANA-USD',
  'SANDUSDT':'SAND-USD',
  'AXSUSD':'AXS-USD',   'AXSUSDT':'AXS-USD',
  'APEUSDT':'APE-USD',
  'BLURUSDT':'BLUR-USD',
  'JTOUSDT':'JTO-USD',
  'PYTHUSDT':'PYTH-USD',
  'SEIUSDT':'SEI-USD',
  'ZETAUSD':'ZETA-USD', 'ZETAUSDT':'ZETA-USD',
  'CFXUSDT':'CFX-USD',
  'BATUSD':'BAT-USD',   'BATUSDT':'BAT-USD',
}

// Crypto exchanges: any symbol from these gets treated as crypto
const CRYPTO_EXCHANGES = new Set([
  'BINANCE', 'BINANCEUS', 'BINANCEUSDM', 'COINBASE', 'BITSTAMP',
  'KRAKEN', 'GEMINI', 'KUCOIN', 'OKX', 'BYBIT', 'HUOBI', 'GATE',
  'CRYPTO', 'BITMEX', 'BITFINEX', 'BITTREX', 'MEXC', 'PHEMEX',
  'DERIBIT', 'HYPERLIQUID',
])

const FUTURES_MAP = {
  'ES1!': 'ES=F',
  'NQ1!': 'NQ=F',
  'GC1!': 'GC=F',
  'CL1!': 'CL=F',
}

function tvToYahoo(tvSymbol) {
  if (!tvSymbol) return tvSymbol

  // Split exchange prefix from symbol
  const colonIdx = tvSymbol.indexOf(':')
  let exchange = ''
  let sym = tvSymbol

  if (colonIdx !== -1) {
    exchange = tvSymbol.slice(0, colonIdx).toUpperCase()
    sym      = tvSymbol.slice(colonIdx + 1)
  }

  // Futures
  if (FUTURES_MAP[sym]) return FUTURES_MAP[sym]

  // Crypto — check static map first
  const symUpper = sym.toUpperCase()
  if (CRYPTO_MAP[symUpper]) return CRYPTO_MAP[symUpper]

  // Crypto exchange — dynamically parse composite symbol (SOLUSDT, SOLUSD, SOL…)
  if (CRYPTO_EXCHANGES.has(exchange)) {
    // Try to strip known quote currencies (longest match first to avoid false splits)
    const quotes = ['USDT', 'USDC', 'BUSD', 'USD', 'BTC', 'ETH', 'EUR', 'GBP', 'BNB']
    for (const q of quotes) {
      if (symUpper.endsWith(q) && symUpper.length > q.length + 1) {
        const base = symUpper.slice(0, symUpper.length - q.length)
        // Stablecoins/USD variants → normalize to -USD
        const yahooQ = ['USDT', 'USDC', 'BUSD'].includes(q) ? 'USD' : q
        return `${base}-${yahooQ}`
      }
    }
    // Bare ticker like COINBASE:SOL → SOL-USD
    return `${symUpper}-USD`
  }

  // Forex
  if (exchange === 'FX_IDC' || exchange === 'OANDA') return symUpper + '=X'

  // Default: strip exchange prefix and return the symbol part
  return symUpper
}

// ── StockTwits retail sentiment ───────────────────────────────────────────────

async function fetchStockTwits(symbol) {
  const base = symbol.replace(/-[A-Z]+$/, '').replace(/[^A-Z0-9]/g, '')
  if (!base) return null
  try {
    const r = await fetch(
      `https://api.stocktwits.com/api/2/streams/symbol/${base}.json`,
      { headers: { 'User-Agent': 'FinSurfing/1.0' }, signal: AbortSignal.timeout(4000) }
    )
    if (!r.ok) return null
    const { messages = [] } = await r.json()
    if (!messages.length) return null
    let bullish = 0, bearish = 0, neutral = 0
    const snippets = []
    for (const m of messages.slice(0, 30)) {
      const sent = m?.entities?.sentiment?.basic
      if (sent === 'Bullish') bullish++
      else if (sent === 'Bearish') bearish++
      else neutral++
      if (snippets.length < 3 && m.body)
        snippets.push(`[${sent ?? 'Neutral'}] ${m.body.slice(0, 80).replace(/\n/g, ' ')}`)
    }
    const labeled = bullish + bearish
    const bullishPct = labeled > 0 ? Math.round((bullish / labeled) * 100) : null
    return { bullish, bearish, neutral, total: messages.length, snippets, bullishPct }
  } catch { return null }
}

function getSourceAlignment(bullishPcts) {
  if (!bullishPcts || bullishPcts.length === 0) return 'No data'
  if (bullishPcts.length === 1) return 'Single source'
  const min = Math.min(...bullishPcts)
  const max = Math.max(...bullishPcts)
  const avg = bullishPcts.reduce((s, v) => s + v, 0) / bullishPcts.length
  const spread = max - min
  if (spread <= 12 && avg >= 60) return 'Bullish alignment'
  if (spread <= 12 && avg <= 40) return 'Bearish alignment'
  if (spread <= 12) return 'Tight alignment'
  if (spread >= 25) return 'Wide divergence'
  return 'Mixed'
}

// ── Interval conversion: TradingView → Yahoo interval + range ─────────────────

function tvToChartParams(tvInterval) {
  const map = {
    '1':   { interval: '1m',  range: '1d'  },
    '5':   { interval: '5m',  range: '5d'  },
    '15':  { interval: '15m', range: '1mo' },
    '30':  { interval: '30m', range: '1mo' },
    '60':  { interval: '60m', range: '1mo' },
    '240': { interval: '60m', range: '3mo' },
    'D':   { interval: '1d',  range: '1y'  },
    'W':   { interval: '1wk', range: '2y'  },
  }
  return map[tvInterval] || { interval: '1d', range: '1y' }
}

// ── Analysis prompt builder ────────────────────────────────────────────────────

function buildAnalysisPrompt(symbol, interval, price, indicators, patterns, vol, priceLabel = 'last bar close', sentiment = null, priorMemories = [], socialSnippet = '', analystSnippet = '') {
  const { rsi, macd, ema9, ema21, ema50, ema200, bb, atr, stochRsi, vwap, obv, sr } = indicators

  const rsiInterp = rsi == null ? 'N/A'
    : rsi > 70 ? `${rsi} (overbought — potential reversal or continuation in strong trend)`
    : rsi < 30 ? `${rsi} (oversold — potential bounce or continued weakness)`
    : rsi > 55 ? `${rsi} (moderately bullish momentum)`
    : rsi < 45 ? `${rsi} (moderately bearish momentum)`
    : `${rsi} (neutral zone)`

  const macdInterp = !macd ? 'N/A'
    : `MACD ${macd.macd} | Signal ${macd.signal} | Histogram ${macd.histogram} — ${macd.trend}, histogram ${macd.histogramDir}`

  const emaInterp = [
    ema9   != null ? `EMA9=${ema9}`   : null,
    ema21  != null ? `EMA21=${ema21}` : null,
    ema50  != null ? `EMA50=${ema50}` : null,
    ema200 != null ? `EMA200=${ema200}` : null,
  ].filter(Boolean).join(', ')

  const bbInterp = !bb ? 'N/A'
    : `Upper=${bb.upper} | Middle=${bb.middle} | Lower=${bb.lower} | %B=${bb.pctB}% | BW=${bb.bandwidth} | Position=${bb.position} | Squeeze=${bb.squeeze}`

  const srInterp = !sr ? 'N/A'
    : `Support=${sr.support ?? 'none'} | Resistance=${sr.resistance ?? 'none'}`

  const volInterp = !vol ? 'N/A'
    : `Current=${vol.current} | Avg20=${vol.avg20} | Ratio=${vol.ratio}x | Trend=${vol.trend} | Spike=${vol.spike}`

  const obvInterp = !obv ? 'N/A'
    : `OBV=${obv.current} | Trend=${obv.trend}`

  const patternsStr = patterns && patterns.length ? patterns.join(', ') : 'none detected'

  const sentimentSection = sentiment
    ? `\nRETAIL SENTIMENT (StockTwits — last ${sentiment.total} posts): Bullish ${sentiment.bullish} | Bearish ${sentiment.bearish} | Neutral ${sentiment.neutral}${sentiment.snippets.length ? '\nSample posts:\n' + sentiment.snippets.join('\n') : ''}`
    : ''

  const memoryBlock = priorMemories.length
    ? `\nPRIOR ANALYSES FOR ${symbol} (your past signals — note any trend changes):\n` +
      priorMemories.map(m => {
        const date = new Date(m.created_at).toLocaleDateString()
        return `• [${date}] ${m.signal ?? '—'} @ $${m.price ?? '?'} (${m.confidence ?? '?'}% conf) — ${m.summary?.slice(0, 150) ?? 'no summary'}`
      }).join('\n') + '\n'
    : ''

  const prompt = `You are an expert quantitative trading analyst.${memoryBlock ? '\n' + memoryBlock : ''} Analyze the following technical data for ${symbol} on the ${interval} timeframe and generate a structured trading signal.

MARKET DATA:
- Symbol: ${symbol}
- Timeframe: ${interval}
- Current Price: ${price} [${priceLabel}]

TECHNICAL INDICATORS:
- RSI(14): ${rsiInterp}
- MACD(12,26,9): ${macdInterp}
- EMAs: ${emaInterp || 'N/A'}
- Bollinger Bands(20,2): ${bbInterp}
- ATR(14): ${atr != null ? atr : 'N/A'}
- StochRSI(14): ${stochRsi != null ? stochRsi + ' (0-100 scale)' : 'N/A'}
- VWAP(50-bar): ${vwap != null ? vwap : 'N/A'}
- OBV: ${obvInterp}
- Support/Resistance: ${srInterp}

VOLUME ANALYSIS:
${volInterp}

DETECTED PATTERNS:
${patternsStr}
${sentimentSection}${socialSnippet}${analystSnippet}
ANALYSIS INSTRUCTIONS:
1. Look for CONTRADICTIONS between indicators (e.g. RSI overbought but MACD still bullish, price above EMA50 but OBV falling, BB squeeze while RSI diverging). List each contradiction explicitly.
2. For price targets, provide a ZONE (low/high) based on key S/R and ATR, not a single precise number. Entry zone should reflect realistic fill range around current price.
3. Assess overall signal confidence based on indicator CONFLUENCE — high confidence requires 4+ indicators agreeing.
4. Reasoning should explicitly weigh the bull and bear cases before reaching a conclusion.

Respond with ONLY pure JSON (absolutely no markdown fences, no backticks, no code blocks, no text before or after the JSON). The JSON must match this exact shape:
{
  "signal": "BUY or SELL or HOLD",
  "confidence": 0-100,
  "trend": "BULLISH or BEARISH or NEUTRAL",
  "entry": number,
  "entryZoneLow": number,
  "entryZoneHigh": number,
  "stopLoss": number,
  "takeProfit": [number, number],
  "riskReward": number,
  "timeHorizon": "scalp or swing or position",
  "bullishProbability": 0-100,
  "bearishProbability": 0-100,
  "indicators": {
    "rsi": "concise interpretation string",
    "macd": "concise interpretation string",
    "ema": "concise interpretation string",
    "bollinger": "concise interpretation string",
    "volume": "concise interpretation string"
  },
  "contradictions": ["contradiction1 if any", "contradiction2 if any"],
  "patterns": ["pattern1", "pattern2"],
  "reasoning": "3-4 sentence analysis weighing bull and bear cases",
  "risks": ["risk1", "risk2", "risk3"],
  "disclaimer": "brief risk disclaimer string"
}`

  return prompt
}

// ── POST /analyze ─────────────────────────────────────────────────────────────

router.post('/analyze', requireAuth, async (req, res) => {
  const symbol = req.body.symbol || req.query.symbol
  const interval = req.body.interval || req.query.interval || 'D'
  const clientLivePrice = req.body.livePrice ?? req.body.clientLivePrice ?? null

  if (!symbol || typeof symbol !== 'string')
    return res.status(400).json({ error: 'symbol is required' })

  const sym = tvToYahoo(symbol.trim())
  if (!sym) return res.status(400).json({ error: 'Could not convert symbol to Yahoo Finance format' })

  let { interval: yInterval, range } = tvToChartParams(String(interval))

  try {
    const port = process.env.PORT || 3001
    const fwdHeaders = {}
    for (const h of ['x-aisa-key', 'x-finnhub-key', 'x-fmp-key', 'x-td-key', 'x-av-key']) {
      if (req.headers[h]) fwdHeaders[h] = req.headers[h]
    }

    // Helper: fetch chart and return filtered bars, or null if insufficient
    const fetchBars = async (ivl, rng) => {
      const r = await fetch(
        `http://127.0.0.1:${port}/api/chart?symbol=${encodeURIComponent(sym)}&interval=${ivl}&range=${rng}`,
        { headers: fwdHeaders, signal: AbortSignal.timeout(30000) }
      )
      const d    = await r.json()
      const res  = d?.chart?.result?.[0]
      const ts   = res?.timestamp
      const q    = res?.indicators?.quote?.[0]
      console.log(`[trading-analysis] ${sym} ${ivl}/${rng}: ${ts?.length ?? 0} raw bars`)
      if (!ts?.length || !q?.close) return null
      const bars = ts.map((t, i) => ({
        t, o: q.open?.[i], h: q.high?.[i], l: q.low?.[i], c: q.close?.[i], v: q.volume?.[i] ?? 0,
      })).filter(b => b.c != null && !isNaN(b.c))
      return bars.length >= 10 ? bars : null
    }

    // Primary attempt
    let bars = await fetchBars(yInterval, range)

    // Fallback 1: daily 1y (works without any user API keys via AV/TD demo)
    if (!bars && yInterval !== '1d') {
      console.log(`[trading-analysis] ${sym}: intraday failed, falling back to 1d/1y`)
      bars = await fetchBars('1d', '1y')
      if (bars) { yInterval = '1d'; range = '1y' }
    }

    // Fallback 2: weekly 2y
    if (!bars) {
      console.log(`[trading-analysis] ${sym}: daily failed, falling back to 1wk/2y`)
      bars = await fetchBars('1wk', '2y')
      if (bars) { yInterval = '1wk'; range = '2y' }
    }

    if (!bars) {
      // Distinguish "no keys → keys would help" from "keys present but the symbol
      // genuinely isn't covered by any data provider". TradingView's widget charts
      // many illiquid/delisted/non-US tickers that our OHLCV providers don't carry,
      // so a working chart does NOT guarantee our backend can analyze the symbol.
      const hasDataKey = !!(fwdHeaders['x-aisa-key'] || fwdHeaders['x-finnhub-key'] || fwdHeaders['x-fmp-key'] || fwdHeaders['x-td-key'] || fwdHeaders['x-av-key']
        || process.env.AISA_API_KEY || process.env.FINNHUB_API_KEY || process.env.FMP_API_KEY || process.env.TWELVEDATA_API_KEY || process.env.ALPHAVANTAGE_API_KEY)
      const msg = hasDataKey
        ? `No price history available for ${sym}. The TradingView chart may render it, but none of the configured data providers carry OHLCV data for this symbol — it may be illiquid, recently listed, delisted, or non-US. AI Analysis needs historical bars to compute indicators.`
        : `No market data available for ${sym}. Add an AISA, Finnhub, or FMP API key in Settings for full coverage.`
      return res.status(422).json({ error: msg })
    }

    const ts      = bars.map(b => b.t)
    const opens   = bars.map(b => b.o ?? b.c)
    const highs   = bars.map(b => b.h ?? b.c)
    const lows    = bars.map(b => b.l ?? b.c)
    const closes  = bars.map(b => b.c)
    const volumes = bars.map(b => b.v)

    // Resolve current price: prefer live price from TradingView widget (most accurate),
    // then try a fresh quote from the internal API, then fall back to last bar close.
    let price = closes[closes.length - 1]
    let priceLabel = 'last bar close'
    let analystTarget = null, analystCount = null, analystRecMean = null, forwardPE = null

    if (clientLivePrice && typeof clientLivePrice === 'number' && clientLivePrice > 0) {
      price = clientLivePrice
      priceLabel = 'live (TradingView)'
    } else {
      try {
        const qr = await fetch(
          `http://127.0.0.1:${port}/api/quote?symbols=${encodeURIComponent(sym)}`,
          { headers: fwdHeaders, signal: AbortSignal.timeout(5000) }
        )
        const qd = await qr.json()
        const q0 = qd?.quoteResponse?.result?.[0]
        const lp = q0?.regularMarketPrice
        if (lp && lp > 0 && (Math.abs(lp - price) / price < 0.5 || isCryptoSymbol(sym))) {
          // Sanity check: accept if within 50% of bar close, OR always for crypto
          // (crypto quote from Binance/CoinGecko is authoritative even when bars are stale)
          price = lp
          priceLabel = 'live quote'
        }
        if (q0) {
          analystTarget    = q0.targetMedianPrice ?? null
          analystCount     = q0.numberOfAnalystOpinions ?? null
          analystRecMean   = q0.recommendationMean ?? null
          forwardPE        = q0.forwardPE ?? null
        }
      } catch { /* keep last bar close */ }
    }
    console.log(`[trading-analysis] ${sym} price: $${price} (${priceLabel})`)

    // Compute all indicators
    const rsi      = computeRSI(closes)
    const macd     = computeMACD(closes)
    const ema9     = computeEMA(closes, 9)
    const ema21    = computeEMA(closes, 21)
    const ema50    = computeEMA(closes, 50)
    const ema200   = computeEMA(closes, 200)
    const bb       = computeBB(closes)
    const atr      = computeATR(highs, lows, closes)
    const stochRsi = computeStochRSI(closes)
    const vwap     = computeVWAP(highs, lows, closes, volumes)
    const obv      = computeOBV(closes, volumes)
    const sr       = findSR(highs, lows, closes)
    const patterns = detectPatterns(opens, highs, lows, closes, volumes)
    const vol      = volumeAnalysis(volumes)

    const indicators = { rsi, macd, ema9, ema21, ema50, ema200, bb, atr, stochRsi, vwap, obv, sr, patterns, volume: vol }

    // Fetch StockTwits + broader social sentiment + prior memory in parallel
    const [sentiment, socialSnippetRaw, priorMemories] = await Promise.all([
      fetchStockTwits(sym).catch(() => null),
      getSocialSentiment([sym]).catch(() => ''),
      recallMemory(req.user?.userId, sym),
    ])
    if (sentiment) console.log(`[trading-analysis] ${sym} StockTwits: ${sentiment.bullish}B ${sentiment.bearish}Be ${sentiment.neutral}N / ${sentiment.total}`)
    if (priorMemories.length) console.log(`[trading-analysis] ${sym} memory: ${priorMemories.length} prior analyses injected`)

    // Build analyst snippet from quote data
    const analystParts = []
    if (analystTarget != null) analystParts.push(`Median target: $${analystTarget.toFixed(analystTarget >= 1 ? 2 : 4)}${analystCount ? ` (${analystCount} analysts)` : ''}`)
    if (analystRecMean != null) analystParts.push(`Consensus score: ${analystRecMean.toFixed(1)}/5 (1=Strong Buy, 5=Strong Sell)`)
    if (forwardPE != null) analystParts.push(`Fwd P/E: ${forwardPE.toFixed(1)}`)
    const analystSnippet = analystParts.length ? `\nANALYST CONSENSUS:\n${analystParts.join(' | ')}\n` : ''

    // Build prompt and call Claude
    const analysisPrompt = buildAnalysisPrompt(sym, interval, price, indicators, patterns, vol, priceLabel, sentiment, priorMemories, socialSnippetRaw, analystSnippet)

    const { text: rawText } = await aiRouter.call({
      prompt:    analysisPrompt,
      maxTokens: 2048,
      symbols:   [sym],
    })

    // Strip any accidental markdown fences
    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()

    let analysis
    try {
      analysis = JSON.parse(cleaned)
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/)
      if (!m) {
        console.error('[trading-analysis] No JSON in Claude response:', rawText.slice(0, 200))
        return res.status(500).json({ error: 'AI analysis returned no parseable JSON — please try again' })
      }
      try {
        analysis = JSON.parse(m[0])
      } catch (parseErr) {
        console.error('[trading-analysis] JSON parse failed:', parseErr.message)
        return res.status(500).json({ error: 'AI analysis response was malformed — please try again' })
      }
    }

    // Persist analysis to memory (fire-and-forget — never blocks response)
    if (req.user?.userId) saveMemory(req.user.userId, sym, yInterval, price, analysis)

    // Candles: last 200 bars for charting
    const candleSlice = bars.slice(-200)
    const candles = candleSlice.map(b => ({
      time: b.t,
      open: b.o ?? b.c,
      high: b.h ?? b.c,
      low:  b.l ?? b.c,
      close: b.c,
      volume: b.v,
    }))

    // Compute multi-source sentiment alignment
    const bullishPcts = []
    if (sentiment?.bullishPct != null) bullishPcts.push(sentiment.bullishPct)
    if (analysis?.bullishProbability != null) bullishPcts.push(analysis.bullishProbability)
    const sentimentAlignment = getSourceAlignment(bullishPcts)

    return res.json({
      symbol:    sym,
      interval,
      price,
      analysis,
      indicators,
      candles,
      sentiment: sentiment ? { bullish: sentiment.bullish, bearish: sentiment.bearish, neutral: sentiment.neutral, total: sentiment.total, bullishPct: sentiment.bullishPct, snippets: sentiment.snippets } : null,
      sentimentAlignment,
      timestamp: new Date().toISOString(),
    })
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError')
      return res.status(504).json({ error: 'Market data request timed out' })
    console.error('[trading-analysis/analyze]', err.message)
    return res.status(500).json({ error: 'Analysis failed: ' + err.message })
  }
})

// ── GET /memory/search?q=... ──────────────────────────────────────────────────

router.get('/memory/search', requireAuth, async (req, res) => {
  const { q, limit = 10 } = req.query
  if (!q) return res.status(400).json({ error: 'q is required' })
  const rows = await searchMemory(req.user.userId, String(q), parseInt(limit, 10))
  res.json({ results: rows })
})

// ── GET /memory/:symbol ───────────────────────────────────────────────────────

router.get('/memory/:symbol', requireAuth, async (req, res) => {
  const sym   = req.params.symbol?.toUpperCase()
  const limit = Math.min(parseInt(req.query.limit, 10) || 10, 50)
  if (!sym) return res.status(400).json({ error: 'symbol is required' })
  const rows = await recallMemory(req.user.userId, sym, limit)
  res.json({ symbol: sym, history: rows })
})

// ── POST /chat (SSE streaming) ────────────────────────────────────────────────

const CHAT_SYSTEM_PROMPT =
  'You are an expert AI trading analyst integrated into a professional trading platform. ' +
  'Answer concisely with specific references to the indicator values provided. ' +
  'Always include brief risk disclaimers. Never guarantee profits.'

router.post('/chat', requireAuth, async (req, res) => {
  const {
    message,
    symbol,
    interval,
    price,
    analysisContext,
    history = [],
  } = req.body

  if (!message || typeof message !== 'string') {
    res.setHeader('Content-Type', 'text/event-stream')
    res.write(`data: ${JSON.stringify({ error: 'message is required' })}\n\n`)
    return res.end()
  }

  // SSE headers
  res.setHeader('Content-Type',     'text/event-stream')
  res.setHeader('Cache-Control',    'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')

  // Build system prompt with chart context
  let systemPrompt = CHAT_SYSTEM_PROMPT
  if (symbol || interval || price != null) {
    const contextLines = []
    if (symbol)        contextLines.push(`Symbol: ${symbol}`)
    if (interval)      contextLines.push(`Timeframe: ${interval}`)
    if (price != null) contextLines.push(`Current price: ${price}`)
    systemPrompt += `\n\nCurrent chart context:\n${contextLines.join('\n')}`
  }
  if (analysisContext && typeof analysisContext === 'object') {
    systemPrompt += `\n\nLatest analysis context:\n${JSON.stringify(analysisContext, null, 2)}`
  }

  // Build full prompt including conversation history
  const historyBlock = history.slice(-10)
    .map(m => `${m.role === 'user' ? 'User' : 'Assistant'}: ${String(m.content)}`)
    .join('\n')
  const fullPrompt = historyBlock ? `${historyBlock}\nUser: ${message}` : message

  try {
    const stream = aiRouter.stream({ prompt: fullPrompt, maxTokens: 1024, system: systemPrompt })

    stream.on('text', (text) => {
      res.write(`data: ${JSON.stringify({ text })}\n\n`)
    })

    stream.on('error', (err) => {
      console.error('[trading-analysis/chat] Stream error:', err.message)
      try {
        res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
        res.end()
      } catch {}
    })

    await stream.finalMessage()

    res.write(`data: ${JSON.stringify({ done: true })}\n\n`)
    res.end()
  } catch (err) {
    console.error('[trading-analysis/chat]', err.message)
    try {
      res.write(`data: ${JSON.stringify({ error: err.message })}\n\n`)
      res.end()
    } catch {}
  }
})

module.exports = router
