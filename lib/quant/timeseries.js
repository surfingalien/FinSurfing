'use strict'
/**
 * lib/quant/timeseries.js — time-series diagnostics and models from one price/return series.
 *
 *   acf / ljungBox      autocorrelation and its joint test
 *   adf                 augmented Dickey–Fuller unit-root test (lag chosen by AIC)
 *   engleGranger        two-step cointegration test (OLS hedge ratio + ADF on the residual)
 *   ouHalfLife          Ornstein–Uhlenbeck mean-reversion speed of a spread
 *   hurst               variance-scaling Hurst exponent (trending / random / mean-reverting)
 *   dominantCycles      FFT power spectrum → strongest periods
 *   arima               ARIMA(p,d,q) by Hannan–Rissanen two-step least squares, order picked by AIC
 *   kalmanRegression    time-varying hedge ratio (random-walk state) and its standardised error
 *   kalmanLocalLevel    smoothed level of a noisy series
 *   hmm2                two-state Gaussian hidden Markov model (Baum–Welch), i.e. calm/stressed regimes
 * Critical values are the asymptotic MacKinnon values; they are approximate for short samples.
 * Tests: tests/quant-timeseries.test.js
 */
const L = require('./linalg')

const diff = x => x.slice(1).map((v, i) => v - x[i])

function acf(x, maxLag = 20) {
  const m = L.mean(x), n = x.length, c0 = x.reduce((a, v) => a + (v - m) ** 2, 0)
  const out = []
  for (let k = 1; k <= Math.min(maxLag, n - 2); k++) {
    let s = 0; for (let i = k; i < n; i++) s += (x[i] - m) * (x[i - k] - m)
    out.push(c0 > 0 ? s / c0 : 0)
  }
  return out
}

/* regularised upper incomplete gamma Q(a, x) — for the chi-square survival function */
function gammaQ(a, x) {
  if (x <= 0) return 1
  const gln = lnGamma(a)
  if (x < a + 1) { let ap = a, sum = 1 / a, del = sum; for (let n = 0; n < 500; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break } return 1 - sum * Math.exp(-x + a * Math.log(x) - gln) }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d
  for (let i = 1; i < 500; i++) { const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-14) break }
  return Math.exp(-x + a * Math.log(x) - gln) * h
}
function lnGamma(z) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = z, x = z, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015
  for (const cj of c) s += cj / ++y
  return -t + Math.log(2.5066282746310005 * s / x)
}
const chi2Sf = (x, k) => gammaQ(k / 2, x / 2)

/** Ljung–Box Q over m lags; small p ⇒ the series is autocorrelated (not white noise). */
function ljungBox(x, m = 10) {
  const n = x.length, r = acf(x, m); let q = 0
  r.forEach((rk, i) => { q += rk * rk / (n - (i + 1)) })
  q *= n * (n + 2)
  return { q, lags: r.length, pValue: chi2Sf(q, r.length) }
}

const ADF_CRIT = { 0.01: -3.43, 0.05: -2.86, 0.10: -2.57 }
const EG_CRIT = { 0.01: -3.90, 0.05: -3.34, 0.10: -3.04 }

/** Augmented Dickey–Fuller (constant, no trend). Null: unit root. stat below the critical value ⇒ stationary. */
function adf(y, { maxLag = 8, crit = ADF_CRIT } = {}) {
  if (y.length < 30) throw new Error('ADF needs at least 30 observations')
  const dy = diff(y)
  let best = null
  for (let p = 0; p <= Math.min(maxLag, Math.floor(y.length / 5)); p++) {
    // use the same sample for every p: start after maxLag so AIC is comparable
    const start = Math.min(maxLag, Math.floor(y.length / 5)), X = [], z = []
    for (let t = start; t < dy.length; t++) { const row = [y[t]]; for (let i = 1; i <= p; i++) row.push(dy[t - i]); X.push(row); z.push(dy[t]) }
    let f; try { f = L.ols(X, z) } catch { continue }
    const n = z.length, k = f.beta.length, sse = f.resid.reduce((a, e) => a + e * e, 0), aic = n * Math.log(sse / n) + 2 * k
    if (!best || aic < best.aic) best = { aic, p, stat: f.tstat[1], gamma: f.beta[1] }
  }
  if (!best) throw new Error('ADF regression failed')
  // Lag chosen on a common sample (so the AIC values are comparable); the reported statistic is then re-fitted on EVERY
  // observation the chosen lag allows, as statsmodels does. Using the truncated sample moved the statistic of a random
  // walk by 0.3 — enough to flip a borderline call.
  const X = [], z = []
  for (let t = best.p; t < dy.length; t++) { const row = [y[t]]; for (let i = 1; i <= best.p; i++) row.push(dy[t - i]); X.push(row); z.push(dy[t]) }
  const fin = L.ols(X, z), stat = fin.tstat[1], gamma = fin.beta[1]
  return { stat, lags: best.p, criticalValues: crit, stationary5pct: stat < crit[0.05], stationary1pct: stat < crit[0.01], phi: 1 + gamma, observations: z.length }
}

/** Ornstein–Uhlenbeck fit of a spread: Δs_t = θ(μ − s_{t−1}) + ε. Half-life in observations (null if not mean-reverting). */
function ouHalfLife(s) {
  const f = L.ols(s.slice(0, -1).map(v => [v]), diff(s)), b = f.beta[1], a = f.beta[0]
  const phi = 1 + b, mu = b < 0 ? -a / b : L.mean(s)
  const halfLife = phi > 0 && phi < 1 ? -Math.log(2) / Math.log(phi) : null
  const sd = L.stdev(s), last = s[s.length - 1]
  return { theta: -b, mu, halfLife, sd, zScore: sd > 0 ? (last - L.mean(s)) / sd : 0, meanReverting: halfLife != null }
}

/** Engle–Granger: y = a + b·x + e, then ADF on e. cointegrated when the stat is below the EG critical value. */
function engleGranger(y, x) {
  if (y.length !== x.length || y.length < 60) throw new Error('need two aligned series of at least 60 observations')
  const f = L.ols(x.map(v => [v]), y), resid = f.resid
  const t = adf(resid, { crit: EG_CRIT })
  return { intercept: f.beta[0], hedgeRatio: f.beta[1], r2: f.r2, adfStat: t.stat, criticalValues: EG_CRIT, cointegrated5pct: t.stat < EG_CRIT[0.05], cointegrated1pct: t.stat < EG_CRIT[0.01], spread: resid, ou: ouHalfLife(resid) }
}

/** Hurst exponent from how the std of τ-step changes scales with τ: std ∝ τ^H. H<0.5 mean-reverting, 0.5 random walk, >0.5 trending. */
function hurst(x, { maxLag = 20 } = {}) {
  const lags = [], vals = []
  for (let tau = 2; tau <= Math.min(maxLag, Math.floor(x.length / 4)); tau++) {
    const d = []; for (let i = tau; i < x.length; i++) d.push(x[i] - x[i - tau])
    const sd = L.stdev(d); if (sd > 0) { lags.push(Math.log(tau)); vals.push(Math.log(sd)) }
  }
  if (lags.length < 5) throw new Error('not enough data for a Hurst estimate')
  const H = L.ols(lags.map(v => [v]), vals).beta[1]
  return { hurst: H, regime: H < 0.45 ? 'mean-reverting' : H > 0.55 ? 'trending' : 'random walk' }
}

/** Radix-2 FFT (in place on copies); input zero-padded to a power of two. Returns {re, im}. */
function fft(x) {
  let n = 1; while (n < x.length) n <<= 1
  const re = new Float64Array(n), im = new Float64Array(n); x.forEach((v, i) => { re[i] = v })
  for (let i = 1, j = 0; i < n; i++) { let bit = n >> 1; for (; j & bit; bit >>= 1) j ^= bit; j ^= bit; if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]] } }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = -2 * Math.PI / len, wr = Math.cos(ang), wi = Math.sin(ang)
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = i + k + len / 2, tr = re[b] * cr - im[b] * ci, ti = re[b] * ci + im[b] * cr
        re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti
        const nr = cr * wr - ci * wi; ci = cr * wi + ci * wr; cr = nr
      }
    }
  }
  return { re, im, n }
}
/** Strongest cycles after removing the linear trend (periods in observations; spectral peaks of noise are common — read as hints, not signals). */
function dominantCycles(x, { top = 3, minPeriod = 3 } = {}) {
  const n = x.length, t = x.map((_, i) => [i]), f = L.ols(t, x), d = f.resid
  const { re, im, n: N } = fft(d), out = []
  for (let k = 1; k < N / 2; k++) { const period = N / k; if (period >= minPeriod && period <= n / 2) out.push({ period, power: (re[k] ** 2 + im[k] ** 2) / n }) }
  out.sort((a, b) => b.power - a.power)
  const total = out.reduce((a, c) => a + c.power, 0)
  return out.slice(0, top).map(c => ({ period: +c.period.toFixed(1), shareOfPower: total > 0 ? c.power / total : 0 }))
}

/**
 * ARIMA(p,d,q) by Hannan–Rissanen: a long AR fit supplies innovation estimates, then y regresses on its own
 * lags and the lagged innovations. d is chosen by ADF (0 or 1) unless given; (p,q) by AIC over p≤3, q≤2.
 * forecast(h) returns the mean path with a 95% band from the ψ-weights.
 */
function arima(y, { p, d, q, horizon = 10, maxP = 3, maxQ = 2 } = {}) {
  if (y.length < 60) throw new Error('ARIMA needs at least 60 observations')
  const dd = d != null ? d : (adf(y).stationary5pct ? 0 : 1)
  let z = y; for (let i = 0; i < dd; i++) z = diff(z)
  const fit = (pp, qq) => {
    const m = Math.max(pp, qq, 1), longP = Math.min(Math.max(8, pp + qq + 2), Math.floor(z.length / 4))
    let e = new Array(z.length).fill(0)
    if (qq > 0) {
      const X = [], t = []; for (let i = longP; i < z.length; i++) { X.push(z.slice(i - longP, i).reverse()); t.push(z[i]) }
      const lf = L.ols(X, t); for (let i = longP; i < z.length; i++) e[i] = lf.resid[i - longP]
    }
    const start = Math.max(longP, m), X = [], t = []
    for (let i = start; i < z.length; i++) { const row = []; for (let a = 1; a <= pp; a++) row.push(z[i - a]); for (let b = 1; b <= qq; b++) row.push(e[i - b]); X.push(row); t.push(z[i]) }
    const f = L.ols(X.length && X[0].length ? X : t.map(() => [0]), t), n = t.length, sse = f.resid.reduce((a, r) => a + r * r, 0)
    return { p: pp, q: qq, c: f.beta[0], phi: f.beta.slice(1, 1 + pp), theta: f.beta.slice(1 + pp), sigma2: sse / n, aic: n * Math.log(sse / n) + 2 * (pp + qq + 1), resid: f.resid, n }
  }
  let best = null
  const pr = p != null ? [p] : [...Array(maxP + 1).keys()], qr = q != null ? [q] : [...Array(maxQ + 1).keys()]
  for (const pp of pr) for (const qq of qr) { try { const f = fit(pp, qq); if (!best || f.aic < best.aic) best = f } catch { /* skip singular */ } }
  if (!best) throw new Error('ARIMA could not be fitted')
  // forecast the differenced series, then integrate
  const zz = z.slice(), ee = new Array(z.length).fill(0)
  const lastRes = best.resid; for (let i = 0; i < lastRes.length; i++) ee[ee.length - lastRes.length + i] = lastRes[i]
  const fz = []
  for (let h = 0; h < horizon; h++) {
    let v = best.c
    for (let a = 1; a <= best.p; a++) v += best.phi[a - 1] * zz[zz.length - a]
    for (let b = 1; b <= best.q; b++) v += best.theta[b - 1] * ee[ee.length - b]
    zz.push(v); ee.push(0); fz.push(v)
  }
  const psi = [1]; for (let j = 1; j < horizon; j++) { let s = j <= best.q ? best.theta[j - 1] : 0; for (let a = 1; a <= Math.min(best.p, j); a++) s += best.phi[a - 1] * psi[j - a]; psi.push(s) }
  let level = y[y.length - 1]; const mean = [], band = []
  let cumPsi = psi.slice(); if (dd === 1) { let c = 0; cumPsi = psi.map(v => (c += v)) }
  let acc = 0
  for (let h = 0; h < horizon; h++) {
    level = dd === 1 ? level + fz[h] : fz[h]; mean.push(level)
    acc += cumPsi[h] ** 2; band.push(1.96 * Math.sqrt(best.sigma2 * acc))
  }
  return { p: best.p, d: dd, q: best.q, aic: best.aic, sigma: Math.sqrt(best.sigma2), forecast: mean.map((m, i) => ({ step: i + 1, mean: m, lo: m - band[i], hi: m + band[i] })), note: 'Hannan–Rissanen least-squares estimate (not exact maximum likelihood)' }
}

/**
 * Kalman filter for y_t = α_t + β_t x_t + ε_t with random-walk state (α, β). `delta` sets how fast the
 * state may drift (0 = fixed OLS, larger = adaptive). Returns the β path, the one-step forecast error and
 * its standardised form (a z-score of the spread that never uses future data).
 */
function kalmanRegression(y, x, { delta = 1e-4, ve = null } = {}) {
  const n = y.length; if (n !== x.length || n < 10) throw new Error('need two aligned series of at least 10 observations')
  const vw = delta / (1 - delta)
  let theta = [0, 0], P = [[0, 0], [0, 0]]
  const R0 = ve ?? Math.max(1e-6, L.variance(y) * 1e-2)
  const beta = [], alpha = [], err = [], z = []
  for (let t = 0; t < n; t++) {
    const Rm = [[P[0][0] + vw, P[0][1]], [P[1][0], P[1][1] + vw]]
    const F = [1, x[t]], yhat = theta[0] + theta[1] * x[t]
    const RF = [Rm[0][0] * F[0] + Rm[0][1] * F[1], Rm[1][0] * F[0] + Rm[1][1] * F[1]]
    const Q = F[0] * RF[0] + F[1] * RF[1] + R0, e = y[t] - yhat, K = [RF[0] / Q, RF[1] / Q]
    theta = [theta[0] + K[0] * e, theta[1] + K[1] * e]
    P = [[Rm[0][0] - K[0] * RF[0], Rm[0][1] - K[0] * RF[1]], [Rm[1][0] - K[1] * RF[0], Rm[1][1] - K[1] * RF[1]]]
    alpha.push(theta[0]); beta.push(theta[1]); err.push(e); z.push(e / Math.sqrt(Q))
  }
  return { alpha, beta, error: err, zScore: z, finalBeta: beta[n - 1] }
}

/** Local-level Kalman filter: level_t = level_{t−1} + w, y_t = level_t + v. q/r = signal-to-noise ratio. */
function kalmanLocalLevel(y, { q = null, r = null } = {}) {
  const d = diff(y), vr = L.variance(d), R = r ?? vr / 2, Q = q ?? vr / 4
  let m = y[0], P = R; const level = []
  for (const v of y) { P += Q; const K = P / (P + R); m += K * (v - m); P *= 1 - K; level.push(m) }
  return { level, gain: P / (P + R) }
}

/** Two-state Gaussian HMM fitted by Baum–Welch (scaled). State 0 is always the lower-volatility ("calm") state. */
function hmm2(r, { iters = 200 } = {}) {
  const n = r.length; if (n < 100) throw new Error('HMM needs at least 100 observations')
  const m = L.mean(r), absSorted = r.map(v => Math.abs(v - m)).sort((a, b) => a - b), cut = absSorted[Math.floor(n * 0.7)]
  const lowR = r.filter(v => Math.abs(v - m) <= cut), highR = r.filter(v => Math.abs(v - m) > cut)
  let mu = [L.mean(lowR), L.mean(highR)], sd = [Math.max(L.stdev(lowR), 1e-6), Math.max(L.stdev(highR), 1e-6)]
  let A = [[0.97, 0.03], [0.06, 0.94]], pi = [0.5, 0.5], prevLL = -Infinity
  const pdf = (x, k) => Math.exp(-0.5 * ((x - mu[k]) / sd[k]) ** 2) / (sd[k] * Math.sqrt(2 * Math.PI)) + 1e-300
  let gamma = null, ll = 0
  for (let it = 0; it < iters; it++) {
    const B = r.map(x => [pdf(x, 0), pdf(x, 1)]), alpha = [], c = []
    let a0 = [pi[0] * B[0][0], pi[1] * B[0][1]], s = a0[0] + a0[1]; c.push(s); alpha.push(a0.map(v => v / s))
    for (let t = 1; t < n; t++) { const p = alpha[t - 1], a = [0, 1].map(j => (p[0] * A[0][j] + p[1] * A[1][j]) * B[t][j]), ss = a[0] + a[1]; c.push(ss); alpha.push(a.map(v => v / ss)) }
    const beta = new Array(n); beta[n - 1] = [1, 1]
    for (let t = n - 2; t >= 0; t--) beta[t] = [0, 1].map(i => (A[i][0] * B[t + 1][0] * beta[t + 1][0] + A[i][1] * B[t + 1][1] * beta[t + 1][1]) / c[t + 1])
    gamma = alpha.map((a, t) => { const g = [a[0] * beta[t][0], a[1] * beta[t][1]], s2 = g[0] + g[1]; return [g[0] / s2, g[1] / s2] })
    const xi = [[0, 0], [0, 0]]
    for (let t = 0; t < n - 1; t++) { const v = [[0, 0], [0, 0]]; let tot = 0; for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) { v[i][j] = alpha[t][i] * A[i][j] * B[t + 1][j] * beta[t + 1][j]; tot += v[i][j] } for (let i = 0; i < 2; i++) for (let j = 0; j < 2; j++) xi[i][j] += v[i][j] / tot }
    A = [0, 1].map(i => { const s3 = xi[i][0] + xi[i][1]; return [xi[i][0] / s3, xi[i][1] / s3] })
    pi = gamma[0].slice()
    for (let k = 0; k < 2; k++) { const w = gamma.reduce((a, g) => a + g[k], 0); mu[k] = gamma.reduce((a, g, t) => a + g[k] * r[t], 0) / w; sd[k] = Math.max(1e-6, Math.sqrt(gamma.reduce((a, g, t) => a + g[k] * (r[t] - mu[k]) ** 2, 0) / w)) }
    ll = c.reduce((a, v) => a + Math.log(v), 0)
    if (Math.abs(ll - prevLL) < 1e-8) break; prevLL = ll
  }
  const order = sd[0] <= sd[1] ? [0, 1] : [1, 0]
  const P = gamma.map(g => order.map(k => g[k]))
  const Aord = [[A[order[0]][order[0]], A[order[0]][order[1]]], [A[order[1]][order[0]], A[order[1]][order[1]]]]
  const names = ['calm', 'stressed']
  return {
    states: order.map((k, i) => ({ name: names[i], mean: mu[k], dailyVol: sd[k], annualVol: sd[k] * Math.sqrt(252), expectedDurationDays: 1 / (1 - Aord[i][i]) })),
    transition: Aord, probStressed: P.map(p => p[1]), currentState: P[n - 1][1] > 0.5 ? 'stressed' : 'calm', currentProbStressed: P[n - 1][1], logLik: ll,
  }
}

module.exports = { acf, ljungBox, adf, engleGranger, ouHalfLife, hurst, fft, dominantCycles, arima, kalmanRegression, kalmanLocalLevel, hmm2, chi2Sf, ADF_CRIT, EG_CRIT }
