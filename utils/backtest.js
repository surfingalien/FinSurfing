'use strict'

/**
 * utils/backtest.js  (A)
 *
 * Core backtesting engine. Self-contained — no external deps.
 *
 * Strategies:
 *   sma_crossover  — buy when fast SMA crosses above slow SMA, sell on death cross
 *   rsi_threshold  — buy when RSI < oversold, sell when RSI > overbought
 *   macd_signal    — buy when MACD line crosses above signal line, sell on cross below
 *   bb_reversion   — buy at lower band touch, sell at upper band touch
 */

// ── Series helpers ────────────────────────────────────────────────────────────

function smaSeries(closes, period) {
  return closes.map((_, i) => {
    if (i < period - 1) return NaN
    let sum = 0
    for (let j = i - period + 1; j <= i; j++) sum += closes[j]
    return sum / period
  })
}

function emaSeries(arr, period) {
  const out = new Array(arr.length).fill(NaN)
  // Find first index of valid (non-NaN) values
  const start = arr.findIndex(v => !isNaN(v))
  if (start < 0 || arr.length - start < period) return out
  const k = 2 / (period + 1)
  let e = 0
  for (let i = start; i < start + period; i++) e += arr[i]
  e /= period
  out[start + period - 1] = e
  for (let i = start + period; i < arr.length; i++) {
    e = arr[i] * k + e * (1 - k)
    out[i] = e
  }
  return out
}

function rsiSeries(closes, period = 14) {
  const out = new Array(closes.length).fill(NaN)
  if (closes.length < period + 1) return out
  let avgGain = 0, avgLoss = 0
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1]
    if (d >= 0) avgGain += d; else avgLoss -= d
  }
  avgGain /= period; avgLoss /= period
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1]
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

function macdSeries(closes, fast = 12, slow = 26, sig = 9) {
  const fastE  = emaSeries(closes, fast)
  const slowE  = emaSeries(closes, slow)
  const macd   = fastE.map((f, i) => isNaN(f) || isNaN(slowE[i]) ? NaN : f - slowE[i])
  const signal = emaSeries(macd, sig)
  const hist   = macd.map((m, i) => isNaN(m) || isNaN(signal[i]) ? NaN : m - signal[i])
  return { macd, signal, hist }
}

function bbSeries(closes, period = 20, mult = 2) {
  const upper = [], lower = []
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { upper.push(NaN); lower.push(NaN); continue }
    const slice = closes.slice(i - period + 1, i + 1)
    const mean  = slice.reduce((s, v) => s + v, 0) / period
    const std   = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period)
    upper.push(mean + mult * std)
    lower.push(mean - mult * std)
  }
  return { upper, lower }
}

// ── Signal generation ─────────────────────────────────────────────────────────

function generateSignals(closes, strategy, params) {
  const n   = closes.length
  const sig = new Array(n).fill(0) // +1 = buy, -1 = sell

  if (strategy === 'sma_crossover') {
    const { fastPeriod = 20, slowPeriod = 50 } = params
    const fast = smaSeries(closes, fastPeriod)
    const slow = smaSeries(closes, slowPeriod)
    for (let i = 1; i < n; i++) {
      if (isNaN(fast[i]) || isNaN(slow[i]) || isNaN(fast[i-1]) || isNaN(slow[i-1])) continue
      if (fast[i-1] <= slow[i-1] && fast[i] > slow[i]) sig[i] =  1  // golden cross → buy
      if (fast[i-1] >= slow[i-1] && fast[i] < slow[i]) sig[i] = -1  // death cross  → sell
    }
  }

  if (strategy === 'rsi_threshold') {
    const { period = 14, oversold = 30, overbought = 70 } = params
    const rsi = rsiSeries(closes, period)
    let wasOversold = false
    for (let i = 1; i < n; i++) {
      if (isNaN(rsi[i])) continue
      if (rsi[i] < oversold)     wasOversold = true
      if (wasOversold && rsi[i] >= oversold)  { sig[i] =  1; wasOversold = false }
      if (!isNaN(rsi[i-1]) && rsi[i-1] < overbought && rsi[i] >= overbought) sig[i] = -1
    }
  }

  if (strategy === 'macd_signal') {
    const { fast = 12, slow = 26, signal = 9 } = params
    const { macd, signal: sigLine } = macdSeries(closes, fast, slow, signal)
    for (let i = 1; i < n; i++) {
      if (isNaN(macd[i]) || isNaN(sigLine[i]) || isNaN(macd[i-1]) || isNaN(sigLine[i-1])) continue
      if (macd[i-1] <= sigLine[i-1] && macd[i] > sigLine[i]) sig[i] =  1
      if (macd[i-1] >= sigLine[i-1] && macd[i] < sigLine[i]) sig[i] = -1
    }
  }

  if (strategy === 'bb_reversion') {
    const { period = 20, mult = 2 } = params
    const { upper, lower } = bbSeries(closes, period, mult)
    for (let i = 1; i < n; i++) {
      if (isNaN(upper[i]) || isNaN(lower[i])) continue
      if (closes[i-1] >= lower[i-1] && closes[i] < lower[i]) sig[i] =  1  // touch lower → buy
      if (closes[i-1] <= upper[i-1] && closes[i] > upper[i]) sig[i] = -1  // touch upper → sell
    }
  }

  return sig
}

// ── Trade simulation ──────────────────────────────────────────────────────────

function simulate(timestamps, closes, strategy, params, initialCapital = 10000) {
  const signals = generateSignals(closes, strategy, params)
  const n       = closes.length
  const equity  = []
  const trades  = []

  let cash   = initialCapital
  let shares = 0
  let entryPrice = null
  let entryDate  = null

  for (let i = 0; i < n; i++) {
    const price = closes[i]
    const date  = new Date(timestamps[i] * 1000).toISOString().slice(0, 10)
    const value = cash + shares * price
    equity.push({ date, value: +value.toFixed(2) })

    if (signals[i] === 1 && shares === 0 && cash > price) {
      shares     = Math.floor(cash / price)
      cash      -= shares * price
      entryPrice = price
      entryDate  = date
      trades.push({ type: 'buy', date, price: +price.toFixed(4), shares })
    } else if (signals[i] === -1 && shares > 0) {
      const proceeds = shares * price
      const pnl      = ((price - entryPrice) / entryPrice) * 100
      const duration = Math.round((new Date(date) - new Date(entryDate)) / 86_400_000)
      cash += proceeds
      trades.push({ type: 'sell', date, price: +price.toFixed(4), shares, pnl: +pnl.toFixed(2), durationDays: duration })
      shares     = 0
      entryPrice = null
      entryDate  = null
    }
  }

  // Close any open position at last price
  if (shares > 0) {
    const price    = closes.at(-1)
    const pnl      = ((price - entryPrice) / entryPrice) * 100
    const duration = Math.round((new Date(equity.at(-1).date) - new Date(entryDate)) / 86_400_000)
    trades.push({
      type: 'sell', date: equity.at(-1).date, price: +price.toFixed(4),
      shares, pnl: +pnl.toFixed(2), durationDays: duration, open: true,
    })
  }

  // ── Metrics ──────────────────────────────────────────────────────────────
  const finalValue  = equity.at(-1)?.value ?? initialCapital
  const totalReturn = (finalValue - initialCapital) / initialCapital * 100

  // Max drawdown
  let peak = initialCapital, maxDD = 0
  for (const { value } of equity) {
    if (value > peak) peak = value
    const dd = (peak - value) / peak * 100
    if (dd > maxDD) maxDD = dd
  }

  // Sharpe (annualised)
  const dailyRet  = equity.slice(1).map((e, i) => (e.value - equity[i].value) / equity[i].value)
  const meanRet   = dailyRet.reduce((s, v) => s + v, 0) / (dailyRet.length || 1)
  const variance  = dailyRet.reduce((s, v) => s + (v - meanRet) ** 2, 0) / (dailyRet.length || 1)
  const stdDev    = Math.sqrt(variance)
  const annRet    = meanRet * 252
  const annStd    = stdDev * Math.sqrt(252)
  const sharpe    = annStd > 0 ? (annRet - 0.05) / annStd : 0

  // Calmar
  const calmar    = maxDD > 0 ? annRet / (maxDD / 100) : 0

  // Trade stats
  const closed     = trades.filter(t => t.type === 'sell')
  const wins       = closed.filter(t => t.pnl > 0)
  const winRate    = closed.length > 0 ? wins.length / closed.length * 100 : 0
  const avgWin     = wins.length > 0    ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0
  const losses     = closed.filter(t => t.pnl <= 0)
  const avgLoss    = losses.length > 0  ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0
  const profitFactor = avgLoss < 0 ? Math.abs(avgWin * wins.length / (avgLoss * losses.length)) : null

  // Buy & hold benchmark
  const firstClose = closes[0]
  const lastClose  = closes.at(-1)
  const buyHold    = ((lastClose - firstClose) / firstClose) * 100

  return {
    equity,
    trades,
    metrics: {
      totalReturn:    +totalReturn.toFixed(2),
      finalValue:     +finalValue.toFixed(2),
      initialCapital,
      maxDrawdown:    +maxDD.toFixed(2),
      sharpeRatio:    +sharpe.toFixed(3),
      calmarRatio:    +calmar.toFixed(3),
      annualizedReturn: +(annRet * 100).toFixed(2),
      winRate:        +winRate.toFixed(1),
      totalTrades:    closed.length,
      profitableTrades: wins.length,
      avgWinPct:      +avgWin.toFixed(2),
      avgLossPct:     +avgLoss.toFixed(2),
      profitFactor:   profitFactor ? +profitFactor.toFixed(2) : null,
      buyHoldReturn:  +buyHold.toFixed(2),
      alpha:          +(totalReturn - buyHold).toFixed(2),
    }
  }
}

module.exports = { simulate, smaSeries, rsiSeries, macdSeries, bbSeries }
