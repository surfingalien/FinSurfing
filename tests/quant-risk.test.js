'use strict'
const R = require('../lib/quant/risk')
const L = require('../lib/quant/linalg')

function series(n, seed) { const g = L.rng(seed); return Array.from({ length: n }, () => 0.01 * g.normal()) }

test('CAPM recovers a planted beta and alpha; information ratio and Treynor are defined', () => {
  const g = L.rng(2), b = series(750, 1), p = b.map(x => 0.0002 + 1.3 * x + 0.002 * g.normal())
  const c = R.capm(p, b)
  expect(c.beta).toBeCloseTo(1.3, 1); expect(c.jensenAlpha).toBeGreaterThan(0.02); expect(c.r2).toBeGreaterThan(0.9)
  expect(c.treynor).not.toBeNull(); expect(c.informationRatio).not.toBeNull(); expect(c.upCapture).toBeGreaterThan(1)
  expect(() => R.capm(p.slice(0, 10), b.slice(0, 10))).toThrow()
})
test('stress test scales shocks by beta, honours overrides and flags assumed betas', () => {
  const s = R.stressTest([{ symbol: 'NVDA', value: 60000, beta: 2 }, { symbol: 'KO', value: 40000, beta: 0.5 }, { symbol: 'X', value: 0.01 }], { history: series(300, 3) })
  const m20 = s.scenarios.find(x => x.id === 'mkt-20')
  expect(m20.pnl).toBeCloseTo(60000 * -0.4 + 40000 * -0.1 + 0.01 * -0.2, 2)
  expect(s.assumedBeta1).toEqual(['X']); expect(m20.worstPosition.symbol).toBe('NVDA')
  expect(s.worstWindows).toHaveLength(3); expect(s.worstWindows[2].worstReturn).toBeLessThan(s.worstWindows[0].worstReturn + 1e-12)
  const o = R.stressTest([{ symbol: 'A', value: 100, beta: 1, shock: -0.6 }], { scenarios: [{ id: 'x', name: 'x', market: 0.1 }] })
  expect(o.scenarios[0].pnl).toBeCloseTo(-60, 9)
  expect(() => R.stressTest([{ symbol: 'A', value: 0 }])).toThrow()
})
test('bootstrap interval brackets the estimate, narrows with more data, and is reproducible', () => {
  const x = series(500, 4).map(v => v + 0.0006)
  const a = R.bootstrapSharpe(x, { B: 400, seed: 5 }), a2 = R.bootstrapSharpe(x, { B: 400, seed: 5 })
  expect(a.lo).toBeLessThan(a.estimate); expect(a.hi).toBeGreaterThan(a.estimate); expect(a).toEqual(a2)
  const wide = R.bootstrapSharpe(x.slice(0, 100), { B: 400, seed: 5 })
  expect(wide.hi - wide.lo).toBeGreaterThan(a.hi - a.lo)
})
test('Beta–Binomial posterior: 60/100 is probably above 50% but 6/10 is not convincing', () => {
  const big = R.bayesBinomial(60, 100), small = R.bayesBinomial(6, 10)
  expect(big.posteriorMean).toBeCloseTo(61 / 102, 6); expect(big.lo).toBeLessThan(0.6); expect(big.hi).toBeGreaterThan(0.6)
  expect(big.probAbove).toBeGreaterThan(0.95); expect(small.probAbove).toBeLessThan(0.8)
  expect(R.betaCdf(0.5, 2, 2)).toBeCloseTo(0.5, 9); expect(() => R.bayesBinomial(11, 10)).toThrow()
})
test('Cholesky-correlated draws reproduce the target correlation; Monte Carlo VaR matches the analytic normal VaR', () => {
  const z = R.correlatedNormals([[1, 0.7], [0.7, 1]], 20000, 6)
  expect(L.correlation(z.map(r => r[0]), z.map(r => r[1]))).toBeCloseTo(0.7, 1)
  const cov = [[0.0004, 0], [0, 0.0004]], v = R.monteCarloVaR({ weights: [0.5, 0.5], mu: [0, 0], cov, paths: 40000, seed: 7 })
  const analytic = 1.645 * Math.sqrt(0.25 * 0.0004 + 0.25 * 0.0004)
  expect(v.var).toBeCloseTo(analytic, 2); expect(v.expectedShortfall).toBeGreaterThan(v.var)
})
test('Gaussian copula check flags tail clustering that a Gaussian copula misses', () => {
  const g = L.rng(8), n = 3000, a = [], b = []
  for (let i = 0; i < n; i++) { const crash = g.uniform() < 0.04, z1 = g.normal(), z2 = 0.3 * z1 + Math.sqrt(1 - 0.09) * g.normal(); a.push(crash ? -3 - Math.abs(g.normal()) : z1); b.push(crash ? -3 - Math.abs(g.normal()) : z2) }
  const c = R.gaussianCopula(a, b)
  expect(c.jointTailObserved).toBeGreaterThan(c.jointTailGaussian); expect(c.verdict).toMatch(/cluster/)
  const ind = R.gaussianCopula(series(2000, 9), series(2000, 10)); expect(ind.verdict).toMatch(/in line/)
})
test('PCA: one common factor explains most of the variance', () => {
  const g = L.rng(11), f = Array.from({ length: 500 }, () => g.normal()), rows = f.map(x => Array.from({ length: 6 }, () => x + 0.3 * g.normal()))
  const p = R.pca(rows); expect(p.explained[0]).toBeGreaterThan(0.8); expect(p.cumulative[2]).toBeLessThanOrEqual(1 + 1e-9); expect(p.scores[0]).toHaveLength(3)
})
test('market impact grows with the square root of participation and warns on large orders', () => {
  const a = R.marketImpact({ shares: 10000, price: 50, adv: 1e6, dailyVol: 0.02 }), b = R.marketImpact({ shares: 40000, price: 50, adv: 1e6, dailyVol: 0.02 })
  expect(b.impactBps / a.impactBps).toBeCloseTo(2, 6); expect(a.warning).toBeNull()
  expect(R.marketImpact({ shares: 3e5, price: 50, adv: 1e6, dailyVol: 0.02 }).warning).toMatch(/10%/)
  expect(() => R.marketImpact({ shares: 0, price: 1, adv: 1, dailyVol: 1 })).toThrow()
})
