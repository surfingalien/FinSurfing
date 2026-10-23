'use strict'

const or = require('../lib/outcome-range')

const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 1)
// n resolved picks with 30d returns `ret(i)` percent, one every 2 days.
const recs = (n, ret, extra = {}) => Array.from({ length: n }, (_, i) => ({
  symbol: `S${i}`, generatedAt: new Date(T0 + i * 2 * DAY).toISOString(), assetType: 'stock',
  basePrice: 100, price30d: 100 * (1 + ret(i) / 100), price7d: 100 * (1 + ret(i) / 200), ...extra,
}))

test('conformal interval uses the finite-sample order statistics, and refuses below the floor', () => {
  const vals = Array.from({ length: 99 }, (_, i) => i + 1)        // 1..99
  expect(or.conformalInterval(vals)).toMatchObject({ low: 10, high: 90, median: 50, n: 99 })
  expect(or.conformalInterval(vals.slice(0, 10))).toBeNull()
})

test('a pick gets the range of its own asset class at 30d, with the walk-forward check', () => {
  const stocks = recs(80, i => ((i * 37) % 41) - 15)              // spread -15..+25, no trend
  const crypto = recs(40, i => ((i * 13) % 61) - 30, { assetType: 'crypto' })
  const r = or.outcomeRange([...stocks, ...crypto], { assetType: 'crypto' })
  expect(r).toMatchObject({ basis: 'crypto picks', horizon: 30, n: 40, nominal: 0.8 })
  expect(r.low).toBeLessThan(0)
  expect(r.high).toBeGreaterThan(r.low)
  const s = or.outcomeRange([...stocks, ...crypto], { assetType: 'stock' })
  expect(s.measuredCoverage).toBeGreaterThan(0.6)
  expect(s.reliable).toBe(true)
  expect(s.text).toMatch(/past stock picks at 30d: -\d+(\.\d)?% to \+\d+(\.\d)?% \(80% of n=80; held \d+% walk-forward\)/)
})

test('a thin asset class falls back to all picks; too little of anything gives no range at all', () => {
  const r = or.outcomeRange([...recs(50, i => i % 10), ...recs(5, () => 3, { assetType: 'etf' })], { assetType: 'etf' })
  expect(r.basis).toBe('all picks')
  expect(or.outcomeRange(recs(10, () => 1), { assetType: 'stock' })).toBeNull()
})

test('when outcomes shift, the walk-forward check says the range has not held', () => {
  // A calm regime then a violent one: ranges built from the calm past miss the new outcomes.
  const rows = recs(120, i => (i < 60 ? (i % 5) - 2 : (i % 2 ? 30 : -30)))
  const r = or.outcomeRange(rows, { assetType: 'stock' })
  expect(r.measuredCoverage).toBeLessThan(0.7)
  expect(r.reliable).toBe(false)
})

test('walk-forward only uses outcomes already known when each pick was made', () => {
  // With picks every 2 days and a 30d horizon, the first ~15 later picks cannot see each other's outcomes.
  const rows = recs(60, i => i % 7)
  const wf = or.walkForwardCoverage(rows, 30, { minN: 30 })
  expect(wf === null || wf.tested < 30).toBe(true)
})
