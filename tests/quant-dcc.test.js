'use strict'
const D = require('../lib/quant/dcc')
const L = require('../lib/quant/linalg')

function simDcc(T, N, a, b, seed, rho = 0.4) {
  const g = L.rng(seed)
  const Qbar = Array.from({ length: N }, (_, i) => Array.from({ length: N }, (_, j) => (i === j ? 1 : rho)))
  let Q = Qbar.map(r => r.slice()), zprev = null
  const h = new Array(N).fill(1e-4), rows = []
  for (let t = 0; t < T; t++) {
    if (zprev) Q = Q.map((r, i) => r.map((v, j) => (1 - a - b) * Qbar[i][j] + a * zprev[i] * zprev[j] + b * v))
    const C = L.cholesky(L.corrFromCov(Q)), e = Array.from({ length: N }, () => g.normal())
    const z = C.map(r => r.reduce((s, v, k) => s + v * e[k], 0))
    const x = z.map((zi, i) => Math.sqrt(h[i]) * zi)
    rows.push(x)
    for (let i = 0; i < N; i++) h[i] = 2e-6 + 0.08 * x[i] * x[i] + 0.9 * h[i]
    zprev = z
  }
  return rows
}

describe('DCC-GARCH', () => {
  test('recovers a and b of a simulated DCC(1,1)', () => {
    for (const seed of [1, 2]) {
      const d = D.dcc(simDcc(1500, 4, 0.05, 0.9, seed))
      expect(Math.abs(d.a - 0.05)).toBeLessThan(0.025)
      expect(Math.abs(d.b - 0.9)).toBeLessThan(0.06)
      expect(d.likelihoodGain).toBeGreaterThan(10)    // moving correlations fit better than constant ones
    }
  })
  test('constant correlation: a ≈ 0 and no likelihood gain', () => {
    const g = L.rng(9)
    const rows = Array.from({ length: 1200 }, () => { const f = g.normal(); return [0, 1, 2].map(() => 0.01 * (0.6 * f + 0.8 * g.normal())) })
    const d = D.dcc(rows)
    expect(d.a).toBeLessThan(0.02)
    expect(d.likelihoodGain).toBeLessThan(3)
    expect(d.avgCorrLongRun).toBeGreaterThan(0.25)
  })
  test('correlation path never looks ahead and stays a valid correlation matrix', () => {
    const rows = simDcc(400, 3, 0.05, 0.9, 4)
    const Z = rows.map(r => r.map(x => x / 0.01)), Qbar = L.corrFromCov(L.covMatrix(Z))
    const a = D.correlationPath(0.05, 0.9, Z, Qbar).R
    const Z2 = Z.map(r => r.slice()); Z2[300] = [5, -5, 5]
    const b = D.correlationPath(0.05, 0.9, Z2, Qbar).R
    for (let t = 0; t <= 300; t++) expect(b[t]).toEqual(a[t])
    expect(b[301][0][1]).not.toBeCloseTo(a[301][0][1], 6)
    for (const R of a) { expect(R[0][0]).toBeCloseTo(1, 12); expect(Math.abs(R[0][1])).toBeLessThanOrEqual(1) }
  })
  test('portfolio: DCC and static VaR are positive, and the 21-day VaR exceeds the 1-day', () => {
    const d = D.dcc(simDcc(800, 3, 0.05, 0.9, 7), { symbols: ['A', 'B', 'C'], weights: [0.5, 0.3, 0.2] })
    expect(d.portfolio.var95_1d_dcc).toBeGreaterThan(0)
    expect(d.portfolio.var95_1d_static).toBeGreaterThan(0)
    expect(d.portfolio.var95_21d_dcc).toBeGreaterThan(d.portfolio.var95_1d_dcc)
    expect(d.rising[0].change).toBeGreaterThanOrEqual(d.falling[0].change)
    expect(d.symbols).toEqual(['A', 'B', 'C'])
  })
  test('pairsFor: all pairs up to the cap, a seeded sample beyond it', () => {
    expect(D.pairsFor(5)).toHaveLength(10)
    const big = D.pairsFor(30)
    expect(big).toHaveLength(D.MAX_PAIRS)
    expect(D.pairsFor(30)).toEqual(big)
  })
  test('input checks', () => {
    expect(() => D.dcc(Array.from({ length: 300 }, () => [0.01]))).toThrow(/two assets/)
    expect(() => D.dcc(Array.from({ length: 100 }, () => [0.01, 0.02]))).toThrow(/250/)
  })
})
