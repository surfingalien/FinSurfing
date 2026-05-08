const cache = new Map()
const TTL = 30 * 1000 // 30 sec — keeps rapid re-renders cheap but lets Refresh work

function cached(key, fn) {
  const hit = cache.get(key)
  if (hit && Date.now() - hit.ts < TTL) return Promise.resolve(hit.data)
  return fn().then(data => { cache.set(key, { data, ts: Date.now() }); return data })
}

async function apiFetch(path) {
  const res = await fetch(path, { signal: AbortSignal.timeout(12000) })
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

/* ── Quotes ────────────────────────────────── */
export async function fetchQuotes(symbols) {
  if (!symbols.length) return []
  const key = 'q:' + symbols.sort().join(',')
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
      prevClose: q.regularMarketPreviousClose ?? q.prevClose ?? null,
      marketCap: q.marketCap ?? null,
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
