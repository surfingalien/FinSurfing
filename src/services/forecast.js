/**
 * FinSurf ML Forecast Engine
 * Linear-regression + ATR uncertainty + multi-factor probability scoring
 * Produces 7 / 30 / 90-day price forecasts with bull/bear probabilities
 */

import { calcRSI, calcMACD, calcSMA, calcEMA } from './api'
import { calcATR, detectTrend } from './research'

/* ── Fibonacci retracement / extension ───────────── */
export function calcFibonacci(candles) {
  if (!candles?.length) return null
  const n      = candles.length
  const recent = candles.slice(-60)
  const high   = Math.max(...recent.map(c => c.high))
  const low    = Math.min(...recent.map(c => c.low))
  const range  = high - low
  return {
    high, low, range,
    levels: {
      '0.0':   +high.toFixed(2),
      '0.236': +(high - range * 0.236).toFixed(2),
      '0.382': +(high - range * 0.382).toFixed(2),
      '0.500': +(high - range * 0.500).toFixed(2),
      '0.618': +(high - range * 0.618).toFixed(2),
      '0.786': +(high - range * 0.786).toFixed(2),
      '1.0':   +low.toFixed(2),
      // Extensions
      '1.272': +(low  - range * 0.272).toFixed(2),
      '1.618': +(low  - range * 0.618).toFixed(2),
    },
    extensions: {
      '1.272': +(high + range * 0.272).toFixed(2),
      '1.618': +(high + range * 0.618).toFixed(2),
      '2.0':   +(high + range * 1.0).toFixed(2),
    },
  }
}

/* ── Trendline breakout detection ────────────────── */
export function detectTrendlineBreakout(candles) {
  if (candles.length < 30) return null
  const recent = candles.slice(-30)
  const price  = candles[candles.length - 1].close

  // Fit descending resistance: track local highs over 30 bars
  const highs = recent.map((c, i) => ({ i, v: c.high }))
  const topSlope = linRegSlope(highs.map(h => h.v))

  // Fit ascending support: track local lows
  const lows = recent.map((c, i) => ({ i, v: c.low }))
  const botSlope = linRegSlope(lows.map(l => l.v))

  const priorClose = candles[candles.length - 6].close
  const lastClose  = price

  // Descending resistance → bullish breakout
  if (topSlope < -0.05) {
    const resistLine = recent[recent.length - 1].high
    if (lastClose > resistLine * 1.01 && priorClose <= resistLine) {
      return { type: 'Trendline Breakout', direction: 'bullish', strength: 9,
        desc: 'Price closed above descending resistance trendline — momentum shift' }
    }
  }

  // Ascending support → breakdown
  if (botSlope > 0.05) {
    const supportLine = recent[recent.length - 1].low
    if (lastClose < supportLine * 0.99 && priorClose >= supportLine) {
      return { type: 'Trendline Breakdown', direction: 'bearish', strength: 9,
        desc: 'Price closed below ascending support trendline — bearish momentum shift' }
    }
  }

  // Horizontal support/resistance breakout (last 20-bar range)
  const rangeBars = candles.slice(-20)
  const rHigh = Math.max(...rangeBars.slice(0, -3).map(c => c.high))
  const rLow  = Math.min(...rangeBars.slice(0, -3).map(c => c.low))
  const rng   = rHigh - rLow

  if (rng / price < 0.07) {  // was in tight range
    if (price > rHigh * 1.005) return { type: 'Range Breakout', direction: 'bullish', strength: 8,
      desc: `Breakout above ${rng.toFixed(0)}-bar consolidation range — watch for volume confirmation` }
    if (price < rLow  * 0.995) return { type: 'Range Breakdown', direction: 'bearish', strength: 8,
      desc: 'Breakdown below consolidation range — sellers gaining control' }
  }

  return null
}

function linRegSlope(arr) {
  const n = arr.length; if (n < 2) return 0
  const meanX = (n - 1) / 2
  const meanY = arr.reduce((a, b) => a + b, 0) / n
  const num = arr.reduce((s, y, x) => s + (x - meanX) * (y - meanY), 0)
  const den = arr.reduce((s, _, x) => s + (x - meanX) ** 2, 0)
  return den === 0 ? 0 : num / den
}

/* ── Chart-based AI insights ─────────────────────── */
export function generateChartInsights(candles, quote) {
  const insights = []
  if (!candles?.length) return insights

  const closes  = candles.map(c => c.close)
  const price   = closes[closes.length - 1]
  const rsiArr  = calcRSI(closes)
  const rsi     = rsiArr[rsiArr.length - 1]
  const macdArr = calcMACD(closes)
  const macd    = macdArr[macdArr.length - 1]
  const atrArr  = calcATR(candles)
  const atr     = atrArr[atrArr.length - 1] ?? price * 0.02
  const sma20   = calcSMA(closes, 20)
  const sma50   = calcSMA(closes, 50)
  const s20     = sma20[sma20.length - 1]
  const s50     = sma50.filter(v => v !== null).slice(-1)[0]
  const trend   = detectTrend(candles)
  const tl      = detectTrendlineBreakout(candles)

  // Volume spike
  const avgVol   = candles.slice(-21, -1).reduce((s, c) => s + c.volume, 0) / 20
  const lastVol  = candles[candles.length - 1].volume
  const volRatio = avgVol > 0 ? lastVol / avgVol : 1

  if (tl) {
    insights.push({ type: tl.direction === 'bullish' ? 'bullish' : 'bearish', icon: '⚡',
      title: tl.type, desc: tl.desc, priority: 10 })
  }

  if (volRatio > 2.5) {
    insights.push({ type: 'neutral', icon: '📊',
      title: 'Unusual Volume Spike',
      desc: `Volume ${volRatio.toFixed(1)}× above 20-day avg — institutional activity likely`,
      priority: 9 })
  }

  if (rsi != null) {
    if (rsi < 25) insights.push({ type: 'bullish', icon: '🔋',
      title: 'Extreme Oversold Condition',
      desc: `RSI(14) at ${rsi.toFixed(1)} — deeply oversold, high mean-reversion probability`, priority: 8 })
    else if (rsi < 35) insights.push({ type: 'bullish', icon: '↩',
      title: 'Oversold Condition',
      desc: `RSI(14) at ${rsi.toFixed(1)} — approaching oversold territory, watch for reversal`, priority: 7 })
    else if (rsi > 75) insights.push({ type: 'bearish', icon: '⚠',
      title: 'Overbought Warning',
      desc: `RSI(14) at ${rsi.toFixed(1)} — extended, risk of pullback or consolidation`, priority: 7 })
    else if (rsi > 60 && rsi <= 75) insights.push({ type: 'bullish', icon: '💪',
      title: 'Momentum Strength',
      desc: `RSI(14) at ${rsi.toFixed(1)} — strong momentum in bullish range`, priority: 4 })
  }

  // MACD crossover
  if (macd.macd != null && macd.signal != null) {
    const prev = macdArr[macdArr.length - 2]
    if (prev?.macd != null) {
      if (prev.macd < prev.signal && macd.macd >= macd.signal)
        insights.push({ type: 'bullish', icon: '🔀', title: 'MACD Bullish Crossover',
          desc: 'MACD line just crossed above signal — momentum turning positive', priority: 9 })
      if (prev.macd > prev.signal && macd.macd <= macd.signal)
        insights.push({ type: 'bearish', icon: '🔀', title: 'MACD Bearish Crossover',
          desc: 'MACD line just crossed below signal — momentum deteriorating', priority: 9 })
    }
    if (macd.hist > 0 && macd.hist > Math.abs(macd.macd) * 0.5)
      insights.push({ type: 'bullish', icon: '📈', title: 'MACD Histogram Expanding',
        desc: 'Positive momentum building — histogram widening above zero', priority: 5 })
  }

  // SMA alignment
  if (s20 && s50) {
    if (price > s20 && price > s50 && s20 > s50)
      insights.push({ type: 'bullish', icon: '📐', title: 'Bullish MA Stack',
        desc: `Price > SMA20 ($${s20.toFixed(0)}) > SMA50 ($${s50.toFixed(0)}) — trend aligned`, priority: 6 })
    else if (price < s20 && price < s50 && s20 < s50)
      insights.push({ type: 'bearish', icon: '📐', title: 'Bearish MA Stack',
        desc: `Price < SMA20 ($${s20.toFixed(0)}) < SMA50 ($${s50.toFixed(0)}) — downtrend intact`, priority: 6 })

    // Golden/Death cross check (recent)
    const prevS20 = sma20[sma20.length - 5]
    const prevS50 = sma50.filter(v => v !== null).slice(-6)[0]
    if (prevS20 && prevS50) {
      if (prevS20 < prevS50 && s20 > s50)
        insights.push({ type: 'bullish', icon: '✨', title: 'Golden Cross',
          desc: 'SMA20 just crossed above SMA50 — historically strong long-term bullish signal', priority: 10 })
      if (prevS20 > prevS50 && s20 < s50)
        insights.push({ type: 'bearish', icon: '💀', title: 'Death Cross',
          desc: 'SMA20 just crossed below SMA50 — historically significant bearish signal', priority: 10 })
    }
  }

  // Trend
  if (trend.direction === 'uptrend' && trend.strength === 'Strong')
    insights.push({ type: 'bullish', icon: '🚀', title: 'Strong Uptrend',
      desc: `Regression slope +${trend.slope}%/bar — sustained buying pressure`, priority: 5 })
  if (trend.direction === 'downtrend' && trend.strength === 'Strong')
    insights.push({ type: 'bearish', icon: '🔻', title: 'Strong Downtrend',
      desc: `Regression slope ${trend.slope}%/bar — sustained selling pressure`, priority: 5 })
  if (trend.direction === 'sideways')
    insights.push({ type: 'neutral', icon: '↔', title: 'Sideways Consolidation',
      desc: 'Price in tight range — expect volatility expansion; direction unclear until breakout', priority: 3 })

  // High accumulation
  const recent5Avg = closes.slice(-5).reduce((a,b)=>a+b,0)/5
  const prior5Avg  = closes.slice(-10,-5).reduce((a,b)=>a+b,0)/5
  if (recent5Avg > prior5Avg * 1.015 && volRatio > 1.3)
    insights.push({ type: 'bullish', icon: '🏦', title: 'High Accumulation Zone',
      desc: 'Rising price on above-average volume — institutional accumulation pattern', priority: 8 })

  return insights.sort((a, b) => b.priority - a.priority).slice(0, 6)
}

/* ── Fear & Greed Index (0–100) ──────────────────── */
export function calcFearGreed(portfolioQuotes, vixPrice) {
  let score = 50
  const components = []

  // VIX component (0–20 = greed, 20–30 = neutral, 30+ = fear)
  if (vixPrice) {
    const vixScore = Math.max(0, Math.min(100, 100 - (vixPrice - 10) * 3.5))
    score = score * 0.7 + vixScore * 0.3
    components.push({ name: 'VIX (Volatility)', value: vixPrice.toFixed(1),
      score: +vixScore.toFixed(0), weight: '30%' })
  }

  // Portfolio momentum component
  if (portfolioQuotes?.length) {
    const upCount = portfolioQuotes.filter(q => (q.changePct ?? 0) > 0).length
    const momScore = (upCount / portfolioQuotes.length) * 100
    score = score * 0.75 + momScore * 0.25
    components.push({ name: 'Market Breadth', value: `${upCount}/${portfolioQuotes.length} advancing`,
      score: +momScore.toFixed(0), weight: '25%' })

    // Avg RSI proxy from changePct distribution
    const avgChange = portfolioQuotes.reduce((s, q) => s + (q.changePct ?? 0), 0) / portfolioQuotes.length
    const rsiProxy  = Math.max(0, Math.min(100, 50 + avgChange * 8))
    score = score * 0.85 + rsiProxy * 0.15
    components.push({ name: 'Momentum', value: `${avgChange.toFixed(2)}% avg day`,
      score: +rsiProxy.toFixed(0), weight: '15%' })
  }

  const finalScore = Math.round(Math.max(0, Math.min(100, score)))
  return {
    score:  finalScore,
    label:  finalScore >= 75 ? 'Extreme Greed'
          : finalScore >= 55 ? 'Greed'
          : finalScore >= 45 ? 'Neutral'
          : finalScore >= 25 ? 'Fear'
          : 'Extreme Fear',
    color:  finalScore >= 75 ? '#ef4444'
          : finalScore >= 55 ? '#f97316'
          : finalScore >= 45 ? '#f59e0b'
          : finalScore >= 25 ? '#6366f1'
          : '#8b5cf6',
    components,
  }
}

/* ── Linear-regression price forecast ───────────── */
function projectPrice(closes, daysAhead, atr) {
  const n    = closes.length
  const slope = linRegSlope(closes.slice(-60))
  const last  = closes[n - 1]
  const proj  = last + slope * daysAhead
  const sigma = atr * Math.sqrt(daysAhead) * 0.7  // uncertainty grows with √t
  return {
    target: +proj.toFixed(2),
    high:   +(proj + sigma * 1.28).toFixed(2),  // ~90% CI upper
    low:    +(proj - sigma * 1.28).toFixed(2),  // ~90% CI lower
    change: +(((proj - last) / last) * 100).toFixed(2),
  }
}

/* ── Bull / Bear probability ─────────────────────── */
function calcProbability(closes, rsi, macd, trend, sentimentScore = 0) {
  let bull = 0.50

  // Trend contribution
  if (trend.direction === 'uptrend')   bull += trend.strength === 'Strong' ? 0.12 : 0.07
  if (trend.direction === 'downtrend') bull -= trend.strength === 'Strong' ? 0.12 : 0.07

  // RSI contribution
  if (rsi != null) {
    if (rsi < 30) bull += 0.10
    else if (rsi < 45) bull += 0.05
    else if (rsi > 70) bull -= 0.10
    else if (rsi > 55) bull -= 0.02
  }

  // MACD contribution
  if (macd?.macd != null && macd?.signal != null) {
    bull += macd.macd > macd.signal ? 0.07 : -0.07
    if (macd.hist != null) bull += macd.hist > 0 ? 0.03 : -0.03
  }

  // Sentiment
  bull += (sentimentScore / 10) * 0.08

  // Recent 10-bar momentum
  const recent10 = closes.slice(-10)
  const m10 = (recent10[9] - recent10[0]) / recent10[0]
  bull += Math.max(-0.08, Math.min(0.08, m10 * 5))

  bull = Math.max(0.15, Math.min(0.88, bull))
  return { bull: +bull.toFixed(3), bear: +(1 - bull).toFixed(3) }
}

/* ── Main forecast generator ─────────────────────── */
export function generateForecast(candles, quote, sentimentScore = 0) {
  if (!candles?.length || candles.length < 30) return null

  const closes = candles.map(c => c.close)
  const price  = quote?.price ?? closes[closes.length - 1]
  const rsiArr = calcRSI(closes)
  const rsi    = rsiArr[rsiArr.length - 1]
  const macd   = calcMACD(closes).slice(-1)[0]
  const trend  = detectTrend(candles)
  const atrArr = calcATR(candles)
  const atr    = atrArr[atrArr.length - 1] ?? price * 0.02

  const fib  = calcFibonacci(candles)
  const proba = calcProbability(closes, rsi, macd, trend, sentimentScore)

  const horizons = [
    { label: '7-Day',  days: 7,  ...projectPrice(closes, 7,  atr) },
    { label: '30-Day', days: 30, ...projectPrice(closes, 30, atr) },
    { label: '90-Day', days: 90, ...projectPrice(closes, 90, atr) },
  ]

  // Build forecast chart data (historical + projected)
  const histData = candles.slice(-60).map(c => ({
    t:    new Date(c.time).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
    price: +c.close.toFixed(2),
    high:  null, low: null, type: 'historical',
  }))

  const slope    = linRegSlope(closes.slice(-60))
  const lastDate = new Date(candles[candles.length - 1].time)
  const projData = []
  for (let d = 1; d <= 90; d += 3) {
    const dt = new Date(lastDate); dt.setDate(dt.getDate() + d)
    const proj  = price + slope * d
    const sigma = atr * Math.sqrt(d) * 0.7
    projData.push({
      t:    dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }),
      price: null,
      proj:  +proj.toFixed(2),
      high:  +(proj + sigma * 1.28).toFixed(2),
      low:   +(proj - sigma * 1.28).toFixed(2),
      type:  'forecast',
    })
  }

  return {
    price,
    proba,
    horizons,
    fib,
    chartData: [...histData, ...projData],
    trend,
    insights:  generateChartInsights(candles, quote),
    generatedAt: new Date(),
  }
}

/* ── Sector performance ──────────────────────────── */
export function calcSectorPerformance(quotes, positions) {
  const sectors = {}
  positions.forEach(pos => {
    const q = quotes[pos.symbol]
    if (!q?.changePct) return
    const sector = pos.sector || 'Other'
    if (!sectors[sector]) sectors[sector] = { total: 0, count: 0 }
    sectors[sector].total += q.changePct
    sectors[sector].count += 1
  })
  return Object.entries(sectors).map(([name, d]) => ({
    name,
    avg: +(d.total / d.count).toFixed(2),
    count: d.count,
  })).sort((a, b) => b.avg - a.avg)
}
