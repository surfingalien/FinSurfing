'use strict'
/**
 * lib/quant/exotics.js — path-dependent options by Monte Carlo, with the variance reduction and bias corrections that
 * make Monte Carlo usable, plus the closed forms they are checked against.
 *
 *   asian        arithmetic-average price option; control variate = the geometric-average option, which has a closed
 *                form (Kemna–Vorst, discrete). Cuts the standard error by an order of magnitude.
 *   barrier      knock-in/out, up/down. Discrete simulation misses crossings between steps, so each step uses the
 *                Brownian-bridge crossing probability exp(−2·ln(B/S_i)·ln(B/S_{i+1})/(σ²Δt)) — prices the
 *                continuously monitored contract that the closed form (Reiner–Rubinstein) quotes.
 *   lookback     floating-strike; the discretely sampled max/min is shifted by Broadie–Glasserman–Kou's
 *                exp(±0.5826·σ·√Δt) to approximate continuous monitoring.
 * All antithetic, seeded. Validated against QuantLib's analytic engines in tools/quant-validation.
 * Tests: tests/quant-exotics.test.js
 */
const L = require('./linalg')

const N = L.normCdf

/** Closed form for a DISCRETELY sampled geometric-average price option (n fixings at T/n, 2T/n, …, T). */
function geometricAsian({ S, K, r, q = 0, sigma, T, n, type = 'call' }) {
  const dt = T / n, b = r - q
  const muG = Math.log(S) + (b - 0.5 * sigma * sigma) * dt * (n + 1) / 2
  const varG = sigma * sigma * dt * (n + 1) * (2 * n + 1) / (6 * n)
  const sG = Math.sqrt(varG), d1 = (muG - Math.log(K) + varG) / sG, d2 = d1 - sG, df = Math.exp(-r * T)
  const fwd = Math.exp(muG + 0.5 * varG)
  return type === 'call' ? df * (fwd * N(d1) - K * N(d2)) : df * (K * N(-d2) - fwd * N(-d1))
}

function asian({ S, K, r, q = 0, sigma, T, fixings = 252, type = 'call', paths = 20000, seed = 1, controlVariate = true }) {
  const n = fixings, dt = T / n, g = L.rng(seed), drift = (r - q - 0.5 * sigma * sigma) * dt, vol = sigma * Math.sqrt(dt), df = Math.exp(-r * T)
  const pay = a => (type === 'call' ? Math.max(a - K, 0) : Math.max(K - a, 0))
  const geoExact = geometricAsian({ S, K, r, q, sigma, T, n, type })
  const X = [], Y = []
  for (let p = 0; p < paths / 2; p++) {
    let s1 = S, s2 = S, a1 = 0, a2 = 0, l1 = 0, l2 = 0
    for (let i = 0; i < n; i++) { const z = g.normal(); s1 *= Math.exp(drift + vol * z); s2 *= Math.exp(drift - vol * z); a1 += s1; a2 += s2; l1 += Math.log(s1); l2 += Math.log(s2) }
    X.push((df * pay(a1 / n) + df * pay(a2 / n)) / 2); Y.push((df * pay(Math.exp(l1 / n)) + df * pay(Math.exp(l2 / n))) / 2)
  }
  const mX = L.mean(X), mY = L.mean(Y)
  let beta = 0
  if (controlVariate) { let c = 0, v = 0; for (let i = 0; i < X.length; i++) { c += (X[i] - mX) * (Y[i] - mY); v += (Y[i] - mY) ** 2 } beta = v > 0 ? c / v : 0 }
  const adj = X.map((x, i) => x - beta * (Y[i] - geoExact))
  const price = L.mean(adj), se = L.stdev(adj) / Math.sqrt(adj.length), seRaw = L.stdev(X) / Math.sqrt(X.length)
  return { price, se, plainMcPrice: mX, plainMcSe: seRaw, varianceReduction: seRaw > 0 ? (seRaw / se) ** 2 : null, geometricClosedForm: geoExact, fixings: n, paths: X.length * 2 }
}

/** Reiner–Rubinstein closed form for continuously monitored single-barrier options (rebate 0). */
function barrierAnalytic({ S, K, H, r, q = 0, sigma, T, type = 'call', barrier = 'down-and-out' }) {
  const b = r - q, mu = (b - 0.5 * sigma * sigma) / (sigma * sigma), sT = sigma * Math.sqrt(T)
  const x1 = Math.log(S / K) / sT + (1 + mu) * sT, x2 = Math.log(S / H) / sT + (1 + mu) * sT
  const y1 = Math.log(H * H / (S * K)) / sT + (1 + mu) * sT, y2 = Math.log(H / S) / sT + (1 + mu) * sT
  const phi = type === 'call' ? 1 : -1, eta = barrier.startsWith('down') ? 1 : -1, dq = Math.exp(-q * T), dr = Math.exp(-r * T)
  const A = phi * S * dq * N(phi * x1) - phi * K * dr * N(phi * x1 - phi * sT)
  const B = phi * S * dq * N(phi * x2) - phi * K * dr * N(phi * x2 - phi * sT)
  const C = phi * S * dq * Math.pow(H / S, 2 * (mu + 1)) * N(eta * y1) - phi * K * dr * Math.pow(H / S, 2 * mu) * N(eta * y1 - eta * sT)
  const D = phi * S * dq * Math.pow(H / S, 2 * (mu + 1)) * N(eta * y2) - phi * K * dr * Math.pow(H / S, 2 * mu) * N(eta * y2 - eta * sT)
  const vanilla = phi > 0 ? S * dq * N(x1) - K * dr * N(x1 - sT) : K * dr * N(-(x1 - sT)) - S * dq * N(-x1)
  let out
  if (type === 'call' && barrier === 'down-and-out') out = K > H ? A - C : B - D
  else if (type === 'call' && barrier === 'up-and-out') out = K > H ? 0 : A - B + C - D
  else if (type === 'put' && barrier === 'down-and-out') out = K > H ? A - B + C - D : 0
  else if (type === 'put' && barrier === 'up-and-out') out = K > H ? B - D : A - C
  else if (barrier.endsWith('-in')) return vanilla - barrierAnalytic({ S, K, H, r, q, sigma, T, type, barrier: barrier.replace('-in', '-out') })
  else throw new Error('barrier must be up-and-out, down-and-out, up-and-in or down-and-in')
  return Math.max(out, 0)
}

function barrier({ S, K, H, r, q = 0, sigma, T, type = 'call', barrier: kind = 'down-and-out', steps = 252, paths = 20000, seed = 1, bridge = true }) {
  const up = kind.startsWith('up'), out = kind.endsWith('-out')
  if (up ? S >= H : S <= H) throw new Error('spot is already through the barrier')
  const dt = T / steps, g = L.rng(seed), drift = (r - q - 0.5 * sigma * sigma) * dt, vol = sigma * Math.sqrt(dt), df = Math.exp(-r * T), s2dt = sigma * sigma * dt
  const pay = s => (type === 'call' ? Math.max(s - K, 0) : Math.max(K - s, 0))
  const one = sign => {
    let s = S, alive = 1
    for (let i = 0; i < steps; i++) {
      const s1 = s * Math.exp(drift + sign[i] * vol)
      if (up ? s1 >= H : s1 <= H) { alive = 0; s = s1; break }
      if (bridge) { const pc = Math.exp(-2 * Math.log(H / s) * Math.log(H / s1) / s2dt); alive *= 1 - pc }
      s = s1
    }
    const hit = 1 - alive
    return df * pay(s) * (out ? alive : hit)
  }
  // the knock-in leg needs the path's terminal value even after crossing: rerun without the break for in-options
  const oneIn = sign => { let s = S, survive = 1; for (let i = 0; i < steps; i++) { const s1 = s * Math.exp(drift + sign[i] * vol); if (up ? s1 >= H : s1 <= H) survive = 0; else if (bridge) survive *= 1 - Math.exp(-2 * Math.log(H / s) * Math.log(H / s1) / s2dt); s = s1 } return df * pay(s) * (1 - survive) }
  const vals = []
  for (let p = 0; p < paths / 2; p++) {
    const z = Array.from({ length: steps }, () => g.normal()), zn = z.map(v => -v)
    vals.push(out ? (one(z) + one(zn)) / 2 : (oneIn(z) + oneIn(zn)) / 2)
  }
  return { price: L.mean(vals), se: L.stdev(vals) / Math.sqrt(vals.length), analytic: barrierAnalytic({ S, K, H, r, q, sigma, T, type, barrier: kind }), steps, paths: vals.length * 2, bridge }
}

/** Goldman–Sosin–Gatto closed form, floating-strike lookback (continuous monitoring, current extreme = S). */
function lookbackAnalytic({ S, r, q = 0, sigma, T, type = 'call' }) {
  const b = r - q, s2 = sigma * sigma, sT = sigma * Math.sqrt(T)
  if (Math.abs(b) < 1e-12) throw new Error('lookback closed form needs r ≠ q')
  const a1 = ((b + 0.5 * s2) * T) / sT, a2 = a1 - sT, dq = Math.exp(-q * T), dr = Math.exp(-r * T)
  const k = 2 * b * Math.sqrt(T) / sigma, w = S * dr * s2 / (2 * b)
  if (type === 'call') return S * dq * N(a1) - S * dr * N(a2) + w * (N(-a1 + k) - Math.exp(b * T) * N(-a1))
  return S * dr * N(-a2) - S * dq * N(-a1) + w * (-N(a1 - k) + Math.exp(b * T) * N(a1))
}

function lookback({ S, r, q = 0, sigma, T, type = 'call', steps = 252, paths = 20000, seed = 1, bgk = true }) {
  const dt = T / steps, g = L.rng(seed), drift = (r - q - 0.5 * sigma * sigma) * dt, vol = sigma * Math.sqrt(dt), df = Math.exp(-r * T), shift = bgk ? Math.exp(0.5826 * sigma * Math.sqrt(dt)) : 1
  const vals = []
  for (let p = 0; p < paths / 2; p++) {
    let s1 = S, s2 = S, mn1 = S, mn2 = S, mx1 = S, mx2 = S
    for (let i = 0; i < steps; i++) { const z = g.normal(); s1 *= Math.exp(drift + vol * z); s2 *= Math.exp(drift - vol * z); mn1 = Math.min(mn1, s1); mn2 = Math.min(mn2, s2); mx1 = Math.max(mx1, s1); mx2 = Math.max(mx2, s2) }
    const v1 = type === 'call' ? s1 - mn1 / shift : mx1 * shift - s1, v2 = type === 'call' ? s2 - mn2 / shift : mx2 * shift - s2
    vals.push(df * (Math.max(v1, 0) + Math.max(v2, 0)) / 2)
  }
  let analytic = null; try { analytic = lookbackAnalytic({ S, r, q, sigma, T, type }) } catch { /* r = q */ }
  return { price: L.mean(vals), se: L.stdev(vals) / Math.sqrt(vals.length), analytic, steps, paths: vals.length * 2, bgk }
}

module.exports = { geometricAsian, asian, barrierAnalytic, barrier, lookbackAnalytic, lookback }
