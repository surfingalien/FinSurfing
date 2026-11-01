'use strict'
const O = require('../lib/quant/optimize')
const L = require('../lib/quant/linalg')

// the infographic's 4-asset example: vol 10/15/22/30%, mu 4/6/9/12%
const vol = [0.10, 0.15, 0.22, 0.30], mu = [0.04, 0.06, 0.09, 0.12]
const rho = 0.3
const S = vol.map((a, i) => vol.map((b, j) => (i === j ? a * a : rho * a * b)))

test('projectCapped lands on the capped simplex', () => {
  const w = O.projectCapped([0.9, 0.5, -0.2, 0.1], 0, 0.5)
  expect(L.sum(w)).toBeCloseTo(1, 9); w.forEach(x => { expect(x).toBeGreaterThanOrEqual(-1e-12); expect(x).toBeLessThanOrEqual(0.5 + 1e-12) })
  expect(() => O.projectCapped([1, 1, 1], 0, 0.2)).toThrow(/infeasible/)
})
test('min variance puts most weight on the low-vol asset and beats equal weight', () => {
  const w = O.minVariance(S)
  expect(L.sum(w)).toBeCloseTo(1, 8); expect(w[0]).toBeGreaterThan(w[3])
  expect(L.quadForm(w, S)).toBeLessThan(L.quadForm(O.equalWeight(4), S))
})
test('risk parity equalises risk contributions', () => {
  const w = O.riskParity(S), rc = O.riskContributions(w, S)
  expect(L.sum(w)).toBeCloseTo(1, 9); rc.forEach(x => expect(x).toBeCloseTo(0.25, 5))
  expect(w[0]).toBeGreaterThan(w[3])
})
test('max Sharpe beats every other fully-invested mix on the sweep and respects the cap', () => {
  const f = O.efficientFrontier(mu, S, { points: 15 })
  expect(f.maxSharpe.sharpe).toBeGreaterThanOrEqual(f.minVariance.sharpe - 1e-9)
  for (const p of f.points) expect(p.sharpe).toBeLessThanOrEqual(f.maxSharpe.sharpe + 1e-6)
  const capped = O.maxSharpe(mu, S, { cap: 0.4 }); capped.forEach(x => expect(x).toBeLessThanOrEqual(0.4 + 1e-9))
  // frontier is increasing in return as vol rises past the minimum-variance point
  expect(f.points[f.points.length - 1].ret).toBeGreaterThan(f.points[0].ret)
})
test('Ledoit–Wolf shrinks toward a scaled identity when observations are few', () => {
  const g = L.rng(5), few = Array.from({ length: 30 }, () => Array.from({ length: 12 }, () => 0.01 * g.normal()))
  const many = Array.from({ length: 3000 }, () => Array.from({ length: 12 }, () => 0.01 * g.normal()))
  const a = O.ledoitWolf(few), b = O.ledoitWolf(many)
  expect(a.shrinkage).toBeGreaterThan(b.shrinkage); expect(a.shrinkage).toBeGreaterThan(0); expect(a.shrinkage).toBeLessThanOrEqual(1)
  expect(() => L.cholesky(a.cov)).not.toThrow()           // well conditioned
})
function bars(rets, seed) { let p = 100; const T0 = Date.UTC(2024, 0, 1); return [{ t: T0, c: 100 }, ...rets.map((r, i) => ({ t: T0 + (i + 1) * 86400000, c: (p *= 1 + r) }))] }
test('compareMethods reports in- and out-of-sample for every method', () => {
  const g = L.rng(8), n = 400, f = Array.from({ length: n }, () => 0.01 * g.normal())
  const mk = (b, s, sd) => Array.from({ length: n }, (_, i) => b * f[i] + sd * g.normal() + s)
  const data = { A: bars(mk(1, 0.0003, 0.004)), B: bars(mk(1.2, 0.0004, 0.006)), C: bars(mk(0.2, 0.0002, 0.01)), D: bars(mk(0, 0.0001, 0.008)) }
  const r = O.compareMethods(data)
  expect(r.methods.map(m => m.method)).toEqual(expect.arrayContaining(['Equal weight', 'Risk parity (ERC)', 'Hierarchical risk parity', 'Max Sharpe (mean–variance)']))
  for (const m of r.methods) { expect(Object.values(m.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2); expect(m.outOfSample.vol).toBeGreaterThan(0) }
  expect(r.testObs).toBeGreaterThan(100); expect(r.note).toMatch(/out-of-sample/)
  expect(() => O.compareMethods({ A: data.A })).toThrow(/at least 2/)
})
