'use strict'

const lh = require('../lib/learning-health')

// A stats segment with k alpha wins out of n benchmark-matched picks.
const seg = (k, n) => ({ n, nBench: n, alphaWins: k, alphaWinRate: +(k / n).toFixed(3), wins: k, winRate: +(k / n).toFixed(3) })

describe('compare', () => {
  test('a clear difference is decided; a small one is not', () => {
    expect(lh.compare({ k: 70, n: 100 }, { k: 40, n: 100 }).status).toBe('higher')
    expect(lh.compare({ k: 52, n: 100 }, { k: 48, n: 100 }).status).toBe('no-difference')
  })
  test('below the floor on either side it is insufficient, never a verdict', () => {
    expect(lh.compare({ k: 9, n: 9 }, { k: 0, n: 50 }).status).toBe('insufficient')
  })
})

describe('auditFlags', () => {
  const stats = {
    byVolumeSignal: { Confirming: seg(70, 100), Weak: seg(20, 50), Diverging: seg(20, 50) },
    conflictImpact: { conflict: seg(26, 50), noConflict: seg(25, 50) },
    calibration:    { High: seg(3, 5), Low: seg(2, 5) },
  }

  test('a YES the data establishes is kept', () => {
    expect(lh.auditFlags({ volumeConfirmationPredictive: true }, stats).volumeConfirmationPredictive)
      .toMatchObject({ verdict: 'supported', keep: true })
  })
  test('a NO the data contradicts is dropped', () => {
    expect(lh.auditFlags({ volumeConfirmationPredictive: false }, stats).volumeConfirmationPredictive)
      .toMatchObject({ verdict: 'contradicted', keep: false })
  })
  test('a YES on a coin-flip split is unsupported and dropped; the matching NO is consistent', () => {
    expect(lh.auditFlags({ conflictSignalUseful: true }, stats).conflictSignalUseful).toMatchObject({ verdict: 'unsupported', keep: false })
    expect(lh.auditFlags({ conflictSignalUseful: false }, stats).conflictSignalUseful).toMatchObject({ verdict: 'consistent', keep: true })
  })
  test('a claim about something barely measured is dropped either way', () => {
    expect(lh.auditFlags({ confidenceCalibrated: false }, stats).confidenceCalibrated).toMatchObject({ verdict: 'insufficient', keep: false })
    expect(lh.auditFlags({ optionsBullishPredictive: true }, stats).optionsBullishPredictive).toMatchObject({ verdict: 'insufficient', keep: false })
  })
})

describe('auditLearnings', () => {
  const stats = { byVolumeSignal: { Confirming: seg(62, 100), Weak: seg(3, 6) } }

  test('a finding citing a real, large-enough segment, with figures it holds, is kept', () => {
    const { kept } = lh.auditLearnings(['Confirming volume picks beat the benchmark 62% of the time [byVolumeSignal.Confirming]'], stats)
    expect(kept).toHaveLength(1)
  })
  test('uncited, unknown path, thin segment and invented figure are each dropped with a reason', () => {
    const { kept, rejected } = lh.auditLearnings([
      'Prefer confirming volume',
      'Momentum works [byMomentum.high]',
      'Weak volume is a trap [byVolumeSignal.Weak]',
      'Confirming volume won 81% [byVolumeSignal.Confirming]',
    ], stats)
    expect(kept).toEqual([])
    expect(rejected.map(r => r.reason)).toEqual([
      'cites no statistic',
      expect.stringMatching(/not in the stats/),
      expect.stringMatching(/fewer than 10 picks/),
      expect.stringMatching(/figure not present/),
    ])
  })
  test('the "stats." prefix and several paths are accepted', () => {
    const { kept } = lh.auditLearnings(['Confirming leads [stats.byVolumeSignal.Confirming, byVolumeSignal.Confirming]'], stats)
    expect(kept).toHaveLength(1)
  })
})

describe('judgeEffect / learningHealth', () => {
  test('learnings that measurably hurt are withheld; the caveat travels with the verdict', () => {
    const h = lh.learningHealth({ keyLearnings: [], stats: { byLearnings: { on: seg(30, 100), off: seg(60, 100) } } })
    expect(h.effect.verdict).toBe('hurting')
    expect(h.withheld).toBe(true)
    expect(h.effect.caveat).toMatch(/early weeks/)
  })
  test('too few picks either side is "insufficient", and nothing is withheld', () => {
    const h = lh.learningHealth({ keyLearnings: [], stats: { byLearnings: { on: seg(1, 4) } } })
    expect(h.effect.verdict).toBe('insufficient')
    expect(h.withheld).toBe(false)
  })
  test('no learnings document → not available', () => {
    expect(lh.learningHealth(null)).toMatchObject({ available: false })
  })
})
