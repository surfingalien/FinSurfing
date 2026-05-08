/**
 * FinSurf AI Advisory Engine v2
 * Ensemble ML model: technical + fundamental + sentiment + analyst consensus
 * Outputs 7-type signals across 3 time horizons with confidence %
 */

import { calcSMA, calcEMA, calcRSI, calcMACD, calcBollinger, fmt } from './api'
import {
  calcATR, detectTrend, findSwingPoints, findKeyLevels,
  detectDivergence, generateAdvisory as baseAdvisory
} from './research'

/* ── Constants ───────────────────────────────────── */
export const SIGNAL_TYPES = {
  STRONG_BUY:    { label: 'Strong Buy',         color: '#10b981', bg: 'bg-emerald-500/20', border: 'border-emerald-500/40', text: 'text-emerald-400', emoji: '🚀' },
  BUY:           { label: 'Buy',                 color: '#34d399', bg: 'bg-emerald-500/10', border: 'border-emerald-500/25', text: 'text-emerald-400', emoji: '✅' },
  WATCHLIST:     { label: 'Watchlist Candidate', color: '#6366f1', bg: 'bg-indigo-500/15',  border: 'border-indigo-500/30',  text: 'text-indigo-400',  emoji: '👁' },
  HOLD:          { label: 'Hold',                color: '#f59e0b', bg: 'bg-amber-500/10',   border: 'border-amber-500/25',   text: 'text-amber-400',   emoji: '⏸' },
  PROFIT_BOOK:   { label: 'Profit Booking',      color: '#a78bfa', bg: 'bg-purple-500/15',  border: 'border-purple-500/30',  text: 'text-purple-400',  emoji: '💰' },
  SELL:          { label: 'Sell',                color: '#f87171', bg: 'bg-red-500/10',     border: 'border-red-500/25',     text: 'text-red-400',     emoji: '🔻' },
  STOP_TRIGGER:  { label: 'Stop Loss Trigger',   color: '#ef4444', bg: 'bg-red-500/20',     border: 'border-red-500/40',     text: 'text-red-400',     emoji: '🛑' },
}

/* ── Sentiment lexicon ───────────────────────────── */
const BULL_WORDS = [
  'beat', 'beats', 'exceeds', 'surpasses', 'record', 'upgrade', 'outperform',
  'buy', 'overweight', 'bullish', 'growth', 'breakout', 'rally', 'gains',
  'profit', 'revenue', 'dividend', 'buyback', 'partnership', 'acquisition',
  'breakthrough', 'launch', 'expand', 'recovery', 'strong', 'surge', 'rises',
  'soars', 'jumps', 'climbs', 'positive', 'optimistic', 'innovation', 'ai',
]
const BEAR_WORDS = [
  'miss', 'misses', 'below', 'disappoints', 'downgrade', 'underperform',
  'sell', 'underweight', 'bearish', 'loss', 'decline', 'warning', 'cut',
  'layoff', 'lawsuit', 'investigation', 'recall', 'bankruptcy', 'debt',
  'falls', 'drops', 'plunges', 'slumps', 'concern', 'risk', 'weak',
  'disappointing', 'negative', 'caution', 'slowdown', 'deficit', 'fine',
]

export function analyzeSentiment(headlines = []) {
  if (!headlines.length) return { score: 0, label: 'Unknown', articles: 0, bullCount: 0, bearCount: 0 }

  let bullCount = 0, bearCount = 0
  const scored = headlines.map(h => {
    const text = ((h.title || '') + ' ' + (h.summary || '')).toLowerCase()
    let s = 0
    BULL_WORDS.forEach(w => { if (text.includes(w)) s += 1 })
    BEAR_WORDS.forEach(w => { if (text.includes(w)) s -= 1 })
    if (s > 0) bullCount++
    if (s < 0) bearCount++
    return { ...h, sentimentScore: s }
  })

  const avg = scored.reduce((a, b) => a + b.sentimentScore, 0) / scored.length
  const normalized = Math.max(-10, Math.min(10, avg * 2.5))

  const label = normalized > 3 ? 'Very Bullish'
    : normalized > 1 ? 'Bullish'
    : normalized < -3 ? 'Very Bearish'
    : normalized < -1 ? 'Bearish'
    : 'Neutral'

  return { score: +normalized.toFixed(2), label, articles: headlines.length, bullCount, bearCount, headlines: scored }
}

/* ── Advanced pattern detection ─────────────────── */
export function detectAdvancedPatterns(candles) {
  const n = candles.length
  if (n < 40) return []
  const patterns = []
  const { highs, lows } = findSwingPoints(candles, 5)
  const price = candles[n - 1].close

  // Double top
  if (highs.length >= 2) {
    const [h1, h2] = highs.slice(-2)
    const tol = 0.02
    if (h2.idx > h1.idx + 5 && Math.abs(h2.price - h1.price) / h1.price < tol && price < h2.price * 0.97) {
      patterns.push({ name: 'Double Top', type: 'bearish', desc: 'Two peaks at similar levels — distribution pattern, expect breakdown', strength: 8 })
    }
  }

  // Double bottom
  if (lows.length >= 2) {
    const [l1, l2] = lows.slice(-2)
    const tol = 0.02
    if (l2.idx > l1.idx + 5 && Math.abs(l2.price - l1.price) / l1.price < tol && price > l2.price * 1.03) {
      patterns.push({ name: 'Double Bottom', type: 'bullish', desc: 'Two troughs at similar levels — accumulation pattern, potential reversal up', strength: 8 })
    }
  }

  // Head & shoulders (top)
  if (highs.length >= 3) {
    const [h1, head, h2] = highs.slice(-3)
    if (head.price > h1.price * 1.02 && head.price > h2.price * 1.02 &&
        Math.abs(h1.price - h2.price) / h1.price < 0.04 && price < head.price * 0.93) {
      patterns.push({ name: 'Head & Shoulders', type: 'bearish', desc: 'Classic topping pattern — neckline breach signals distribution phase', strength: 9 })
    }
  }

  // Inverse H&S (bottom)
  if (lows.length >= 3) {
    const [l1, head, l2] = lows.slice(-3)
    if (head.price < l1.price * 0.97 && head.price < l2.price * 0.97 &&
        Math.abs(l1.price - l2.price) / l1.price < 0.04 && price > head.price * 1.07) {
      patterns.push({ name: 'Inv. Head & Shoulders', type: 'bullish', desc: 'Classic bottoming pattern — breakout above neckline confirms reversal', strength: 9 })
    }
  }

  // Rising wedge (bearish)
  const recent20 = candles.slice(-20)
  const highSlope = trendSlopeFn(recent20.map(c => c.high))
  const lowSlope  = trendSlopeFn(recent20.map(c => c.low))
  if (highSlope > 0 && lowSlope > highSlope * 1.3 && highSlope < 0.3) {
    patterns.push({ name: 'Rising Wedge', type: 'bearish', desc: 'Narrowing upward channel — buyers losing momentum, breakdown likely', strength: 6 })
  }

  // Falling wedge (bullish)
  if (lowSlope < 0 && highSlope < lowSlope * 1.3 && lowSlope > -0.3) {
    patterns.push({ name: 'Falling Wedge', type: 'bullish', desc: 'Narrowing downward channel — sellers losing momentum, breakout likely', strength: 7 })
  }

  // Cup & Handle (bullish)
  if (n >= 60) {
    const cup = candles.slice(-60, -10)
    const handle = candles.slice(-10)
    const cupLow  = Math.min(...cup.map(c => c.low))
    const cupLeft = cup[0].close
    const cupRight = cup[cup.length - 1].close
    const handleLow = Math.min(...handle.map(c => c.low))
    if (Math.abs(cupLeft - cupRight) / cupLeft < 0.03 && cupLow < cupLeft * 0.88 && handleLow > cupLow * 1.03) {
      patterns.push({ name: 'Cup & Handle', type: 'bullish', desc: 'Rounded base with shallow pullback — high-probability breakout setup', strength: 8 })
    }
  }

  return patterns
}

function trendSlopeFn(arr) {
  const n = arr.length
  if (n < 2) return 0
  const sumX = n*(n-1)/2, sumY = arr.reduce((a,b)=>a+b,0)
  const sumXY = arr.reduce((s,y,x)=>s+x*y,0), sumX2 = n*(n-1)*(2*n-1)/6
  return (n*sumXY - sumX*sumY) / (n*sumX2 - sumX**2) / (sumY/n) * 100
}

/* ── Signal backtest (walk-forward hit rate) ─────── */
export function backtestSignals(candles, lookforward = 20) {
  if (candles.length < 80) return null
  const closes = candles.map(c => c.close)
  let wins = 0, losses = 0, total = 0

  // Test signal at every 10-bar window going back
  for (let i = 50; i < candles.length - lookforward - 5; i += 10) {
    const slice = candles.slice(0, i)
    const slCloses = slice.map(c => c.close)
    const rsi = calcRSI(slCloses)
    const lastRSI = rsi[rsi.length - 1]
    const macd = calcMACD(slCloses)
    const lastMACD = macd[macd.length - 1]

    if (lastRSI == null || lastMACD.macd == null) continue

    // Simulated bullish signal condition
    const wasBullish = lastRSI < 45 && lastMACD.macd > lastMACD.signal
    const wasBearish = lastRSI > 60 && lastMACD.macd < lastMACD.signal

    if (!wasBullish && !wasBearish) continue

    const entryPrice = closes[i]
    const exitPrice  = closes[i + lookforward]
    const moved = (exitPrice - entryPrice) / entryPrice

    if (wasBullish && moved > 0.02) wins++
    else if (wasBearish && moved < -0.02) wins++
    else losses++
    total++
  }

  if (total < 5) return null
  return {
    hitRate: +((wins / total) * 100).toFixed(1),
    total,
    wins,
    losses,
    label: wins/total > 0.6 ? 'High accuracy' : wins/total > 0.45 ? 'Moderate accuracy' : 'Low accuracy',
  }
}

/* ── Analyst score normalization ─────────────────── */
function scoreAnalyst(fundamentals, price) {
  if (!fundamentals) return 5
  let score = 5
  // recommendationMean: 1=Strong Buy, 2=Buy, 3=Hold, 4=Sell, 5=Strong Sell
  if (fundamentals.recommendationKey) {
    const key = fundamentals.recommendationKey.toLowerCase()
    if (key.includes('strong_buy') || key === 'strong buy') score = 9
    else if (key === 'buy')    score = 7.5
    else if (key === 'hold')   score = 5
    else if (key === 'sell')   score = 2.5
    else if (key.includes('strong_sell')) score = 1
  }
  // Upside to analyst target
  if (fundamentals.targetMeanPrice && price) {
    const upside = (fundamentals.targetMeanPrice - price) / price
    if (upside > 0.3) score = Math.min(10, score + 1.5)
    else if (upside > 0.1) score = Math.min(10, score + 0.5)
    else if (upside < -0.1) score = Math.max(0, score - 1)
  }
  return score
}

/* ── Multi-timeframe momentum alignment ──────────── */
export function scoreMultiTimeframe(dailyCandles, weeklyCandles) {
  const scores = []
  const details = []

  for (const [label, candles] of [['Daily (1Y)', dailyCandles], ['Weekly (2Y)', weeklyCandles]]) {
    if (!candles || candles.length < 30) continue
    const closes = candles.map(c => c.close)
    const rsi    = calcRSI(closes)
    const macd   = calcMACD(closes)
    const sma20  = calcSMA(closes, 20)
    const sma50  = calcSMA(closes, Math.min(50, closes.length - 1))
    const price  = closes[closes.length - 1]

    const lastRSI  = rsi[rsi.length - 1]
    const lastMACD = macd[macd.length - 1]
    const lastS20  = sma20[sma20.length - 1]
    const lastS50  = sma50.filter(v => v !== null).slice(-1)[0]

    let s = 0
    if (lastRSI != null) { s += lastRSI < 50 ? 1 : lastRSI > 65 ? -1 : 0 }
    if (lastMACD.macd != null) { s += lastMACD.macd > lastMACD.signal ? 1 : -1 }
    if (lastS20 && price > lastS20) s += 0.5
    if (lastS50 && price > lastS50) s += 0.5
    if (lastS20 && lastS50 && lastS20 > lastS50) s += 0.5

    scores.push(s)
    details.push({
      label,
      rsi: lastRSI ? +lastRSI.toFixed(1) : null,
      macd: lastMACD.macd != null ? (lastMACD.macd > lastMACD.signal ? 'Bullish' : 'Bearish') : null,
      trend: s > 1.5 ? 'Bullish' : s < -1.5 ? 'Bearish' : 'Neutral',
      score: s,
    })
  }

  const avg = scores.length ? scores.reduce((a,b)=>a+b,0)/scores.length : 0
  const aligned = scores.every(s => s > 0) ? 'All Bullish' :
                  scores.every(s => s < 0) ? 'All Bearish' :
                  scores.length > 1 && Math.sign(scores[0]) !== Math.sign(scores[scores.length-1])
                    ? 'Conflicting' : 'Mixed'

  return { avg: +avg.toFixed(2), aligned, details }
}

/* ── Signal classification ───────────────────────── */
export function classifySignal({
  techScore, fundScore, sentimentScore, analystScore, mtfScore,
  position, rsi, price, stopLevel, atr,
}) {
  // Weighted ensemble
  const ensemble =
    techScore      * 0.35 +
    fundScore      * 0.20 +
    sentimentScore * 0.15 +
    analystScore   * 0.15 +
    mtfScore       * 0.15

  // Stop-loss trigger (highest priority — portfolio positions)
  if (position && stopLevel && price <= stopLevel * 1.01) {
    return { type: 'STOP_TRIGGER', ensemble, raw: { techScore, fundScore, sentimentScore, analystScore, mtfScore } }
  }

  // Profit booking (portfolio positions with significant gain)
  if (position) {
    const gainPct = ((price - position.avgCost) / position.avgCost) * 100
    if (gainPct > 20 && (rsi > 68 || techScore < 1)) {
      return { type: 'PROFIT_BOOK', ensemble, gainPct: +gainPct.toFixed(1), raw: { techScore, fundScore, sentimentScore, analystScore, mtfScore } }
    }
  }

  // Direction signals
  if (ensemble >= 7.5) return { type: 'STRONG_BUY', ensemble, raw: { techScore, fundScore, sentimentScore, analystScore, mtfScore } }
  if (ensemble >= 6.0) return { type: 'BUY',        ensemble, raw: { techScore, fundScore, sentimentScore, analystScore, mtfScore } }
  if (ensemble >= 4.5) return { type: 'WATCHLIST',  ensemble, raw: { techScore, fundScore, sentimentScore, analystScore, mtfScore } }
  if (ensemble >= 3.5) return { type: 'HOLD',       ensemble, raw: { techScore, fundScore, sentimentScore, analystScore, mtfScore } }
  if (ensemble >= 2.0) return { type: 'SELL',       ensemble, raw: { techScore, fundScore, sentimentScore, analystScore, mtfScore } }
  return                       { type: 'SELL',       ensemble, raw: { techScore, fundScore, sentimentScore, analystScore, mtfScore } }
}

/* ── Confidence % ────────────────────────────────── */
export function calcConfidencePct(signalType, factors, alignment, backtest) {
  let base = 50

  // Factor alignment
  const vals  = Object.values(factors)
  const above = vals.filter(v => v >= 5).length
  const below = vals.filter(v => v < 5).length
  const agreePct = above / vals.length
  base += (agreePct - 0.5) * 40

  // Multi-timeframe alignment bonus/penalty
  if (alignment === 'All Bullish' || alignment === 'All Bearish') base += 10
  if (alignment === 'Conflicting') base -= 10

  // Backtest accuracy influence
  if (backtest) {
    base += (backtest.hitRate - 50) * 0.3
  }

  // Strong signal type boosts
  if (signalType === 'STRONG_BUY' || signalType === 'STOP_TRIGGER') base += 5
  if (signalType === 'WATCHLIST')  base -= 5

  return Math.min(94, Math.max(22, Math.round(base)))
}

/* ── Trade parameters for all 3 horizons ─────────── */
export function generateHorizonSetups(price, atr, support, resistance, rsi) {
  const horizons = []

  // Intraday (tight, ATR-based)
  const intradayStop = +(price - atr * 0.8).toFixed(2)
  const intradayTP1  = +(price + atr * 1.2).toFixed(2)
  const intradayTP2  = +(price + atr * 2.0).toFixed(2)
  horizons.push({
    label:         'Intraday',
    horizon:       'Same day / overnight',
    entry:         price,
    stop:          intradayStop,
    tp1:           intradayTP1,
    tp2:           intradayTP2,
    rr:            +((intradayTP1 - price) / (price - intradayStop)).toFixed(2),
    stopPct:       +(((price - intradayStop) / price) * 100).toFixed(2),
    note:          'Tight ATR-based levels for short-term momentum play',
  })

  // Swing (1–3 weeks)
  const swStop = support ? +(Math.min(support * 0.985, price - atr * 1.5)).toFixed(2) : +(price - atr * 1.5).toFixed(2)
  const swTP1  = resistance ? +(Math.min(resistance * 0.99, price + atr * 2.5)).toFixed(2) : +(price + atr * 2.5).toFixed(2)
  const swTP2  = +(price + (swTP1 - price) * 1.8).toFixed(2)
  horizons.push({
    label:         'Swing Trade',
    horizon:       '1–3 weeks',
    entry:         price,
    stop:          swStop,
    tp1:           swTP1,
    tp2:           swTP2,
    rr:            +((swTP1 - price) / Math.max(0.01, price - swStop)).toFixed(2),
    stopPct:       +(((price - swStop) / price) * 100).toFixed(2),
    note:          'Support-anchored stop, resistance-anchored target',
  })

  // Long-term (3–12 months)
  const ltStop = +(price - atr * 4).toFixed(2)
  const ltTP1  = +(price * 1.15).toFixed(2)
  const ltTP2  = +(price * 1.30).toFixed(2)
  horizons.push({
    label:         'Long-Term Investment',
    horizon:       '3–12 months',
    entry:         `$${fmt(price * 0.97)}–$${fmt(price * 1.01)}`,
    stop:          ltStop,
    tp1:           ltTP1,
    tp2:           ltTP2,
    rr:            +((ltTP1 - price) / Math.max(0.01, price - ltStop)).toFixed(2),
    stopPct:       +(((price - ltStop) / price) * 100).toFixed(2),
    note:          'Scale in on dips; fundamental thesis must remain intact',
  })

  return horizons
}

/* ── Main AI advisory generator ─────────────────── */
export async function generateAIAdvisory({
  symbol, candles, weeklyCandles, quote, fundamentals, headlines, position,
}) {
  const price  = quote?.price ?? candles?.[candles.length - 1]?.close
  if (!price || !candles?.length) return { error: 'Insufficient data' }

  const closes = candles.map(c => c.close)

  // ── All indicators ──────────────────────────────
  const rsiArr  = calcRSI(closes)
  const macdArr = calcMACD(closes)
  const bbArr   = calcBollinger(closes)
  const atrArr  = calcATR(candles, 14)
  const sma20   = calcSMA(closes, 20)
  const sma50   = calcSMA(closes, 50)

  const rsi    = rsiArr[rsiArr.length - 1]
  const macd   = macdArr[macdArr.length - 1]
  const bb     = bbArr[bbArr.length - 1]
  const atr    = atrArr[atrArr.length - 1] ?? price * 0.02
  const s20    = sma20[sma20.length - 1]
  const s50    = sma50.filter(v => v !== null).slice(-1)[0]

  // ── Individual factor scores (0–10) ────────────
  // 1. Technical (0-10)
  let techRaw = 5
  if (rsi != null) {
    if (rsi < 30) techRaw += 2.5
    else if (rsi < 45) techRaw += 1.0
    else if (rsi > 70) techRaw -= 2.5
    else if (rsi > 58) techRaw -= 0.5
  }
  if (macd.macd != null && macd.signal != null) {
    techRaw += macd.macd > macd.signal ? 1.0 : -1.0
    if (macd.hist != null) techRaw += macd.hist > 0 ? 0.5 : -0.5
  }
  if (bb.lower && bb.upper) {
    const bbPos = (price - bb.lower) / (bb.upper - bb.lower)
    if (bbPos < 0.2) techRaw += 1.0
    else if (bbPos > 0.85) techRaw -= 1.0
  }
  if (s20 && s50) {
    if (price > s20 && s20 > s50) techRaw += 1.0
    else if (price < s20 && s20 < s50) techRaw -= 1.0
  }
  const techScore = Math.min(10, Math.max(0, techRaw))

  // 2. Fundamental (0-10)
  let fundRaw = 5
  if (fundamentals) {
    if (fundamentals.revenueGrowth > 0.15) fundRaw += 1.5
    else if (fundamentals.revenueGrowth < 0)  fundRaw -= 1.0
    if (fundamentals.earningsGrowth > 0.10) fundRaw += 1.0
    else if (fundamentals.earningsGrowth < -0.10) fundRaw -= 1.0
    if (fundamentals.profitMargin > 0.15)  fundRaw += 0.5
    if (fundamentals.debtToEquity != null && fundamentals.debtToEquity < 1) fundRaw += 0.5
    if (fundamentals.returnOnEquity > 0.15) fundRaw += 0.5
    if (fundamentals.pe && fundamentals.pe < 20)  fundRaw += 0.5
    if (fundamentals.pe && fundamentals.pe > 60)  fundRaw -= 0.5
  }
  const fundScore = Math.min(10, Math.max(0, fundRaw))

  // 3. Sentiment (0-10)
  const sentiment = analyzeSentiment(headlines)
  const sentimentScore = Math.min(10, Math.max(0, 5 + sentiment.score))

  // 4. Analyst (0-10)
  const analystScore = scoreAnalyst(fundamentals, price)

  // 5. Multi-timeframe (0-10)
  const mtf = scoreMultiTimeframe(candles, weeklyCandles)
  const mtfScore = Math.min(10, Math.max(0, 5 + mtf.avg * 1.5))

  // ── Patterns ─────────────────────────────────
  const { support, resistance } = findKeyLevels(candles, price)
  const patterns  = detectAdvancedPatterns(candles)
  const divergence = detectDivergence(candles, rsiArr)
  const backtest  = backtestSignals(candles)

  // ── Signal classification ─────────────────────
  const stopLevel = position ? position.avgCost * 0.85 : null  // rough stop for held positions
  const rawSignal = classifySignal({
    techScore, fundScore, sentimentScore, analystScore, mtfScore,
    position, rsi, price, stopLevel, atr,
  })

  const signalCfg = SIGNAL_TYPES[rawSignal.type]

  // ── Confidence % ─────────────────────────────
  const confidencePct = calcConfidencePct(
    rawSignal.type,
    { techScore, fundScore, sentimentScore, analystScore, mtfScore },
    mtf.aligned,
    backtest,
  )

  // ── Horizon setups ────────────────────────────
  const horizons = generateHorizonSetups(
    price, atr, support[0], resistance[0], rsi,
  )

  // ── Ensemble breakdown for UI ─────────────────
  const factors = [
    { name: 'Technical Analysis', score: techScore,      weight: '35%', icon: '📊',
      detail: `RSI ${rsi?.toFixed(1) ?? '—'} · MACD ${macd.hist > 0 ? '+' : ''}${macd.hist?.toFixed(3) ?? '—'}` },
    { name: 'Fundamental Quality', score: fundScore,     weight: '20%', icon: '📋',
      detail: `Rev growth ${fundamentals?.revenueGrowth != null ? (fundamentals.revenueGrowth*100).toFixed(0)+'%' : 'N/A'} · P/E ${fundamentals?.pe?.toFixed(0) ?? 'N/A'}` },
    { name: 'News Sentiment',      score: sentimentScore, weight: '15%', icon: '📰',
      detail: `${sentiment.label} · ${sentiment.bullCount}B/${sentiment.bearCount}Ba from ${sentiment.articles} articles` },
    { name: 'Analyst Consensus',   score: analystScore,  weight: '15%', icon: '🎯',
      detail: `${fundamentals?.recommendationKey ?? 'N/A'} · Target $${fundamentals?.targetMeanPrice?.toFixed(0) ?? '—'}` },
    { name: 'Multi-Timeframe',     score: mtfScore,      weight: '15%', icon: '⏱',
      detail: `${mtf.aligned} · ${mtf.details.map(d => d.label.split(' ')[0]+': '+d.trend).join(', ')}` },
  ]

  const ensembleScore = +rawSignal.ensemble.toFixed(2)

  return {
    symbol: quote?.symbol ?? symbol,
    name:   quote?.name   ?? symbol,
    price,
    quote,
    signal: rawSignal.type,
    signalCfg,
    ensembleScore,
    confidencePct,
    factors,
    technical: { rsi, macd, bb, atr, atrPct: +((atr/price)*100).toFixed(2), s20, s50 },
    patterns,
    divergence,
    sentiment,
    fundamentals,
    keyLevels:    { support, resistance },
    horizons,
    mtf,
    backtest,
    gainPct: rawSignal.gainPct ?? (position ? +((price - position.avgCost) / position.avgCost * 100).toFixed(2) : null),
    generatedAt: new Date(),
  }
}

/* ── Portfolio scan ──────────────────────────────── */
export async function scanPortfolio({ positions, quotes, newsMap, fundamentalsMap, weeklyMap }) {
  const results = []
  for (const pos of positions) {
    const quote = quotes[pos.symbol]
    if (!quote) continue
    // We don't have full candles here — use quote data to generate a simplified signal
    const price = quote.price ?? pos.avgCost
    const gainPct = ((price - pos.avgCost) / pos.avgCost) * 100
    const changePct = quote.changePct ?? 0

    // Quick heuristic signal from quote data alone
    let type = 'HOLD'
    if (gainPct > 25 && changePct > 0) type = 'PROFIT_BOOK'
    else if (price < pos.avgCost * 0.85) type = 'STOP_TRIGGER'
    else if (changePct > 3) type = 'BUY'
    else if (changePct < -3) type = 'SELL'
    else if (gainPct > 15) type = 'PROFIT_BOOK'
    else if (gainPct > 0) type = 'HOLD'
    else type = 'WATCHLIST'

    results.push({
      symbol:     pos.symbol,
      name:       pos.name,
      price,
      avgCost:    pos.avgCost,
      shares:     pos.shares,
      gainPct:    +gainPct.toFixed(2),
      changePct:  +changePct.toFixed(2),
      signal:     type,
      signalCfg:  SIGNAL_TYPES[type],
      mktValue:   +(price * pos.shares).toFixed(2),
    })
  }
  // Sort: Stop triggers first, then Strong Buy, then by gain%
  const order = ['STOP_TRIGGER','STRONG_BUY','PROFIT_BOOK','BUY','SELL','WATCHLIST','HOLD']
  results.sort((a, b) => order.indexOf(a.signal) - order.indexOf(b.signal))
  return results
}
