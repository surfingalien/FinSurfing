'use strict'

// The nightly resolver writes exit quality onto each filled pick once its 30d
// window has elapsed, and backfills records resolved before the field existed.

const fs = require('fs')

const DAY = 86_400_000
const GEN = Date.now() - 40 * DAY
// Daily bars from generation: flat at 100, up to 108 on day 3, back to 101.
const mockBars = Array.from({ length: 40 }, (_, i) => {
  const t = GEN + i * DAY
  if (i === 3) return { t, o: 101, h: 108, l: 100, c: 107 }
  return { t, o: 100, h: 101, l: 99, c: i > 3 ? 101 : 100 }
})

jest.mock('../lib/internal-api', () => ({ fetchDailyBars: jest.fn(async () => mockBars) }))

const { PREDICTION_LOG } = require('../lib/prediction-log-path')
const bl = require('../lib/brain-learnings')
const { EXIT_VERSION } = require('../lib/exit-quality')

const pick = extra => ({
  symbol: 'TEST', verdict: 'Buy', generatedAt: new Date(GEN).toISOString(),
  entryZoneLow: 99, entryZoneHigh: 101, entryZoneMid: 100,
  targetZoneMid: 115, stopZoneMid: 92, targetReturn: 15, stopLoss: 8,
  ...extra,
})

beforeEach(() => {
  fs.writeFileSync(PREDICTION_LOG, [pick(), pick({ price7d: 100, price30d: 101, symbol: 'OLD' })].map(r => JSON.stringify(r)).join('\n') + '\n')
})

test('a filled pick gets its excursions; an already-resolved record is backfilled', async () => {
  await bl.resolveOutcomes()
  const rows = bl.readPredictions()
  for (const r of rows) {
    expect(r.exitV).toBe(EXIT_VERSION)
    expect(r.exit).toMatchObject({ filled: true, exitReason: 'time', mfe: 8, realized: 1, giveBack: 7 })
  }
})

test('a second pass does not recompute it', async () => {
  await bl.resolveOutcomes()
  const first = fs.readFileSync(PREDICTION_LOG, 'utf8')
  await bl.resolveOutcomes()
  expect(fs.readFileSync(PREDICTION_LOG, 'utf8')).toBe(first)
})
