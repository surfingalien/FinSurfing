'use strict'
/**
 * routes/trading-analysis.js
 *
 * AI-powered trading analysis routes:
 *   POST /analyze — fetch OHLCV, compute TA indicators, call Claude for structured signal
 *   POST /chat    — SSE streaming chat with chart context memory
 */

const express   = require('express')
const Anthropic  = require('@anthropic-ai/sdk')

const router = express.Router()

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

// ── StockTwits retail sentiment (no API key required) ─────────────────────────

async function fetchStockTwits(symbol) {
  // Strip quote suffix for crypto (BTC-USD → BTC) then sanitize
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

// ── Multi-source sentiment alignment classifier (ported from OpenStock) ─

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

// ── Technical Analysis functions ───────────────────────────────────────────────

/**
 * Wilder's smoothed RSI
 */
function computeRSI(closes, period = 14) {
  if (!closes || closes.length < period + 1) return null

  let gains = 0
  let losses = 0

  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gains  += diff
    else           losses -= diff
  }

  let avgGain = gains  / period
  let avgLoss = losses / period

  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain)  / period
    avgLoss = (avgLoss * (period - 1) + loss)  / period
  }

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return parseFloat((100 - 100 / (1 + rs)).toFixed(2))
}

/**
 * Standard EMA
 */
function computeEMA(closes, period) {
  if (!closes || closes.length < period) return null

  const k = 2 / (period + 1)
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k)
  }

  return parseFloat(ema.toFixed(4))
}

/**
 * Compute full EMA array (same length as closes, NaN before period)
 */
function computeEMAArray(closes, period) {
  if (!closes || closes.length < period) return []

  const k = 2 / (period + 1)
  const result = new Array(closes.length).fill(NaN)
  let ema = closes.slice(0, period).reduce((s, v) => s + v, 0) / period
  result[period - 1] = ema

  for (let i = period; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k)
    result[i] = ema
  }

  return result
}

/**
 * MACD (12, 26, 9)
 */
function computeMACD(closes) {
  if (!closes || closes.length < 35) return null

  const ema12Arr = computeEMAArray(closes, 12)
  const ema26Arr = computeEMAArray(closes, 26)

  // Build MACD line array (only where both EMAs are valid)
  const macdLine = []
  for (let i = 0; i < closes.length; i++) {
    if (!isNaN(ema12Arr[i]) && !isNaN(ema26Arr[i])) {
      macdLine.push(ema12Arr[i] - ema26Arr[i])
    }
  }

  if (macdLine.length < 9) return null

  // Signal line: EMA9 of MACD line
  const k = 2 / (9 + 1)
  let signal = macdLine.slice(0, 9).reduce((s, v) => s + v, 0) / 9
  for (let i = 9; i < macdLine.length; i++) {
    signal = macdLine[i] * k + signal * (1 - k)
  }

  const macdVal   = macdLine[macdLine.length - 1]
  const prevMacd  = macdLine[macdLine.length - 2]
  const histogram = macdVal - signal

  const prevK  = 2 / (9 + 1)
  // Approximate previous signal for histogram direction
  let prevSignal = signal
  if (macdLine.length >= 2) {
    // Recompute one step back
    const prevMacdLine = macdLine.slice(0, macdLine.length - 1)
    let ps = prevMacdLine.slice(0, 9).reduce((s, v) => s + v, 0) / 9
    for (let i = 9; i < prevMacdLine.length; i++) {
      ps = prevMacdLine[i] * prevK + ps * (1 - prevK)
    }
    prevSignal = ps
  }
  const prevHistogram = prevMacd - prevSignal

  return {
    macd:         parseFloat(macdVal.toFixed(4)),
    signal:       parseFloat(signal.toFixed(4)),
    histogram:    parseFloat(histogram.toFixed(4)),
    trend:        macdVal > signal ? 'bullish' : 'bearish',
    histogramDir: histogram > prevHistogram ? 'increasing' : 'decreasing',
  }
}

/**
 * Bollinger Bands
 */
function computeBB(closes, period = 20, mult = 2) {
  if (!closes || closes.length < period) return null

  const slice  = closes.slice(closes.length - period)
  const mean   = slice.reduce((s, v) => s + v, 0) / period
  const variance = slice.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / period
  const stdDev = Math.sqrt(variance)

  const upper = mean + mult * stdDev
  const lower = mean - mult * stdDev
  const price = closes[closes.length - 1]
  const bandwidth = stdDev === 0 ? 0 : (upper - lower) / mean
  const pctB = upper === lower ? 50 : ((price - lower) / (upper - lower)) * 100

  let position
  if (price >= upper)              position = 'upper'
  else if (price <= lower)         position = 'lower'
  else if (price >= mean)          position = 'middle'
  else                             position = 'middle'

  // Squeeze: bandwidth in bottom 20% of recent range (use simple threshold)
  const squeeze = bandwidth < 0.02

  return {
    upper:     parseFloat(upper.toFixed(4)),
    middle:    parseFloat(mean.toFixed(4)),
    lower:     parseFloat(lower.toFixed(4)),
    bandwidth: parseFloat(bandwidth.toFixed(4)),
    pctB:      parseFloat(pctB.toFixed(2)),
    position,
    squeeze,
  }
}

/**
 * Average True Range
 */
function computeATR(highs, lows, closes, period = 14) {
  if (!highs || highs.length < period + 1) return null

  const trs = []
  for (let i = 1; i < highs.length; i++) {
    const hl   = highs[i] - lows[i]
    const hpc  = Math.abs(highs[i] - closes[i - 1])
    const lpc  = Math.abs(lows[i]  - closes[i - 1])
    trs.push(Math.max(hl, hpc, lpc))
  }

  if (trs.length < period) return null

  let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period - 1) + trs[i]) / period
  }

  return parseFloat(atr.toFixed(4))
}

/**
 * Stochastic RSI (normalized to 0-100)
 */
function computeStochRSI(closes, period = 14) {
  if (!closes || closes.length < period * 2 + 1) return null

  // Compute RSI history
  const rsiHistory = []
  for (let i = period; i <= closes.length - 1; i++) {
    const slice = closes.slice(i - period, i + 1)
    const rsi = computeRSI(slice, period)
    if (rsi !== null) rsiHistory.push(rsi)
  }

  if (rsiHistory.length < period) return null

  const rsiSlice = rsiHistory.slice(rsiHistory.length - period)
  const minRSI   = Math.min(...rsiSlice)
  const maxRSI   = Math.max(...rsiSlice)
  const current  = rsiSlice[rsiSlice.length - 1]

  if (maxRSI === minRSI) return 50
  return parseFloat(((current - minRSI) / (maxRSI - minRSI) * 100).toFixed(2))
}

/**
 * VWAP (rolling over last 50 bars)
 */
function computeVWAP(highs, lows, closes, volumes) {
  if (!highs || highs.length < 1) return null

  const len    = Math.min(highs.length, 50)
  const start  = highs.length - len

  let tpvSum = 0
  let volSum = 0

  for (let i = start; i < highs.length; i++) {
    const tp  = (highs[i] + lows[i] + closes[i]) / 3
    const vol = volumes[i] || 0
    tpvSum += tp * vol
    volSum += vol
  }

  if (volSum === 0) return null
  return parseFloat((tpvSum / volSum).toFixed(4))
}

/**
 * On-Balance Volume
 */
function computeOBV(closes, volumes) {
  if (!closes || closes.length < 2) return null

  let obv = 0
  const obvArr = [0]

  for (let i = 1; i < closes.length; i++) {
    if (closes[i] > closes[i - 1])      obv += volumes[i] || 0
    else if (closes[i] < closes[i - 1]) obv -= volumes[i] || 0
    obvArr.push(obv)
  }

  const current  = obv
  const lookback = Math.min(20, obvArr.length - 1)
  const prev20   = obvArr[obvArr.length - 1 - lookback]
  const trend    = current > prev20 ? 'rising' : 'falling'

  return { current, trend }
}

/**
 * Support & Resistance via pivot points (last 100 bars, window=3)
 */
function findSR(highs, lows, closes) {
  if (!highs || highs.length < 7) return { support: null, resistance: null }

  const len    = Math.min(highs.length, 100)
  const start  = highs.length - len
  const price  = closes[closes.length - 1]

  const pivotHighs = []
  const pivotLows  = []
  const window = 3

  for (let i = start + window; i < highs.length - window; i++) {
    let isHigh = true
    let isLow  = true
    for (let j = 1; j <= window; j++) {
      if (highs[i] <= highs[i - j] || highs[i] <= highs[i + j]) isHigh = false
      if (lows[i]  >= lows[i - j]  || lows[i]  >= lows[i + j])  isLow  = false
    }
    if (isHigh) pivotHighs.push(highs[i])
    if (isLow)  pivotLows.push(lows[i])
  }

  // Find nearest resistance above price and support below price
  const resistanceCandidates = pivotHighs.filter(v => v > price).sort((a, b) => a - b)
  const supportCandidates    = pivotLows.filter(v => v < price).sort((a, b) => b - a)

  return {
    support:    supportCandidates.length    ? parseFloat(supportCandidates[0].toFixed(4))    : null,
    resistance: resistanceCandidates.length ? parseFloat(resistanceCandidates[0].toFixed(4)) : null,
  }
}

/**
 * Detect chart patterns and contextual signals
 */
function detectPatterns(opens, highs, lows, closes, volumes) {
  const patterns = []
  if (!closes || closes.length < 3) return patterns

  const n     = closes.length
  const price = closes[n - 1]

  // EMA arrays for trend context
  const ema9Arr   = computeEMAArray(closes, 9)
  const ema21Arr  = computeEMAArray(closes, 21)
  const ema50Arr  = computeEMAArray(closes, 50)
  const ema200Arr = computeEMAArray(closes, 200)

  const e9   = ema9Arr[n - 1]
  const e21  = ema21Arr[n - 1]
  const e50  = ema50Arr[n - 1]
  const e200 = ema200Arr[n - 1]

  // EMA trend context
  if (!isNaN(e50) && !isNaN(e200)) {
    if (price > e50 && price > e200 && e50 > e200) patterns.push('strong_uptrend')
    else if (price < e50 && price < e200 && e50 < e200) patterns.push('strong_downtrend')
  }
  if (!isNaN(e50)) {
    if (price > e50)  patterns.push('above_ema50')
    else              patterns.push('below_ema50')
  }
  if (!isNaN(e200)) {
    if (price > e200) patterns.push('above_ema200')
    else              patterns.push('below_ema200')
  }

  // Golden/Death cross: EMA21 vs EMA50
  if (!isNaN(e21) && !isNaN(e50) && n >= 2) {
    const prevE21 = ema21Arr[n - 2]
    const prevE50 = ema50Arr[n - 2]
    if (!isNaN(prevE21) && !isNaN(prevE50)) {
      if (e21 > e50 && prevE21 <= prevE50) patterns.push('golden_cross')
      if (e21 < e50 && prevE21 >= prevE50) patterns.push('death_cross')
    }
  }

  // Last bar candle patterns
  const o = opens[n - 1]
  const h = highs[n - 1]
  const l = lows[n - 1]
  const c = closes[n - 1]
  const range  = h - l
  const body   = Math.abs(c - o)
  const upWick = h - Math.max(c, o)
  const dnWick = Math.min(c, o) - l

  if (range > 0) {
    // Doji: very small body relative to range
    if (body / range < 0.1) patterns.push('doji')

    // Hammer: small body at top, long lower wick, short upper wick
    if (dnWick > body * 2 && upWick < body * 0.5 && range > 0)
      patterns.push('hammer')

    // Shooting star: small body at bottom, long upper wick, short lower wick
    if (upWick > body * 2 && dnWick < body * 0.5 && range > 0)
      patterns.push('shooting_star')

    // Strong bull/bear candles
    if (c > o && body / range > 0.7) patterns.push('strong_bull_candle')
    if (c < o && body / range > 0.7) patterns.push('strong_bear_candle')

    // Engulfing (need prior bar)
    if (n >= 2) {
      const po = opens[n - 2]
      const pc = closes[n - 2]
      // Bullish engulfing: prior bar bearish, current bar bullish and engulfs prior
      if (pc < po && c > o && o < pc && c > po) patterns.push('bullish_engulfing')
      // Bearish engulfing: prior bar bullish, current bar bearish and engulfs prior
      if (pc > po && c < o && o > pc && c < po) patterns.push('bearish_engulfing')
    }
  }

  // 20-bar breakout
  if (n >= 21) {
    const last20Highs = highs.slice(n - 21, n - 1)
    const last20Lows  = lows.slice(n - 21, n - 1)
    const max20 = Math.max(...last20Highs)
    const min20 = Math.min(...last20Lows)
    if (h > max20) patterns.push('20bar_breakout_up')
    if (l < min20) patterns.push('20bar_breakout_down')
  }

  // Volume spike
  if (volumes && volumes.length >= 21) {
    const avgVol20 = volumes.slice(n - 21, n - 1).reduce((s, v) => s + v, 0) / 20
    const curVol   = volumes[n - 1]
    if (avgVol20 > 0 && curVol > avgVol20 * 2) {
      patterns.push('volume_spike')
      if (c > o) patterns.push('high_vol_bull')
      else       patterns.push('high_vol_bear')
    }
  }

  // BB squeeze
  const bb = computeBB(closes)
  if (bb && bb.squeeze) patterns.push('bb_squeeze')

  return patterns
}

/**
 * Volume analysis
 */
function volumeAnalysis(volumes) {
  if (!volumes || volumes.length < 2) return null

  const n       = volumes.length
  const current = volumes[n - 1]
  const slice20 = volumes.slice(Math.max(0, n - 21), n - 1)
  const avg20   = slice20.length ? slice20.reduce((s, v) => s + v, 0) / slice20.length : 0
  const ratio   = avg20 > 0 ? parseFloat((current / avg20).toFixed(2)) : 0

  // Trend: compare recent 5 to prior 5
  let trend = 'neutral'
  if (n >= 10) {
    const recent5 = volumes.slice(n - 5).reduce((s, v) => s + v, 0) / 5
    const prior5  = volumes.slice(n - 10, n - 5).reduce((s, v) => s + v, 0) / 5
    if (recent5 > prior5 * 1.1) trend = 'increasing'
    else if (recent5 < prior5 * 0.9) trend = 'decreasing'
  }

  return {
    current,
    avg20:  parseFloat(avg20.toFixed(0)),
    ratio,
    trend,
    spike:  ratio > 2,
  }
}

// ── Analysis prompt builder ────────────────────────────────────────────────────

function buildAnalysisPrompt(symbol, interval, price, indicators, patterns, vol, priceLabel = 'last bar close', sentiment = null) {
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
    ? `\nRETAIL SENTIMENT (StockTwits — last ${sentiment.total} posts):\nBullish: ${sentiment.bullish} | Bearish: ${sentiment.bearish} | Neutral: ${sentiment.neutral}${sentiment.snippets.length ? '\nSample posts:\n' + sentiment.snippets.join('\n') : ''}\n`
    : ''

  const prompt = `You are an expert quantitative trading analyst. Analyze the following technical data for ${symbol} on the ${interval} timeframe and generate a structured trading signal.

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
${sentimentSection}
ANALYSIS INSTRUCTIONS:
1. Look for CONTRADICTIONS between indicators (e.g. RSI overbought but MACD still bullish, price above EMA50 but OBV falling, BB squeeze while RSI diverging). List each contradiction explicitly.
2. For price targets, provide a ZONE (low/high) based on key S/R and ATR, not a single precise number. Entry zone should reflect realistic fill range around current price.
3. Assess overall signal confidence based on indicator CONFLUENCE — high confidence requires 4+ indicators agreeing.
4. TWO-SIDED THESIS (institutional research framework — populate the "thesis" object):
   LEFT SIDE — technical structure: What do the indicators say about the underlying price structure? Identify the 2-3 load-bearing assumptions the setup rests on. State your "variant view" — where this reading differs from the obvious, consensus interpretation of the chart. Then: what must remain true for the left case to hold, and what single signal would break it?
   RIGHT SIDE — market confirmation: Is the market itself moving with or against the thesis right now? Judge via price momentum, OBV/volume trend, and trend alignment across EMAs. Is capital flowing into or out of this name? What must persist for the right case to hold, and what would break it?
   PRICED-IN CHECK: Is this setup obvious and already crowded? A correct thesis that everyone can see has thin edge even if technically valid.
   ENTRY TYPE — classify as exactly one of: "left-entry" (setup is structurally sound but market not yet confirming — higher timing risk, potentially better price), "right-entry" (market actively confirming the thesis — pay slightly higher for lower timing risk), "neither" (thesis doesn't hold on either side).
5. Use the full 5-tier signal scale: BUY = strong entry, 4+ indicators confirming | OVERWEIGHT = favorable setup, add to existing position | HOLD = no clear directional edge, stay flat | UNDERWEIGHT = headwinds building, reduce exposure | SELL = exit or short, significant downside confirmed by multiple signals.

Respond with ONLY pure JSON (absolutely no markdown fences, no backticks, no code blocks, no text before or after the JSON). The JSON must match this exact shape:
{
  "signal": "BUY | OVERWEIGHT | HOLD | UNDERWEIGHT | SELL",
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
  "thesis": {
    "claim": "one sentence — what must happen for this trade to work",
    "left": "technical structure case — load-bearing assumptions and variant view vs consensus chart read",
    "leftMustBeTrue": "the one thing that must hold for the left case to survive",
    "leftBreaksIf": "specific signal that would invalidate the structural case",
    "right": "market confirmation — momentum, volume/OBV flow, trend alignment",
    "rightMustBeTrue": "the condition that must persist for market to keep confirming",
    "rightBreaksIf": "specific signal that would break the confirmation case",
    "pricedIn": "is this the obvious trade — crowded or contrarian",
    "entryType": "left-entry | right-entry | neither"
  },
  "indicators": {
    "rsi": "concise interpretation string",
    "macd": "concise interpretation string",
    "ema": "concise interpretation string",
    "bollinger": "concise interpretation string",
    "volume": "concise interpretation string"
  },
  "contradictions": ["contradiction1 if any", "contradiction2 if any"],
  "patterns": ["pattern1", "pattern2"],
  "reasoning": "3-4 sentence synthesis of the two-sided thesis — which side dominates and why",
  "risks": ["risk1", "risk2", "risk3"],
  "disclaimer": "brief risk disclaimer string"
}`

  return prompt
}

// ── POST /analyze ─────────────────────────────────────────────────────────────

router.post('/analyze', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'AI service not configured (ANTHROPIC_API_KEY missing)' })

  const { symbol, interval = 'D', livePrice: clientLivePrice } = req.body

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

    if (!bars)
      return res.status(422).json({ error: `No market data available for ${sym}. Add an AISA, Finnhub, or FMP API key in Settings for full coverage.` })

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
        const lp = qd?.quoteResponse?.result?.[0]?.regularMarketPrice
        if (lp && lp > 0 && (Math.abs(lp - price) / price < 0.5 || isCryptoSymbol(sym))) {
          // Sanity check: accept if within 50% of bar close, OR always for crypto
          // (crypto quote from Binance/CoinGecko is authoritative even when bars are stale)
          price = lp
          priceLabel = 'live quote'
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

    // Fetch StockTwits sentiment (fire-and-forget, non-blocking on failure)
    const sentiment = await fetchStockTwits(sym)
    if (sentiment) console.log(`[trading-analysis] ${sym} StockTwits: ${sentiment.bullish}B ${sentiment.bearish}Be ${sentiment.neutral}N / ${sentiment.total}`)

    // Build prompt and call Claude
    const analysisPrompt = buildAnalysisPrompt(sym, interval, price, indicators, patterns, vol, priceLabel, sentiment)

    const anthropic = new Anthropic({ apiKey })
    const msg = await anthropic.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      messages:   [{ role: 'user', content: analysisPrompt }],
    })

    const rawText = msg.content?.[0]?.text || ''

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

// ── POST /chat (SSE streaming) ────────────────────────────────────────────────

const CHAT_SYSTEM_PROMPT =
  'You are an expert AI trading analyst integrated into a professional trading platform. ' +
  'Answer concisely with specific references to the indicator values provided. ' +
  'Always include brief risk disclaimers. Never guarantee profits.'

router.post('/chat', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    res.setHeader('Content-Type', 'text/event-stream')
    res.write(`data: ${JSON.stringify({ error: 'AI service not configured (ANTHROPIC_API_KEY missing)' })}\n\n`)
    return res.end()
  }

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
    if (symbol)   contextLines.push(`Symbol: ${symbol}`)
    if (interval) contextLines.push(`Timeframe: ${interval}`)
    if (price != null) contextLines.push(`Current price: ${price}`)
    systemPrompt += `\n\nCurrent chart context:\n${contextLines.join('\n')}`
  }
  if (analysisContext && typeof analysisContext === 'object') {
    systemPrompt += `\n\nLatest analysis context:\n${JSON.stringify(analysisContext, null, 2)}`
  }

  // Build messages: include last 10 from history + current message
  const messages = [
    ...history.slice(-10).map(m => ({ role: m.role, content: String(m.content) })),
    { role: 'user', content: message },
  ]

  try {
    const anthropic = new Anthropic({ apiKey })

    const stream = anthropic.messages.stream({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      system:     systemPrompt,
      messages,
    })

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
