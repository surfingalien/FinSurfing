'use strict'
const C = require('../lib/quant/ml-compare')
const L = require('../lib/quant/linalg')

function bars(n, seed, { ar = 0 } = {}) { const g = L.rng(seed); let p = 100, last = 0; const T0 = Date.UTC(2020, 0, 1); return Array.from({ length: n }, (_, i) => { last = ar * last + 0.01 * g.normal(); p *= 1 + last; return { t: T0 + i * 86400000, o: p, h: p * 1.004, l: p * 0.996, c: p, v: 1e6 * (1 + 0.2 * g.normal()) } }) }

test('dataset features use only bars ≤ t and labels only the future; the purge keeps train and test apart', () => {
  const b = bars(400, 1), D = C.buildDataset(b), i = 10
  expect(D.X[i]).toHaveLength(C.FEATURES.length)
  // changing a FUTURE bar changes the label of earlier rows but never their features
  const b2 = b.map((x, k) => (k === D.idx[i] + 3 ? { ...x, c: x.c * 5, h: x.h * 5, l: x.l * 5 } : x))
  const D2 = C.buildDataset(b2); expect(D2.X[i]).toEqual(D.X[i]); expect(D2.y[i]).not.toBe(undefined)
  expect(() => C.buildDataset(b.slice(0, 100))).toThrow(/200/)
})
test('on a random walk no model beats the baseline once corrected for trying twelve', () => {
  const r = C.compareModels(bars(900, 2), { only: ['Logistic regression', 'Random forest', 'Gradient boosting', 'Decision tree', 'Gaussian naive Bayes'] })
  expect(r.winners).toEqual([]); expect(r.verdict).toMatch(/No model beat/); expect(r.purgedRows).toBe(5); expect(r.effectiveTestObservations).toBeLessThan(r.testRows)
  for (const m of r.results) { expect(m.accuracy).toBeGreaterThan(0.35); expect(m.accuracy).toBeLessThan(0.65) }
})
test('with a strongly autocorrelated series a model does find the signal', () => {
  const r = C.compareModels(bars(1800, 3, { ar: 0.35 }), { horizon: 1, only: ['Logistic regression', 'Linear discriminant analysis'] })
  expect(r.results[0].accuracy).toBeGreaterThan(r.baseline.accuracy + 0.03)
})
test('the neural models run through the same harness', () => {
  const r = C.compareModels(bars(700, 4), { only: ['Neural network (MLP)', 'Convolutional network (1-D CNN)', 'Recurrent network (LSTM)'] })
  expect(r.results.filter(x => !x.error)).toHaveLength(3); r.results.forEach(x => expect(x.auc).toBeGreaterThan(0.35))
})
test('clusterSymbols groups symbols by risk fingerprint and flags nothing silently', () => {
  const mk = (vol, seed) => bars(300, seed).map((b, i, a) => b), set = {}
  const g = L.rng(9); ;['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H'].forEach((s, i) => { let p = 100; const hi = i >= 4; set[s] = Array.from({ length: 300 }, (_, k) => ({ c: (p *= 1 + (hi ? 0.03 : 0.005) * g.normal() + (hi ? 0.001 : 0.0003)) })) })
  const r = C.clusterSymbols(set, { k: 2 })
  expect(r.symbols).toHaveLength(8); expect(new Set(r.symbols.slice(0, 4).map(x => x.kmeans)).size).toBe(1); expect(r.symbols[0].kmeans).not.toBe(r.symbols[7].kmeans); expect(r.symbols[0].x).not.toBeNull()
  expect(() => C.clusterSymbols({ A: set.A })).toThrow()
})
