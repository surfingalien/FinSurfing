/**
 * Price-structure helpers shared by the AI Advisory Engine (aiEngine.js) and
 * the client forecast (forecast.js): ATR, trend, swing points, key levels and
 * RSI divergence.
 *
 * This file used to hold generateAdvisory, the "Quantitative Advisory Engine"
 * behind ResearchView. That page had not been reachable since the auth rework
 * (1e9a9da) and duplicated the AI Advisory Engine, with its own hand-made
 * 1–9.5 "confidence"; both were removed.
 */

/* ── ATR ─────────────────────────────────────────── */
export function calcATR(candles, period = 14) {
  if (candles.length < period + 1) return []
  const trs = candles.map((c, i) => {
    if (i === 0) return c.high - c.low
    const prev = candles[i - 1]
    return Math.max(c.high - c.low, Math.abs(c.high - prev.close), Math.abs(c.low - prev.close))
  })
  const atrs = []
  let sum = trs.slice(0, period).reduce((a, b) => a + b, 0)
  atrs.push(sum / period)
  for (let i = period; i < trs.length; i++) {
    const atr = (atrs[atrs.length - 1] * (period - 1) + trs[i]) / period
    atrs.push(atr)
  }
  return atrs
}

/* ── Linear-regression trend slope ──────────────── */
function trendSlope(closes) {
  const n = closes.length
  if (n < 2) return 0
  const sumX = (n * (n - 1)) / 2
  const sumY = closes.reduce((a, b) => a + b, 0)
  const sumXY = closes.reduce((s, y, x) => s + x * y, 0)
  const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6
  const slope = (n * sumXY - sumX * sumY) / (n * sumX2 - sumX ** 2)
  return (slope / (sumY / n)) * 100  // as % per bar
}

export function detectTrend(candles, period = 50) {
  const recent = candles.slice(-period)
  const closes = recent.map(c => c.close)
  const slope  = trendSlope(closes)

  // Also check short-term trend (last 10 bars)
  const shortSlope = trendSlope(closes.slice(-10))

  let direction = 'sideways'
  let strength  = 'Weak'
  if (slope > 0.15) { direction = 'uptrend';   strength = slope > 0.5 ? 'Strong' : 'Moderate' }
  if (slope < -0.15) { direction = 'downtrend'; strength = slope < -0.5 ? 'Strong' : 'Moderate' }

  // Detect momentum shift
  let momentum = 'Neutral'
  if (shortSlope > slope + 0.2) momentum = 'Accelerating'
  else if (shortSlope < slope - 0.2) momentum = 'Decelerating'
  else if (shortSlope > 0.1) momentum = 'Positive'
  else if (shortSlope < -0.1) momentum = 'Negative'

  return { direction, strength, slope: +slope.toFixed(3), momentum }
}

/* ── Swing highs / lows ─────────────────────────── */
export function findSwingPoints(candles, window = 5) {
  const highs = [], lows = []
  for (let i = window; i < candles.length - window; i++) {
    const slice = candles.slice(i - window, i + window + 1)
    if (candles[i].high >= Math.max(...slice.map(c => c.high))) {
      highs.push({ price: candles[i].high, time: candles[i].time, idx: i })
    }
    if (candles[i].low <= Math.min(...slice.map(c => c.low))) {
      lows.push({ price: candles[i].low, time: candles[i].time, idx: i })
    }
  }
  return { highs, lows }
}

/* ── Cluster nearby price levels ────────────────── */
function clusterLevels(prices, tolerance = 0.015) {
  const sorted  = [...prices].sort((a, b) => a - b)
  const clusters = []
  let group = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    if ((sorted[i] - group[0]) / group[0] < tolerance) {
      group.push(sorted[i])
    } else {
      clusters.push(group.reduce((a, b) => a + b) / group.length)
      group = [sorted[i]]
    }
  }
  clusters.push(group.reduce((a, b) => a + b) / group.length)
  return clusters
}

export function findKeyLevels(candles, currentPrice) {
  const { highs, lows } = findSwingPoints(candles, 5)
  const rawResistance   = highs.map(h => h.price).filter(p => p >= currentPrice * 0.98)
  const rawSupport      = lows.map(l => l.price).filter(p => p <= currentPrice * 1.02)

  const resistance = clusterLevels(rawResistance).sort((a, b) => a - b).slice(0, 4)
  const support    = clusterLevels(rawSupport).sort((a, b) => b - a).slice(0, 4)

  return { support, resistance }
}

/* ── RSI divergence ─────────────────────────────── */
export function detectDivergence(candles, rsiValues, lookback = 30) {
  if (rsiValues.length < lookback) return null
  const offset = candles.length - rsiValues.length
  const recentC = candles.slice(-lookback)
  const recentR = rsiValues.slice(-lookback)

  // Find last two price lows and corresponding RSI
  const priceLows = []
  const priceHighs = []
  for (let i = 2; i < recentC.length - 2; i++) {
    if (recentC[i].low < recentC[i-1].low && recentC[i].low < recentC[i+1].low &&
        recentC[i].low < recentC[i-2].low && recentC[i].low < recentC[i+2].low) {
      priceLows.push({ price: recentC[i].low, rsi: recentR[i], idx: i })
    }
    if (recentC[i].high > recentC[i-1].high && recentC[i].high > recentC[i+1].high &&
        recentC[i].high > recentC[i-2].high && recentC[i].high > recentC[i+2].high) {
      priceHighs.push({ price: recentC[i].high, rsi: recentR[i], idx: i })
    }
  }

  if (priceLows.length >= 2) {
    const [p1, p2] = priceLows.slice(-2)
    if (p2.price < p1.price && p2.rsi > p1.rsi && p2.rsi < 50) {
      return { type: 'Bullish Divergence', desc: 'Price making lower lows while RSI makes higher lows — potential reversal' }
    }
  }
  if (priceHighs.length >= 2) {
    const [p1, p2] = priceHighs.slice(-2)
    if (p2.price > p1.price && p2.rsi < p1.rsi && p2.rsi > 50) {
      return { type: 'Bearish Divergence', desc: 'Price making higher highs while RSI makes lower highs — momentum fading' }
    }
  }
  return null
}
