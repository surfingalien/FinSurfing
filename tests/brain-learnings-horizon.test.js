'use strict'

// A scan picks for 3, 6 or 12 months and sizes its targets for that, but every
// pick's target-first label was measured over 30 days. Each pick now carries
// its horizon, and the resolver measures the barrier, the exit and the
// horizon return over it; unstamped picks keep their 30-day label.

const fs = require('fs')

const DAY = 86_400_000
const GEN = Date.now() - 100 * DAY
// Flat at 100 until day 60, when it reaches the $115 target.
const mockBars = Array.from({ length: 100 }, (_, i) => {
  const t = GEN + i * DAY
  return i === 60 ? { t, o: 110, h: 116, l: 109, c: 114 } : { t, o: 100, h: 101, l: 99, c: i > 60 ? 114 : 100 }
})

jest.mock('../lib/internal-api', () => ({ fetchDailyBars: jest.fn(async () => mockBars) }))

const { PREDICTION_LOG } = require('../lib/prediction-log-path')
const bl = require('../lib/brain-learnings')
const ml = require('../lib/meta-label')

const pick = extra => ({
  symbol: 'TEST', verdict: 'Buy', generatedAt: new Date(GEN).toISOString(),
  entryZoneLow: 99, entryZoneHigh: 101, entryZoneMid: 100,
  targetZoneMid: 115, stopZoneMid: 92, targetReturn: 15, stopLoss: 8,
  ...extra,
})

beforeEach(() => {
  fs.writeFileSync(PREDICTION_LOG, [pick({ horizon: '3m', horizonDays: 91 }), pick({ symbol: 'OLD' })].map(r => JSON.stringify(r)).join('\n') + '\n')
})

test('a 3-month pick is labelled over 91 days; an unstamped one keeps its 30-day window', async () => {
  await bl.resolveOutcomes()
  const [stamped, legacy] = bl.readPredictions()
  expect(stamped.barrier).toMatchObject({ label: 'target', window: 91, days: 60 })
  expect(stamped.exitWindow).toBe(91)
  expect(stamped.priceHorizon).toBe(114)
  expect(legacy.barrier).toMatchObject({ label: 'time', window: 30 })
  expect(legacy.priceHorizon).toBeUndefined()
})

test('only the horizon-matched label teaches the meta-label and counts in the stats', async () => {
  await bl.resolveOutcomes()
  const [stamped, legacy] = bl.readPredictions()
  expect(ml.labelOf(stamped)).toBe(1)
  expect(ml.labelOf(legacy)).toBeNull()
  expect(bl.computeStats(bl.readPredictions()).barriers).toMatchObject({ n: 1, targetFirst: 1, legacyExcluded: 1 })
})

test('a window still open is not labelled', async () => {
  fs.writeFileSync(PREDICTION_LOG, JSON.stringify(pick({ horizon: '6m', horizonDays: 182 })) + '\n')
  await bl.resolveOutcomes()
  const [r] = bl.readPredictions()
  expect(r.barrier).toBeUndefined()
  expect(r.price30d).toBe(100)                   // the fixed horizons still resolve on time
})

test('the scan horizons map to days', () => {
  expect(bl.HORIZON_DAYS).toEqual({ '3m': 91, '6m': 182, '12m': 365 })
})
