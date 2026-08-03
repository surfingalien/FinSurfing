'use strict'
/**
 * Unit tests for lib/brain-evolution.js — pure helpers only.
 * The network-bound stages (revalidate/discover/resolve) are exercised via
 * their pure inputs; no HTTP, no AI calls, no disk.
 */

const { rotateUniverse, toSeries, nearestClose, benchmarkFor, EVOLUTION_UNIVERSE } = require('../lib/brain-evolution')

describe('rotateUniverse', () => {
  const u = ['A', 'B', 'C', 'D', 'E', 'F', 'G']

  test('is deterministic for the same date — reruns are idempotent', () => {
    const d = new Date('2026-03-05T00:00:00.000Z')
    expect(rotateUniverse(u, 3, d)).toEqual(rotateUniverse(u, 3, d))
  })

  test('picks a different slice on a different day (coverage broadens)', () => {
    const a = rotateUniverse(u, 3, new Date('2026-03-05T00:00:00.000Z'))
    const b = rotateUniverse(u, 3, new Date('2026-03-06T00:00:00.000Z'))
    expect(a).not.toEqual(b)
  })

  test('returns the requested count without duplicates', () => {
    const got = rotateUniverse(u, 4, new Date('2026-07-01T00:00:00.000Z'))
    expect(got).toHaveLength(4)
    expect(new Set(got).size).toBe(4)
  })

  test('never returns more than the universe holds', () => {
    expect(rotateUniverse(u, 99, new Date())).toHaveLength(u.length)
  })

  test('handles empty/degenerate input safely', () => {
    expect(rotateUniverse([], 3)).toEqual([])
    expect(rotateUniverse(u, 0)).toEqual([])
    expect(rotateUniverse(null, 3)).toEqual([])
  })

  test('rotation eventually covers the whole real universe', () => {
    const seen = new Set()
    for (let day = 0; day < 40; day++) {
      const d = new Date(Date.UTC(2026, 0, 1 + day))
      rotateUniverse(EVOLUTION_UNIVERSE, 6, d).forEach(s => seen.add(s))
    }
    expect(seen.size).toBe(EVOLUTION_UNIVERSE.length)
  })
})

describe('toSeries', () => {
  test('converts ms timestamps to unix seconds for the backtest engine', () => {
    const bars = [{ t: 1_700_000_000_000, o: 1, h: 2, l: 0.5, c: 1.5, v: 10 }]
    const s = toSeries(bars)
    expect(s.timestamps[0]).toBe(1_700_000_000)
    expect(s.closes[0]).toBe(1.5)
  })

  test('falls back to close for missing OHLC fields', () => {
    const s = toSeries([{ t: 1000, c: 7 }])
    expect(s.opens[0]).toBe(7)
    expect(s.highs[0]).toBe(7)
    expect(s.lows[0]).toBe(7)
    expect(s.volumes[0]).toBe(0)
  })
})

describe('nearestClose', () => {
  const DAY = 86400000
  const t0 = Date.UTC(2026, 0, 5)
  const bars = [
    { t: t0,          c: 100 },
    { t: t0 + 1 * DAY, c: 102 },
    { t: t0 + 7 * DAY, c: 110 },
  ]

  test('exact hit', () => {
    expect(nearestClose(bars, t0 + 1 * DAY)).toBe(102)
  })

  test('snaps across a weekend gap within tolerance', () => {
    expect(nearestClose(bars, t0 + 6 * DAY)).toBe(110)
  })

  test('returns null when no bar is close enough', () => {
    expect(nearestClose(bars, t0 + 60 * DAY)).toBeNull()
    expect(nearestClose([], t0)).toBeNull()
  })
})

describe('benchmarkFor', () => {
  test('crypto benchmarks against BTC, everything else against SPY', () => {
    expect(benchmarkFor('ETH-USD')).toBe('BTC-USD')
    expect(benchmarkFor('NVDA')).toBe('SPY')
  })
})
