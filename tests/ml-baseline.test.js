'use strict'
/**
 * Unit tests for lib/ml-baseline.js — featurization, the logistic scorer,
 * the trainer, and the baseline section computeStats() builds from logged
 * records. No network, no disk weights (in-memory test hook).
 */

const {
  FEATURE_NAMES, DEFAULT_WEIGHTS, featurize, predictProb, baselineFromBars,
  train, sigmoid, _setWeightsForTests,
} = require('../lib/ml-baseline')
const { computeStats } = require('../lib/brain-learnings')

beforeEach(() => _setWeightsForTests(DEFAULT_WEIGHTS))

// Synthetic daily bars: steady uptrend / downtrend with constant volume
const trendBars = (n, drift) =>
  Array.from({ length: n }, (_, i) => ({ c: 100 * (1 + drift) ** i, v: 1_000_000 }))

describe('featurize', () => {
  test('null under 60 closes', () => {
    expect(featurize(trendBars(59, 0.001).map(b => b.c))).toBeNull()
  })

  test('fixed-length, fixed-order vector', () => {
    const f = featurize(trendBars(80, 0.002).map(b => b.c), trendBars(80, 0).map(b => b.v))
    expect(f).toHaveLength(FEATURE_NAMES.length)
    f.forEach(x => expect(typeof x).toBe('number'))
  })

  test('uptrend produces positive momentum and SMA-gap features', () => {
    const bars = trendBars(80, 0.005)
    const f = featurize(bars.map(b => b.c), bars.map(b => b.v))
    const idx = name => FEATURE_NAMES.indexOf(name)
    expect(f[idx('momentum5d')]).toBeGreaterThan(0)
    expect(f[idx('momentum20d')]).toBeGreaterThan(0)
    expect(f[idx('smaGap20')]).toBeGreaterThan(0)
    expect(f[idx('smaGap50')]).toBeGreaterThan(0)
    expect(f[idx('volumeRatio')]).toBeCloseTo(0, 6)   // constant volume
  })

  test('features are clamped', () => {
    // Extreme spike: last close 100× prior
    const closes = [...new Array(70).fill(100), 10_000]
    const f = featurize(closes)
    f.forEach(x => { expect(x).toBeGreaterThanOrEqual(-3); expect(x).toBeLessThanOrEqual(3) })
  })
})

describe('predictProb / baselineFromBars', () => {
  test('sigmoid bounds and midpoint', () => {
    expect(sigmoid(0)).toBe(0.5)
    expect(sigmoid(100)).toBeCloseTo(1, 10)
    expect(sigmoid(-100)).toBeCloseTo(0, 10)
  })

  test('uptrend → UP, downtrend → DOWN under the default momentum prior', () => {
    expect(baselineFromBars(trendBars(80, 0.005))).toMatchObject({ dir: 'UP' })
    expect(baselineFromBars(trendBars(80, -0.005))).toMatchObject({ dir: 'DOWN' })
  })

  test('prob is a valid probability and features are echoed', () => {
    const b = baselineFromBars(trendBars(80, 0.003))
    expect(b.prob).toBeGreaterThan(0)
    expect(b.prob).toBeLessThan(1)
    expect(b.features).toHaveLength(FEATURE_NAMES.length)
  })

  test('null on short or empty bars', () => {
    expect(baselineFromBars(trendBars(30, 0.001))).toBeNull()
    expect(baselineFromBars([])).toBeNull()
    expect(predictProb(null)).toBeNull()
    expect(predictProb([1, 2])).toBeNull()
  })
})

describe('train', () => {
  test('null under 10 usable rows', () => {
    expect(train([{ features: new Array(7).fill(0), label: 1 }])).toBeNull()
  })

  test('learns a linearly separable rule with the right sign', () => {
    // Label depends only on feature 4 (momentum5d): positive → 1
    const rows = []
    for (let i = 0; i < 200; i++) {
      const f = FEATURE_NAMES.map(() => (Math.sin(i * 12.9898 + 78.233) * 43758.5453) % 1)
      f[4] = i % 2 === 0 ? 0.5 + (i % 7) / 20 : -0.5 - (i % 7) / 20
      rows.push({ features: f.map(x => +x.toFixed(4)), label: f[4] > 0 ? 1 : 0 })
    }
    const w = train(rows, { epochs: 500, lr: 0.5, l2: 0.001 })
    expect(w.trainedOn).toBe(200)
    expect(w.w[4]).toBeGreaterThan(0.5)   // dominant learned signal
    // In-sample accuracy well above chance
    const correct = rows.filter(r => (predictProb(r.features, w) >= 0.5 ? 1 : 0) === r.label).length
    expect(correct / rows.length).toBeGreaterThan(0.9)
  })
})

describe('computeStats baseline section', () => {
  const rec = (over) => ({
    symbol: 'TEST', generatedAt: '2026-05-01T00:00:00Z', verdict: 'STRONG_BUY',
    priceAtPrediction: 100, entered: true,
    price7d: 110, price30d: null, benchRet7d: 1.0,
    baselineProb: 0.7, baselineDir: 'UP', baselineFeatures: new Array(7).fill(0.1),
    ...over,
  })

  test('splits AI win rate by baseline agreement', () => {
    const records = [
      rec({}),                                            // UP, ret +10% → both right
      rec({ price7d: 90 }),                               // UP, ret −10% → both wrong
      rec({ baselineDir: 'DOWN', price7d: 120 }),         // DOWN, ret +20% → AI right, baseline wrong
      rec({ baselineDir: 'DOWN', price7d: 80 }),          // DOWN, ret −20% → AI wrong, baseline right
    ]
    const stats = computeStats(records)
    expect(stats.baseline).toMatchObject({
      n: 4,
      baselineAccuracy7d: 0.5,
      aiWinRate7d: 0.5,
      aiWinWhenBaselineAgrees: 0.5,
      aiWinWhenBaselineDisagrees: 0.5,
    })
  })

  test('absent when no records carry baseline fields', () => {
    const stats = computeStats([rec({ baselineDir: null, baselineProb: null, baselineFeatures: null })])
    expect(stats.baseline).toBeNull()
  })

  test('never-entered records are excluded', () => {
    const stats = computeStats([rec({}), rec({ entered: false, price7d: 50 })])
    expect(stats.baseline.n).toBe(1)
    expect(stats.baseline.aiWinRate7d).toBe(1)
  })
})
