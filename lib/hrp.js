'use strict'

/**
 * lib/hrp.js — Hierarchical Risk Parity: how to split a slate of picks so that
 * correlated ones share one risk budget instead of each taking a full one.
 *
 * Advisory sizes every pick on its own (Kelly + caps). Five semiconductor
 * picks therefore get five full sizes, and the "diversified" slate is one bet
 * five times over. HRP (López de Prado, 2016) fixes that without inverting a
 * covariance matrix — which is unstable for 20 names on months of data:
 *   1. distance  d_ij = √((1 − ρ_ij) / 2) from the return correlations
 *   2. single-linkage clustering of the picks on that distance
 *   3. quasi-diagonalise: order the picks so correlated ones sit together
 *   4. recursive bisection: split the ordered list in two, give each half
 *      weight in inverse proportion to its (inverse-variance) cluster variance
 * Correlated names end up splitting a branch between them; an uncorrelated
 * name keeps its own.
 *
 * Implemented from the published algorithm (skfolio/riskfolio are reference
 * implementations; no code taken). Pure. Tests: tests/hrp.test.js
 */

const MIN_OBS = 60

/** Align daily bars by date → { symbols, returns[T][N] } over dates every series has. Pure. */
function alignReturns(barsBySymbol) {
  const entries = Object.entries(barsBySymbol || {}).filter(([, b]) => Array.isArray(b) && b.length > 2)
  if (!entries.length) return { symbols: [], returns: [] }
  const day = t => new Date(t).toISOString().slice(0, 10)
  const maps = entries.map(([s, bars]) => [s, new Map(bars.filter(b => b.c > 0).map(b => [day(b.t), b.c]))])
  const common = [...maps[0][1].keys()].filter(d => maps.every(([, m]) => m.has(d))).sort()
  const returns = []
  for (let i = 1; i < common.length; i++) {
    returns.push(maps.map(([, m]) => m.get(common[i]) / m.get(common[i - 1]) - 1))
  }
  return { symbols: maps.map(([s]) => s), returns }
}

function covariance(returns) {
  const T = returns.length, N = returns[0]?.length || 0
  const mean = Array.from({ length: N }, (_, j) => returns.reduce((s, r) => s + r[j], 0) / T)
  const cov = Array.from({ length: N }, () => new Array(N).fill(0))
  for (const r of returns) for (let i = 0; i < N; i++) for (let j = i; j < N; j++) cov[i][j] += (r[i] - mean[i]) * (r[j] - mean[j])
  for (let i = 0; i < N; i++) for (let j = i; j < N; j++) { cov[i][j] /= (T - 1); cov[j][i] = cov[i][j] }
  return cov
}

/** Single-linkage clustering → leaf order of the dendrogram (quasi-diagonal order). */
function seriation(dist) {
  let clusters = dist.map((_, i) => ({ members: [i], order: [i] }))
  while (clusters.length > 1) {
    let best = null
    for (let a = 0; a < clusters.length; a++) {
      for (let b = a + 1; b < clusters.length; b++) {
        let d = Infinity
        for (const i of clusters[a].members) for (const j of clusters[b].members) d = Math.min(d, dist[i][j])
        if (!best || d < best.d) best = { a, b, d }
      }
    }
    const A = clusters[best.a], B = clusters[best.b]
    const merged = { members: [...A.members, ...B.members], order: [...A.order, ...B.order] }
    clusters = clusters.filter((_, k) => k !== best.a && k !== best.b).concat([merged])
  }
  return clusters[0].order
}

function clusterVariance(cov, idx) {
  const ivp = idx.map(i => 1 / cov[i][i])
  const s = ivp.reduce((a, v) => a + v, 0)
  const w = ivp.map(v => v / s)
  let v = 0
  for (let a = 0; a < idx.length; a++) for (let b = 0; b < idx.length; b++) v += w[a] * w[b] * cov[idx[a]][idx[b]]
  return v
}

/**
 * HRP weights for aligned returns. Returns { weights: {sym: fraction}, order, n }
 * or null when there is too little history or fewer than two names. Pure.
 */
function hrpWeights({ symbols, returns }, { minObs = MIN_OBS } = {}) {
  if (!symbols?.length || symbols.length < 2 || returns.length < minObs) return null
  const cov = covariance(returns)
  if (cov.some((row, i) => !(row[i] > 0))) return null   // a flat series has no risk to balance
  const sd = cov.map((row, i) => Math.sqrt(row[i]))
  const dist = cov.map((row, i) => row.map((c, j) => Math.sqrt(Math.max(0, (1 - c / (sd[i] * sd[j])) / 2))))
  const order = seriation(dist)
  const w = new Array(symbols.length).fill(1)
  const stack = [order]
  while (stack.length) {
    const items = stack.pop()
    if (items.length < 2) continue
    const left = items.slice(0, Math.floor(items.length / 2)), right = items.slice(Math.floor(items.length / 2))
    const vl = clusterVariance(cov, left), vr = clusterVariance(cov, right)
    const alpha = 1 - vl / (vl + vr)
    for (const i of left) w[i] *= alpha
    for (const i of right) w[i] *= 1 - alpha
    stack.push(left, right)
  }
  return { weights: Object.fromEntries(symbols.map((s, i) => [s, w[i]])), order: order.map(i => symbols[i]), n: returns.length }
}

module.exports = { MIN_OBS, alignReturns, covariance, seriation, hrpWeights }
