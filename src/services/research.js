/**
 * FinSurf Quantitative Research Engine
 * Multi-timeframe technical + fundamental analysis → structured advisory
 */

import { calcSMA, calcEMA, calcRSI, calcMACD, calcBollinger } from './api'
import * as horizonSetups from '../../lib/horizon-setups.js'

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

/* ── Volume analysis ────────────────────────────── */
function analyzeVolume(candles, period = 20) {
  if (candles.length < period) return { trend: 'Unknown', ratio: 1 }
  const avgVol = candles.slice(-period - 1, -1).reduce((s, c) => s + c.volume, 0) / period
  const lastVol = candles[candles.length - 1].volume
  const ratio = avgVol > 0 ? lastVol / avgVol : 1

  // Check if recent up-days have higher volume than down-days (accumulation)
  const recent20 = candles.slice(-20)
  const upVol   = recent20.filter(c => c.close >= c.open).reduce((s, c) => s + c.volume, 0)
  const downVol = recent20.filter(c => c.close < c.open).reduce((s, c) => s + c.volume, 0)
  const trend = upVol > downVol * 1.15 ? 'Accumulation' : downVol > upVol * 1.15 ? 'Distribution' : 'Neutral'

  return { trend, ratio: +ratio.toFixed(2), aboveAvg: ratio > 1.2 }
}

/* ── Chart pattern detection ────────────────────── */
function detectPattern(candles) {
  const n = candles.length
  if (n < 20) return { name: 'Insufficient data', bullish: null }

  const recent = candles.slice(-20)
  const closes = recent.map(c => c.close)
  const highs  = recent.map(c => c.high)
  const lows   = recent.map(c => c.low)

  const maxH  = Math.max(...highs)
  const minL  = Math.min(...lows)
  const range = maxH - minL
  const rangeRatio = range / closes[closes.length - 1]

  // Tight consolidation (BB squeeze)
  const bb  = calcBollinger(closes)
  const lastBB = bb[bb.length - 1]
  const bbWidth = lastBB.upper && lastBB.lower
    ? (lastBB.upper - lastBB.lower) / lastBB.middle
    : null

  if (bbWidth !== null && bbWidth < 0.04) {
    return { name: 'Bollinger Squeeze', bullish: null, desc: 'Tight consolidation — volatility expansion imminent' }
  }

  // Higher highs and higher lows → uptrend continuation
  const slope = trendSlope(closes)
  if (slope > 0.3 && rangeRatio < 0.12) {
    return { name: 'Ascending Channel', bullish: true, desc: 'Orderly uptrend with contained volatility' }
  }
  if (slope < -0.3 && rangeRatio < 0.12) {
    return { name: 'Descending Channel', bullish: false, desc: 'Sustained downtrend — sellers in control' }
  }

  // Flag/pennant (tight range after sharp move)
  const priorSlope = trendSlope(candles.slice(-40, -20).map(c => c.close))
  if (Math.abs(priorSlope) > 0.5 && rangeRatio < 0.08) {
    return {
      name: priorSlope > 0 ? 'Bull Flag' : 'Bear Flag',
      bullish: priorSlope > 0,
      desc: priorSlope > 0
        ? 'Tight consolidation after sharp rally — continuation pattern'
        : 'Tight consolidation after sharp decline — continuation pattern'
    }
  }

  // Cup rim / breakout setup (last close near 4-week high)
  const close4wHigh = Math.max(...candles.slice(-20).map(c => c.close))
  const lastClose   = closes[closes.length - 1]
  if (lastClose >= close4wHigh * 0.98) {
    return { name: 'Near 4-Week High', bullish: true, desc: 'Price testing recent highs — watch for breakout confirmation' }
  }

  if (rangeRatio > 0.2) {
    return { name: 'High Volatility Range', bullish: null, desc: 'Wide-ranging chop — wait for directional break' }
  }

  return { name: 'Consolidation', bullish: null, desc: 'Sideways price action — awaiting catalyst or breakout' }
}

/* ── Fundamental scoring ────────────────────────── */
function scoreFundamentals(fund) {
  if (!fund) return { score: 5, flags: [], grade: 'N/A' }
  const flags = []
  let score = 5

  if (fund.revenueGrowth != null) {
    if (fund.revenueGrowth > 0.20) { score += 1; flags.push({ text: `Revenue +${(fund.revenueGrowth * 100).toFixed(0)}% YoY`, positive: true }) }
    else if (fund.revenueGrowth < 0) { score -= 1; flags.push({ text: `Revenue ${(fund.revenueGrowth * 100).toFixed(0)}% YoY`, positive: false }) }
  }
  if (fund.earningsGrowth != null) {
    if (fund.earningsGrowth > 0.15) { score += 1; flags.push({ text: `Earnings +${(fund.earningsGrowth * 100).toFixed(0)}% YoY`, positive: true }) }
    else if (fund.earningsGrowth < -0.1) { score -= 1; flags.push({ text: `Earnings ${(fund.earningsGrowth * 100).toFixed(0)}% YoY`, positive: false }) }
  }
  if (fund.profitMargin != null) {
    if (fund.profitMargin > 0.15) { score += 0.5; flags.push({ text: `Margin ${(fund.profitMargin * 100).toFixed(1)}%`, positive: true }) }
    else if (fund.profitMargin < 0) { score -= 0.5; flags.push({ text: `Negative margin`, positive: false }) }
  }
  if (fund.returnOnEquity != null) {
    if (fund.returnOnEquity > 0.15) { score += 0.5; flags.push({ text: `ROE ${(fund.returnOnEquity * 100).toFixed(0)}%`, positive: true }) }
  }
  if (fund.debtToEquity != null) {
    if (fund.debtToEquity > 2) { score -= 0.5; flags.push({ text: `High D/E ${fund.debtToEquity.toFixed(1)}x`, positive: false }) }
    else { flags.push({ text: `D/E ${fund.debtToEquity.toFixed(1)}x`, positive: true }) }
  }
  if (fund.targetMeanPrice && fund.pe != null) {
    const upside = fund.targetMeanPrice  // we'll compare against current price in caller
    flags.push({ text: `Analyst target $${upside.toFixed(0)}`, positive: true })
  }

  const clamped = Math.min(10, Math.max(1, score))
  const grade = clamped >= 8 ? 'A' : clamped >= 6.5 ? 'B' : clamped >= 5 ? 'C' : 'D'
  return { score: clamped, flags, grade }
}

/* ── Position sizing ────────────────────────────── */
function calcPositionSize(entryPrice, stopPrice, portfolioValue = 100000) {
  const riskPerShare = Math.abs(entryPrice - stopPrice)
  if (riskPerShare <= 0) return { conservative: 0, moderate: 0, aggressive: 0 }

  // Risk 0.5%, 1%, 2% of portfolio
  const sizes = {
    conservative: Math.floor((portfolioValue * 0.005) / riskPerShare),
    moderate:     Math.floor((portfolioValue * 0.010) / riskPerShare),
    aggressive:   Math.floor((portfolioValue * 0.020) / riskPerShare),
  }
  return sizes
}

/* ── Main advisory generator ─────────────────────── */
export function generateAdvisory({
  symbol, timeframe = 'Swing', riskTolerance = 'Moderate',
  candles, quote, fundamentals,
}) {
  if (!candles || candles.length < 30) {
    return { error: 'Insufficient price history for analysis' }
  }

  const closes = candles.map(c => c.close)
  const price  = quote?.price ?? closes[closes.length - 1]

  // ── Technical indicators ──────────────────────
  const rsiArr   = calcRSI(closes)
  const macdArr  = calcMACD(closes)
  const bbArr    = calcBollinger(closes)
  const sma20Arr = calcSMA(closes, 20)
  const sma50Arr = calcSMA(closes, 50)
  const sma200Arr= calcSMA(closes, 200)
  const ema12Arr = calcEMA(closes, 12)
  const atrArr   = calcATR(candles, 14)

  const rsi    = rsiArr[rsiArr.length - 1]
  const macd   = macdArr[macdArr.length - 1]
  const bb     = bbArr[bbArr.length - 1]
  const sma20  = sma20Arr[sma20Arr.length - 1]
  const sma50  = sma50Arr[sma50Arr.length - 1]
  const sma200 = sma200Arr.find(v => v !== null)
    ? sma200Arr.filter(v => v !== null).slice(-1)[0]
    : null
  const atr    = atrArr[atrArr.length - 1] ?? (price * 0.02)

  const trend     = detectTrend(candles)
  const { support, resistance } = findKeyLevels(candles, price)
  const volume    = analyzeVolume(candles)
  const pattern   = detectPattern(candles)
  const divergence = detectDivergence(candles, rsiArr)

  // ── 52-week context ───────────────────────────
  const high52 = quote?.high52 ?? Math.max(...closes)
  const low52  = quote?.low52  ?? Math.min(...closes)
  const pctFrom52High = ((price - high52) / high52) * 100
  const pctFrom52Low  = ((price - low52)  / low52)  * 100
  const rangePct52    = ((price - low52) / (high52 - low52)) * 100

  // ── Signal scoring ────────────────────────────
  let techScore = 0
  const signals = []

  // Trend
  if (trend.direction === 'uptrend')   { techScore += trend.strength === 'Strong' ? 2 : 1; signals.push({ name: 'Trend', verdict: trend.strength + ' Uptrend', bullish: true }) }
  if (trend.direction === 'downtrend') { techScore -= trend.strength === 'Strong' ? 2 : 1; signals.push({ name: 'Trend', verdict: trend.strength + ' Downtrend', bullish: false }) }
  if (trend.direction === 'sideways')  { signals.push({ name: 'Trend', verdict: 'Sideways / No trend', bullish: null }) }

  // RSI
  if (rsi != null) {
    if (rsi < 30)      { techScore += 1.5; signals.push({ name: 'RSI', verdict: `Oversold (${rsi.toFixed(1)})`, bullish: true }) }
    else if (rsi < 45) { techScore += 0.5; signals.push({ name: 'RSI', verdict: `Mild Oversold (${rsi.toFixed(1)})`, bullish: true }) }
    else if (rsi > 70) { techScore -= 1.5; signals.push({ name: 'RSI', verdict: `Overbought (${rsi.toFixed(1)})`, bullish: false }) }
    else if (rsi > 55) { techScore += 0.5; signals.push({ name: 'RSI', verdict: `Bullish range (${rsi.toFixed(1)})`, bullish: true }) }
    else               { signals.push({ name: 'RSI', verdict: `Neutral (${rsi.toFixed(1)})`, bullish: null }) }
  }

  // MACD
  if (macd?.macd != null && macd?.signal != null) {
    if (macd.macd > macd.signal && macd.hist > 0) { techScore += 1; signals.push({ name: 'MACD', verdict: 'Bullish crossover', bullish: true }) }
    else if (macd.macd < macd.signal)              { techScore -= 1; signals.push({ name: 'MACD', verdict: 'Bearish crossover', bullish: false }) }
    else                                           { signals.push({ name: 'MACD', verdict: 'Neutral', bullish: null }) }
  }

  // Bollinger
  if (bb?.lower && bb?.upper) {
    if (price < bb.lower)      { techScore += 1; signals.push({ name: 'Bollinger', verdict: 'Below lower band — oversold', bullish: true }) }
    else if (price > bb.upper) { techScore -= 1; signals.push({ name: 'Bollinger', verdict: 'Above upper band — extended', bullish: false }) }
    else {
      const bbPos = (price - bb.lower) / (bb.upper - bb.lower)
      const v = bbPos > 0.5 ? 'Riding upper half' : 'Near mid-band support'
      signals.push({ name: 'Bollinger', verdict: v, bullish: bbPos > 0.5 ? true : null })
      if (bbPos > 0.5) techScore += 0.5
    }
  }

  // SMA alignment
  if (sma20 && sma50) {
    if (price > sma20 && price > sma50 && sma20 > sma50) {
      techScore += 1; signals.push({ name: 'MA Stack', verdict: 'Price > SMA20 > SMA50 (Bullish)', bullish: true })
    } else if (price < sma20 && price < sma50 && sma20 < sma50) {
      techScore -= 1; signals.push({ name: 'MA Stack', verdict: 'Price < SMA20 < SMA50 (Bearish)', bullish: false })
    } else if (price > sma20 && sma20 > sma50) {
      signals.push({ name: 'MA Stack', verdict: 'Above SMA20 (Neutral-Bullish)', bullish: true })
      techScore += 0.5
    } else {
      signals.push({ name: 'MA Stack', verdict: 'Mixed MA alignment', bullish: null })
    }
  }
  if (sma200) {
    if (price > sma200) { techScore += 0.5; signals.push({ name: 'SMA200', verdict: `Above 200d SMA ($${sma200.toFixed(2)})`, bullish: true }) }
    else                { techScore -= 0.5; signals.push({ name: 'SMA200', verdict: `Below 200d SMA ($${sma200.toFixed(2)})`, bullish: false }) }
  }

  // Volume
  if (volume.trend === 'Accumulation') { techScore += 0.5; signals.push({ name: 'Volume', verdict: 'Accumulation — institutional buying', bullish: true }) }
  if (volume.trend === 'Distribution') { techScore -= 0.5; signals.push({ name: 'Volume', verdict: 'Distribution — selling pressure', bullish: false }) }

  // Divergence
  if (divergence) {
    if (divergence.type === 'Bullish Divergence') { techScore += 1.5; signals.push({ name: 'Divergence', verdict: divergence.type, bullish: true }) }
    if (divergence.type === 'Bearish Divergence') { techScore -= 1.5; signals.push({ name: 'Divergence', verdict: divergence.type, bullish: false }) }
  }

  // ── Aggregate technical signal ────────────────
  let techSignal
  if (techScore >= 4)       techSignal = 'Strong Buy'
  else if (techScore >= 2)  techSignal = 'Buy'
  else if (techScore <= -4) techSignal = 'Strong Sell'
  else if (techScore <= -2) techSignal = 'Sell'
  else                      techSignal = 'Hold'

  // ── Stance ────────────────────────────────────
  const stance = techScore >= 1.5 ? 'Bullish' : techScore <= -1.5 ? 'Bearish' : 'Neutral'

  // ── Trade setup ───────────────────────────────
  // findKeyLevels keeps swing highs down to 98% of the price and swing lows up
  // to 102% of it, so the nearest "resistance" can sit under the price and the
  // nearest "support" over it. Anything that anchors a level on one side of
  // the price takes it from that side.
  const nearestResistance = resistance[0]
  const supportBelow    = support.find(s => s < price) ?? null      // nearest first
  const resistanceAbove = resistance.find(r => r > price) ?? null
  const atr2 = atr * 1.5

  let trade, riskReward = null, positionSizes = null

  if (stance === 'Bullish') {
    // Levels, target rule and validation live in lib/horizon-setups.js (shared
    // with the AI Advisory horizon cards and tested by Jest): R from the top of
    // the entry zone, resistance caps TP1 only above that zone, and a setup
    // that is not 0 < stop < every entry < TP1 ≤ TP2 comes back valid: false.
    const s = horizonSetups.advisoryLongSetup({ price, atr, support, resistance })
    const holdingPeriod = timeframe === 'Day Trade' ? '1–3 days' : timeframe === 'Position' ? '4–12 weeks' : '1–3 weeks'
    if (s.valid) {
      riskReward    = s.riskReward
      // Sized from the top of the zone (the worst fill), so a stop-out costs at
      // most the stated share of the portfolio wherever it filled.
      positionSizes = calcPositionSize(s.entryHigh, s.stop)
      const pressed = s.bypassed[0]
      let targetNote = s.targetSource === 'resistance'
        ? `TP1 just under resistance $${s.targetLevel.toFixed(2)}`
        : `TP1 at 1.5R from the top of the entry zone`
      if (pressed != null) targetNote += ` — assumes a break above $${pressed.toFixed(2)} first`
      trade = {
        valid: true, reason: null,
        action: techScore >= 4 ? 'BUY' : 'BUY (Scale-in)',
        reference: price,
        entryZone: { low: s.entryLow, high: s.entryHigh },
        targets: [
          { price: s.tp1, label: s.targetSource === 'resistance' ? 'TP1 (resistance)' : 'TP1 (1.5R)', pct: s.tp1Pct },
          { price: s.tp2, label: 'TP2 (2.5R)', pct: s.tp2Pct },
        ],
        stopLoss: {
          price: s.stop, pct: s.stopPct,
          rationale: s.stopSource === 'support'
            ? `Below key support at $${s.support.toFixed(2)} and 1.5×ATR`
            : `1.5×ATR below the price (ATR=${atr.toFixed(2)})`,
        },
        riskReward:     s.riskReward,
        riskRewardBest: s.riskRewardBest,
        targetNote,
        holdingPeriod,
        invalidation: `Close below $${s.stop.toFixed(2)} on volume > 1.5× avg`,
      }
    } else {
      trade = {
        valid: false, reason: s.reason,
        action: 'NO VALID SETUP',
        reference: price,
        entryZone: null, targets: [], stopLoss: null, riskReward: null,
        holdingPeriod,
        invalidation: null,
      }
    }
  } else if (stance === 'Bearish') {
    const entryLow  = price * 0.995
    const entryHigh = price * 1.01
    const stopLoss  = nearestResistance
      ? Math.max(nearestResistance * 1.015, price + atr2)
      : price + atr2
    const riskPerShare = stopLoss - entryLow
    const tp1 = entryLow - riskPerShare * 1.5
    const tp2 = entryLow - riskPerShare * 2.5
    riskReward = tp1 && stopLoss && entryLow > 0
      ? +((tp1 - entryLow) / (entryLow - stopLoss)).toFixed(2)
      : null
    positionSizes = calcPositionSize(entryLow, stopLoss)
    // Unchanged short-side levels; the long check does not apply, so no
    // `valid` flag (the card renders any trade that is not valid: false).
    trade = {
      action: 'REDUCE / AVOID',
      reference: +entryLow.toFixed(2),
      entryZone: { low: +entryLow.toFixed(2), high: +entryHigh.toFixed(2) },
      targets: [
        { price: +tp1.toFixed(2), label: 'TP1 (1.5R)', pct: +(((tp1 - entryLow) / entryLow) * 100).toFixed(1) },
        { price: +tp2.toFixed(2), label: 'TP2 (2.5R)', pct: +(((tp2 - entryLow) / entryLow) * 100).toFixed(1) },
      ],
      stopLoss: {
        price: +stopLoss.toFixed(2),
        pct: +(((entryLow - stopLoss) / entryLow) * 100).toFixed(1),
        rationale: `Above resistance $${(nearestResistance ?? price * 1.03).toFixed(2)}`,
      },
      riskReward,
      holdingPeriod: timeframe === 'Position' ? '4–12 weeks' : '1–3 weeks',
      invalidation:  `Reclaim of $${stopLoss.toFixed(2)} with volume`,
    }
  } else {
    // No directional edge, so no entry, stop or target. It used to show the
    // whole support–resistance band as the "entry zone" with TP1 at the
    // nearest resistance: the zone ran to resistance × 1.01, above its own TP1,
    // and that resistance could be up to 2% under the price.
    trade = {
      valid: false,
      reason: 'Neutral stance — no directional edge, so no entry, stop or target. Wait for a break of the range.',
      action: 'HOLD / WATCH',
      reference: price,
      watch: { support: supportBelow, resistance: resistanceAbove },
      entryZone: null, targets: [], stopLoss: null, riskReward: null,
      holdingPeriod: 'Monitor — no active trade',
      invalidation: null,
    }
  }

  // ── Fundamental context ───────────────────────
  const fundScore = scoreFundamentals(fundamentals)
  const analystUpside = fundamentals?.targetMeanPrice
    ? (((fundamentals.targetMeanPrice - price) / price) * 100).toFixed(1)
    : null

  // ── Volatility assessment ─────────────────────
  const atrPct = (atr / price) * 100
  const volRegime = atrPct > 4 ? 'Extreme' : atrPct > 2.5 ? 'High' : atrPct > 1.2 ? 'Normal' : 'Low'

  // ── Confidence score (1–10) ───────────────────
  let confidence = 5
  const confFactors = []

  const techNorm = Math.min(10, Math.max(0, (techScore + 8) / 1.6))
  confidence += (techNorm - 5) * 0.4
  confFactors.push({ name: 'Technical alignment', score: techNorm.toFixed(1), weight: '40%' })

  const fundNorm = fundScore.score
  confidence += (fundNorm - 5) * 0.2
  confFactors.push({ name: 'Fundamental quality', score: fundNorm.toFixed(1), weight: '20%' })

  if (volume.trend === 'Accumulation') { confidence += 0.5 }
  if (volume.trend === 'Distribution') { confidence -= 0.5 }
  confFactors.push({ name: 'Volume confirmation', score: volume.trend, weight: '15%' })

  if (divergence?.type === 'Bullish Divergence' && stance === 'Bullish') confidence += 1
  if (divergence?.type === 'Bearish Divergence' && stance === 'Bearish') confidence += 1
  confFactors.push({ name: 'Divergence signal', score: divergence?.type ?? 'None', weight: '15%' })

  if (pattern.bullish === true  && stance === 'Bullish') confidence += 0.5
  if (pattern.bullish === false && stance === 'Bearish') confidence += 0.5
  confFactors.push({ name: 'Chart pattern', score: pattern.name, weight: '10%' })

  if (volRegime === 'Extreme') confidence -= 1
  // R/R only counts where a trade is proposed; a bullish stance whose levels
  // do not form a valid setup gets the same penalty as a thin R/R.
  if (stance !== 'Neutral' && (riskReward == null || riskReward < 1.5)) confidence -= 0.5

  confidence = Math.min(9.5, Math.max(1, confidence))

  // ── Risk warnings ─────────────────────────────
  const warnings = []
  if (volRegime === 'Extreme')   warnings.push('⚠ Extreme volatility — reduce position size significantly')
  if (volRegime === 'High')      warnings.push('⚠ Above-average volatility — use wider stops or smaller size')
  if (pctFrom52High > -5)        warnings.push('⚠ Trading near 52-week high — momentum extended, risk of pullback')
  if (pctFrom52Low < 10)         warnings.push('⚠ Near 52-week low — potential value but confirm no fundamental deterioration')
  if (stance === 'Bullish' && trade.valid === false) warnings.push(`⚠ No valid long setup — ${trade.reason}`)
  if (riskReward != null && riskReward < 1.5) warnings.push(
    stance === 'Bullish'
      ? '⚠ Risk/reward below 1.5:1 from the top of the entry zone — enter lower or pass on the trade'
      : '⚠ Risk/reward below 1.5:1 — consider tighter entry or pass on trade'
  )
  if (!sma200)                   warnings.push('ℹ Insufficient history for 200-day SMA calculation')

  // ── Watchlist triggers ────────────────────────
  const bullishTriggers = []
  const bearishTriggers = []
  if (stance === 'Neutral' || stance === 'Bullish') {
    if (resistanceAbove) bullishTriggers.push(`Confirmed break above $${resistanceAbove.toFixed(2)} on volume`)
    if (rsi != null && rsi < 50) bullishTriggers.push(`RSI reclaims 50 level (currently ${rsi.toFixed(1)})`)
    bullishTriggers.push(`MACD cross above signal line`)
  }
  if (stance === 'Neutral' || stance === 'Bearish') {
    if (supportBelow) bearishTriggers.push(`Break below support $${supportBelow.toFixed(2)} on volume`)
    bearishTriggers.push(`RSI fails to hold 40 on rally attempt`)
    bearishTriggers.push(`MACD histogram turns negative`)
  }

  return {
    symbol: quote?.symbol ?? symbol,
    name:   quote?.name   ?? symbol,
    price,
    quote,
    timeframe,
    riskTolerance,
    stance,
    thesis: buildThesis(stance, trend, pattern, rsi, divergence, fundScore, analystUpside),

    technical: {
      trend,
      pattern,
      signals,
      indicators: {
        rsi:    rsi    != null ? +rsi.toFixed(2)    : null,
        macdVal: macd?.macd  != null ? +macd.macd.toFixed(3) : null,
        macdSig: macd?.signal != null ? +macd.signal.toFixed(3): null,
        macdHist: macd?.hist != null ? +macd.hist.toFixed(3) : null,
        bbUpper: bb?.upper ? +bb.upper.toFixed(2) : null,
        bbMiddle: bb?.middle ? +bb.middle.toFixed(2) : null,
        bbLower: bb?.lower ? +bb.lower.toFixed(2) : null,
        sma20:  sma20  ? +sma20.toFixed(2)  : null,
        sma50:  sma50  ? +sma50.toFixed(2)  : null,
        sma200: sma200 ? +sma200.toFixed(2) : null,
        atr:    +atr.toFixed(3),
        atrPct: +atrPct.toFixed(2),
      },
      keyLevels: { support, resistance },
      divergence,
      signal: techSignal,
      techScore: +techScore.toFixed(1),
      volume,
    },

    fundamental: {
      ...fundScore,
      pe:           fundamentals?.pe,
      forwardPE:    fundamentals?.forwardPE,
      beta:         fundamentals?.beta,
      marketCap:    fundamentals?.marketCap ?? quote?.marketCap,
      revenueGrowth: fundamentals?.revenueGrowth,
      earningsGrowth: fundamentals?.earningsGrowth,
      profitMargin: fundamentals?.profitMargin,
      debtToEquity: fundamentals?.debtToEquity,
      returnOnEquity: fundamentals?.returnOnEquity,
      targetMeanPrice: fundamentals?.targetMeanPrice,
      recommendationKey: fundamentals?.recommendationKey,
      analystUpside,
      sector:   fundamentals?.sector,
      industry: fundamentals?.industry,
      volRegime,
      atrPct: +atrPct.toFixed(2),
      rangePct52: +rangePct52.toFixed(1),
      pctFrom52High: +pctFrom52High.toFixed(1),
    },

    trade,

    risk: {
      positionSizes,
      warnings,
      volRegime,
      atr: +atr.toFixed(2),
      hedges: stance === 'Bullish'
        ? ['Consider protective put 5% OTM if holding >4 weeks', 'Diversify — avoid >10% single stock concentration']
        : ['Reduce position or cash out', 'Consider inverse ETF hedge for portfolio protection'],
      portfolioFit: fundScore.score >= 7 ? 'Strong fit — core holding quality'
        : fundScore.score >= 5 ? 'Moderate fit — opportunistic position'
        : 'Speculative — small position only',
    },

    confidence: {
      score: +confidence.toFixed(1),
      factors: confFactors,
      rationale: buildConfidenceRationale(confidence, stance, signals),
    },

    watchlist: { bullishTriggers, bearishTriggers },
    generatedAt: new Date(),
  }
}

/* ── Helper: thesis sentence ─────────────────────── */
function buildThesis(stance, trend, pattern, rsi, divergence, fundScore, analystUpside) {
  if (stance === 'Bullish') {
    const parts = []
    if (trend.direction === 'uptrend') parts.push(`${trend.strength.toLowerCase()} uptrend intact`)
    if (rsi != null && rsi < 40) parts.push(`RSI at oversold ${rsi.toFixed(0)}`)
    if (divergence?.type === 'Bullish Divergence') parts.push('bullish divergence confirmed')
    if (analystUpside && parseFloat(analystUpside) > 10) parts.push(`analyst consensus implies ${analystUpside}% upside`)
    if (pattern.bullish) parts.push(`${pattern.name.toLowerCase()} setup`)
    return parts.length ? 'Constructive setup — ' + parts.join(', ') + '.' : 'Technical setup favors continuation higher.'
  }
  if (stance === 'Bearish') {
    const parts = []
    if (trend.direction === 'downtrend') parts.push(`${trend.strength.toLowerCase()} downtrend`)
    if (rsi != null && rsi > 65) parts.push(`RSI overbought at ${rsi.toFixed(0)}`)
    if (divergence?.type === 'Bearish Divergence') parts.push('bearish divergence warning')
    if (pattern.bullish === false) parts.push(pattern.name.toLowerCase())
    return parts.length ? 'Caution warranted — ' + parts.join(', ') + '.' : 'Risk/reward unfavorable at current levels.'
  }
  return 'No high-conviction directional setup — monitor for breakout or breakdown.'
}

function buildConfidenceRationale(score, stance, signals) {
  const bullCount = signals.filter(s => s.bullish === true).length
  const bearCount = signals.filter(s => s.bullish === false).length
  const total     = signals.length || 1
  const alignedPct = stance === 'Bullish' ? bullCount / total : stance === 'Bearish' ? bearCount / total : 0.5
  const quality   = score >= 7.5 ? 'high' : score >= 5.5 ? 'moderate' : 'low'
  return `${Math.round(alignedPct * 100)}% of technical signals align with ${stance.toLowerCase()} stance. Overall conviction is ${quality} (${score.toFixed(1)}/10) — ${score >= 7 ? 'proceed with defined risk' : score >= 5 ? 'wait for additional confirmation' : 'exercise significant caution'}.`
}
