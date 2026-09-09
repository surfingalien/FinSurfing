'use strict'
/**
 * Unit tests for the walk-forward validation + promotion gate in
 * lib/ml-baseline.js.
 *
 * The nightly job refits these weights unattended and whatever it saves
 * becomes the benchmark every future AI Brain pick is scored against, so the
 * property under test is not "does it fit" but "does it refuse to ship a fit
 * that is worse than what it replaces".
 */

const fs = require('fs')
const {
  FEATURE_NAMES, DEFAULT_WEIGHTS, MIN_TRAIN_ROWS, MIN_HOLDOUT,
  evaluateWeights, splitByTime, trainFromRecords, _setWeightsForTests,
} = require('../lib/ml-baseline')

// Keep every test off the real data/ml-baseline-weights.json.
let writes
beforeEach(() => {
  writes = []
  jest.spyOn(fs, 'writeFileSync').mockImplementation((f, c) => writes.push({ f, c }))
  jest.spyOn(fs, 'mkdirSync').mockImplementation(() => {})
  _setWeightsForTests(DEFAULT_WEIGHTS)
})
afterEach(() => jest.restoreAllMocks())

/** A feature vector whose first two slots are set and the rest zeroed. */
const feat = (f0, f1 = 0) => [f0, f1, 0, 0, 0, 0, 0]

/** Build a prediction record with a given label and ordinal timestamp. */
function rec(features, label, dayOffset) {
  return {
    baselineFeatures:  features,
    priceAtPrediction: 100,
    price7d:           label ? 101 : 99,
    generatedAt:       new Date(Date.UTC(2025, 0, 1) + dayOffset * 86400000).toISOString(),
  }
}

/** Weights that key entirely off one feature index. */
const weightsOn = (idx, mag = 10) => ({
  bias: 0,
  w: FEATURE_NAMES.map((_, i) => (i === idx ? mag : 0)),
  trainedOn: 0, source: 'test',
})

describe('evaluateWeights', () => {
  const rows = [
    { features: feat(1), label: 1 },
    { features: feat(1), label: 1 },
    { features: feat(-1), label: 0 },
    { features: feat(-1), label: 1 },   // the one miss for a f0-following model
  ]

  test('scores accuracy, logLoss and the majority-class base rate', () => {
    const s = evaluateWeights(weightsOn(0), rows)
    expect(s.n).toBe(4)
    expect(s.accuracy).toBeCloseTo(0.75, 5)
    expect(s.baseRate).toBeCloseTo(0.75, 5)   // 3 of 4 labels are 1
    expect(s.logLoss).toBeGreaterThan(0)
  })

  test('a confident miss produces a finite logLoss, never Infinity', () => {
    const s = evaluateWeights(weightsOn(0, 500), rows)
    expect(Number.isFinite(s.logLoss)).toBe(true)
  })

  test('ignores malformed rows and returns null when nothing is usable', () => {
    expect(evaluateWeights(weightsOn(0), [{ features: [1, 2], label: 1 }])).toBeNull()
    expect(evaluateWeights(weightsOn(0), [])).toBeNull()
  })
})

describe('splitByTime', () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ features: feat(1), label: 1, at: i }))

  test('holds out the NEWEST slice, never a random one', () => {
    const { train, holdout } = splitByTime(rows)
    expect(train.length + holdout.length).toBe(100)
    // Every training row must predate every holdout row.
    expect(Math.max(...train.map(r => r.at))).toBeLessThan(Math.min(...holdout.map(r => r.at)))
  })

  test('sorts by time first, so caller ordering cannot leak the future', () => {
    const shuffled = [...rows].reverse()
    const { holdout } = splitByTime(shuffled)
    expect(Math.min(...holdout.map(r => r.at))).toBe(75)
  })

  test('null when either side would be too small to mean anything', () => {
    expect(splitByTime(rows.slice(0, MIN_HOLDOUT))).toBeNull()
    expect(splitByTime([])).toBeNull()
  })
})

describe('trainFromRecords — promotion gate', () => {
  test('waits for data below MIN_TRAIN_ROWS and writes nothing', () => {
    const records = Array.from({ length: 10 }, (_, i) => rec(feat(1), 1, i))
    const fit = trainFromRecords(records)
    expect(fit).toMatchObject({ trained: false, promoted: false, needed: MIN_TRAIN_ROWS })
    expect(writes).toHaveLength(0)
  })

  test('promotes a fit that beats both the base rate and the incumbent', () => {
    // f0 cleanly separates the labels across the whole period.
    const records = Array.from({ length: 160 }, (_, i) => {
      const up = i % 2 === 0
      return rec(feat(up ? 1 : -1), up ? 1 : 0, i)
    })
    const fit = trainFromRecords(records)

    expect(fit.promoted).toBe(true)
    expect(fit.validation.candidate.accuracy).toBeGreaterThan(fit.validation.baseRate)
    expect(fit.validation.holdoutN).toBe(40)
    expect(fit.validation.trainN).toBe(120)
    expect(writes).toHaveLength(1)
  })

  test('the shipped model is refit on ALL rows, holdout included', () => {
    const records = Array.from({ length: 160 }, (_, i) => {
      const up = i % 2 === 0
      return rec(feat(up ? 1 : -1), up ? 1 : 0, i)
    })
    const fit = trainFromRecords(records)
    // Validated on 120, but shipped having seen all 160 — the holdout proved
    // the procedure, it should not cost the model the most recent evidence.
    expect(fit.validation.trainN).toBe(120)
    expect(fit.weights.trainedOn).toBe(160)
    expect(fit.weights.validation).toEqual(fit.validation)
  })

  test('REJECTS a refit whose relationship broke down in the recent period', () => {
    // f0 predicts the label for the first 120 days, then inverts. A model fit
    // on the old regime scores far below the base rate on the new one.
    const records = Array.from({ length: 160 }, (_, i) => {
      const up = i % 2 === 0
      const label = i < 120 ? (up ? 1 : 0) : (up ? 0 : 1)
      return rec(feat(up ? 1 : -1), label, i)
    })
    const fit = trainFromRecords(records)

    expect(fit.trained).toBe(true)      // a fit ran …
    expect(fit.promoted).toBe(false)    // … and was refused
    expect(fit.reason).toMatch(/base rate/)
    expect(writes).toHaveLength(0)      // incumbent weights untouched
  })

  test('REJECTS a refit that scores below the incumbent on the holdout', () => {
    // Train: f0 carries the signal, f1 is dead. Holdout: f1 is perfect and f0
    // is only 60% right — so the candidate (which learned f0) underperforms an
    // incumbent that keys off f1.
    const records = []
    for (let i = 0; i < 120; i++) {
      const up = i % 2 === 0
      records.push(rec(feat(up ? 1 : -1, 0), up ? 1 : 0, i))
    }
    for (let i = 120; i < 160; i++) {
      const label = i % 2 === 0 ? 1 : 0
      // f0 agrees with the label on 6 of every 10 holdout rows.
      const f0Agrees = i % 10 < 6
      records.push(rec(feat(f0Agrees ? (label ? 1 : -1) : (label ? -1 : 1), label ? 1 : -1), label, i))
    }
    _setWeightsForTests(weightsOn(1))   // incumbent reads f1 → perfect on holdout

    const fit = trainFromRecords(records)
    expect(fit.promoted).toBe(false)
    expect(fit.reason).toMatch(/below incumbent/)
    expect(fit.validation.incumbent.accuracy).toBeGreaterThan(fit.validation.candidate.accuracy)
    expect(writes).toHaveLength(0)
  })

  test('a rejected refit still reports what it measured', () => {
    const records = Array.from({ length: 160 }, (_, i) => {
      const up = i % 2 === 0
      const label = i < 120 ? (up ? 1 : 0) : (up ? 0 : 1)
      return rec(feat(up ? 1 : -1), label, i)
    })
    const { validation } = trainFromRecords(records)
    expect(validation).toMatchObject({ holdoutN: 40, trainN: 120 })
    expect(validation.candidate.accuracy).toBeDefined()
    expect(validation.incumbent.accuracy).toBeDefined()
    expect(validation.validatedAt).toBeDefined()
  })
})
