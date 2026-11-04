'use strict'
/**
 * lib/cpcv.js — Combinatorial Purged Cross-Validation (López de Prado,
 * "Advances in Financial Machine Learning", ch. 12; the idea reached us via
 * QuantJourney Backtester, Apache-2.0, walkforward/folds/cpcv.py — written
 * fresh here from the published method).
 *
 * The question it answers is not "did the strategy we picked do well?" but
 * "does the PROCEDURE that picked it — best of these candidates on the data we
 * had — hold up out of sample, across many alternative histories?"
 *
 *   1. Cut the history into N contiguous groups.
 *   2. For every way of holding out k of them (C(N,k) splits), choose the best
 *      candidate by Sharpe on the remaining groups only, with `purge` bars
 *      dropped from training just before each held-out block (trades opened
 *      there run into the test) and `embargo` bars dropped just after it
 *      (serial correlation leaks the test into the next training bars).
 *   3. Each group is held out in C(N−1,k−1) splits; stitching the chosen
 *      candidate's held-out returns group by group gives that many complete
 *      out-of-sample PATHS, each the length of the history.
 *
 * The result is a DISTRIBUTION of out-of-sample Sharpe ratios rather than one
 * number from one split. A selection procedure whose median path Sharpe is ≤ 0
 * does not generalise, however good the chosen strategy looked in full.
 *
 * Pure. Input is per-bar returns, one array per candidate (equal length) — the
 * same `returns` lib/strategy-lab.js:evaluateSignals already produces for PBO.
 * Tests: tests/cpcv.test.js
 */

const ANN = 252

function combinations(n, k) {
  const out = [], cur = []
  const rec = start => {
    if (cur.length === k) { out.push(cur.slice()); return }
    for (let i = start; i < n; i++) { cur.push(i); rec(i + 1); cur.pop() }
  }
  rec(0)
  return out
}

function sharpe(r) {
  const n = r.length
  if (n < 2) return 0
  const m = r.reduce((a, v) => a + v, 0) / n
  const sd = Math.sqrt(r.reduce((a, v) => a + (v - m) ** 2, 0) / (n - 1))
  return sd > 0 ? (m / sd) * Math.sqrt(ANN) : 0
}

const quantile = (sorted, q) => sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))))] : null

/**
 * Training bars for one split: every bar outside the held-out groups, minus `purge` bars just before
 * each held-out block and `embargo` bars just after it. Pure.
 */
function trainIndices(T, bounds, test, { purge = 5, embargo = 5 } = {}) {
  const inTest = new Uint8Array(T), drop = new Uint8Array(T)
  for (const g of test) {
    const [a, b] = bounds[g]
    for (let t = a; t < b; t++) inTest[t] = 1
    for (let t = Math.max(0, a - purge); t < a; t++) drop[t] = 1          // purge before the block
    for (let t = b; t < Math.min(T, b + embargo); t++) drop[t] = 1       // embargo after it
  }
  const out = []
  for (let t = 0; t < T; t++) if (!inTest[t] && !drop[t]) out.push(t)
  return out
}

/**
 * @param {number[][]} candidates  per-bar returns, one array per candidate, all the same length
 * @returns {object|null} null when the history is too short to cut into groups
 */
function cpcv(candidates, { nGroups = 6, kTest = 2, purge = 5, embargo = 5, minGroupBars = 20 } = {}) {
  const K = candidates.length
  if (!K) return null
  const T = candidates[0].length
  if (candidates.some(c => c.length !== T)) throw new Error('every candidate needs the same number of bars')
  if (!(kTest >= 1 && kTest < nGroups)) throw new Error('kTest must be between 1 and nGroups − 1')
  if (T < nGroups * minGroupBars) return null

  // Contiguous groups [start, end).
  const bounds = []
  for (let g = 0; g < nGroups; g++) bounds.push([Math.floor((g * T) / nGroups), Math.floor(((g + 1) * T) / nGroups)])

  const splits = combinations(nGroups, kTest)
  const nPaths = combinations(nGroups - 1, kTest - 1).length
  // pieces[g] = the chosen candidate's returns on group g, one entry per split that held g out (in split order)
  const pieces = Array.from({ length: nGroups }, () => [])
  const chosen = []

  for (const test of splits) {
    const trainIdx = trainIndices(T, bounds, test, { purge, embargo })
    let best = 0, bestS = -Infinity
    for (let c = 0; c < K; c++) {
      const s = sharpe(trainIdx.map(t => candidates[c][t]))
      if (s > bestS) { bestS = s; best = c }
    }
    chosen.push(best)
    for (const g of test) { const [a, b] = bounds[g]; pieces[g].push(candidates[best].slice(a, b)) }
  }

  const paths = []
  for (let p = 0; p < nPaths; p++) {
    const r = []
    for (let g = 0; g < nGroups; g++) r.push(...pieces[g][p])
    paths.push(sharpe(r))
  }
  const sorted = paths.slice().sort((a, b) => a - b)
  const counts = {}
  for (const c of chosen) counts[c] = (counts[c] || 0) + 1
  const mode = Math.max(...Object.values(counts))
  const median = quantile(sorted, 0.5)
  const mean = paths.reduce((a, v) => a + v, 0) / paths.length
  const sd = paths.length > 1 ? Math.sqrt(paths.reduce((a, v) => a + (v - mean) ** 2, 0) / (paths.length - 1)) : 0
  return {
    method: 'CPCV',
    nGroups, kTest, purge, embargo, candidates: K, splits: splits.length, nPaths,
    pathSharpes: paths.map(v => +v.toFixed(3)),
    medianSharpe: +median.toFixed(3),
    meanSharpe: +mean.toFixed(3),
    sdSharpe: +sd.toFixed(3),
    p10Sharpe: +quantile(sorted, 0.1).toFixed(3),
    p90Sharpe: +quantile(sorted, 0.9).toFixed(3),
    shareNegative: +(paths.filter(v => v <= 0).length / paths.length).toFixed(3),
    // How often the same candidate won its training split: low means the "best" changes with the data used.
    selectionStability: +(mode / chosen.length).toFixed(3),
    generalises: median > 0,
  }
}

module.exports = { cpcv, trainIndices, combinations, sharpe }
