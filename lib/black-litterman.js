'use strict'

/**
 * lib/black-litterman.js — how much of each Advisory pick to hold, blending a
 * neutral prior with the AI's views in proportion to how much those views have
 * EARNED (Black & Litterman 1992; PyPortfolioOpt popularised it — no code
 * taken).
 *
 * HRP (lib/hrp.js) splits the slate by risk alone and ignores the views.
 * Mean-variance on the raw views does the opposite and goes all-in on the
 * loudest one. Black-Litterman sits between:
 *   prior     π = δ Σ w₀  — the returns that would justify holding the slate
 *             in equal weight (w₀ = 1/N; market caps are not reliably
 *             available for every pick), δ = 2.5
 *   views     Q = each pick's expected value after costs (lib/expected-value.js
 *             netEdge — p·W − q·L − c), one absolute view per pick
 *   trust     Ω = diag(τ σᵢ²) · (1 − c)/c, with c from the MEASURED win rate's
 *             sample size: c = n/(n+100). No measured record ⇒ c = 0.05 and
 *             the views barely move the prior — an uncalibrated model gets no
 *             say, the same stance as kelly.sizeIfCalibrated.
 *   posterior μ = [(τΣ)⁻¹ + Ω⁻¹]⁻¹ [(τΣ)⁻¹π + Ω⁻¹Q]
 *   weights   w ∝ (δΣ)⁻¹ μ, long-only (negatives to 0), summing to 1.
 * Σ is the daily covariance scaled to the pick horizon. Pure.
 * Tests: tests/black-litterman.test.js
 */

const { covariance } = require('./hrp')

const DELTA = 2.5
const TAU = 0.05
const MIN_CONFIDENCE = 0.05
const MAX_CONFIDENCE = 0.8

/** Gauss-Jordan inverse with a small ridge so a near-singular Σ still inverts. */
function invert(m) {
  const n = m.length
  const tr = m.reduce((s, r, i) => s + r[i], 0) / n
  const a = m.map((r, i) => [...r.map((v, j) => v + (i === j ? tr * 1e-8 : 0)), ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(a[r][c]) > Math.abs(a[p][c])) p = r
    if (Math.abs(a[p][c]) < 1e-18) return null
    ;[a[c], a[p]] = [a[p], a[c]]
    const d = a[c][c]
    for (let j = 0; j < 2 * n; j++) a[c][j] /= d
    for (let r = 0; r < n; r++) {
      if (r === c) continue
      const f = a[r][c]
      if (f) for (let j = 0; j < 2 * n; j++) a[r][j] -= f * a[c][j]
    }
  }
  return a.map(r => r.slice(n))
}

const matVec = (m, v) => m.map(r => r.reduce((s, x, j) => s + x * v[j], 0))
const add = (a, b) => a.map((r, i) => r.map((x, j) => x + b[i][j]))
const scale = (m, k) => m.map(r => r.map(x => x * k))

/** View confidence from the size of the measured record behind the win rate. */
function confidenceFrom(n) {
  if (!(n > 0)) return MIN_CONFIDENCE
  return Math.min(MAX_CONFIDENCE, Math.max(MIN_CONFIDENCE, n / (n + 100)))
}

/**
 * @param {{symbols: string[], returns: number[][]}} aligned  hrp.alignReturns output
 * @param {Object<string, number>} views   symbol → expected return over the horizon (fraction)
 * @param {object} opts  { horizonDays, calibratedN, delta, tau }
 * @returns {{ weights: Object<string, number>, posterior: Object<string, number>, prior: Object<string, number>, confidence } | null}
 */
function blackLitterman(aligned, views, { horizonDays = 63, calibratedN = 0, delta = DELTA, tau = TAU } = {}) {
  const syms = aligned?.symbols || []
  if (syms.length < 2 || (aligned.returns || []).length < 30) return null
  const n = syms.length
  const S = scale(covariance(aligned.returns), horizonDays)
  if (S.some((r, i) => !(r[i] > 0))) return null
  const w0 = new Array(n).fill(1 / n)
  const pi = matVec(S, w0).map(x => x * delta)
  const c = confidenceFrom(calibratedN)
  const Q = syms.map((s, i) => (Number.isFinite(views?.[s]) ? views[s] : pi[i]))   // no view ⇒ the prior
  const tS = scale(S, tau)
  const tSinv = invert(tS)
  if (!tSinv) return null
  const omegaInv = S.map((r, i) => r.map((_, j) => (i === j ? 1 / (tau * S[i][i] * (1 - c) / c) : 0)))
  const A = invert(add(tSinv, omegaInv))
  if (!A) return null
  const b = matVec(tSinv, pi).map((x, i) => x + omegaInv[i][i] * Q[i])
  const mu = matVec(A, b)
  const Sinv = invert(scale(S, delta))
  if (!Sinv) return null
  const raw = matVec(Sinv, mu).map(x => Math.max(0, x))
  const total = raw.reduce((s, x) => s + x, 0)
  if (!(total > 0)) return null
  const pct = x => +x.toFixed(6)
  return {
    weights: Object.fromEntries(syms.map((s, i) => [s, pct(raw[i] / total)])),
    posterior: Object.fromEntries(syms.map((s, i) => [s, pct(mu[i])])),
    prior: Object.fromEntries(syms.map((s, i) => [s, pct(pi[i])])),
    confidence: +c.toFixed(3),
  }
}

module.exports = { DELTA, TAU, invert, confidenceFrom, blackLitterman }
