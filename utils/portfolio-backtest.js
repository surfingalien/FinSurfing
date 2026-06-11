'use strict'

/**
 * utils/portfolio-backtest.js
 *
 * Multi-asset portfolio backtesting engine — the portfolio-level counterpart
 * to the single-symbol strategy engine in utils/backtest.js. Concepts adapted
 * from RL trading-framework environment design (composable sizing/rebalance/
 * risk rules) without the RL: deterministic, transparent, unit-testable.
 *
 * Model:
 *   - Target weights per symbol (default equal weight), fully invested at the
 *     first common trading day's close.
 *   - Daily mark-to-market at close.
 *   - Optional per-position stop-loss / take-profit (vs. the position's entry
 *     price): triggered positions are sold to cash and stay in cash until the
 *     next rebalance event re-enters them.
 *   - Rebalancing: 'none' | 'monthly' | 'quarterly' (first common trading day
 *     of the period) | 'threshold' (any position drifts more than
 *     thresholdPct absolute weight from target). Rebalances restore target
 *     weights across ALL symbols, including stopped-out ones.
 *   - No commissions or slippage in v1 (commissionPct accepted, default 0,
 *     deducted on every trade's notional).
 *   - Benchmark: buy-and-hold of the same symbols at the same target weights,
 *     never rebalanced.
 *
 * Pure math, no I/O. Risk metrics come from lib/portfolio-metrics.js so
 * backtest and live analytics are directly comparable.
 */

const {
  sharpeRatio, sortinoRatio, maxDrawdown, annualizedReturn,
  annualizedVolatility, valueAtRisk, conditionalVaR, dailyReturns,
} = require('../lib/portfolio-metrics')

// ── Date alignment ────────────────────────────────────────────────────────────
/**
 * Intersect per-symbol series to common dates, ascending.
 * seriesBySymbol: { SYM: [{ date: 'YYYY-MM-DD', close: number }, ...] }
 * → { dates: [...], closes: { SYM: [...] } } aligned 1:1 with dates.
 */
function alignSeries(seriesBySymbol) {
  const symbols = Object.keys(seriesBySymbol)
  if (!symbols.length) return { dates: [], closes: {} }
  const maps = symbols.map(s => new Map(
    (seriesBySymbol[s] || [])
      .filter(p => p && p.date && p.close != null && !isNaN(p.close))
      .map(p => [p.date, p.close])
  ))
  const dates = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort()
  const closes = {}
  symbols.forEach((s, i) => { closes[s] = dates.map(d => maps[i].get(d)) })
  return { dates, closes }
}

// ── Rebalance triggers ────────────────────────────────────────────────────────
function isPeriodStart(rebalance, prevDate, date) {
  if (!prevDate) return false
  const pm = prevDate.slice(0, 7), cm = date.slice(0, 7)
  if (rebalance === 'monthly') return pm !== cm
  if (rebalance === 'quarterly') {
    const q = d => Math.floor((parseInt(d.slice(5, 7), 10) - 1) / 3)
    return pm.slice(0, 4) !== cm.slice(0, 4) || q(prevDate) !== q(date)
  }
  return false
}

function driftedBeyond(positions, prices, cash, weights, thresholdPct) {
  let equity = cash
  for (const s of Object.keys(positions)) equity += positions[s].shares * prices[s]
  if (equity <= 0) return false
  for (const s of Object.keys(weights)) {
    const w = positions[s] ? (positions[s].shares * prices[s]) / equity : 0
    if (Math.abs(w - weights[s]) * 100 > thresholdPct) return true
  }
  return false
}

// ── Engine ────────────────────────────────────────────────────────────────────
/**
 * @param {Object} opts
 *   seriesBySymbol  { SYM: [{date, close}] }     required
 *   weights         { SYM: number }              optional — normalized; default equal
 *   initialCapital  number                        default 10000
 *   rebalance       'none'|'monthly'|'quarterly'|'threshold'  default 'monthly'
 *   thresholdPct    number (abs weight drift %)   default 5 (threshold mode only)
 *   stopLossPct     number|null  e.g. 15 = sell at −15% from entry
 *   takeProfitPct   number|null
 *   commissionPct   number       default 0, % of trade notional
 */
function runPortfolioBacktest({
  seriesBySymbol,
  weights = null,
  initialCapital = 10_000,
  rebalance = 'monthly',
  thresholdPct = 5,
  stopLossPct = null,
  takeProfitPct = null,
  commissionPct = 0,
} = {}) {
  const { dates, closes } = alignSeries(seriesBySymbol || {})
  const symbols = Object.keys(closes)
  if (!symbols.length || dates.length < 30) {
    return { error: `Insufficient overlapping history (${dates.length} common days, need 30+)` }
  }

  // Normalize target weights
  let target = {}
  if (weights && Object.keys(weights).length) {
    let sum = 0
    for (const s of symbols) { target[s] = Math.max(0, weights[s] || 0); sum += target[s] }
    if (sum <= 0) { target = {}; symbols.forEach(s => { target[s] = 1 / symbols.length }) }
    else for (const s of symbols) target[s] /= sum
  } else {
    symbols.forEach(s => { target[s] = 1 / symbols.length })
  }

  const fee = nominal => Math.abs(nominal) * (commissionPct / 100)

  // State
  let cash = initialCapital
  const positions = {}   // sym → { shares, entryPrice }
  const stopped   = new Set()
  const trades    = []
  const equitySeries = []
  let rebalances = 0, stopsTriggered = 0, takesTriggered = 0

  const priceAt = (i) => Object.fromEntries(symbols.map(s => [s, closes[s][i]]))

  const equityAt = (prices) => {
    let eq = cash
    for (const s of Object.keys(positions)) eq += positions[s].shares * prices[s]
    return eq
  }

  const trade = (sym, shares, price, date, reason) => {
    // shares > 0 buy, < 0 sell
    const nominal = shares * price
    cash -= nominal + fee(nominal)
    const pos = positions[sym]
    if (shares > 0) {
      if (pos) {
        pos.entryPrice = (pos.entryPrice * pos.shares + price * shares) / (pos.shares + shares)
        pos.shares += shares
      } else {
        positions[sym] = { shares, entryPrice: price }
      }
    } else if (pos) {
      pos.shares += shares
      if (pos.shares <= 1e-9) delete positions[sym]
    }
    trades.push({ date, symbol: sym, side: shares > 0 ? 'buy' : 'sell', shares: +Math.abs(shares).toFixed(6), price: +price.toFixed(4), reason })
  }

  const rebalanceTo = (prices, date, reason) => {
    const eq = equityAt(prices)
    for (const s of symbols) {
      const want   = (eq * target[s]) / prices[s]
      const have   = positions[s]?.shares || 0
      const delta  = want - have
      if (Math.abs(delta * prices[s]) < eq * 1e-6) continue
      trade(s, delta, prices[s], date, reason)
    }
    stopped.clear()
    if (reason !== 'init') rebalances++
  }

  // Day 0: invest at first common close
  rebalanceTo(priceAt(0), dates[0], 'init')
  equitySeries.push({ date: dates[0], value: +equityAt(priceAt(0)).toFixed(2) })

  for (let i = 1; i < dates.length; i++) {
    const date = dates[i]
    const prices = priceAt(i)

    // 1. Risk exits (checked before rebalance so a stop on a rebalance day still fires)
    for (const s of [...Object.keys(positions)]) {
      const pos = positions[s]
      const chg = (prices[s] - pos.entryPrice) / pos.entryPrice * 100
      if (stopLossPct != null && chg <= -Math.abs(stopLossPct)) {
        trade(s, -pos.shares, prices[s], date, 'stop-loss'); stopped.add(s); stopsTriggered++
      } else if (takeProfitPct != null && chg >= Math.abs(takeProfitPct)) {
        trade(s, -pos.shares, prices[s], date, 'take-profit'); stopped.add(s); takesTriggered++
      }
    }

    // 2. Rebalance triggers
    const due = (rebalance === 'monthly' || rebalance === 'quarterly')
      ? isPeriodStart(rebalance, dates[i - 1], date)
      : rebalance === 'threshold'
        ? driftedBeyond(positions, prices, cash, target, thresholdPct)
        : false
    if (due) rebalanceTo(prices, date, 'rebalance')

    equitySeries.push({ date, value: +equityAt(prices).toFixed(2) })
  }

  // ── Benchmark: same weights, buy-and-hold, never touched ───────────────────
  const benchShares = {}
  for (const s of symbols) benchShares[s] = (initialCapital * target[s]) / closes[s][0]
  const benchSeries = dates.map((d, i) => {
    let v = 0
    for (const s of symbols) v += benchShares[s] * closes[s][i]
    return +v.toFixed(2)
  })

  // ── Metrics (same lib as live analytics) ───────────────────────────────────
  const eqValues = equitySeries.map(e => e.value)
  const rets     = dailyReturns(eqValues)
  const bhRets   = dailyReturns(benchSeries)
  const pct = (a, b) => +(((a - b) / b) * 100).toFixed(2)

  const metricsFor = (values, returns) => ({
    totalReturn:  pct(values[values.length - 1], values[0]),
    annualReturn: annualizedReturn(values)      != null ? +(annualizedReturn(values) * 100).toFixed(2) : null,
    sharpeRatio:  sharpeRatio(returns)          != null ? +sharpeRatio(returns).toFixed(3)  : null,
    sortinoRatio: sortinoRatio(returns)         != null ? +sortinoRatio(returns).toFixed(3) : null,
    maxDrawdown:  maxDrawdown(values)           != null ? +(maxDrawdown(values) * 100).toFixed(2) : null,
    volatility:   annualizedVolatility(returns) != null ? +(annualizedVolatility(returns) * 100).toFixed(2) : null,
    var95:        valueAtRisk(returns)          != null ? +(valueAtRisk(returns) * 100).toFixed(2)    : null,
    cvar95:       conditionalVaR(returns)       != null ? +(conditionalVaR(returns) * 100).toFixed(2) : null,
  })

  return {
    symbols,
    weights: Object.fromEntries(symbols.map(s => [s, +target[s].toFixed(4)])),
    config: { rebalance, thresholdPct: rebalance === 'threshold' ? thresholdPct : undefined, stopLossPct, takeProfitPct, commissionPct },
    days: dates.length,
    startDate: dates[0],
    endDate: dates[dates.length - 1],
    finalValue: eqValues[eqValues.length - 1],
    metrics:   metricsFor(eqValues, rets),
    benchmark: { ...metricsFor(benchSeries, bhRets), label: 'buy-and-hold (same weights, no rebalance)' },
    activity: { trades: trades.length, rebalances, stopsTriggered, takesTriggered },
    equity: equitySeries,
    benchmarkEquity: dates.map((d, i) => ({ date: d, value: benchSeries[i] })),
    trades: trades.slice(-200),   // cap payload
  }
}

module.exports = { runPortfolioBacktest, alignSeries, isPeriodStart }
