'use strict'
// The win probability trades are sized on: target-before-stop, calibrated on the record.

const bp = require('../lib/bracket-prob')
const kelly = require('../lib/kelly')

function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }

/** Resolved picks; `edge(rec, r)` decides whether one reached its target first. */
function records(n, edge, seed = 5) {
  const r = rng(seed)
  return Array.from({ length: n }, (_, i) => {
    const rec = {
      generatedAt: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString(),
      symbol: 'S' + (i % 30), compositeScore: Math.round(40 + r() * 50), confidence: ['High', 'Medium', 'Low'][Math.floor(r() * 3)],
      ensembleConfirmed: r() < 0.4, rsRankAtScan: Math.round(r() * 100), priceRegimeAtScan: 'up-calm',
      assetType: r() < 0.5 ? 'crypto' : 'stock', targetReturn: 10, stopLoss: 6, entered: true, priceAtPrediction: 100,
    }
    rec.barrier = { label: edge(rec, r) ? 'target' : 'stop' }
    return rec
  })
}
const flat = () => () => 0.5          // a "current method" that knows nothing

test('per-asset bracket rates replace a rate that cannot tell stocks from crypto', () => {
  const recs = records(600, (rec, r) => r() < (rec.assetType === 'crypto' ? 0.25 : 0.7))
  const s = bp.trainFromRecords(recs, { currentMethod: flat })
  expect(s.adopted).not.toBeNull()
  expect(s.rateAdopted).toBe(true)
  expect(s.validation.brier.rate).toBeLessThan(s.validation.brier.current)
  const c = bp.winProbFor(s, { assetType: 'crypto' }), st = bp.winProbFor(s, { assetType: 'Equity' })
  expect(c.p).toBeLessThan(0.35)
  expect(st.p).toBeGreaterThan(0.6)
  expect(c).toMatchObject({ bracket: true })
  expect(c.n).toBeGreaterThan(0)       // counts as measured for kelly.sizeIfCalibrated
  expect(kelly.sizeIfCalibrated(st, { winFrac: 0.1, lossFrac: 0.06 }).uncalibrated).toBeUndefined()
})

test('a per-pick signal is adopted as the model, and picks without scan fields still get the rate', () => {
  const recs = records(700, (rec, r) => r() < (rec.compositeScore >= 70 ? 0.8 : 0.3))
  const s = bp.trainFromRecords(recs, { currentMethod: flat })
  expect(s.adopted).toBe('model')
  const hi = bp.winProbFor(s, { assetType: 'stock', pickLike: { compositeScore: 85, assetType: 'stock', targetReturn: 10, stopLoss: 6 } })
  const lo = bp.winProbFor(s, { assetType: 'stock', pickLike: { compositeScore: 45, assetType: 'stock', targetReturn: 10, stopLoss: 6 } })
  expect(hi.p).toBeGreaterThan(lo.p + 0.15)
  expect(hi.source).toMatch(/bracket model/)
  // Advisory/Research Desk have no scan features: the rate applies only if it ALSO beat the current method.
  const noFeatures = bp.winProbFor(s, { assetType: 'stock' })
  if (s.rateAdopted) expect(noFeatures.source).toMatch(/bracket win rate/)
  else expect(noFeatures).toBeNull()
})

test('coin-flip outcomes change nothing (checked across several draws)', () => {
  let adopted = 0
  for (let seed = 1; seed <= 8; seed++) {
    const s = bp.trainFromRecords(records(400, (rec, r) => r() < 0.5, seed * 131), { currentMethod: flat })
    if (s.adopted) adopted++
    else expect(bp.winProbFor(s, { assetType: 'stock' })).toBeNull()
  }
  expect(adopted).toBeLessThanOrEqual(1)
})

test('when the current rate already predicts the bracket outcome, it stays', () => {
  const recs = records(600, (rec, r) => r() < (rec.assetType === 'crypto' ? 0.25 : 0.7))
  const oracle = () => r => (r.assetType === 'crypto' ? 0.25 : 0.7)
  const s = bp.trainFromRecords(recs, { currentMethod: oracle })
  expect(s.adopted).toBeNull()
  expect(s.reason).toMatch(/neither candidate clearly beat/)
})

test('too few labelled picks says so; unfilled and unresolved picks are not labels', () => {
  const recs = records(100, () => true)
  recs[0].entered = false
  delete recs[1].barrier
  expect(bp.labelled(recs)).toHaveLength(98)
  const s = bp.trainFromRecords(recs, { currentMethod: flat })
  expect(s).toMatchObject({ adopted: null })
  expect(s.reason).toMatch(/98 labelled picks \(need 150\)/)
  expect(bp.winProbFor(s, {})).toBeNull()
  expect(bp.winProbFor(null, {})).toBeNull()
})

test('the default current method is the real one: kelly.winProbFromStats over computeStats of the older picks', () => {
  // Fixed-horizon outcomes say "up" for everything; the bracket says crypto mostly stopped out first.
  const recs = records(400, (rec, r) => r() < (rec.assetType === 'crypto' ? 0.2 : 0.7)).map(r => ({
    ...r, priceAtPrediction: 100, price7d: 104, price30d: 106, outcome7d: 4, outcome30d: 6,
  }))
  const s = bp.trainFromRecords(recs)
  expect(Number.isFinite(s.validation.brier.current)).toBe(true)
  expect(s.adopted).not.toBeNull()
})

test('the store round-trips', () => {
  const s = bp.trainFromRecords(records(300, (rec, r) => r() < (rec.assetType === 'crypto' ? 0.25 : 0.7)), { currentMethod: flat })
  const file = require('path').join(require('os').tmpdir(), `bp-${process.pid}.json`)
  bp.saveStore(s, file)
  expect(bp.loadStore(file)).toEqual(s)
})
