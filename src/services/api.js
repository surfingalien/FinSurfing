const cache = new Map()
const TTL = 30 * 1000 // 30 sec — keeps rapid re-renders cheap but lets Refresh work

function cached(key, fn) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < TTL) return Promise.resolve(hit.data)
  return fn().then(data => { cache.set(key, { data, ts: Date.now() }); return data })
}

// Read user-supplied API keys from localStorage and return them as request headers.
// Keys are stored by ApiKeysContext under 'finsurf_api_keys'.
function getApiKeyHeaders() {
  try {
    const stored = JSON.parse(localStorage.getItem('finsurf_api_keys') || '{}')
    const h = {}
    if (stored.aisa?.trim())    h['x-aisa-key']    = stored.aisa.trim()
    if (stored.finnhub?.trim()) h['x-finnhub-key'] = stored.finnhub.trim()
    if (stored.fmp?.trim())     h['x-fmp-key']     = stored.fmp.trim()
    if (stored.td?.trim())      h['x-td-key']      = stored.td.trim()
    if (stored.av?.trim())      h['x-av-key']      = stored.av.trim()
    return h
  } catch { return {} }
}

async function apiFetch(path) {
  const res = await fetch(path, {
    headers: getApiKeyHeaders(),
    signal:  AbortSignal.timeout(12000),
  })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

/* ── Quotes ────────────────────────────────── */
export async function fetchQuotes(symbols, { force = false } = {}) {
  if (!symbols.length) return []
  const key = 'q:' + symbols.sort().join(',')
  if (force) cache.delete(key)
  return cached(key, async () => {
    const data = await apiFetch(`/api/quote?symbols=${symbols.join(',')}`)
    return (data?.quoteResponse?.result || []).map(q => ({
      symbol:    q.symbol,
      // v7/quote uses shortName/longName; chart fallback uses name
      name:      q.shortName || q.longName || q.name || q.symbol,
      // v7/quote uses regularMarket* fields; chart fallback uses short names
      price:     q.regularMarketPrice    ?? q.price     ?? null,
      change:    q.regularMarketChange   ?? q.change    ?? null,
      changePct: q.regularMarketChangePercent ?? q.changePct ?? null,
      volume:    q.regularMarketVolume   ?? q.volume    ?? null,
      high52:    q.fiftyTwoWeekHigh      ?? q.high52    ?? null,
      low52:     q.fiftyTwoWeekLow       ?? q.low52     ?? null,
      dayHigh:   q.regularMarketDayHigh  ?? q.dayHigh   ?? null,
      dayLow:    q.regularMarketDayLow   ?? q.dayLow    ?? null,
      open:      q.regularMarketOpen     ?? q.open      ?? null,
      prevClose:  q.regularMarketPreviousClose ?? q.prevClose ?? null,
      // Unix seconds timestamp of last regular-session trade — used to detect stale overnight data
      marketTime: q.regularMarketTime ?? null,
      marketCap:  q.marketCap ?? null,
      pe:        q.trailingPE ?? q.pe ?? null,
    }))
  })
}

/* ── Chart ──────────────────────────────────── */
export async function fetchChart(symbol, interval = '1d', range = '1y') {
  const key = `chart:${symbol}:${interval}:${range}`
  return cached(key, async () => {
    const data = await apiFetch(`/api/chart?symbol=${symbol}&interval=${interval}&range=${range}`)
    const result = data?.chart?.result?.[0]
    if (!result) throw new Error('No chart data for ' + symbol)
    const ts = result.timestamp || []
    const q  = result.indicators?.quote?.[0] || {}
    const adjClose = result.indicators?.adjclose?.[0]?.adjclose || []
    const candles = []
    for (let i = 0; i < ts.length; i++) {
      if (!q.close?.[i]) continue
      candles.push({
        time:   ts[i] * 1000,
        open:   +(q.open?.[i]   || q.close[i]).toFixed(4),
        high:   +(q.high?.[i]   || q.close[i]).toFixed(4),
        low:    +(q.low?.[i]    || q.close[i]).toFixed(4),
        close:  +q.close[i].toFixed(4),
        volume: q.volume?.[i] || 0,
        adj:    +(adjClose[i] || q.close[i]).toFixed(4),
      })
    }
    const meta = result.meta || {}
    return { symbol: meta.symbol || symbol, candles, meta }
  })
}

/* ── Fundamentals ───────────────────────────── */
export async function fetchSummary(symbol) {
  const key = `summary:${symbol}`
  return cached(key, async () => {
    const data = await apiFetch(`/api/summary?symbol=${symbol}&modules=summaryDetail,financialData,defaultKeyStatistics,assetProfile`)
    const r = data?.quoteSummary?.result?.[0]
    if (!r) return null
    const sd = r.summaryDetail        || {}
    const fd = r.financialData        || {}
    const ks = r.defaultKeyStatistics || {}
    const ap = r.assetProfile         || {}
    const g = obj => key => { const v = obj[key]; if (!v) return null; return v.raw !== undefined ? v.raw : v }
    const gsd = g(sd), gfd = g(fd), gks = g(ks)
    return {
      pe:               gsd('trailingPE'),
      forwardPE:        gsd('forwardPE'),
      eps:              gks('trailingEps'),
      marketCap:        gsd('marketCap'),
      dividendYield:    gsd('dividendYield'),
      beta:             gsd('beta'),
      high52:           gsd('fiftyTwoWeekHigh'),
      low52:            gsd('fiftyTwoWeekLow'),
      avgVolume:        gsd('averageVolume'),
      priceToBook:      gks('priceToBook'),
      returnOnEquity:   gfd('returnOnEquity'),
      debtToEquity:     gfd('debtToEquity'),
      currentRatio:     gfd('currentRatio'),
      revenueGrowth:    gfd('revenueGrowth'),
      earningsGrowth:   gfd('earningsGrowth'),
      profitMargin:     gfd('profitMargins'),
      grossMargin:      gfd('grossMargins'),
      operatingMargin:  gfd('operatingMargins'),
      totalRevenue:     gfd('totalRevenue'),
      freeCashFlow:     gfd('freeCashflow'),
      targetMeanPrice:  gfd('targetMeanPrice'),
      recommendationKey: fd.recommendationKey,
      sector:           ap.sector,
      industry:         ap.industry,
      longName:         ap.longName,
      summary:          ap.longBusinessSummary,
      employees:        ap.fullTimeEmployees,
      country:          ap.country,
    }
  })
}

/* ── Search ──────────────────────────────────── */
export async function searchSymbol(q) {
  if (!q.trim()) return []
  const data = await apiFetch(`/api/search?q=${encodeURIComponent(q)}`)
  return (data?.quotes || [])
    .filter(q => ['EQUITY','ETF','INDEX'].includes(q.quoteType))
    .slice(0, 8)
    .map(q => ({ symbol: q.symbol, name: q.shortname || q.longname || q.symbol, exchange: q.exchange || '', type: q.quoteType }))
}

/* ── Real-time quote stream (SSE) ─────────────────────────────────────────── */
// Opens an EventSource to /api/stream/quotes and calls onUpdate for each price tick.
// Returns a cleanup function — call it to close the connection.
export function subscribeQuotes(symbols, onUpdate) {
  if (!symbols.length || typeof EventSource === 'undefined') return () => {}
  const url = `/api/stream/quotes?symbols=${encodeURIComponent(symbols.join(','))}`
  const es  = new EventSource(url)
  es.onmessage = (e) => {
    try { onUpdate(JSON.parse(e.data)) } catch {}
  }
  // EventSource auto-reconnects on error — no manual retry needed
  return () => es.close()
}

/* ── Technical indicators ───────────────────── */
export function calcSMA(closes, period) {
  const result = new Array(closes.length).fill(null)
  for (let i = period - 1; i < closes.length; i++) {
    const sum = closes.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0)
    result[i] = +(sum / period).toFixed(4)
  }
  return result
}

export function calcEMA(closes, period) {
  const k = 2 / (period + 1)
  const result = new Array(closes.length).fill(null)
  let ema = closes[0]
  result[0] = ema
  for (let i = 1; i < closes.length; i++) {
    ema = closes[i] * k + ema * (1 - k)
    result[i] = +ema.toFixed(4)
  }
  return result
}

export function calcRSI(closes, period = 14) {
  const result = new Array(closes.length).fill(null)
  let gains = 0, losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gains += diff; else losses -= diff
  }
  let avgGain = gains / period
  let avgLoss = losses / period
  result[period] = avgLoss === 0 ? 100 : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2)
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + Math.max(0, diff)) / period
    avgLoss = (avgLoss * (period - 1) + Math.max(0, -diff)) / period
    result[i] = avgLoss === 0 ? 100 : +(100 - 100 / (1 + avgGain / avgLoss)).toFixed(2)
  }
  return result
}

export function calcMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = calcEMA(closes, fast)
  const emaSlow = calcEMA(closes, slow)
  const macdLine = closes.map((_, i) => emaFast[i] !== null && emaSlow[i] !== null ? +(emaFast[i] - emaSlow[i]).toFixed(4) : null)
  const signalLine = calcEMA(macdLine.filter(v => v !== null), signal)
  const result = []
  let sigIdx = 0
  for (let i = 0; i < closes.length; i++) {
    if (macdLine[i] === null) { result.push({ macd: null, signal: null, hist: null }); continue }
    const sig = sigIdx < signalLine.length ? signalLine[sigIdx] : null
    result.push({ macd: macdLine[i], signal: sig, hist: sig !== null ? +(macdLine[i] - sig).toFixed(4) : null })
    sigIdx++
  }
  return result
}

export function calcBollinger(closes, period = 20, stdDev = 2) {
  const sma = calcSMA(closes, period)
  return closes.map((_, i) => {
    if (sma[i] === null) return { upper: null, middle: null, lower: null }
    const slice = closes.slice(i - period + 1, i + 1)
    const mean = sma[i]
    const variance = slice.reduce((sum, v) => sum + (v - mean) ** 2, 0) / period
    const sd = Math.sqrt(variance)
    return { upper: +(mean + stdDev * sd).toFixed(4), middle: mean, lower: +(mean - stdDev * sd).toFixed(4) }
  })
}

/* ── Advanced indicators (ported from institutional quant stack) ─────────────
   All pure JS — no external dependencies, works in browser + server.
   Input arrays are parallel: highs[i], lows[i], closes[i], volumes[i].
   ─────────────────────────────────────────────────────────────────────────── */

// Average True Range — volatility measure used by Supertrend, position sizing
export function calcATR(highs, lows, closes, period = 14) {
  const n = closes.length
  const tr = closes.map((c, i) => {
    if (i === 0) return highs[i] - lows[i]
    return Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]))
  })
  // Wilder's smoothing (RMA)
  const result = new Array(n).fill(null)
  let atr = tr.slice(0, period).reduce((a, b) => a + b, 0) / period
  result[period - 1] = +atr.toFixed(4)
  for (let i = period; i < n; i++) {
    atr = (atr * (period - 1) + tr[i]) / period
    result[i] = +atr.toFixed(4)
  }
  return result
}

// Supertrend — trend-following signal, green = bullish, red = bearish
// Returns: { supertrend[], direction[] (1 = bull, -1 = bear), upperBand[], lowerBand[] }
export function calcSupertrend(highs, lows, closes, period = 10, multiplier = 3.0) {
  const n = closes.length
  const atr = calcATR(highs, lows, closes, period)
  const upperBand = new Array(n).fill(null)
  const lowerBand = new Array(n).fill(null)
  const supertrend = new Array(n).fill(null)
  const direction  = new Array(n).fill(null)

  for (let i = period - 1; i < n; i++) {
    if (atr[i] === null) continue
    const hl2 = (highs[i] + lows[i]) / 2
    const rawUpper = +(hl2 + multiplier * atr[i]).toFixed(4)
    const rawLower = +(hl2 - multiplier * atr[i]).toFixed(4)

    upperBand[i] = (i > 0 && upperBand[i - 1] !== null && rawUpper > upperBand[i - 1]) ? upperBand[i - 1] : rawUpper
    lowerBand[i] = (i > 0 && lowerBand[i - 1] !== null && rawLower < lowerBand[i - 1]) ? lowerBand[i - 1] : rawLower

    if (i === period - 1) {
      direction[i]  = 1
      supertrend[i] = lowerBand[i]
    } else {
      const prevDir = direction[i - 1]
      if (prevDir === 1)       direction[i] = closes[i] < lowerBand[i] ? -1 : 1
      else if (prevDir === -1) direction[i] = closes[i] > upperBand[i] ?  1 : -1
      else                     direction[i] = 1
      supertrend[i] = direction[i] === 1 ? lowerBand[i] : upperBand[i]
    }
  }
  return { supertrend, direction, upperBand, lowerBand }
}

// Ichimoku Cloud — multi-timeframe support/resistance + trend system
// Returns: { tenkan[], kijun[], senkouA[], senkouB[], chikou[] }
export function calcIchimoku(highs, lows, closes) {
  const n = closes.length
  const rollMid = (period) => {
    const r = new Array(n).fill(null)
    for (let i = period - 1; i < n; i++) {
      let hi = -Infinity, lo = Infinity
      for (let j = i - period + 1; j <= i; j++) { hi = Math.max(hi, highs[j]); lo = Math.min(lo, lows[j]) }
      r[i] = +((hi + lo) / 2).toFixed(4)
    }
    return r
  }
  const tenkan  = rollMid(9)
  const kijun   = rollMid(26)
  const senkou52 = rollMid(52)
  const senkouA = new Array(n).fill(null)
  const senkouB = new Array(n).fill(null)
  const chikou  = new Array(n).fill(null)

  for (let i = 0; i < n; i++) {
    // Senkou spans are plotted 26 periods into the future
    if (i + 26 < n) {
      senkouA[i + 26] = tenkan[i] !== null && kijun[i] !== null
        ? +((tenkan[i] + kijun[i]) / 2).toFixed(4) : null
      senkouB[i + 26] = senkou52[i]
    }
    // Chikou is the current close plotted 26 periods back
    if (i >= 26) chikou[i - 26] = closes[i]
  }
  return { tenkan, kijun, senkouA, senkouB, chikou }
}

// ADX + DMI — trend strength (ADX > 25 = strong trend) and direction (±DI)
// Returns: { adx[], plusDI[], minusDI[] }
export function calcADX(highs, lows, closes, period = 14) {
  const n = closes.length
  const tr  = new Array(n).fill(0)
  const pdm = new Array(n).fill(0)
  const ndm = new Array(n).fill(0)

  for (let i = 1; i < n; i++) {
    tr[i]  = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i-1]), Math.abs(lows[i] - closes[i-1]))
    const up   = highs[i]  - highs[i-1]
    const down = lows[i-1] - lows[i]
    pdm[i] = up > down && up > 0 ? up : 0
    ndm[i] = down > up && down > 0 ? down : 0
  }

  // Wilder's smoothed sums
  const wilder = (arr) => {
    const r = new Array(n).fill(null)
    let s = arr.slice(1, period + 1).reduce((a, b) => a + b, 0)
    r[period] = s
    for (let i = period + 1; i < n; i++) { s = s - s / period + arr[i]; r[i] = s }
    return r
  }
  const sTR = wilder(tr), sPDM = wilder(pdm), sNDM = wilder(ndm)

  const plusDI  = new Array(n).fill(null)
  const minusDI = new Array(n).fill(null)
  const dx      = new Array(n).fill(null)
  const adx     = new Array(n).fill(null)

  for (let i = period; i < n; i++) {
    if (!sTR[i]) continue
    plusDI[i]  = +(100 * sPDM[i] / sTR[i]).toFixed(2)
    minusDI[i] = +(100 * sNDM[i] / sTR[i]).toFixed(2)
    const diSum = plusDI[i] + minusDI[i]
    dx[i] = diSum === 0 ? 0 : +(100 * Math.abs(plusDI[i] - minusDI[i]) / diSum).toFixed(2)
  }

  // Smooth DX with Wilder's method to get ADX
  const start = period * 2
  if (start < n) {
    let s = dx.slice(period, start).filter(v => v !== null).reduce((a, b) => a + b, 0)
    adx[start - 1] = +(s / period).toFixed(2)
    for (let i = start; i < n; i++) {
      if (dx[i] === null || adx[i-1] === null) continue
      adx[i] = +((adx[i-1] * (period - 1) + dx[i]) / period).toFixed(2)
    }
  }
  return { adx, plusDI, minusDI }
}

// VWAP — Volume Weighted Average Price (intraday / session-level)
export function calcVWAP(highs, lows, closes, volumes) {
  const result = new Array(closes.length).fill(null)
  let cumTPV = 0, cumVol = 0
  for (let i = 0; i < closes.length; i++) {
    const tp = (highs[i] + lows[i] + closes[i]) / 3
    cumTPV += tp * (volumes[i] || 0)
    cumVol += volumes[i] || 0
    result[i] = cumVol > 0 ? +(cumTPV / cumVol).toFixed(4) : null
  }
  return result
}

// ── Signal generator — combines indicators into BUY / SELL / HOLD ─────────────
// candles: [{ open, high, low, close, volume }]
// Returns { action, confidence, stopLoss, takeProfit, rationale[], riskReward }
export function generateSignal(candles) {
  if (!candles || candles.length < 60) return { action: 'HOLD', confidence: 0, rationale: ['Insufficient data (need 60+ bars)'] }

  const highs   = candles.map(c => c.high)
  const lows    = candles.map(c => c.low)
  const closes  = candles.map(c => c.close)
  const volumes = candles.map(c => c.volume)
  const n       = closes.length
  const price   = closes[n - 1]

  // Calculate all indicators
  const atrArr  = calcATR(highs, lows, closes, 14)
  const st      = calcSupertrend(highs, lows, closes, 10, 3)
  const adx     = calcADX(highs, lows, closes, 14)
  const rsi     = calcRSI(closes, 14)
  const macd    = calcMACD(closes)
  const { kijun, senkouA, senkouB } = calcIchimoku(highs, lows, closes)

  const atr     = atrArr[n - 1] || price * 0.01
  const stDir   = st.direction[n - 1]
  const adxVal  = adx.adx[n - 1]
  const rsiVal  = rsi[n - 1]
  const macdNow = macd[n - 1]
  const aboveCloud = senkouA[n - 1] && senkouB[n - 1]
    ? price > Math.max(senkouA[n - 1], senkouB[n - 1])
    : null
  const belowCloud = senkouA[n - 1] && senkouB[n - 1]
    ? price < Math.min(senkouA[n - 1], senkouB[n - 1])
    : null
  const aboveKijun = kijun[n - 1] ? price > kijun[n - 1] : null

  const bull = [], bear = []

  // Supertrend
  if (stDir === 1)  bull.push('Supertrend bullish ↑')
  if (stDir === -1) bear.push('Supertrend bearish ↓')

  // ADX trend strength
  if (adxVal > 25 && stDir === 1)  bull.push(`Strong trend (ADX ${adxVal?.toFixed(0)})`)
  if (adxVal > 25 && stDir === -1) bear.push(`Strong trend (ADX ${adxVal?.toFixed(0)})`)

  // RSI
  if (rsiVal !== null && rsiVal < 35)       bull.push(`Oversold RSI ${rsiVal?.toFixed(0)}`)
  else if (rsiVal !== null && rsiVal > 65)  bear.push(`Overbought RSI ${rsiVal?.toFixed(0)}`)
  else if (rsiVal !== null && rsiVal > 45 && rsiVal < 60) bull.push(`Healthy RSI ${rsiVal?.toFixed(0)}`)

  // MACD
  if (macdNow?.hist !== null && macdNow.hist > 0 && macdNow.macd > 0) bull.push('MACD bullish crossover')
  if (macdNow?.hist !== null && macdNow.hist < 0 && macdNow.macd < 0) bear.push('MACD bearish crossover')

  // Ichimoku
  if (aboveCloud === true)  bull.push('Price above Ichimoku cloud')
  if (belowCloud === true)  bear.push('Price below Ichimoku cloud')
  if (aboveKijun === true)  bull.push('Price above Kijun-sen')
  if (aboveKijun === false) bear.push('Price below Kijun-sen')

  const total = bull.length + bear.length || 1
  const bullScore = bull.length / total
  const bearScore = bear.length / total

  let action, confidence, stopLoss, takeProfit
  if (bullScore >= 0.55) {
    action     = 'BUY'
    confidence = Math.min(bullScore, 0.95)
    stopLoss   = +(price - 2 * atr).toFixed(2)
    takeProfit = +(price + 3 * atr).toFixed(2)
  } else if (bearScore >= 0.55) {
    action     = 'SELL'
    confidence = Math.min(bearScore, 0.95)
    stopLoss   = +(price + 2 * atr).toFixed(2)
    takeProfit = +(price - 3 * atr).toFixed(2)
  } else {
    action     = 'HOLD'
    confidence = 0
    stopLoss   = price
    takeProfit = price
  }

  const slDist = Math.abs(price - stopLoss) || 1
  const tpDist = Math.abs(takeProfit - price)
  return {
    action,
    confidence: +confidence.toFixed(2),
    stopLoss,
    takeProfit,
    riskReward: +(tpDist / slDist).toFixed(2),
    rationale:  action === 'BUY' ? bull : action === 'SELL' ? bear : ['Mixed signals — wait for clearer setup'],
  }
}

// ── News sentiment scorer (finance-lexicon VADER-lite, offline) ───────────────
// Scores an array of headline strings → { compound, label, pos, neg }
const BULL_WORDS = /\b(surge|soar|rally|gain|beat|record|growth|profit|revenue|upgrade|buy|bullish|breakout|boost|outperform|strong|rise|climbs?|jumps?|wins?|positive|recovery|rebound)\b/gi
const BEAR_WORDS = /\b(drop|fall|slump|loss|miss|decline|downgrade|sell|bearish|crash|weak|cut|layoff|lawsuit|debt|default|plunge|tumble|warn|negative|risk|concern|bankruptcy)\b/gi

export function calcNewsSentiment(headlines = []) {
  if (!headlines.length) return { compound: 0, label: 'neutral', pos: 0, neg: 0 }
  let pos = 0, neg = 0
  for (const h of headlines) {
    pos += (h.match(BULL_WORDS) || []).length
    neg += (h.match(BEAR_WORDS) || []).length
  }
  const total   = pos + neg || 1
  const compound = +((pos - neg) / total).toFixed(3)
  return {
    compound,
    label: compound >= 0.1 ? 'bullish' : compound <= -0.1 ? 'bearish' : 'neutral',
    pos:   +(pos / total).toFixed(3),
    neg:   +(neg / total).toFixed(3),
  }
}

/* ── Format helpers ─────────────────────────── */
export function fmt(n, digits = 2) {
  if (n == null || isNaN(n)) return '—'
  return n.toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })
}

export function fmtPct(n, digits = 2) {
  if (n == null || isNaN(n)) return '—'
  return (n >= 0 ? '+' : '') + n.toFixed(digits) + '%'
}

export function fmtLarge(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1e12) return '$' + (n / 1e12).toFixed(2) + 'T'
  if (n >= 1e9)  return '$' + (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6)  return '$' + (n / 1e6).toFixed(2) + 'M'
  return '$' + n.toLocaleString()
}

export function fmtVol(n) {
  if (n == null || isNaN(n)) return '—'
  if (n >= 1e9)  return (n / 1e9).toFixed(2) + 'B'
  if (n >= 1e6)  return (n / 1e6).toFixed(2) + 'M'
  if (n >= 1e3)  return (n / 1e3).toFixed(0) + 'K'
  return n.toString()
}
