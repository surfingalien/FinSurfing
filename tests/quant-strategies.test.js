'use strict'
const S = require('../lib/quant/strategies')
const L = require('../lib/quant/linalg')

const T0 = Date.UTC(2023, 0, 2)
const toBars = closes => closes.map((c, i) => ({ t: T0 + i * 86400000, o: c, h: c, l: c, c }))
const walk = (n, seed, s = 0.01, p0 = 100) => { const g = L.rng(seed); let p = p0; return Array.from({ length: n }, () => (p *= Math.exp(s * g.normal()))) }

test('a planted cointegrated pair trades profitably out of sample; two independent walks are not tradeable', () => {
  const n = 900, x = walk(n, 1), g = L.rng(2); let e = 0
  const y = x.map(v => { e = 0.85 * e + 0.01 * g.normal(); return Math.exp(0.2 + 1.2 * Math.log(v) + e) })
  const r = S.testPair(toBars(y), toBars(x))
  expect(r.formation.cointegrated5pct).toBe(true); expect(r.formation.hedgeRatio).toBeCloseTo(1.2, 0)
  expect(r.trading.trades).toBeGreaterThan(5); expect(r.trading.sharpe).toBeGreaterThan(0.5); expect(r.tradeable).toBe(true)
  const bad = S.testPair(toBars(walk(n, 3)), toBars(walk(n, 4)))
  expect(bad.tradeable).toBe(false)
  expect(() => S.testPair(toBars(y.slice(0, 50)), toBars(x.slice(0, 50)))).toThrow(/200/)
})
test('pairs are traded only on information available at the time (formation fixed before trading)', () => {
  const n = 700, x = walk(n, 5), g = L.rng(6); let e = 0
  const y = x.map(v => { e = 0.8 * e + 0.01 * g.normal(); return v * Math.exp(e) })
  const a = S.testPair(toBars(y), toBars(x)), b = S.testPair(toBars(y.slice(0, 600)), toBars(x.slice(0, 600)))
  expect(a.formation.days).toBe(Math.floor(n * 0.5)); expect(b.formation.days).toBe(300)
  // changing data after the formation window cannot change the formation statistics for the same cut
  const c = S.testPair(toBars(y), toBars(x), { formationShare: 0.5 }), d = S.testPair(toBars([...y.slice(0, 350), ...walk(350, 9)]), toBars(x), { formationShare: 0.5 })
  expect(c.formation.hedgeRatio).toBeCloseTo(d.formation.hedgeRatio, 9)
})
test('screenPairs reports the expected number of false positives', () => {
  const n = 500, bars = {}; ;['A', 'B', 'C', 'D'].forEach((s, i) => { bars[s] = toBars(walk(n, 20 + i)) })
  const r = S.screenPairs(bars)
  expect(r.pairsTested).toBe(6); expect(r.expectedFalsePositives).toBeCloseTo(0.3, 1); expect(r.note).toMatch(/luck/)
})
test('PCA stat-arb flags a name that dislocated from its peers', () => {
  const n = 300, g = L.rng(30), f = Array.from({ length: n }, () => 0.01 * g.normal()), bars = {}
  ;['A', 'B', 'C', 'D', 'E'].forEach((s, i) => { let p = 100; bars[s] = toBars([100, ...f.map((x, t) => (p *= 1 + x + 0.002 * g.normal() + (s === 'E' && t >= n - 5 ? -0.02 : 0)))]) })
  const r = S.statArbPca(bars, { k: 1, window: 200, holding: 5 })
  expect(r.signals[0].symbol).toBe('E'); expect(r.signals[0].residualZ).toBeLessThan(-1.5); expect(r.signals[0].view).toBe('cheap vs peers')
  expect(() => S.statArbPca({ A: bars.A }, {})).toThrow()
})
test('short-term reversal earns on a mean-reverting series and reports exposure-based stats', () => {
  const g = L.rng(40); let p = 100; const closes = [100], phi = -0.3; let last = 0
  for (let i = 0; i < 1500; i++) { last = phi * last + 0.01 * g.normal(); closes.push((p *= 1 + last)) }
  const r = S.shortTermReversal(toBars(closes), { k: 1.2 })
  expect(r.trades).toBeGreaterThan(20); expect(r.winRate).toBeGreaterThan(0.5); expect(r.sharpe).toBeGreaterThan(0)
  expect(() => S.shortTermReversal(toBars(closes.slice(0, 50)))).toThrow()
})
