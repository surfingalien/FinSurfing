'use strict'
const S = require('../lib/spread-estimates')
const L = require('../lib/quant/linalg')

const T0 = Date.UTC(2024, 0, 2)
// Efficient price as a random walk; trades print at mid ± half spread (Roll's model), range from intraday draws.
function bars(n, seed, { spread = 0, vol = 0.01, dollarVol = 5e8 } = {}) {
  const g = L.rng(seed); let m = 100
  return Array.from({ length: n }, (_, i) => {
    m *= Math.exp(vol * g.normal())
    const side = g.uniform() < 0.5 ? -1 : 1, c = m * (1 + side * spread / 2)
    const hi = m * Math.exp(Math.abs(vol * 0.6 * g.normal())) * (1 + spread / 2), lo = m * Math.exp(-Math.abs(vol * 0.6 * g.normal())) * (1 - spread / 2)
    return { t: T0 + i * 864e5, o: m, h: Math.max(hi, c), l: Math.min(lo, c), c, v: dollarVol / c }
  })
}

test('Roll recovers a planted bid-ask bounce and says so when there is none to find', () => {
  const r = S.roll(bars(600, 1, { spread: 0.02, vol: 0.002 }))
  expect(r.spread).toBeGreaterThan(0.015); expect(r.spread).toBeLessThan(0.025)
  // A trending series (positive autocovariance) gives no estimate, never a zero.
  let p = 100, e = 0; const g = L.rng(2)
  const trend = Array.from({ length: 300 }, (_, i) => { e = 0.6 * e + 0.01 * g.normal(); p *= Math.exp(e); return { t: T0 + i * 864e5, c: p } })
  const t = S.roll(trend); expect(t.spread).toBeNull(); expect(t.reason).toMatch(/positively correlated/)
  expect(S.roll(bars(20, 3)).reason).toMatch(/needed/)
})

test('Corwin–Schultz rises with the planted spread and refuses bars with no range', () => {
  const lo = S.corwinSchultz(bars(200, 4, { spread: 0, vol: 0.005 })).spread, hi = S.corwinSchultz(bars(200, 4, { spread: 0.03, vol: 0.005 })).spread
  expect(hi).toBeGreaterThan(lo + 0.01)
  const flat = bars(100, 5).map(b => ({ ...b, h: b.c, l: b.c }))
  const f = S.corwinSchultz(flat); expect(f.spread).toBeNull(); expect(f.reason).toMatch(/high\/low/)
})

test('estimate combines what exists and never invents a missing estimator', () => {
  const e = S.estimate(bars(300, 6, { spread: 0.01, vol: 0.003 }))
  expect(e.estimators).toBeGreaterThanOrEqual(1); expect(e.roundTripBps).toBeGreaterThan(0)
  expect(e.amihud.impactBps).toBeGreaterThanOrEqual(0)
  const none = S.estimate([]); expect(none.roundTripBps).toBeNull(); expect(none.estimators).toBe(0)
})

test('size check: a liquid name is covered by the flat cost, a thin one is flagged, no volume is unknown', () => {
  const liquid = S.sizeCost(bars(120, 7, { vol: 0.015, dollarVol: 5e9 }), { flatBps: 10 })
  expect(liquid.verdict).toBe('in-line'); expect(liquid.extraBps).toBeLessThan(2)
  const thin = S.sizeCost(bars(120, 8, { vol: 0.05, dollarVol: 2e6 }), { flatBps: 10 })
  expect(thin.verdict).toBe('understated'); expect(thin.extraBps).toBeGreaterThan(100); expect(thin.note).toMatch(/understate/)
  // The square-root law: 4× the size costs 2× the impact.
  const b = bars(120, 9, { vol: 0.03, dollarVol: 5e7 })
  expect(S.sizeCost(b, { flatBps: 10, notional: 400_000 }).extraBps / S.sizeCost(b, { flatBps: 10, notional: 100_000 }).extraBps).toBeCloseTo(2, 1)
  // Below the minimum gap nothing is flagged even when it equals the flat cost (crypto's 60 bps too).
  expect(S.sizeCost(bars(120, 10, { vol: 0.05, dollarVol: 2e6 }), { flatBps: 1e6 }).verdict).toBe('in-line')
  expect(S.sizeCost(bars(120, 11).map(x => ({ ...x, v: 0 })), { flatBps: 10 }).verdict).toBe('unknown')
})

test('strategy size check reads only sessions before each entry and reports what is left of the mean', () => {
  const b = bars(300, 12, { vol: 0.04, dollarVol: 1e6 })
  const timestamps = b.map(x => x.t / 1000), closes = b.map(x => x.c), volumes = b.map(x => x.v)
  const day = i => new Date(timestamps[i] * 1000).toISOString().slice(0, 10)
  const trades = [100, 200].map(i => ({ type: 'buy', date: day(i), price: closes[i], shares: Math.floor(10_000 / closes[i]) }))
  const r = S.strategySizeCost({ trades, timestamps, closes, volumes, flatBps: 10, meanPct: 0.5 })
  expect(r.entries).toBe(2); expect(r.verdict).toBe('understated'); expect(r.meanAfterPct).toBeCloseTo(0.5 - r.extraBps / 100, 3)
  // Rewriting the entry day and later sessions does not change the cost of that entry.
  const v2 = volumes.map((v, i) => (i >= 100 ? v * 1000 : v))
  const first = S.strategySizeCost({ trades: trades.slice(0, 1), timestamps, closes, volumes: v2, flatBps: 10 })
  expect(first.extraBps).toBeCloseTo(S.strategySizeCost({ trades: trades.slice(0, 1), timestamps, closes, volumes, flatBps: 10 }).extraBps, 6)
  expect(S.strategySizeCost({ trades, timestamps, closes, volumes: null, flatBps: 10 })).toBeNull()
})
