'use strict'
/**
 * lib/technical-indicators.js
 *
 * Pure technical-analysis math — no HTTP, no state.
 * Extracted from routes/trading-analysis.js so the AI Brain scanner can feed
 * the same server-computed indicators into its prompts (instead of asking the
 * LLM to imagine technicals from a bare price quote).
 */

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

/**
 * Compact one-line technical summary for prompt injection.
 * Returns null when there isn't enough bar history to say anything useful.
 */
function compactTaLine(symbol, opens, highs, lows, closes, volumes) {
  if (!closes || closes.length < 30) return null

  const price  = closes[closes.length - 1]
  const rsi    = computeRSI(closes)
  const macd   = computeMACD(closes)
  const ema50  = computeEMA(closes, 50)
  const ema200 = computeEMA(closes, 200)
  const sr     = findSR(highs, lows, closes)
  const vol    = volumeAnalysis(volumes)
  const patterns = detectPatterns(opens, highs, lows, closes, volumes)

  const trendBits = []
  if (ema50  != null) trendBits.push(price > ema50  ? '>EMA50'  : '<EMA50')
  if (ema200 != null) trendBits.push(price > ema200 ? '>EMA200' : '<EMA200')

  // Keep only the most decision-relevant patterns to stay token-frugal
  const keyPatterns = patterns.filter(p => [
    'strong_uptrend', 'strong_downtrend', 'golden_cross', 'death_cross',
    '20bar_breakout_up', '20bar_breakout_down', 'volume_spike', 'bb_squeeze',
    'bullish_engulfing', 'bearish_engulfing',
  ].includes(p))

  const parts = [
    rsi != null ? `RSI=${rsi}` : null,
    macd ? `MACD=${macd.trend}/${macd.histogramDir}` : null,
    trendBits.length ? `P${trendBits.join(',')}` : null,
    sr?.support    != null ? `S=${sr.support}`    : null,
    sr?.resistance != null ? `R=${sr.resistance}` : null,
    vol ? `Vol=${vol.ratio}x/${vol.trend}` : null,
    keyPatterns.length ? `Patterns=${keyPatterns.join('+')}` : null,
  ].filter(Boolean)

  return parts.length ? `${symbol}: ${parts.join(' ')}` : null
}

module.exports = {
  computeRSI,
  computeEMA,
  computeEMAArray,
  computeMACD,
  computeBB,
  computeATR,
  computeStochRSI,
  computeVWAP,
  computeOBV,
  findSR,
  detectPatterns,
  volumeAnalysis,
  compactTaLine,
}
