'use strict'

const ml = require('../lib/meta-label')

function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }

/** Resolved picks; `edge(rec, r)` decides whether one reached its target first. */
function records(n, edge, seed = 3) {
  const r = rng(seed)
  return Array.from({ length: n }, (_, i) => {
    const rec = {
      generatedAt: new Date(Date.UTC(2025, 0, 1) + i * 86400000).toISOString(),
      compositeScore: Math.round(40 + r() * 50), confidence: ['High', 'Medium', 'Low'][Math.floor(r() * 3)],
      ensembleConfirmed: r() < 0.4, highConviction: r() < 0.2, rsRankAtScan: Math.round(r() * 100),
      volumeSignal: r() < 0.5 ? 'Confirming' : 'Weak', priceRegimeAtScan: r() < 0.6 ? 'up-calm' : 'down-stressed',
      assetType: 'stock', targetReturn: 10, stopLoss: 6, baselineProb: 0.5, entered: true, priceAtPrediction: 100,
    }
    rec.barrier = { label: edge(rec, r) ? 'target' : 'stop' }
    return rec
  })
}

test('features are scan-time facts only, scaled to about [0, 1]', () => {
  const x = ml.featurize({ compositeScore: 80, confidence: 'High', ensembleConfirmed: true, priceRegimeAtScan: 'up-stressed', targetReturn: 12, stopLoss: 6, daysToEarnings: 4 })
  expect(x).toHaveLength(ml.FEATURES.length)
  expect(x.every(v => v >= -0.5 && v <= 1)).toBe(true)
  expect(ml.labelOf({ entered: false, barrier: { label: 'target' } })).toBeNull()
  expect(ml.labelOf({ barrier: { label: 'time' }, priceAtPrediction: 100, price30d: 103 })).toBe(1)
})

test('a real relationship is found and adopted on newer picks it never saw', () => {
  // Ensemble-confirmed picks in an uptrend usually reach target; the rest usually stop out.
  const recs = records(500, (rec, r) => r() < (rec.ensembleConfirmed && rec.priceRegimeAtScan === 'up-calm' ? 0.8 : 0.3))
  const m = ml.trainFromRecords(recs)
  expect(m.validated).toBe(true)
  expect(m.validation.precisionLo).toBeGreaterThan(m.validation.baseRate)
  const good = ml.assess(m, { ensembleConfirmed: true, priceRegimeAtScan: 'up-calm', compositeScore: 70, confidence: 'Medium', targetReturn: 10, stopLoss: 6 })
  const bad = ml.assess(m, { ensembleConfirmed: false, priceRegimeAtScan: 'down-stressed', compositeScore: 70, confidence: 'Medium', targetReturn: 10, stopLoss: 6 })
  expect(good.prob).toBeGreaterThan(bad.prob)
})

test('coin-flip outcomes are not adopted (checked across several draws)', () => {
  let adopted = 0
  for (let seed = 1; seed <= 8; seed++) if (ml.trainFromRecords(records(400, (rec, r) => r() < 0.45, seed * 97)).validated) adopted++
  expect(adopted).toBeLessThanOrEqual(1)
})

test('too few labelled picks says so and filters nothing', () => {
  const m = ml.trainFromRecords(records(60, () => true))
  expect(m).toMatchObject({ validated: false })
  expect(m.reason).toMatch(/60 labelled picks \(need 150\)/)
})
