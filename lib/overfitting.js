'use strict'

/**
 * lib/overfitting.js — the Deflated Sharpe Ratio: is the best of N backtests
 * better than the best of N coin flips?
 *
 * The nightly evolution cycle asks the model for several strategies per
 * symbol, backtests all of them and keeps the winners. Even with the
 * two-window out-of-sample check, "best of N" partly selects for luck: the
 * more configurations are tried, the higher the best Sharpe climbs on noise
 * alone. Bailey & López de Prado (2014) quantify exactly that:
 *
 *   1. Probabilistic Sharpe Ratio — P(true SR > SR*) given the observed
 *      per-period SR, the sample length, and the return distribution's skew
 *      and kurtosis (fat tails make a high SR less convincing):
 *        PSR(SR*) = Φ( (SR − SR*)·√(T−1) / √(1 − γ₃·SR + (γ₄−1)/4·SR²) )
 *   2. Expected maximum Sharpe of N trials that have NO skill, given the
 *      dispersion of the Sharpes actually observed across the trials:
 *        SR*₀ = √V[SRₙ] · ((1−γ)·Φ⁻¹(1 − 1/N) + γ·Φ⁻¹(1 − 1/(N·e)))
 *   3. Deflated Sharpe = PSR(SR*₀): the probability the winner beats what
 *      luck alone would have produced from that many tries.
 *
 * DSR < 0.5 means the winner's Sharpe is below the luck benchmark for the
 * number of strategies tried — indistinguishable from noise, so it is not
 * admitted. (The textbook bar is 0.95; on two years of daily bars even a
 * genuine annual Sharpe of 1.0 scores ~0.9 with a single trial, so 0.95 would
 * admit almost nothing, and forward-only re-validation already does the
 * longer-run work. 0.5 rejects what is plainly luck.)
 *
 * Scope: trials are counted per batch (one symbol's proposals in one cycle).
 * Selection across nightly cycles is handled by forward-only re-validation,
 * which scores only bars no selection step ever saw.
 *
 * All Sharpes here are PER PERIOD (daily), not annualised. Implemented from
 * the published formulas — no third-party code (pypbo is AGPL).
 * Pure. Tests: tests/overfitting.test.js
 */

const { normCdf } = require('./calibration-stats')

const EULER_GAMMA = 0.5772156649015329
const DSR_MIN = 0.5

/** Inverse standard normal CDF (Acklam's rational approximation, |ε| < 1.2e-9). */
function normInv(p) {
  if (!(p > 0 && p < 1)) return p <= 0 ? -Infinity : Infinity
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const lo = 0.02425, hi = 1 - lo
  let q, r
  if (p < lo) {
    q = Math.sqrt(-2 * Math.log(p))
    return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  if (p > hi) {
    q = Math.sqrt(-2 * Math.log(1 - p))
    return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1)
  }
  q = p - 0.5
  r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/**
 * Per-period Sharpe, skew and (non-excess) kurtosis of a return series.
 * null when there are too few observations or no variation.
 */
function returnStats(returns) {
  const x = (returns || []).filter(Number.isFinite)
  const n = x.length
  if (n < 20) return null
  const mean = x.reduce((s, v) => s + v, 0) / n
  const m2 = x.reduce((s, v) => s + (v - mean) ** 2, 0) / n
  if (!(m2 > 0)) return null
  const sd = Math.sqrt(m2)
  const m3 = x.reduce((s, v) => s + (v - mean) ** 3, 0) / n
  const m4 = x.reduce((s, v) => s + (v - mean) ** 4, 0) / n
  return { n, sr: mean / sd, skew: m3 / sd ** 3, kurt: m4 / m2 ** 2 }
}

/** P(true per-period SR > benchmark) — Bailey & López de Prado (2012). */
function probabilisticSharpe({ sr, n, skew = 0, kurt = 3 }, benchmark = 0) {
  if (![sr, n].every(Number.isFinite) || n < 2) return null
  const denom = 1 - skew * sr + ((kurt - 1) / 4) * sr * sr
  if (!(denom > 0)) return null
  return normCdf(((sr - benchmark) * Math.sqrt(n - 1)) / Math.sqrt(denom))
}

/** Expected max per-period SR of `nTrials` skill-less trials with SR variance `variance`. */
function expectedMaxSharpe(nTrials, variance) {
  if (!(nTrials > 1) || !(variance > 0)) return 0
  return Math.sqrt(variance) * ((1 - EULER_GAMMA) * normInv(1 - 1 / nTrials) + EULER_GAMMA * normInv(1 - 1 / (nTrials * Math.E)))
}

const variance = xs => {
  const m = xs.reduce((s, v) => s + v, 0) / xs.length
  return xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1)
}

/**
 * Deflated Sharpe for one candidate, given the per-period Sharpes of EVERY
 * trial in its batch (rejected ones included — they are the point).
 */
function deflatedSharpe(stats, trialSharpes) {
  if (!stats) return null
  const trials = (trialSharpes || []).filter(Number.isFinite)
  const nTrials = Math.max(1, trials.length)
  const srStar = trials.length > 1 ? expectedMaxSharpe(trials.length, variance(trials)) : 0
  const dsr = probabilisticSharpe(stats, srStar)
  if (dsr == null) return null
  return { dsr: +dsr.toFixed(3), sr: +stats.sr.toFixed(4), srStar: +srStar.toFixed(4), nTrials, n: stats.n, pass: dsr >= DSR_MIN }
}

/**
 * Attach `deflated` to every evaluated item of one batch, from the batch's own
 * trial Sharpes. Items carry `returnStats` (lib/strategy-lab.js). Returns a new array.
 */
function attachDeflated(items) {
  // Every item is a trial. One that never traded (flat equity, no stats) or
  // failed to evaluate still counts — as a Sharpe of 0 — so it cannot shrink N.
  const trialSharpes = (items || []).map(i => (Number.isFinite(i?.returnStats?.sr) ? i.returnStats.sr : 0))
  return (items || []).map(i => ({ ...i, deflated: deflatedSharpe(i?.returnStats, trialSharpes) }))
}

module.exports = { DSR_MIN, normInv, returnStats, probabilisticSharpe, expectedMaxSharpe, deflatedSharpe, attachDeflated }
