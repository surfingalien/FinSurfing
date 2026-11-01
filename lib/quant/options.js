'use strict'
/**
 * lib/quant/options.js — option pricing four ways, Greeks, implied volatility and
 * a gamma-scalping model. Pure functions, no network.
 *
 *   blackScholes   closed form, European, continuous dividend yield q
 *   binomial       Cox–Ross–Rubinstein lattice, American or European
 *   finiteDiff     Crank–Nicolson on a price grid (Rannacher start-up, tridiagonal
 *                  solve, early-exercise projection for American)
 *   lsmPut         Longstaff–Schwartz Monte Carlo (antithetic paths, quadratic basis)
 *
 * Reference point (S=K=100, r=5%, σ=20%, T=1y put): European 5.5735; American ≈ 6.09.
 * Tests: tests/quant-options.test.js
 */
const { normCdf, normPdf, thomas, ols, rng, mean, stdev } = require('./linalg')

const isCall = type => String(type).toLowerCase() === 'call'

function d1d2(S, K, r, sigma, T, q = 0) {
  const sq = sigma * Math.sqrt(T)
  const d1 = (Math.log(S / K) + (r - q + 0.5 * sigma * sigma) * T) / sq
  return { d1, d2: d1 - sq }
}

/** Black–Scholes–Merton price. T in years, sigma/r/q as decimals. */
function blackScholes({ S, K, r, sigma, T, type = 'call', q = 0 }) {
  if (T <= 0 || sigma <= 0) { const intrinsic = isCall(type) ? Math.max(S - K, 0) : Math.max(K - S, 0); return intrinsic }
  const { d1, d2 } = d1d2(S, K, r, sigma, T, q)
  const df = Math.exp(-r * T), dq = Math.exp(-q * T)
  return isCall(type) ? S * dq * normCdf(d1) - K * df * normCdf(d2) : K * df * normCdf(-d2) - S * dq * normCdf(-d1)
}

/** Analytic Greeks. vega per 1.00 of σ (also vega1pct per 1 vol point); theta per year (thetaDay per calendar day); rho per 1.00 of r. */
function greeks({ S, K, r, sigma, T, type = 'call', q = 0 }) {
  const { d1, d2 } = d1d2(S, K, r, sigma, T, q)
  const df = Math.exp(-r * T), dq = Math.exp(-q * T), pdf = normPdf(d1), call = isCall(type)
  const delta = call ? dq * normCdf(d1) : -dq * normCdf(-d1)
  const gamma = dq * pdf / (S * sigma * Math.sqrt(T))
  const vega = S * dq * pdf * Math.sqrt(T)
  const theta = call
    ? -S * dq * pdf * sigma / (2 * Math.sqrt(T)) - r * K * df * normCdf(d2) + q * S * dq * normCdf(d1)
    : -S * dq * pdf * sigma / (2 * Math.sqrt(T)) + r * K * df * normCdf(-d2) - q * S * dq * normCdf(-d1)
  const rho = call ? K * T * df * normCdf(d2) : -K * T * df * normCdf(-d2)
  return { delta, gamma, vega, vega1pct: vega / 100, theta, thetaDay: theta / 365, rho, rho1pct: rho / 100 }
}

/** Put–call parity: C − P − (S e^{−qT} − K e^{−rT}). Zero for European options with no arbitrage. */
function putCallParity({ call, put, S, K, r, T, q = 0 }) {
  const theoretical = S * Math.exp(-q * T) - K * Math.exp(-r * T)
  const deviation = call - put - theoretical
  return { theoretical, deviation, holds: Math.abs(deviation) < 0.01 * Math.max(1, S * 0.01) }
}

/** Implied volatility from a market price: bracketed Newton with bisection fallback. Returns null when no σ reproduces the price. */
function impliedVol({ price, S, K, r, T, type = 'call', q = 0, tol = 1e-8 }) {
  const call = isCall(type)
  const lower = call ? Math.max(S * Math.exp(-q * T) - K * Math.exp(-r * T), 0) : Math.max(K * Math.exp(-r * T) - S * Math.exp(-q * T), 0)
  const upper = call ? S * Math.exp(-q * T) : K * Math.exp(-r * T)
  if (!(price > lower + 1e-12) || price >= upper) return null
  let lo = 1e-6, hi = 5, sigma = 0.3
  for (let i = 0; i < 100; i++) {
    const p = blackScholes({ S, K, r, sigma, T, type, q })
    const diff = p - price
    if (Math.abs(diff) < tol) return sigma
    if (diff > 0) hi = sigma; else lo = sigma
    const v = greeks({ S, K, r, sigma, T, type, q }).vega
    const next = v > 1e-10 ? sigma - diff / v : (lo + hi) / 2
    sigma = next > lo && next < hi ? next : (lo + hi) / 2
  }
  return Math.abs(blackScholes({ S, K, r, sigma, T, type, q }) - price) < 1e-5 ? sigma : null
}

/** Cox–Ross–Rubinstein binomial tree; O(n²) time, O(n) space (one layer). */
function binomial({ S, K, r, sigma, T, type = 'put', q = 0, n = 500, american = true }) {
  const dt = T / n, u = Math.exp(sigma * Math.sqrt(dt)), d = 1 / u
  const p = (Math.exp((r - q) * dt) - d) / (u - d), disc = Math.exp(-r * dt), call = isCall(type)
  if (!(p > 0 && p < 1)) throw new Error('binomial: too few steps for these inputs (risk-neutral probability outside (0,1))')
  const pay = s => (call ? Math.max(s - K, 0) : Math.max(K - s, 0))
  const v = new Array(n + 1)
  for (let j = 0; j <= n; j++) v[j] = pay(S * Math.pow(u, 2 * j - n))
  for (let i = n - 1; i >= 0; i--) {
    for (let j = 0; j <= i; j++) {
      const cont = disc * (p * v[j + 1] + (1 - p) * v[j])
      v[j] = american ? Math.max(cont, pay(S * Math.pow(u, 2 * j - i))) : cont
    }
  }
  return v[0]
}
/** Richardson extrapolation over n and n/2 — damps the lattice's odd/even oscillation. */
function binomialRichardson(args) {
  const n = args.n || 500, a = binomial({ ...args, n }), b = binomial({ ...args, n: Math.floor(n / 2) })
  return 2 * a - b
}

/** Crank–Nicolson finite differences for the Black–Scholes PDE. M price steps, N time steps. */
function finiteDiff({ S, K, r, sigma, T, type = 'put', q = 0, M = 400, N = 400, american = true, rannacher = 4 }) {
  const call = isCall(type), Smax = 4 * Math.max(S, K), dS = Smax / M, dt = T / N
  const pay = i => (call ? Math.max(i * dS - K, 0) : Math.max(K - i * dS, 0))
  let V = Array.from({ length: M + 1 }, (_, i) => pay(i))
  // interior operator rows: (L V)_i = lo_i V_{i-1} + mid_i V_i + up_i V_{i+1}
  const lo = [], mid = [], up = []
  for (let i = 1; i < M; i++) {
    const a = 0.5 * sigma * sigma * i * i, b = 0.5 * (r - q) * i
    lo[i] = a - b; mid[i] = -2 * a - r; up[i] = a + b
  }
  for (let k = 0; k < N; k++) {
    const th = k < rannacher ? 1 : 0.5          // implicit Euler start-up, then Crank–Nicolson
    const tau = (k + 1) * dt                      // time to expiry after this step
    const rhs = new Array(M - 1)
    for (let i = 1; i < M; i++) rhs[i - 1] = V[i] + (1 - th) * dt * (lo[i] * V[i - 1] + mid[i] * V[i] + up[i] * V[i + 1])
    // boundaries at the new time level
    const bc0 = call ? 0 : (american ? K : K * Math.exp(-r * tau))
    const bcM = call ? (american ? Smax - K : Smax * Math.exp(-q * tau) - K * Math.exp(-r * tau)) : 0
    rhs[0] += th * dt * lo[1] * bc0
    rhs[M - 2] += th * dt * up[M - 1] * bcM
    const A = [], B = [], C = []
    for (let i = 1; i < M; i++) { A.push(-th * dt * lo[i]); B.push(1 - th * dt * mid[i]); C.push(-th * dt * up[i]) }
    const x = thomas(A, B, C, rhs)
    V = [bc0, ...x, bcM]
    if (american) for (let i = 0; i <= M; i++) V[i] = Math.max(V[i], pay(i))   // early-exercise projection
  }
  const pos = S / dS, i0 = Math.floor(pos), w = pos - i0
  return V[i0] * (1 - w) + (V[Math.min(i0 + 1, M)] || 0) * w
}

/**
 * Longstaff–Schwartz Monte Carlo for an American put (or call with q>0). Antithetic GBM paths,
 * regression on in-the-money paths with basis {1, S, S²}. The estimate is biased low (the fitted
 * exercise rule is not optimal); `se` is the standard error across path pairs.
 */
function lsm({ S, K, r, sigma, T, type = 'put', q = 0, paths = 20000, steps = 50, seed = 1 }) {
  const call = isCall(type), dt = T / steps, g = rng(seed), disc = Math.exp(-r * dt)
  const pay = s => (call ? Math.max(s - K, 0) : Math.max(K - s, 0))
  const drift = (r - q - 0.5 * sigma * sigma) * dt, vol = sigma * Math.sqrt(dt)
  const half = Math.floor(paths / 2), n = half * 2
  const X = Array.from({ length: n }, () => new Float64Array(steps + 1))
  for (let p = 0; p < half; p++) {
    X[p][0] = X[p + half][0] = S
    for (let t = 1; t <= steps; t++) {
      const z = g.normal()
      X[p][t] = X[p][t - 1] * Math.exp(drift + vol * z)
      X[p + half][t] = X[p + half][t - 1] * Math.exp(drift - vol * z)
    }
  }
  const cash = new Float64Array(n)                // discounted-to-t value of the continuation path
  for (let p = 0; p < n; p++) cash[p] = pay(X[p][steps])
  for (let t = steps - 1; t >= 1; t--) {
    for (let p = 0; p < n; p++) cash[p] *= disc
    const idx = []
    for (let p = 0; p < n; p++) if (pay(X[p][t]) > 0) idx.push(p)
    if (idx.length < 10) continue
    const xs = idx.map(p => X[p][t] / S)
    let coef
    try { coef = ols(xs.map(x => [x, x * x]), idx.map(p => cash[p])).beta } catch { continue }
    idx.forEach((p, k) => {
      const cont = coef[0] + coef[1] * xs[k] + coef[2] * xs[k] * xs[k], ex = pay(X[p][t])
      if (ex > cont) cash[p] = ex
    })
  }
  const pv = Array.from(cash, c => c * disc)
  const price = Math.max(mean(pv), pay(S))
  const pairs = Array.from({ length: half }, (_, i) => (pv[i] + pv[i + half]) / 2)
  return { price, se: stdev(pairs) / Math.sqrt(half), paths: n, steps }
}

/** Greeks of any pricer by central finite differences (use for American options, where no closed form exists). */
function bumpGreeks(priceFn, { S, sigma, r, T }) {
  const hS = S * 0.01, hv = 0.01, hr = 0.0001, hT = 1 / 365
  const P = o => priceFn({ S, sigma, r, T, ...o })
  const p0 = P({}), up = P({ S: S + hS }), dn = P({ S: S - hS })
  return {
    price: p0,
    delta: (up - dn) / (2 * hS),
    gamma: (up - 2 * p0 + dn) / (hS * hS),
    vega1pct: (P({ sigma: sigma + hv }) - P({ sigma: sigma - hv })) / 2,
    rho1pct: (P({ r: r + hr }) - P({ r: r - hr })) / (2 * hr) / 100,
    thetaDay: T > hT ? P({ T: T - hT }) - p0 : null,
  }
}

/** Price one option with every method that applies; the spread between them is the model error you are living with. */
function priceAll({ S, K, r, sigma, T, type = 'put', q = 0, american = true, n = 500, grid = 400, paths = 20000, seed = 1 }) {
  const out = { inputs: { S, K, r, sigma, T, type, q, american } }
  out.blackScholes = { price: blackScholes({ S, K, r, sigma, T, type, q }), note: 'European only' }
  out.binomial = { price: binomial({ S, K, r, sigma, T, type, q, n, american }), n }
  out.binomialRichardson = { price: binomialRichardson({ S, K, r, sigma, T, type, q, n, american }), n }
  out.finiteDiff = { price: finiteDiff({ S, K, r, sigma, T, type, q, M: grid, N: grid, american }), grid }
  const mc = lsm({ S, K, r, sigma, T, type, q, paths, seed }); out.monteCarloLSM = { price: mc.price, se: mc.se, paths: mc.paths, note: 'biased low; ± is 1 standard error' }
  out.greeks = american ? bumpGreeks(p => binomial({ ...p, K, type, q, n: 300, american: true }), { S, sigma, r, T }) : { price: out.blackScholes.price, ...greeks({ S, K, r, sigma, T, type, q }) }
  return out
}

/* ── Gamma scalping ─────────────────────────────────────────────────────────── */

/** θ = −½ Γ S² σ² (r = 0): the rent paid for gamma, per year; per day and as a share of spot. */
function thetaGammaIdentity({ S, gamma, sigmaImplied }) {
  const thetaYear = -0.5 * gamma * S * S * sigmaImplied * sigmaImplied
  return { thetaYear, thetaDay: thetaYear / 365, breakevenDailyMovePct: (sigmaImplied / Math.sqrt(252)) * 100 }
}
/** "Rule of 16": annualised vol / 16 ≈ the one-standard-deviation daily move in percent. */
const ruleOf16 = vol => (vol * 100) / Math.sqrt(252)

/** Daily scalp P&L ≈ ½ Γ S² [ (ΔS/S)² − σᵢ² Δt ]. */
function dailyScalpPnl({ S, gamma, move, sigmaImplied, dt = 1 / 252 }) {
  return 0.5 * gamma * S * S * (move * move - sigmaImplied * sigmaImplied * dt)
}

/**
 * Simulate owning a delta-hedged option: GBM at the REALISED vol, option marked at the IMPLIED vol,
 * re-hedged `rehedgesPerDay` times a day with a self-financing share/cash account. Returns the P&L
 * path and its split into gamma and theta (Σ ½ΓS²(ΔS/S)² and Σ θ·dt), so "realised² vs implied²"
 * is visible, not asserted. Delta-hedge P&L only approximately equals gamma + theta (higher-order
 * terms and discrete hedging error remain) — `residual` reports that gap.
 */
function simulateGammaScalp({ S = 100, K = 100, r = 0, sigmaImplied = 0.2, sigmaRealized = 0.25, days = 60, T = 90 / 365, rehedgesPerDay = 1, seed = 3, type = 'call', costBps = 0 }) {
  const g = rng(seed), steps = days * rehedgesPerDay, dt = (1 / 252) / rehedgesPerDay
  let s = S, tte = T
  let opt = blackScholes({ S: s, K, r, sigma: sigmaImplied, T: tte, type })
  let shares = -greeks({ S: s, K, r, sigma: sigmaImplied, T: tte, type }).delta
  let cash = -opt - shares * s, gammaPnl = 0, thetaPnl = 0, costs = 0
  const path = [{ day: 0, pnl: 0, spot: s }]
  for (let i = 1; i <= steps; i++) {
    const gr = greeks({ S: s, K, r, sigma: sigmaImplied, T: tte, type })
    const sNew = s * Math.exp((r - 0.5 * sigmaRealized ** 2) * dt + sigmaRealized * Math.sqrt(dt) * g.normal())
    const move = sNew / s - 1
    gammaPnl += 0.5 * gr.gamma * s * s * move * move
    thetaPnl += gr.theta * dt
    s = sNew; tte = Math.max(tte - dt, 1e-6)
    cash *= Math.exp(r * dt)
    opt = blackScholes({ S: s, K, r, sigma: sigmaImplied, T: tte, type })
    const newShares = -greeks({ S: s, K, r, sigma: sigmaImplied, T: tte, type }).delta
    const c = Math.abs(newShares - shares) * s * costBps / 1e4
    cash -= (newShares - shares) * s + c; costs += c; shares = newShares
    if (i % rehedgesPerDay === 0) path.push({ day: i / rehedgesPerDay, pnl: opt + shares * s + cash, spot: s })
  }
  const pnl = opt + shares * s + cash
  return {
    pnl, gammaPnl, thetaPnl, residual: pnl - (gammaPnl + thetaPnl), costs,
    realizedVsImpliedVar: sigmaRealized ** 2 - sigmaImplied ** 2,
    verdict: sigmaRealized > sigmaImplied ? 'realised > implied: gamma earned more than theta cost' : 'realised <= implied: theta cost more than gamma earned',
    path,
  }
}

module.exports = { blackScholes, greeks, putCallParity, impliedVol, binomial, binomialRichardson, finiteDiff, lsm, bumpGreeks, priceAll, thetaGammaIdentity, ruleOf16, dailyScalpPnl, simulateGammaScalp }
