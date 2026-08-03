'use strict'
/**
 * Unit tests for lib/learning-store.js — the shared cross-surface memory.
 * Pure functions only: record shape, outcome resolution, directional scoring,
 * calibration math, sample-size gating, and the prompt block.
 */

const {
  buildDecision, resolveDecision, wasCorrect, beatBenchmark,
  calibrate, calibrationReport, buildCalibrationBlock, pendingDecisions,
  MIN_SAMPLE,
} = require('../lib/learning-store')

const mk = (over = {}) => ({
  ...buildDecision({ surface: 'ai-brain', symbol: 'NVDA', action: 'buy', price: 100, confidence: 'High' }),
  ...over,
})
const resolved = (retPct, benchRetPct = null, over = {}) =>
  mk({ outcome: { at: '2026-01-08T00:00:00.000Z', price: 100 * (1 + retPct / 100), retPct, benchRetPct, horizonDays: 7 }, ...over })

describe('buildDecision', () => {
  test('normalizes symbol and action', () => {
    const d = buildDecision({ surface: 'advisory', symbol: 'nvda', action: 'BUY', price: 10 })
    expect(d.symbol).toBe('NVDA')
    expect(d.action).toBe('buy')
    expect(d.outcome).toBeNull()
  })

  test('rejects an unknown surface — prevents silent segment fragmentation', () => {
    expect(() => buildDecision({ surface: 'brain', symbol: 'X', action: 'buy' })).toThrow(/Unknown surface/)
  })
})

describe('resolveDecision', () => {
  test('computes return from the decision-time price', () => {
    const d = resolveDecision(mk(), { price: 110, benchRetPct: 3, horizonDays: 7 })
    expect(d.outcome.retPct).toBe(10)
    expect(d.outcome.benchRetPct).toBe(3)
  })

  test('leaves the decision untouched when the anchor price is unusable', () => {
    const d = resolveDecision(mk({ price: 0 }), { price: 110, horizonDays: 7 })
    expect(d.outcome).toBeNull()
  })
})

describe('directional scoring', () => {
  test('a buy wins when price rises', () => {
    expect(wasCorrect(resolved(5))).toBe(true)
    expect(wasCorrect(resolved(-5))).toBe(false)
  })

  test('a SELL wins when price FALLS — bearish calls are not scored as losses', () => {
    expect(wasCorrect(resolved(-5, null, { action: 'sell' }))).toBe(true)
    expect(wasCorrect(resolved(5, null, { action: 'sell' }))).toBe(false)
  })

  test('hold makes no directional claim and is excluded', () => {
    expect(wasCorrect(resolved(5, null, { action: 'hold' }))).toBeNull()
  })

  test('alpha compares against the benchmark, not zero', () => {
    expect(beatBenchmark(resolved(5, 8))).toBe(false)   // up, but lagged the market
    expect(beatBenchmark(resolved(5, 2))).toBe(true)
    expect(beatBenchmark(resolved(5))).toBeNull()       // no benchmark recorded
  })

  test('a sell beats the benchmark by falling further than it', () => {
    expect(beatBenchmark(resolved(-10, -2, { action: 'sell' }))).toBe(true)
  })
})

describe('calibrate — sample-size gating', () => {
  test('below the minimum sample nothing is reported as fact', () => {
    const rows = Array.from({ length: MIN_SAMPLE - 1 }, () => resolved(5, 1))
    const c = calibrate(rows)
    expect(c.sufficient).toBe(false)
    expect(c.winRate).toBeNull()
    expect(c.n).toBe(MIN_SAMPLE - 1)
  })

  test('at the minimum sample rates are computed', () => {
    const rows = [
      ...Array.from({ length: 6 }, () => resolved(5, 1)),   // wins, beat bench
      ...Array.from({ length: 2 }, () => resolved(-5, 1)),  // losses
    ]
    const c = calibrate(rows)
    expect(c.sufficient).toBe(true)
    expect(c.n).toBe(8)
    expect(c.winRate).toBe(0.75)
    expect(c.alphaWinRate).toBe(0.75)
    expect(c.avgReturn).toBe(2.5)
  })

  test('unresolved decisions are ignored entirely', () => {
    expect(calibrate([mk(), mk(), mk()]).n).toBe(0)
  })
})

describe('calibrationReport', () => {
  const rows = [
    ...Array.from({ length: 8 }, () => resolved(6, 2, { surface: 'ai-brain', confidence: 'High' })),
    ...Array.from({ length: 8 }, () => resolved(-4, 2, { surface: 'advisory', confidence: 'Low', symbol: 'ABC' })),
  ]

  test('splits by surface — the cross-surface view a single surface could not compute', () => {
    const r = calibrationReport(rows)
    expect(r.totalResolved).toBe(16)
    expect(r.overall.winRate).toBe(0.5)
    expect(r.bySurface['ai-brain'].winRate).toBe(1)
    expect(r.bySurface['advisory'].winRate).toBe(0)
  })

  test('splits by stated confidence', () => {
    const r = calibrationReport(rows)
    expect(r.bySurface).not.toBeNull()
    expect(r.byConfidence.High.winRate).toBe(1)
    expect(r.byConfidence.Low.winRate).toBe(0)
  })

  test('surfaces symbols the system is repeatedly wrong about', () => {
    const r = calibrationReport(rows)
    expect(r.bySymbol.ABC.winRate).toBe(0)
  })

  test('empty input produces a well-formed, non-throwing report', () => {
    const r = calibrationReport([])
    expect(r.totalResolved).toBe(0)
    expect(r.overall.sufficient).toBe(false)
    expect(r.bySurface).toBeNull()
  })
})

describe('buildCalibrationBlock', () => {
  test('returns empty string when the sample is too small to claim anything', () => {
    expect(buildCalibrationBlock(calibrationReport([resolved(5, 1)]))).toBe('')
    expect(buildCalibrationBlock(null)).toBe('')
  })

  test('reports measured rates once the sample is sufficient', () => {
    const rows = Array.from({ length: 10 }, () => resolved(6, 2))
    const block = buildCalibrationBlock(calibrationReport(rows))
    expect(block).toContain('CROSS-SURFACE CALIBRATION')
    expect(block).toContain('10 resolved decisions')
  })

  test('flags symbols with a poor track record', () => {
    const rows = [
      ...Array.from({ length: 10 }, () => resolved(-5, 1, { symbol: 'BAD' })),
      ...Array.from({ length: 10 }, () => resolved(5, 1, { symbol: 'GOOD' })),
    ]
    const block = buildCalibrationBlock(calibrationReport(rows))
    expect(block).toContain('Repeatedly WRONG on')
    expect(block).toContain('BAD')
  })
})

describe('pendingDecisions', () => {
  const now = Date.parse('2026-01-20T00:00:00.000Z')

  test('returns only unresolved decisions past the horizon', () => {
    const old    = mk({ at: '2026-01-01T00:00:00.000Z' })
    const recent = mk({ at: '2026-01-19T00:00:00.000Z' })
    const done   = resolved(5, 1, { at: '2026-01-01T00:00:00.000Z' })
    const pending = pendingDecisions([old, recent, done], { horizonDays: 7, now })
    expect(pending).toHaveLength(1)
    expect(pending[0].at).toBe('2026-01-01T00:00:00.000Z')
  })

  test('skips decisions with no usable anchor price', () => {
    const noPrice = mk({ at: '2026-01-01T00:00:00.000Z', price: null })
    expect(pendingDecisions([noPrice], { horizonDays: 7, now })).toHaveLength(0)
  })
})
