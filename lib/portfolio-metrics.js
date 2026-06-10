'use strict'

/**
 * lib/portfolio-metrics.js
 *
 * Pure portfolio risk/performance math, extracted from routes/analytics.js
 * so it can be unit-tested and shared. Adds the metrics the analytics route
 * lacked: annualized volatility, historical VaR/CVaR, weighted portfolio
 * return series, and equity-curve reconstruction (which makes portfolio-level
 * max drawdown / annualized return computable).
 *
 * Conventions:
 *   - "returns" are simple daily returns (0.01 = +1%)
 *   - annualization uses 252 trading days
 *   - drawdown is negative (-0.23 = -23% peak-to-trough)
 *   - functions return null when there is not enough data
 */

const TRADING_DAYS     = 252
const RISK_FREE_ANNUAL = 0.045   // ~4.5% T-bill rate (kept from routes/analytics.js)

// ── Basics ────────────────────────────────────────────────────────────────────
function dailyReturns(closes) {
  const out = []
  for (let i = 1; i < closes.length; i++)
    out.push((closes[i] - closes[i - 1]) / closes[i - 1])
  return out
}

function mean(xs) { return xs.length ? xs.reduce((s, v) => s + v, 0) / xs.length : null }

function stdDev(xs) {
  if (xs.length < 2) return null
  const m = mean(xs)
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / xs.length)
}

// ── Risk-adjusted ratios (verbatim semantics from routes/analytics.js) ───────
function sharpeRatio(returns, riskFree = RISK_FREE_ANNUAL) {
  if (returns.length < 20) return null
  const sd = stdDev(returns)
  if (!sd) return null
  const annualReturn = mean(returns) * TRADING_DAYS
  const annualStdDev = sd * Math.sqrt(TRADING_DAYS)
  return (annualReturn - riskFree) / annualStdDev
}

function sortinoRatio(returns, riskFree = RISK_FREE_ANNUAL) {
  if (returns.length < 20) return null
  const downside = returns.filter(r => r < 0)
  if (downside.length === 0) return null
  const downsideVariance = downside.reduce((s, v) => s + v ** 2, 0) / returns.length
  const downsideStd = Math.sqrt(downsideVariance) * Math.sqrt(TRADING_DAYS)
  if (downsideStd === 0) return null
  return (mean(returns) * TRADING_DAYS - riskFree) / downsideStd
}

function annualizedVolatility(returns) {
  if (returns.length < 20) return null
  const sd = stdDev(returns)
  return sd == null ? null : sd * Math.sqrt(TRADING_DAYS)
}

// ── Drawdown / growth on a price or equity series ─────────────────────────────
function maxDrawdown(closes) {
  if (closes.length < 2) return null
  let peak = closes[0], maxDD = 0
  for (const c of closes) {
    if (c > peak) peak = c
    const dd = (c - peak) / peak
    if (dd < maxDD) maxDD = dd
  }
  return maxDD
}

function annualizedReturn(closes) {
  if (closes.length < 2) return null
  const totalReturn = (closes[closes.length - 1] - closes[0]) / closes[0]
  const years = closes.length / TRADING_DAYS
  return (1 + totalReturn) ** (1 / years) - 1
}

// ── Tail risk: historical VaR / CVaR ──────────────────────────────────────────
// valueAtRisk(returns, 0.95) → the daily loss exceeded only 5% of the time,
// as a negative return (e.g. -0.021 = a 95% one-day VaR of 2.1%).
function valueAtRisk(returns, confidence = 0.95) {
  if (returns.length < 20) return null
  const sorted = [...returns].sort((a, b) => a - b)
  // k-th worst observation, k = ceil((1-c)·n) — e.g. 5th worst of 100 at 95%.
  // Epsilon guards FP noise: (1-0.95)*100 is 5.000000000000004 in IEEE754.
  const idx = Math.max(0, Math.ceil((1 - confidence) * sorted.length - 1e-9) - 1)
  return sorted[Math.min(idx, sorted.length - 1)]
}

// Expected shortfall: mean of returns at or below the VaR cutoff.
function conditionalVaR(returns, confidence = 0.95) {
  if (returns.length < 20) return null
  const cutoff = valueAtRisk(returns, confidence)
  if (cutoff == null) return null
  const tail = returns.filter(r => r <= cutoff)
  return tail.length ? mean(tail) : null
}

// ── Co-movement (verbatim semantics from routes/analytics.js) ────────────────
function pearson(a, b) {
  const n = Math.min(a.length, b.length)
  if (n < 5) return null
  const ax = a.slice(-n), bx = b.slice(-n)
  const ma = mean(ax), mb = mean(bx)
  let num = 0, da2 = 0, db2 = 0
  for (let i = 0; i < n; i++) {
    const da = ax[i] - ma, db = bx[i] - mb
    num += da * db; da2 += da * da; db2 += db * db
  }
  return da2 === 0 || db2 === 0 ? 0 : num / Math.sqrt(da2 * db2)
}

function beta(stockRet, mktRet) {
  const n = Math.min(stockRet.length, mktRet.length)
  if (n < 5) return null
  const sr = stockRet.slice(-n), mr = mktRet.slice(-n)
  const ms = mean(sr), mm = mean(mr)
  let cov = 0, varM = 0
  for (let i = 0; i < n; i++) {
    cov  += (sr[i] - ms) * (mr[i] - mm)
    varM += (mr[i] - mm) ** 2
  }
  return varM === 0 ? 0 : cov / varM
}

// ── Portfolio construction ────────────────────────────────────────────────────
/**
 * Weighted daily return series for a portfolio.
 * closeSeries: array of close arrays (one per holding, ascending dates)
 * weights:     array of weights (normalized internally); null/empty → equal weight
 * Series are right-aligned to the shortest history, matching the previous
 * behaviour of routes/analytics.js.
 */
function weightedReturnSeries(closeSeries, weights = null) {
  const series = closeSeries.filter(c => Array.isArray(c) && c.length >= 2)
  if (!series.length) return []
  const n = series.length
  let w = (weights && weights.length === closeSeries.length)
    ? closeSeries.map((c, i) => (Array.isArray(c) && c.length >= 2) ? weights[i] : null).filter(x => x != null)
    : new Array(n).fill(1 / n)
  const totalW = w.reduce((s, v) => s + v, 0)
  if (totalW <= 0) w = new Array(n).fill(1 / n)
  else w = w.map(v => v / totalW)

  const aligned = Math.min(...series.map(c => c.length))
  if (aligned < 2) return []
  const out = []
  for (let i = 1; i < aligned; i++) {
    let ret = 0
    for (let k = 0; k < n; k++) {
      const closes = series[k]
      const off = closes.length - aligned
      ret += w[k] * ((closes[off + i] - closes[off + i - 1]) / closes[off + i - 1])
    }
    out.push(ret)
  }
  return out
}

// Reconstruct an equity curve from a return series (base 1.0) so price-series
// metrics (maxDrawdown, annualizedReturn) work on portfolios.
function equityFromReturns(returns, base = 1) {
  const out = [base]
  for (const r of returns) out.push(out[out.length - 1] * (1 + r))
  return out
}

module.exports = {
  TRADING_DAYS, RISK_FREE_ANNUAL,
  dailyReturns, mean, stdDev,
  sharpeRatio, sortinoRatio, annualizedVolatility,
  maxDrawdown, annualizedReturn,
  valueAtRisk, conditionalVaR,
  pearson, beta,
  weightedReturnSeries, equityFromReturns,
}
