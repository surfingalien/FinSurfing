'use strict'
/**
 * lib/quant/volatility.js — volatility estimators and forecasters from daily data.
 *
 *   rollingVol    O(1) per step sliding window (add the new return, drop the old one) using
 *                 Welford's update — the naive running Σx and Σx² lose precision and can go
 *                 negative on long series; this cannot
 *   ewmaVol       RiskMetrics exponential weighting (λ 0.94) — reacts to vol clustering
 *   garch11       GARCH(1,1) by Gaussian maximum likelihood with variance targeting
 *   parkinson / garmanKlass / yangZhang   range-based estimators from OHLC bars
 *   harRv         Heterogeneous AR on daily squared returns (a HAR-style proxy: true HAR-RV needs
 *                 intraday realised variance, which this app does not have)
 * Annualisation is √252. Tests: tests/quant-volatility.test.js
 */
const { mean, variance, ols } = require('./linalg')

const ANN = 252

/** Sliding-window sample volatility. Returns an array aligned with `r`: null until k observations exist. */
function rollingVol(r, k, { annualize = true } = {}) {
  if (!(k >= 2)) throw new Error('window must be at least 2')
  const out = new Array(r.length).fill(null)
  let n = 0, m = 0, M2 = 0
  const add = x => { n++; const d = x - m; m += d / n; M2 += d * (x - m) }
  const remove = x => { const d = x - m; n--; if (n === 0) { m = 0; M2 = 0; return } m -= d / n; M2 -= d * (x - m); if (M2 < 0) M2 = 0 }
  for (let i = 0; i < r.length; i++) {
    add(r[i])
    if (i >= k) remove(r[i - k])
    if (i >= k - 1) { const sd = Math.sqrt(M2 / (k - 1)); out[i] = annualize ? sd * Math.sqrt(ANN) : sd }
  }
  return out
}

/** EWMA volatility: σ²_t = λ σ²_{t−1} + (1−λ) r²_{t−1}. Seeded with the variance of the first `seed` returns. */
function ewmaVol(r, { lambda = 0.94, seed = 20, annualize = true } = {}) {
  if (r.length < 2) return []
  const s0 = r.slice(0, Math.min(seed, r.length)); let v = s0.reduce((a, x) => a + x * x, 0) / s0.length
  const out = []
  for (let i = 0; i < r.length; i++) {
    if (i > 0) v = lambda * v + (1 - lambda) * r[i - 1] * r[i - 1]
    out.push(annualize ? Math.sqrt(v * ANN) : Math.sqrt(v))
  }
  return out
}

function garchLogLik(r, alpha, beta, uncond) {
  const omega = uncond * (1 - alpha - beta)
  let h = uncond, ll = 0
  for (let i = 0; i < r.length; i++) {
    if (i > 0) h = omega + alpha * r[i - 1] * r[i - 1] + beta * h
    if (!(h > 1e-14)) return -Infinity
    ll += -0.5 * (Math.log(2 * Math.PI) + Math.log(h) + r[i] * r[i] / h)
  }
  return ll
}

/**
 * GARCH(1,1): h_t = ω + α r²_{t−1} + β h_{t−1}, ω set by variance targeting (ω = σ²(1−α−β)),
 * so only (α, β) are searched — coarse grid then successive refinement, constrained to α+β < 1.
 * Needs ≥ 100 returns. Returns the parameters, persistence, long-run vol, today's conditional vol
 * and a `forecast(days)` of annualised vol that mean-reverts to the long run.
 */
function garch11(r, { horizon = 10 } = {}) {
  if (r.length < 100) throw new Error('GARCH needs at least 100 returns')
  const m = mean(r), x = r.map(v => v - m), uncond = variance(x, 0)
  let best = { a: 0.08, b: 0.9, ll: -Infinity }
  let step = 0.04, a0 = 0.02, a1 = 0.3, b0 = 0.5, b1 = 0.98
  for (let round = 0; round < 6; round++) {
    for (let a = a0; a <= a1 + 1e-12; a += step) for (let b = b0; b <= b1 + 1e-12; b += step) {
      if (a + b >= 0.9995) continue
      const ll = garchLogLik(x, a, b, uncond)
      if (ll > best.ll) best = { a, b, ll }
    }
    a0 = Math.max(0.001, best.a - step); a1 = best.a + step; b0 = Math.max(0.05, best.b - step); b1 = Math.min(0.999, best.b + step); step /= 3
  }
  const alpha = best.a, beta = best.b, omega = uncond * (1 - alpha - beta)
  let h = uncond
  const cond = []
  for (let i = 0; i < x.length; i++) { if (i > 0) h = omega + alpha * x[i - 1] ** 2 + beta * h; cond.push(h) }
  const hNext = omega + alpha * x[x.length - 1] ** 2 + beta * h
  const persistence = alpha + beta, longRunVar = omega / (1 - persistence)
  const volAt = v => Math.sqrt(v * ANN)
  const forecast = []
  for (let d = 1; d <= horizon; d++) forecast.push(volAt(longRunVar + persistence ** (d - 1) * (hNext - longRunVar)))
  return {
    omega, alpha, beta, persistence, logLik: best.ll,
    longRunVol: volAt(longRunVar), currentVol: volAt(h), nextDayVol: volAt(hNext),
    halfLifeDays: persistence < 1 && persistence > 0 ? Math.log(0.5) / Math.log(persistence) : null,
    forecast, conditionalVol: cond.map(volAt),
    note: persistence > 0.98 ? 'persistence close to 1: shocks to volatility fade very slowly' : undefined,
  }
}

const okBar = b => b && b.o > 0 && b.h > 0 && b.l > 0 && b.c > 0 && b.h >= b.l
/** Parkinson (1980): high–low range estimator. Daily σ² = mean( ln²(H/L) ) / (4 ln 2). */
function parkinson(bars) {
  const b = bars.filter(okBar); if (b.length < 2) return null
  const v = b.reduce((a, x) => a + Math.log(x.h / x.l) ** 2, 0) / (4 * Math.log(2) * b.length)
  return Math.sqrt(v * ANN)
}
/** Garman–Klass (1980): uses open/high/low/close, assumes no overnight gap. */
function garmanKlass(bars) {
  const b = bars.filter(okBar); if (b.length < 2) return null
  const v = b.reduce((a, x) => a + 0.5 * Math.log(x.h / x.l) ** 2 - (2 * Math.log(2) - 1) * Math.log(x.c / x.o) ** 2, 0) / b.length
  return v > 0 ? Math.sqrt(v * ANN) : null
}
/** Yang–Zhang (2000): overnight + open-to-close + Rogers–Satchell; unbiased with gaps and drift. */
function yangZhang(bars) {
  const b = bars.filter(okBar); const n = b.length - 1; if (n < 5) return null
  const on = [], oc = []; let rs = 0
  for (let i = 1; i < b.length; i++) {
    on.push(Math.log(b[i].o / b[i - 1].c)); oc.push(Math.log(b[i].c / b[i].o))
    rs += Math.log(b[i].h / b[i].c) * Math.log(b[i].h / b[i].o) + Math.log(b[i].l / b[i].c) * Math.log(b[i].l / b[i].o)
  }
  const k = 0.34 / (1.34 + (n + 1) / (n - 1))
  const v = variance(on) + k * variance(oc) + (1 - k) * (rs / n)
  return v > 0 ? Math.sqrt(v * ANN) : null
}

/**
 * HAR on daily squared returns: RV_{t+1} = c + b_d RV_t + b_w mean(RV_{t-4..t}) + b_m mean(RV_{t-21..t}).
 * Returns the fitted coefficients, in-sample R² and the next-day annualised vol forecast.
 */
function harRv(r) {
  const rv = r.map(x => x * x), X = [], y = []
  if (rv.length < 60) throw new Error('HAR needs at least 60 returns')
  for (let t = 21; t < rv.length - 1; t++) {
    X.push([rv[t], mean(rv.slice(t - 4, t + 1)), mean(rv.slice(t - 21, t + 1))]); y.push(rv[t + 1])
  }
  const f = ols(X, y), t = rv.length - 1
  const x = [1, rv[t], mean(rv.slice(t - 4, t + 1)), mean(rv.slice(t - 21, t + 1))]
  const pred = Math.max(0, x.reduce((a, v, i) => a + v * f.beta[i], 0))
  return { coef: { c: f.beta[0], daily: f.beta[1], weekly: f.beta[2], monthly: f.beta[3] }, r2: f.r2, nextDayVol: Math.sqrt(pred * ANN), n: y.length, note: 'proxy: daily squared returns, not intraday realised variance' }
}

/** Position scale that targets a volatility: min(maxLeverage, target / current). */
const volTargetScale = (currentVol, targetVol = 0.15, maxLeverage = 1) => (currentVol > 0 ? Math.min(maxLeverage, targetVol / currentVol) : 0)

/** Everything for one symbol's bars in one call. */
function volatilityReport(bars, { window = 21 } = {}) {
  const closes = bars.map(b => b.c), r = []
  for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0 && closes[i] > 0) r.push(Math.log(closes[i] / closes[i - 1]))
  if (r.length < 30) throw new Error('not enough history for a volatility report')
  const roll = rollingVol(r, Math.min(window, r.length - 1)), ew = ewmaVol(r)
  const out = {
    observations: r.length,
    close2close: Math.sqrt(variance(r) * ANN),
    rolling: { window, current: roll[roll.length - 1], series: roll.slice(-250) },
    ewma: { lambda: 0.94, current: ew[ew.length - 1], series: ew.slice(-250) },
    parkinson: parkinson(bars), garmanKlass: garmanKlass(bars), yangZhang: yangZhang(bars),
  }
  try { out.garch = garch11(r) } catch (e) { out.garchError = e.message }
  try { out.har = harRv(r) } catch (e) { out.harError = e.message }
  out.volTarget15 = volTargetScale(out.ewma.current)
  return out
}

module.exports = { rollingVol, ewmaVol, garch11, parkinson, garmanKlass, yangZhang, harRv, volTargetScale, volatilityReport }
