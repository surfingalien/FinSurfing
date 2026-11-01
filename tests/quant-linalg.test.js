'use strict'
const L = require('../lib/quant/linalg')

test('normCdf / normInv are accurate and inverse of each other', () => {
  expect(L.normCdf(0)).toBeCloseTo(0.5, 12)
  expect(L.normCdf(1.96)).toBeCloseTo(0.9750021, 6)
  expect(L.normInv(0.975)).toBeCloseTo(1.959964, 5)
  for (const p of [0.001, 0.2, 0.5, 0.9, 0.9999]) expect(L.normCdf(L.normInv(p))).toBeCloseTo(p, 7)
})
test('solve / inverse / cholesky', () => {
  const A = [[4, 2, 0.6], [2, 5, 1], [0.6, 1, 3]]
  const x = L.solve(A, [1, 2, 3])
  expect(L.matVec(A, x).map(v => +v.toFixed(9))).toEqual([1, 2, 3])
  const I = L.matMul(A, L.inverse(A)); expect(I[0][0]).toBeCloseTo(1, 9); expect(I[0][1]).toBeCloseTo(0, 9)
  const Ch = L.cholesky(A), back = L.matMul(Ch, L.transpose(Ch))
  expect(back[1][2]).toBeCloseTo(1, 9)
  expect(() => L.cholesky([[1, 2], [2, 1]])).toThrow(/positive definite/)
  expect(() => L.solve([[1, 2], [2, 4]], [1, 2])).toThrow(/singular/)
})
test('jacobiEigen recovers eigenpairs', () => {
  const A = [[2, 1, 0], [1, 2, 1], [0, 1, 2]]
  const { values, vectors } = L.jacobiEigen(A)
  expect(values[0]).toBeCloseTo(2 + Math.SQRT2, 8); expect(values[2]).toBeCloseTo(2 - Math.SQRT2, 8)
  const Av = L.matVec(A, vectors[0]); Av.forEach((v, i) => expect(v).toBeCloseTo(values[0] * vectors[0][i], 8))
})
test('ols recovers a planted line and reports t-stats', () => {
  const g = L.rng(7), X = [], y = []
  for (let i = 0; i < 300; i++) { const x = g.normal(); X.push([x]); y.push(1.5 + 2 * x + 0.1 * g.normal()) }
  const f = L.ols(X, y)
  expect(f.beta[0]).toBeCloseTo(1.5, 1); expect(f.beta[1]).toBeCloseTo(2, 1); expect(f.r2).toBeGreaterThan(0.99); expect(f.tstat[1]).toBeGreaterThan(50)
})
test('thomas solves a tridiagonal system', () => {
  const x = L.thomas([0, 1, 1], [2, 2, 2], [1, 1, 0], [4, 8, 8])
  const check = [2 * x[0] + x[1], x[0] + 2 * x[1] + x[2], x[1] + 2 * x[2]]
  check.forEach((v, i) => expect(v).toBeCloseTo([4, 8, 8][i], 9))
})
test('rng is deterministic and roughly standard normal', () => {
  const a = L.rng(5), b = L.rng(5); expect(a.normal()).toBe(b.normal())
  const g = L.rng(11), xs = Array.from({ length: 20000 }, () => g.normal())
  expect(L.mean(xs)).toBeCloseTo(0, 1); expect(L.stdev(xs)).toBeCloseTo(1, 1)
})
