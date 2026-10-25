'use strict'

/**
 * lib/pbo.js — Probability of Backtest Overfitting via combinatorially
 * symmetric cross-validation (Bailey, Borwein, López de Prado & Zhu, "The
 * Probability of Backtest Overfitting", 2013/2017). Implemented from the
 * paper; the MIT-licensed R `pbo` package was a reference only.
 *
 * The deflated Sharpe (lib/overfitting.js) asks whether the WINNER's Sharpe
 * beats what the best of N lucky tries would show. PBO asks a different
 * question of the SELECTION itself: split history into S blocks; for every
 * way of choosing half of them as in-sample, pick the best candidate there and
 * see where it ranks on the other half. If the in-sample winner lands below
 * the out-of-sample median more often than not, picking the best backtest is
 * a procedure that selects luck.
 *
 *   ω  = OOS rank of the in-sample best / (N + 1)        (relative rank)
 *   λ  = log(ω / (1 − ω))
 *   PBO = share of the C(S, S/2) splits with λ ≤ 0
 * Also reported: how often the in-sample best LOST out of sample, and the
 * slope of out-of-sample vs in-sample performance of the selected candidate
 * (negative = the better it looked, the worse it did).
 *
 * `overfit` needs BOTH PBO > 0.5 AND the selected candidate losing out of
 * sample in more than half the splits. PBO alone judges the selection, not the
 * strategy: when every candidate in a batch is genuinely good and alike, the
 * in-sample best is a coin toss among them and PBO sits near 0.5 although
 * nothing is overfit. Pure.
 * Tests: tests/pbo.test.js
 */

const BLOCKS = 8          // C(8, 4) = 70 splits
const MIN_PER_BLOCK = 10
const PBO_MAX = 0.5

function* halves(n, k = n / 2, start = 0, chosen = []) {
  if (chosen.length === k) { yield chosen; return }
  for (let i = start; i <= n - (k - chosen.length); i++) yield* halves(n, k, i + 1, [...chosen, i])
}

/** Per-period Sharpe-like score of one series over the given indices (0 for no variation). */
function score(series, idx) {
  let s = 0, s2 = 0
  for (const i of idx) { s += series[i]; s2 += series[i] * series[i] }
  const n = idx.length, m = s / n, v = s2 / n - m * m
  return v > 1e-18 ? m / Math.sqrt(v) : 0
}

/** Rank of `x` among `xs` (1 = lowest), ties averaged. */
function rankOf(x, xs) {
  let below = 0, equal = 0
  for (const v of xs) { if (v < x) below++; else if (v === x) equal++ }
  return below + (equal + 1) / 2
}

/**
 * @param {number[][]} candidates  one return (or IC) series per candidate, aligned, equal length
 * @returns {{ pbo, splits, candidates, periods, blocks, lossRate, degradation } | null}
 */
function pbo(candidates, { blocks = BLOCKS, minPerBlock = MIN_PER_BLOCK } = {}) {
  const series = (candidates || []).filter(s => Array.isArray(s) && s.length)
  if (series.length < 2 || blocks < 2 || blocks % 2) return null
  const T = Math.min(...series.map(s => s.length))
  if (T < blocks * minPerBlock) return null
  const clean = series.map(s => s.slice(s.length - T).map(v => (Number.isFinite(v) ? v : 0)))
  const size = Math.floor(T / blocks)
  const blockIdx = Array.from({ length: blocks }, (_, b) => Array.from({ length: b === blocks - 1 ? T - b * size : size }, (_, j) => b * size + j))

  let below = 0, losses = 0, splits = 0
  const pairs = []
  for (const isBlocks of halves(blocks)) {
    const inSet = new Set(isBlocks)
    const isIdx = isBlocks.flatMap(b => blockIdx[b])
    const oosIdx = blockIdx.flatMap((ix, b) => (inSet.has(b) ? [] : ix))
    const isScores = clean.map(s => score(s, isIdx))
    const oosScores = clean.map(s => score(s, oosIdx))
    // The in-sample best; ties go to the lowest index, so the choice is deterministic.
    let best = 0
    for (let n = 1; n < isScores.length; n++) if (isScores[n] > isScores[best]) best = n
    const omega = rankOf(oosScores[best], oosScores) / (clean.length + 1)
    if (Math.log(omega / (1 - omega)) <= 0) below++
    if (oosScores[best] < 0) losses++
    pairs.push([isScores[best], oosScores[best]])
    splits++
  }
  // Least-squares slope of OOS on IS for the selected candidate.
  const mx = pairs.reduce((a, p) => a + p[0], 0) / pairs.length, my = pairs.reduce((a, p) => a + p[1], 0) / pairs.length
  const sxx = pairs.reduce((a, p) => a + (p[0] - mx) ** 2, 0)
  const slope = sxx > 0 ? pairs.reduce((a, p) => a + (p[0] - mx) * (p[1] - my), 0) / sxx : null
  return {
    pbo: +(below / splits).toFixed(3), splits, candidates: clean.length, periods: T, blocks,
    lossRate: +(losses / splits).toFixed(3),
    degradation: slope == null ? null : +slope.toFixed(3),
    overfit: below / splits > PBO_MAX && losses / splits > 0.5,
  }
}

module.exports = { BLOCKS, MIN_PER_BLOCK, PBO_MAX, pbo, score, rankOf, halves }
