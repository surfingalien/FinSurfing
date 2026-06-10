'use strict'
/**
 * Unit tests for the AI Brain measurement engine (lib/brain-learnings.js).
 * Pure functions only — no HTTP, no Anthropic calls, no file I/O.
 */

const { computeStats, nearestClose, zoneTouched, benchmarkFor } = require('../lib/brain-learnings')

const DAY = 86400 * 1000

describe('nearestClose', () => {
  const t0 = Date.UTC(2026, 0, 5) // Mon Jan 5 2026
  const bars = [
    { t: t0,           c: 100 },
    { t: t0 + 1 * DAY, c: 102 },
    { t: t0 + 2 * DAY, c: 104 },
    { t: t0 + 7 * DAY, c: 110 }, // next Monday (weekend gap)
  ]

  test('exact match returns that bar close', () => {
    expect(nearestClose(bars, t0 + 1 * DAY)).toBe(102)
  })

  test('weekend target snaps to nearest trading day within tolerance', () => {
    // Saturday (+5d) → nearest bars are Wed (+2d, 3d away) and Mon (+7d, 2d away)
    expect(nearestClose(bars, t0 + 5 * DAY)).toBe(110)
  })

  test('target far outside data returns null', () => {
    expect(nearestClose(bars, t0 + 60 * DAY)).toBe(null)
  })

  test('empty bars returns null', () => {
    expect(nearestClose([], t0)).toBe(null)
    expect(nearestClose(null, t0)).toBe(null)
  })
})

describe('zoneTouched', () => {
  const t0 = Date.UTC(2026, 0, 5)
  const bars = [
    { t: t0,           l: 98,  h: 101, c: 100 },
    { t: t0 + 1 * DAY, l: 101, h: 105, c: 104 },
    { t: t0 + 2 * DAY, l: 104, h: 109, c: 108 },
  ]

  test('returns true when a bar range overlaps the zone', () => {
    expect(zoneTouched(bars, t0, t0 + 3 * DAY, 99, 100)).toBe(true)
  })

  test('returns false when price never traded in the zone', () => {
    expect(zoneTouched(bars, t0, t0 + 3 * DAY, 90, 95)).toBe(false)
  })

  test('returns null for undefined zone (legacy records)', () => {
    expect(zoneTouched(bars, t0, t0 + 3 * DAY, null, null)).toBe(null)
  })

  test('returns null when no bars fall in the window', () => {
    expect(zoneTouched(bars, t0 + 10 * DAY, t0 + 17 * DAY, 99, 101)).toBe(null)
  })
})

describe('benchmarkFor', () => {
  test('crypto symbols benchmark against BTC', () => {
    expect(benchmarkFor('ETH-USD')).toBe('BTC-USD')
    expect(benchmarkFor('SOL-USD')).toBe('BTC-USD')
  })

  test('equities and ETFs benchmark against SPY', () => {
    expect(benchmarkFor('NVDA')).toBe('SPY')
    expect(benchmarkFor('QQQ')).toBe('SPY')
  })
})

describe('computeStats', () => {
  const mkRecord = (over = {}) => ({
    symbol: 'NVDA',
    generatedAt: '2026-05-01T00:00:00.000Z',
    confidence: 'High',
    basePrice: 100,
    entryZoneMid: 100,
    targetZoneMid: 115,
    entered: true,
    price7d: 105,  benchRet7d: 1,
    price30d: 112, benchRet30d: 3,
    ...over,
  })

  test('empty input produces zero-count stats', () => {
    const s = computeStats([])
    expect(s.totalResolved).toBe(0)
    expect(s.h7).toBe(null)
    expect(s.h30).toBe(null)
  })

  test('win rate counts positive returns from base price', () => {
    const records = [
      mkRecord(),                              // +5% @7d → win
      mkRecord({ price7d: 95, benchRet7d: 1 }), // -5% @7d → loss
    ]
    const s = computeStats(records)
    expect(s.h7.n).toBe(2)
    expect(s.h7.winRate).toBe(0.5)
  })

  test('alpha win rate compares against the benchmark, not zero', () => {
    // +2% return vs +5% benchmark = raw win but alpha loss
    const records = [mkRecord({ price7d: 102, benchRet7d: 5, price30d: null, benchRet30d: null })]
    const s = computeStats(records)
    expect(s.h7.winRate).toBe(1)
    expect(s.h7.alphaWinRate).toBe(0)
  })

  test('predictions that never entered the zone are excluded from win rates', () => {
    const records = [
      mkRecord(),                       // entered, +5% win
      mkRecord({ entered: false, price7d: 200 }), // phantom +100% — never tradeable
    ]
    const s = computeStats(records)
    expect(s.h7.n).toBe(2)
    expect(s.h7.nTradeable).toBe(1)
    expect(s.h7.neverEntered).toBe(1)
    expect(s.h7.winRate).toBe(1)       // only the real fill counts
    expect(s.h7.avgReturn).toBe(5)     // phantom gain excluded
  })

  test('target hit rate uses the target zone mid', () => {
    const records = [
      mkRecord({ price30d: 116 }), // above 115 target → hit
      mkRecord({ price30d: 110 }), // below target → miss
    ]
    const s = computeStats(records)
    expect(s.h30.targetHitRate).toBe(0.5)
  })

  test('calibration buckets by stated confidence', () => {
    const records = [
      mkRecord({ confidence: 'High',  price30d: 120, benchRet30d: 2 }), // alpha win
      mkRecord({ confidence: 'High',  price30d: 90,  benchRet30d: 2 }), // alpha loss
      mkRecord({ confidence: 'Low',   price30d: 130, benchRet30d: 2 }), // alpha win
    ]
    const s = computeStats(records)
    expect(s.calibration.High.n).toBe(2)
    expect(s.calibration.High.alphaWinRate).toBe(0.5)
    expect(s.calibration.Low.n).toBe(1)
    expect(s.calibration.Low.alphaWinRate).toBe(1)
    expect(s.calibration.Medium).toBeUndefined()
  })

  test('legacy records without basePrice fall back to entryZoneMid', () => {
    const records = [mkRecord({ basePrice: undefined, priceAtPrediction: undefined })]
    const s = computeStats(records)
    expect(s.h7.winRate).toBe(1) // (105-100)/100 from entryZoneMid
  })
})
