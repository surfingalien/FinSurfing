'use strict'
/**
 * lib/param-surface.js — the optimizer's whole grid as a surface (idea from
 * vectorbt's parameter heatmaps; written from scratch).
 *
 * The optimizer ranks every setting on one history, so its top row is
 * in-sample by construction. What the top row cannot show is its
 * NEIGHBOURHOOD: a best setting surrounded by settings that also work is a
 * plateau (the rule is robust to its parameters); a best setting surrounded by
 * settings that do not is a spike (likely luck). This lays the grid out over
 * the two parameters that vary, and reads the eight neighbours of the best
 * cell: `plateau` when their median Sharpe is positive and at least half the
 * best, else `spike`. Same idea as strategy-lab.neighborhood (±20% per
 * parameter), shown as a picture. Pure.
 *
 * Tests: tests/param-surface.test.js
 */

/** results: [{params, metrics}] from utils/backtest.js:optimizeStrategy. */
function paramSurface(results, { metric = 'sharpeRatio' } = {}) {
  const rows = (results || []).filter(r => r?.params && Number.isFinite(r?.metrics?.[metric]))
  if (!rows.length) return { kind: 'none', reason: 'no results' }
  const keys = Object.keys(rows[0].params)
  const values = Object.fromEntries(keys.map(k => [k, [...new Set(rows.map(r => r.params[k]))].sort((a, b) => a - b)]))
  const varied = keys.filter(k => values[k].length > 1)
  if (varied.length !== 2) {
    return { kind: 'none', metric, varied, reason: varied.length < 2 ? 'vary two parameters to see a surface' : 'more than two parameters vary — fix all but two to see a surface' }
  }
  const [kx, ky] = varied
  const xs = values[kx], ys = values[ky]
  const cells = ys.map(() => xs.map(() => null))
  for (const r of rows) {
    const i = ys.indexOf(r.params[ky]), j = xs.indexOf(r.params[kx])
    if (i >= 0 && j >= 0) cells[i][j] = +r.metrics[metric].toFixed(3)
  }
  let best = null
  cells.forEach((row, i) => row.forEach((v, j) => { if (v != null && (!best || v > best.value)) best = { i, j, value: v } }))
  const neighbours = []
  for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
    if (!di && !dj) continue
    const v = cells[best.i + di]?.[best.j + dj]
    if (v != null) neighbours.push(v)
  }
  neighbours.sort((a, b) => a - b)
  const med = neighbours.length ? neighbours[Math.floor((neighbours.length - 1) / 2)] : null
  const shape = med == null || !(best.value > 0) ? null : med > 0 && med >= best.value / 2 ? 'plateau' : 'spike'
  return {
    kind: 'grid', metric,
    x: { key: kx, values: xs }, y: { key: ky, values: ys }, cells,
    best: { x: xs[best.j], y: ys[best.i], value: best.value },
    neighbours: neighbours.length, neighbourMedian: med, shape,
  }
}

module.exports = { paramSurface }
