'use strict'
const V = require('../lib/quant/volatility')
const { rng, stdev } = require('../lib/quant/linalg')

test('rollingVol equals the naive window stdev, even on a series with a huge offset (Welford stays exact)', () => {
  const g = rng(2), r = Array.from({ length: 300 }, () => 1e6 + 0.01 * g.normal())
  const out = V.rollingVol(r, 20, { annualize: false })
  for (const i of [19, 100, 299]) expect(out[i]).toBeCloseTo(stdev(r.slice(i - 19, i + 1)), 9)
  expect(out[18]).toBeNull()
  expect(() => V.rollingVol(r, 1)).toThrow()
})
test('rolling vol of the infographic example (k=4) is 1.54% daily / 24.5% annualised', () => {
  const r = [0.8, 1.5, -0.5, -2.0].map(x => x / 100)
  const out = V.rollingVol(r, 4, { annualize: false })
  expect(out[3] * 100).toBeCloseTo(1.54, 1)
  expect(V.rollingVol(r, 4)[3] * 100).toBeCloseTo(24.5, 0)
})
test('EWMA reacts to a volatility burst faster than a long window', () => {
  const g = rng(3), calm = Array.from({ length: 200 }, () => 0.005 * g.normal()), burst = Array.from({ length: 10 }, () => 0.04 * g.normal())
  const r = [...calm, ...burst], ew = V.ewmaVol(r), rv = V.rollingVol(r, 60)
  expect(ew[ew.length - 1]).toBeGreaterThan(rv[rv.length - 1])
})
test('GARCH(1,1) recovers planted parameters and mean-reverts its forecast', () => {
  const g = rng(9), omega = 2e-6, a = 0.1, b = 0.85, r = []; let h = omega / (1 - a - b)
  for (let i = 0; i < 4000; i++) { const e = Math.sqrt(h) * g.normal(); r.push(e); h = omega + a * e * e + b * h }
  const f = V.garch11(r)
  expect(f.persistence).toBeGreaterThan(0.9); expect(f.persistence).toBeLessThan(1)
  expect(f.alpha).toBeGreaterThan(0.05); expect(f.alpha).toBeLessThan(0.17)
  expect(f.longRunVol).toBeGreaterThan(0.07); expect(f.longRunVol).toBeLessThan(0.14) // planted: 10.0% a year
  expect(Math.abs(f.forecast[9] - f.longRunVol)).toBeLessThanOrEqual(Math.abs(f.forecast[0] - f.longRunVol) + 1e-12)
  expect(() => V.garch11(r.slice(0, 50))).toThrow(/100/)
})
function bars(n, sigma, seed) {
  const g = rng(seed); let p = 100; const out = []
  for (let i = 0; i < n; i++) {
    const o = p * (1 + 0.002 * g.normal()), steps = 40; let hi = o, lo = o, c = o
    for (let s = 0; s < steps; s++) { c *= 1 + sigma / Math.sqrt(252 * steps) * g.normal(); hi = Math.max(hi, c); lo = Math.min(lo, c) }
    out.push({ t: i, o, h: hi, l: lo, c }); p = c
  }
  return out
}
test('range-based estimators land near the true 30% volatility', () => {
  const b = bars(500, 0.3, 4)
  for (const f of [V.parkinson, V.garmanKlass, V.yangZhang]) { const v = f(b); expect(v).toBeGreaterThan(0.2); expect(v).toBeLessThan(0.4) }
  expect(V.parkinson([])).toBeNull()
})
test('HAR fits and forecasts a positive vol; report assembles every estimator', () => {
  const b = bars(400, 0.25, 5)
  const rep = V.volatilityReport(b)
  expect(rep.garch.nextDayVol).toBeGreaterThan(0); expect(rep.har.nextDayVol).toBeGreaterThan(0)
  expect(rep.rolling.series.length).toBeLessThanOrEqual(250); expect(rep.yangZhang).toBeGreaterThan(0)
  expect(V.volTargetScale(0.3, 0.15)).toBeCloseTo(0.5, 9); expect(V.volTargetScale(0.05, 0.15, 1)).toBe(1)
})
