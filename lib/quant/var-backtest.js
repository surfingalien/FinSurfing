'use strict'
/**
 * lib/quant/var-backtest.js — Value at Risk that is CHECKED. Five ways to forecast tomorrow's VaR from a trailing
 * window, each rolled forward through history and scored on the days that followed:
 *
 *   historical          empirical quantile of the last `window` returns
 *   parametric          normal, mean and stdev of the window
 *   Cornish–Fisher      normal quantile corrected for the window's skew and excess kurtosis
 *   EWMA                normal with RiskMetrics λ = 0.94 volatility (reacts to clustering)
 *   filtered HS         returns standardised by EWMA vol, empirical quantile of those, rescaled by today's vol
 *                       (Barone-Adesi, Giannopoulos & Vosper) — fat tails AND clustering
 *
 * Scored with Kupiec's proportion-of-failures test (are there as many breaches as the level promises?) and
 * Christoffersen's independence test (do breaches cluster?), combined into conditional coverage. A VaR model that
 * fails these is a number, not a risk measure. Tests: tests/quant-var-backtest.test.js
 */
const L = require('./linalg')

const chi2Sf1 = x => 2 * (1 - L.normCdf(Math.sqrt(Math.max(0, x))))      // χ²(1) survival
const chi2Sf2 = x => Math.exp(-Math.max(0, x) / 2)                         // χ²(2) survival
const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b), h = (s.length - 1) * p, lo = Math.floor(h); return s[lo] + (s[Math.min(lo + 1, s.length - 1)] - s[lo]) * (h - lo) }
const xlogy = (x, y) => (x === 0 ? 0 : x * Math.log(y))

/** Kupiec POF: x breaches in n days at expected rate p. */
function kupiec(x, n, p) {
  const ph = x / n
  const lr = -2 * (xlogy(n - x, 1 - p) + xlogy(x, p) - xlogy(n - x, 1 - ph) - xlogy(x, ph))
  return { breaches: x, expected: n * p, rate: ph, lr, pValue: chi2Sf1(lr) }
}
/** Christoffersen independence on the 0/1 breach sequence. */
function christoffersen(hits) {
  let n00 = 0, n01 = 0, n10 = 0, n11 = 0
  for (let i = 1; i < hits.length; i++) { const a = hits[i - 1], b = hits[i]; if (!a && !b) n00++; else if (!a && b) n01++; else if (a && !b) n10++; else n11++ }
  const p01 = n01 / Math.max(1, n00 + n01), p11 = n11 / Math.max(1, n10 + n11), p = (n01 + n11) / Math.max(1, n00 + n01 + n10 + n11)
  const l0 = xlogy(n00 + n10, 1 - p) + xlogy(n01 + n11, p), l1 = xlogy(n00, 1 - p01) + xlogy(n01, p01) + xlogy(n10, 1 - p11) + xlogy(n11, p11)
  const lr = -2 * (l0 - l1)
  return { lr, pValue: chi2Sf1(lr), breachAfterBreach: p11, breachAfterQuiet: p01 }
}

function forecasters(level) {
  const a = 1 - level, z = L.normInv(a)
  return {
    historical: w => -q(w, a),
    parametric: w => -(L.mean(w) + L.stdev(w) * z),
    'Cornish–Fisher': w => {
      const m = L.mean(w), s = L.stdev(w), n = w.length
      const sk = w.reduce((acc, x) => acc + ((x - m) / s) ** 3, 0) / n, ku = w.reduce((acc, x) => acc + ((x - m) / s) ** 4, 0) / n - 3
      const zc = z + (z * z - 1) * sk / 6 + (z ** 3 - 3 * z) * ku / 24 - (2 * z ** 3 - 5 * z) * sk * sk / 36
      return -(m + s * zc)
    },
    EWMA: (w, ctx) => -(ctx.sigma * z),
    'Filtered HS': (w, ctx) => -(q(ctx.std, a) * ctx.sigma),
  }
}

/** Roll every method through `returns` (daily, decimal). Returns per-method breach statistics and tests. */
function backtestVar(returns, { level = 0.99, window = 250, lambda = 0.94 } = {}) {
  if (!(level > 0.5 && level < 1)) throw new Error('level must be between 0.5 and 1 (e.g. 0.99)')
  if (returns.length < window + 250) throw new Error(`need at least ${window + 250} returns (window + one year of tests)`)
  const F = forecasters(level), names = Object.keys(F), hits = Object.fromEntries(names.map(k => [k, []])), avg = Object.fromEntries(names.map(k => [k, 0]))
  // EWMA variance path (σ²_t uses returns < t) and standardised residuals for filtered HS
  const s2 = new Array(returns.length); s2[0] = L.variance(returns.slice(0, Math.min(window, returns.length)))
  for (let t = 1; t < returns.length; t++) s2[t] = lambda * s2[t - 1] + (1 - lambda) * returns[t - 1] ** 2
  const z = returns.map((r, t) => r / Math.sqrt(s2[t]))
  const series = []
  for (let t = window; t < returns.length; t++) {
    const w = returns.slice(t - window, t), ctx = { sigma: Math.sqrt(s2[t]), std: z.slice(t - window, t) }
    const row = { t, ret: returns[t] }
    for (const k of names) { const v = F[k](w, ctx); hits[k].push(returns[t] < -v ? 1 : 0); avg[k] += v; row[k] = v }
    if ((t - window) % 5 === 0) series.push(row)
  }
  const n = returns.length - window, p = 1 - level
  const methods = names.map(k => {
    const x = hits[k].reduce((a, b) => a + b, 0), kp = kupiec(x, n, p), ch = christoffersen(hits[k]), cc = kp.lr + ch.lr
    const pass = kp.pValue >= 0.05 && ch.pValue >= 0.05
    return { method: k, averageVar: avg[k] / n, ...kp, kupiecP: kp.pValue, independenceP: ch.pValue, conditionalCoverageP: chi2Sf2(cc), breachAfterBreach: ch.breachAfterBreach, verdict: pass ? 'passes' : kp.pValue < 0.05 ? (x > n * p ? 'too many breaches (underestimates risk)' : 'too few breaches (overstates risk)') : 'breaches cluster' }
  })
  return { level, window, days: n, expectedBreaches: n * p, methods, series, note: 'A model passes when its breach count matches the level (Kupiec) and breaches do not bunch together (Christoffersen). Overlapping windows make neighbouring forecasts similar; the tests assume nothing more.' }
}

module.exports = { kupiec, christoffersen, backtestVar }
