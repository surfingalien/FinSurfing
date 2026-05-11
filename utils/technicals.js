/**
 * utils/technicals.js
 * Server-side technical indicator computations from OHLCV arrays.
 *
 * All functions accept arrays of numbers (most-recent LAST) and return
 * numeric values or structured objects. NaN is returned when there is
 * insufficient data.
 */

'use strict'

// ── Helpers ──────────────────────────────────────────────────────────────────

function avg(arr) {
  if (!arr.length) return NaN
  return arr.reduce((s, v) => s + v, 0) / arr.length
}

function round(n, d = 4) {
  if (n == null || isNaN(n)) return null
  return +n.toFixed(d)
}

// ── Simple Moving Average ─────────────────────────────────────────────────────

function sma(closes, period) {
  if (closes.length < period) return NaN
  return avg(closes.slice(-period))
}

// ── Exponential Moving Average ────────────────────────────────────────────────

function ema(closes, period) {
  if (closes.length < period) return NaN
  const k = 2 / (period + 1)
  let e = avg(closes.slice(0, period))
  for (let i = period; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k)
  }
  return e
}

// Build full EMA series (same length as closes, NaN for early entries)
function emaSeries(closes, period) {
  const k = 2 / (period + 1)
  const out = new Array(closes.length).fill(NaN)
  if (closes.length < period) return out
  let e = avg(closes.slice(0, period))
  out[period - 1] = e
  for (let i = period; i < closes.length; i++) {
    e = closes[i] * k + e * (1 - k)
    out[i] = e
  }
  return out
}

// ── RSI(14) ──────────────────────────────────────────────────────────────────

function rsi(closes, period = 14) {
  if (closes.length < period + 1) return NaN

  let gains = 0, losses = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff >= 0) gains += diff
    else losses -= diff
  }

  let avgGain = gains / period
  let avgLoss = losses / period

  // Wilder smoothing
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
  }

  if (avgLoss === 0) return 100
  const rs = avgGain / avgLoss
  return 100 - 100 / (1 + rs)
}

// ── MACD(12,26,9) ─────────────────────────────────────────────────────────────

function macd(closes, fast = 12, slow = 26, signal = 9) {
  if (closes.length < slow + signal) {
    return { macdLine: null, signalLine: null, histogram: null }
  }

  const fastSeries   = emaSeries(closes, fast)
  const slowSeries   = emaSeries(closes, slow)

  // MACD line = difference of two EMAs (only where both exist)
  const macdSeries = fastSeries.map((f, i) =>
    isNaN(f) || isNaN(slowSeries[i]) ? NaN : f - slowSeries[i]
  )

  // Signal = EMA(9) of MACD line — need at least `signal` valid MACD values
  const validMacd = macdSeries.filter(v => !isNaN(v))
  if (validMacd.length < signal) {
    return { macdLine: round(macdSeries.at(-1)), signalLine: null, histogram: null }
  }

  // Build signal series from first valid MACD value onward
  const startIdx = macdSeries.findIndex(v => !isNaN(v))
  const macdValid = macdSeries.slice(startIdx)
  const signalK   = 2 / (signal + 1)
  let sig = avg(macdValid.slice(0, signal))
  for (let i = signal; i < macdValid.length; i++) {
    sig = macdValid[i] * signalK + sig * (1 - signalK)
  }

  const macdLine   = macdSeries.at(-1)
  const histogram  = macdLine - sig

  return {
    macdLine:   round(macdLine),
    signalLine: round(sig),
    histogram:  round(histogram),
  }
}

// ── Bollinger Bands(20,2) ─────────────────────────────────────────────────────

function bollingerBands(closes, period = 20, stdDev = 2) {
  if (closes.length < period) {
    return { upper: null, middle: null, lower: null, bandwidth: null, percentB: null }
  }

  const slice  = closes.slice(-period)
  const middle = avg(slice)
  const variance = slice.reduce((s, v) => s + (v - middle) ** 2, 0) / period
  const sd     = Math.sqrt(variance)

  const upper  = middle + stdDev * sd
  const lower  = middle - stdDev * sd
  const price  = closes.at(-1)
  const bandwidth = middle > 0 ? ((upper - lower) / middle) * 100 : null
  const percentB  = upper !== lower ? ((price - lower) / (upper - lower)) * 100 : 50

  return {
    upper:      round(upper, 2),
    middle:     round(middle, 2),
    lower:      round(lower, 2),
    bandwidth:  round(bandwidth, 2),
    percentB:   round(percentB, 2),
  }
}

// ── ATR(14) ──────────────────────────────────────────────────────────────────

function atr(highs, lows, closes, period = 14) {
  if (closes.length < period + 1) return null

  const n = Math.min(highs.length, lows.length, closes.length)
  const trueRanges = []
  for (let i = 1; i < n; i++) {
    const tr = Math.max(
      highs[i]  - lows[i],
      Math.abs(highs[i]  - closes[i - 1]),
      Math.abs(lows[i]   - closes[i - 1])
    )
    trueRanges.push(tr)
  }

  if (trueRanges.length < period) return null

  // Wilder smoothing
  let atrVal = avg(trueRanges.slice(0, period))
  for (let i = period; i < trueRanges.length; i++) {
    atrVal = (atrVal * (period - 1) + trueRanges[i]) / period
  }

  return round(atrVal, 4)
}

// ── Support & Resistance (simple pivot detection) ─────────────────────────────

function supportResistance(highs, lows, closes, lookback = 20) {
  const slice = closes.slice(-lookback)
  const hSlice = highs.slice(-lookback)
  const lSlice = lows.slice(-lookback)

  // Local maxima / minima with 3-bar window
  const resistanceLevels = []
  const supportLevels    = []

  for (let i = 1; i < hSlice.length - 1; i++) {
    if (hSlice[i] > hSlice[i - 1] && hSlice[i] > hSlice[i + 1]) {
      resistanceLevels.push(round(hSlice[i], 2))
    }
    if (lSlice[i] < lSlice[i - 1] && lSlice[i] < lSlice[i + 1]) {
      supportLevels.push(round(lSlice[i], 2))
    }
  }

  // Cluster nearby levels (within 1%)
  function cluster(levels) {
    if (!levels.length) return []
    levels.sort((a, b) => a - b)
    const clusters = [[levels[0]]]
    for (let i = 1; i < levels.length; i++) {
      const last = clusters.at(-1)
      const ref  = last.at(-1)
      if (Math.abs(levels[i] - ref) / ref < 0.01) {
        last.push(levels[i])
      } else {
        clusters.push([levels[i]])
      }
    }
    return clusters.map(c => round(avg(c), 2)).filter(Boolean)
  }

  const price = closes.at(-1)

  // Get closest support below price and resistance above price
  const supLevels = cluster(supportLevels).filter(l => l < price)
  const resLevels = cluster(resistanceLevels).filter(l => l > price)

  return {
    nearestSupport:    supLevels.length ? Math.max(...supLevels) : round(Math.min(...lSlice), 2),
    nearestResistance: resLevels.length ? Math.min(...resLevels) : round(Math.max(...hSlice), 2),
    supportLevels:     supLevels.slice(-3),
    resistanceLevels:  resLevels.slice(0, 3),
  }
}

// ── Volume analysis ───────────────────────────────────────────────────────────

function volumeAnalysis(volumes, closes) {
  const n = Math.min(volumes.length, closes.length)
  if (n < 5) return { avgVolume: null, relativeVolume: null, trend: 'neutral' }

  const avgVol      = avg(volumes.slice(-20))
  const currentVol  = volumes.at(-1)
  const relativeVol = avgVol > 0 ? round(currentVol / avgVol, 2) : null

  // Volume trend: compare recent 5-day avg vs 20-day avg
  const recent5  = avg(volumes.slice(-5))
  const trend    = recent5 > avgVol * 1.1 ? 'increasing' : recent5 < avgVol * 0.9 ? 'decreasing' : 'neutral'

  return {
    avgVolume:      Math.round(avgVol),
    currentVolume:  currentVol,
    relativeVolume: relativeVol,
    trend,
  }
}

// ── Price action metrics ──────────────────────────────────────────────────────

function priceAction(opens, highs, lows, closes) {
  const n = closes.length
  if (n < 2) return {}

  const price    = closes.at(-1)
  const prevClose = closes.at(-2)
  const open     = opens.at(-1)
  const high     = highs.at(-1)
  const low      = lows.at(-1)

  const dayChange    = price - prevClose
  const dayChangePct = prevClose > 0 ? (dayChange / prevClose) * 100 : 0
  const candleBody   = Math.abs(price - open)
  const candleRange  = high - low
  const bodyRatio    = candleRange > 0 ? candleBody / candleRange : 0

  // Trend: compare close vs 10 & 20 day ago
  const close10ago = n > 10 ? closes[n - 11] : null
  const close20ago = n > 20 ? closes[n - 21] : null

  let shortTrend = 'sideways'
  if (close10ago) {
    const pct10 = (price - close10ago) / close10ago * 100
    shortTrend = pct10 > 2 ? 'uptrend' : pct10 < -2 ? 'downtrend' : 'sideways'
  }

  let longTrend = 'sideways'
  if (close20ago) {
    const pct20 = (price - close20ago) / close20ago * 100
    longTrend = pct20 > 5 ? 'uptrend' : pct20 < -5 ? 'downtrend' : 'sideways'
  }

  return {
    price:         round(price, 2),
    dayChange:     round(dayChange, 4),
    dayChangePct:  round(dayChangePct, 2),
    open:          round(open, 2),
    high:          round(high, 2),
    low:           round(low, 2),
    candleBody:    round(candleBody, 4),
    candleRange:   round(candleRange, 4),
    bodyRatio:     round(bodyRatio, 2),
    shortTrend,
    longTrend,
  }
}

// ── Master compute (all indicators from OHLCV arrays) ─────────────────────────

/**
 * computeAll(ohlcv)
 *
 * @param {object} ohlcv  { opens[], highs[], lows[], closes[], volumes[], timestamps[] }
 * @returns Full indicator snapshot ready for the agent
 */
function computeAll(ohlcv) {
  const { opens = [], highs = [], lows = [], closes = [], volumes = [] } = ohlcv

  if (closes.length < 5) {
    return { error: 'Insufficient data (need at least 5 bars)' }
  }

  const rsiVal   = round(rsi(closes, 14), 2)
  const macdVals = macd(closes)
  const bb       = bollingerBands(closes)
  const atrVal   = atr(highs, lows, closes)
  const sma50    = closes.length >= 50  ? round(sma(closes, 50),  2) : null
  const sma200   = closes.length >= 200 ? round(sma(closes, 200), 2) : null
  const ema20    = closes.length >= 20  ? round(ema(closes, 20),  2) : null
  const sr       = supportResistance(highs, lows, closes)
  const vol      = volumeAnalysis(volumes, closes)
  const pa       = priceAction(opens, highs, lows, closes)

  // RSI interpretation
  const rsiSignal = rsiVal == null ? 'unknown'
    : rsiVal >= 70 ? 'overbought'
    : rsiVal <= 30 ? 'oversold'
    : rsiVal >= 60 ? 'bullish'
    : rsiVal <= 40 ? 'bearish'
    : 'neutral'

  // MACD trend
  const macdTrend = macdVals.histogram == null ? 'unknown'
    : macdVals.histogram > 0 && macdVals.macdLine > 0  ? 'strong_bullish'
    : macdVals.histogram > 0                            ? 'bullish'
    : macdVals.histogram < 0 && macdVals.macdLine < 0  ? 'strong_bearish'
    : 'bearish'

  // Bollinger squeeze
  const bbSignal = bb.bandwidth == null ? 'unknown'
    : bb.bandwidth < 5  ? 'squeeze'
    : bb.bandwidth > 20 ? 'expansion'
    : 'normal'

  // MA cross signals
  const maSignals = []
  const price = pa.price
  if (price && sma50)  maSignals.push(price > sma50  ? 'above_sma50'  : 'below_sma50')
  if (price && sma200) maSignals.push(price > sma200 ? 'above_sma200' : 'below_sma200')
  if (sma50 && sma200) maSignals.push(sma50 > sma200 ? 'golden_cross_zone' : 'death_cross_zone')

  return {
    priceAction: pa,
    indicators: {
      rsi:      { value: rsiVal, signal: rsiSignal },
      macd:     { ...macdVals, trend: macdTrend },
      bb:       { ...bb, signal: bbSignal },
      sma50,
      sma200,
      ema20,
      atr:      atrVal,
    },
    volume:           vol,
    supportResistance: sr,
    maSignals,
    dataPoints: closes.length,
  }
}

module.exports = { computeAll, rsi, macd, bollingerBands, atr, sma, ema, supportResistance }
