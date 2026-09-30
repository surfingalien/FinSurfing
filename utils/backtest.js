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

// Shared risk-free rate so backtest Sharpe/Sortino use the same hurdle as
// the live portfolio analytics (was a hardcoded 5% vs 4.5% elsewhere)
const { RISK_FREE_ANNUAL } = require('../lib/portfolio-metrics')

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

function simulate(timestamps, closes, strategy, params, initialCapital = 10000, opts = {}) {
  return simulateWithSignals(timestamps, closes, generateSignals(closes, strategy, params), initialCapital, opts)
}

// Execution model defaults. The engine used to fill every order at the close
// of the very bar whose close generated the signal — a price nobody can trade
// at, since the signal does not exist until that close prints — and charged
// nothing to trade, while lib/expected-value.js charges the same strategies
// 10-60bps per round trip before letting a pick through. Both flattered every
// strategy, most of all the high-turnover ones.
const DEFAULT_COST_BPS = 10          // round trip; ROUND_TRIP_BPS.stock
const DEFAULT_FILL     = 'next'      // 'next' = next bar's open (close if no opens); 'close' = legacy same-bar

/**
 * Run the trade simulation over a PRECOMPUTED signal array (+1 buy, -1 sell,
 * 0 hold). Split out of simulate() so signals produced elsewhere — e.g. the
 * composed-rule interpreter in lib/strategy-dsl.js — are scored by exactly
 * the same trade accounting and metrics as the built-in strategies. There is
 * one execution/metrics implementation, so a novel strategy cannot be graded
 * on a friendlier scale than a catalog one.
 *
 * opts.costBps — round-trip cost in basis points, half charged on each side
 *                (callers derive it from the asset class: costBpsForSymbol)
 * opts.fill    — 'next' (default): a signal on bar i fills on bar i+1, at
 *                opts.opens[i+1] when given, else closes[i+1]. A signal on
 *                the final bar never fills. 'close': legacy same-bar fill.
 * opts.opens   — optional open prices aligned with closes
 */
function simulateWithSignals(timestamps, closes, signals, initialCapital = 10000, opts = {}) {
  const n       = closes.length
  const equity  = []
  const trades  = []
  const costBps = Number.isFinite(opts.costBps) && opts.costBps >= 0 ? opts.costBps : DEFAULT_COST_BPS
  const fill    = opts.fill === 'close' ? 'close' : DEFAULT_FILL
  const opens   = Array.isArray(opts.opens) ? opts.opens : null
  const half    = costBps / 2 / 10_000

  let cash   = initialCapital
  let shares = 0
  let entryPrice = null      // net of cost — what the position actually cost
  let entryDate  = null
  let pending    = 0         // order carried to the next bar under 'next' fills
  let costPaid   = 0

  const execute = (side, px, date) => {
    if (side === 1 && shares === 0) {
      const buyPx = px * (1 + half)
      const qty = Math.floor(cash / buyPx)
      if (qty <= 0) return
      shares     = qty
      cash      -= qty * buyPx
      costPaid  += qty * px * half
      entryPrice = buyPx
      entryDate  = date
      trades.push({ type: 'buy', date, price: +px.toFixed(4), netPrice: +buyPx.toFixed(4), shares })
    } else if (side === -1 && shares > 0) {
      const sellPx   = px * (1 - half)
      const pnl      = ((sellPx - entryPrice) / entryPrice) * 100
      const duration = Math.round((new Date(date) - new Date(entryDate)) / 86_400_000)
      cash     += shares * sellPx
      costPaid += shares * px * half
      trades.push({ type: 'sell', date, price: +px.toFixed(4), netPrice: +sellPx.toFixed(4), shares, pnl: +pnl.toFixed(2), durationDays: duration })
      shares     = 0
      entryPrice = null
      entryDate  = null
    }
  }

  for (let i = 0; i < n; i++) {
    const price = closes[i]
    const date  = new Date(timestamps[i] * 1000).toISOString().slice(0, 10)

    // Yesterday's signal fills at today's open (or close when opens are absent).
    if (pending) {
      const o = opens?.[i]
      execute(pending, Number.isFinite(o) && o > 0 ? o : price, date)
      pending = 0
    }

    equity.push({ date, value: +(cash + shares * price).toFixed(2) })

    if (signals[i] === 1 || signals[i] === -1) {
      if (fill === 'close') execute(signals[i], price, date)
      else pending = signals[i]
    }
  }

  // Close any open position at the last price, paying the exit cost, and mark
  // the final equity point at that liquidation value.
  if (shares > 0) {
    const price    = closes.at(-1)
    const sellPx   = price * (1 - half)
    const pnl      = ((sellPx - entryPrice) / entryPrice) * 100
    const duration = Math.round((new Date(equity.at(-1).date) - new Date(entryDate)) / 86_400_000)
    trades.push({
      type: 'sell', date: equity.at(-1).date, price: +price.toFixed(4), netPrice: +sellPx.toFixed(4),
      shares, pnl: +pnl.toFixed(2), durationDays: duration, open: true,
    })
    costPaid += shares * price * half
    equity[equity.length - 1] = { ...equity.at(-1), value: +(cash + shares * sellPx).toFixed(2) }
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
  const sharpe    = annStd > 0 ? (annRet - RISK_FREE_ANNUAL) / annStd : 0

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
  // Sortino ratio (downside deviation only)
  const downside = dailyRet.filter(r => r < 0)
  const downVar  = downside.reduce((s, v) => s + v ** 2, 0) / (dailyRet.length || 1)
  const downStd  = Math.sqrt(downVar) * Math.sqrt(252)
  const sortino  = downStd > 0 ? (annRet - RISK_FREE_ANNUAL) / downStd : 0

  // Consecutive wins / losses
  let maxConsecWins = 0, maxConsecLoss = 0, curW = 0, curL = 0
  for (const t of closed) {
    if (t.pnl > 0) { curW++; curL = 0; maxConsecWins = Math.max(maxConsecWins, curW) }
    else           { curL++; curW = 0; maxConsecLoss = Math.max(maxConsecLoss, curL) }
  }

  // Recovery factor = total return / max drawdown
  const recoveryFactor = maxDD > 0 ? Math.abs(totalReturn) / maxDD : 0

  // Avg trade duration
  const avgDuration = closed.length > 0
    ? Math.round(closed.reduce((s, t) => s + (t.durationDays ?? 0), 0) / closed.length)
    : 0

  // Buy & hold pays the same round trip, so alpha compares like with like.
  const buyHold    = ((lastClose * (1 - half)) / (firstClose * (1 + half)) - 1) * 100

  return {
    equity,
    trades,
    metrics: {
      totalReturn:      +totalReturn.toFixed(2),
      finalValue:       +finalValue.toFixed(2),
      initialCapital,
      maxDrawdown:      +maxDD.toFixed(2),
      sharpeRatio:      +sharpe.toFixed(3),
      sortinoRatio:     +sortino.toFixed(3),
      calmarRatio:      +calmar.toFixed(3),
      recoveryFactor:   +recoveryFactor.toFixed(2),
      annualizedReturn: +(annRet * 100).toFixed(2),
      winRate:          +winRate.toFixed(1),
      totalTrades:      closed.length,
      profitableTrades: wins.length,
      maxConsecWins,
      maxConsecLoss,
      avgDurationDays:  avgDuration,
      avgWinPct:        +avgWin.toFixed(2),
      avgLossPct:       +avgLoss.toFixed(2),
      profitFactor:     profitFactor ? +profitFactor.toFixed(2) : null,
      buyHoldReturn:    +buyHold.toFixed(2),
      alpha:            +(totalReturn - buyHold).toFixed(2),
      costBps,
      fill,
      costPaid:         +costPaid.toFixed(2),
    }
  }
}

// ── Parameter optimizer ───────────────────────────────────────────────────────
// Runs a grid search over all combinations of param ranges and returns
// results sorted by the given metric (default: sharpeRatio).
// paramRanges: { paramKey: { min, max, step } }
// Returns: array of { params, metrics } sorted descending by sortBy
function optimizeStrategy(timestamps, closes, strategy, paramRanges, initialCapital = 10000, sortBy = 'sharpeRatio', maxResults = 50, opts = {}) {
  // Build grid of all param combinations
  const keys  = Object.keys(paramRanges)
  const grids = keys.map(k => {
    const { min, max, step } = paramRanges[k]
    const vals = []
    for (let v = min; v <= max + 1e-9; v += step) vals.push(+v.toFixed(6))
    return vals
  })

  function* cartesian(arrays, idx = 0, current = []) {
    if (idx === arrays.length) { yield [...current]; return }
    for (const v of arrays[idx]) { current[idx] = v; yield* cartesian(arrays, idx + 1, current) }
  }

  const results = []
  for (const combo of cartesian(grids)) {
    const params = {}
    keys.forEach((k, i) => { params[k] = combo[i] })
    try {
      const r = simulate(timestamps, closes, strategy, params, initialCapital, opts)
      if (r.metrics.totalTrades < 2) continue   // skip configs with no trades
      results.push({ params: { ...params }, metrics: r.metrics })
    } catch (_) {}
  }

  results.sort((a, b) => (b.metrics[sortBy] ?? -Infinity) - (a.metrics[sortBy] ?? -Infinity))
  return results.slice(0, maxResults)
}

/**
 * Round-trip cost for a symbol, from the same table the Advisory EV gate uses
 * (lib/expected-value.js ROUND_TRIP_BPS), so a strategy is backtested at the
 * cost the rest of the app assumes it will pay.
 */
function costBpsForSymbol(symbol, assetType = null) {
  const { ROUND_TRIP_BPS, normalizeAssetType } = require('../lib/expected-value')
  const key = normalizeAssetType(assetType)
    || (require('../lib/crypto-classify').isCryptoSymbol(String(symbol || '')) ? 'crypto' : 'stock')
  return ROUND_TRIP_BPS[key]
}

module.exports = {
  simulate, simulateWithSignals, optimizeStrategy, generateSignals, costBpsForSymbol,
  smaSeries, emaSeries, rsiSeries, macdSeries, bbSeries, DEFAULT_COST_BPS, DEFAULT_FILL,
}
