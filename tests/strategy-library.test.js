'use strict'
/**
 * Unit tests for lib/strategy-library.js — the evolution memory.
 * Pure functions only: identity, fitness math, retirement, ranking, pruning,
 * and the prompt block. No file I/O, no AI calls.
 */

const {
  strategyKey, strategyId, scoreValidation, computeFitness, consecutiveFailures,
  shouldRetire, buildEntry, applyValidation, rankStrategies, pruneLibrary,
  buildStrategyBlock, PASS_SCORE, MAX_VALIDATIONS,
} = require('../lib/strategy-library')

const goodMetrics = { alpha: 15, sharpeRatio: 1.2, totalTrades: 8 }
const badMetrics  = { alpha: -12, sharpeRatio: -0.8, totalTrades: 6 }

describe('identity', () => {
  test('same config produces the same key and id regardless of param order', () => {
    const a = { symbol: 'AAPL', strategy: 'sma_crossover', params: { fastPeriod: 10, slowPeriod: 40 } }
    const b = { symbol: 'aapl', strategy: 'sma_crossover', params: { slowPeriod: 40, fastPeriod: 10 } }
    expect(strategyKey(a)).toBe(strategyKey(b))
    expect(strategyId(a)).toBe(strategyId(b))
  })

  test('different params produce a different id', () => {
    const a = { symbol: 'AAPL', strategy: 'sma_crossover', params: { fastPeriod: 10, slowPeriod: 40 } }
    const b = { symbol: 'AAPL', strategy: 'sma_crossover', params: { fastPeriod: 12, slowPeriod: 40 } }
    expect(strategyId(a)).not.toBe(strategyId(b))
  })
})

describe('scoreValidation', () => {
  test('positive alpha and sharpe score above neutral', () => {
    expect(scoreValidation(goodMetrics)).toBeGreaterThan(50)
  })

  test('negative alpha and sharpe score below neutral', () => {
    expect(scoreValidation(badMetrics)).toBeLessThan(50)
  })

  test('flat performance scores ~50', () => {
    expect(scoreValidation({ alpha: 0, sharpeRatio: 0, totalTrades: 5 })).toBeCloseTo(50, 1)
  })

  test('too few trades scores 0 — a 1-trade backtest proves nothing', () => {
    expect(scoreValidation({ alpha: 99, sharpeRatio: 5, totalTrades: 1 })).toBe(0)
    expect(scoreValidation(null)).toBe(0)
  })

  test('non-finite metrics score 0 rather than NaN', () => {
    expect(scoreValidation({ alpha: NaN, sharpeRatio: 1, totalTrades: 5 })).toBe(0)
  })

  test('score is bounded to 0-100 for extreme inputs', () => {
    const hi = scoreValidation({ alpha: 1e6, sharpeRatio: 1e6, totalTrades: 50 })
    const lo = scoreValidation({ alpha: -1e6, sharpeRatio: -1e6, totalTrades: 50 })
    expect(hi).toBeLessThanOrEqual(100)
    expect(lo).toBeGreaterThanOrEqual(0)
  })
})

describe('computeFitness', () => {
  test('an unproven single validation is discounted vs a repeatedly proven one', () => {
    const once = buildEntry({ symbol: 'AAPL', strategy: 'macd_signal', params: { fast: 12, slow: 26, signal: 9 }, metrics: goodMetrics, verdict: 'validated' })
    let many = once
    for (let i = 0; i < 3; i++) many = applyValidation(many, { metrics: goodMetrics, verdict: 'validated' })
    // Identical measured performance — the difference is survival across cycles
    expect(many.fitness).toBeGreaterThan(once.fitness)
  })

  test('recent validations outweigh old ones (a decayed strategy loses fitness)', () => {
    let entry = buildEntry({ symbol: 'X', strategy: 'macd_signal', params: {}, metrics: goodMetrics, verdict: 'validated' })
    entry = applyValidation(entry, { metrics: goodMetrics, verdict: 'validated' })
    const stillGood = applyValidation(entry, { metrics: goodMetrics, verdict: 'validated' })
    const wentBad   = applyValidation(entry, { metrics: badMetrics,  verdict: 'rejected' })
    expect(wentBad.fitness).toBeLessThan(stillGood.fitness)
  })

  test('no validations → 0', () => {
    expect(computeFitness({ validations: [] })).toBe(0)
    expect(computeFitness(null)).toBe(0)
  })
})

describe('retirement — the selection pressure', () => {
  test('two consecutive failures retire a strategy', () => {
    let entry = buildEntry({ symbol: 'X', strategy: 'bb_reversion', params: { period: 20, mult: 2 }, metrics: goodMetrics, verdict: 'validated' })
    entry = applyValidation(entry, { metrics: badMetrics, verdict: 'rejected' })
    expect(entry.status).toBe('active')          // one bad night is tolerated
    entry = applyValidation(entry, { metrics: badMetrics, verdict: 'rejected' })
    expect(entry.status).toBe('retired')         // two in a row is a pattern
  })

  test('a failure followed by a pass does not retire', () => {
    let entry = buildEntry({ symbol: 'X', strategy: 'bb_reversion', params: {}, metrics: goodMetrics, verdict: 'validated' })
    entry = applyValidation(entry, { metrics: badMetrics,  verdict: 'rejected' })
    entry = applyValidation(entry, { metrics: goodMetrics, verdict: 'validated' })
    expect(consecutiveFailures(entry)).toBe(0)
    expect(entry.status).toBe('active')
  })

  test('a strategy that has not passed in a long time goes stale', () => {
    const entry = buildEntry({ symbol: 'X', strategy: 'macd_signal', params: {}, metrics: goodMetrics, verdict: 'validated', at: '2020-01-01T00:00:00.000Z' })
    expect(shouldRetire(entry, { now: Date.parse('2020-01-10T00:00:00.000Z') })).toBe(false)
    expect(shouldRetire(entry, { now: Date.parse('2020-06-01T00:00:00.000Z') })).toBe(true)
  })

  test('validation history is capped', () => {
    let entry = buildEntry({ symbol: 'X', strategy: 'macd_signal', params: {}, metrics: goodMetrics, verdict: 'validated' })
    for (let i = 0; i < MAX_VALIDATIONS + 5; i++) entry = applyValidation(entry, { metrics: goodMetrics, verdict: 'validated' })
    expect(entry.validations.length).toBe(MAX_VALIDATIONS)
    expect(entry.generation).toBe(MAX_VALIDATIONS + 6)
  })
})

describe('ranking and pruning', () => {
  const mk = (symbol, fitness, status = 'active', generation = 3) =>
    ({ id: symbol, symbol, strategy: 'macd_signal', params: {}, fitness, status, generation, validations: [{ score: fitness }] })

  test('ranks by fitness, best first, excluding retired', () => {
    const ranked = rankStrategies([mk('A', 60), mk('B', 90), mk('C', 95, 'retired'), mk('D', 75)])
    expect(ranked.map(e => e.symbol)).toEqual(['B', 'D', 'A'])
  })

  test('prune drops retired entries', () => {
    const pruned = pruneLibrary([mk('A', 60), mk('B', 90, 'retired')])
    expect(pruned.map(e => e.symbol)).toEqual(['A'])
  })

  test('prune caps size keeping the fittest', () => {
    const many = Array.from({ length: 10 }, (_, i) => mk(`S${i}`, i * 10))
    const pruned = pruneLibrary(many, { maxSize: 3 })
    expect(pruned).toHaveLength(3)
    expect(pruned.map(e => e.fitness)).toEqual([90, 80, 70])
  })
})

describe('buildStrategyBlock', () => {
  test('returns empty string when nothing is proven yet', () => {
    expect(buildStrategyBlock([])).toBe('')
    const weak = [{ id: 'a', symbol: 'A', strategy: 'macd_signal', params: {}, fitness: 10, status: 'active', generation: 1, validations: [{ score: 10 }] }]
    expect(buildStrategyBlock(weak)).toBe('')
  })

  test('includes proven strategies with their measured numbers', () => {
    let entry = buildEntry({ symbol: 'NVDA', strategy: 'sma_crossover', params: { fastPeriod: 10, slowPeriod: 40 }, metrics: goodMetrics, verdict: 'validated' })
    for (let i = 0; i < 3; i++) entry = applyValidation(entry, { metrics: goodMetrics, verdict: 'validated' })
    const block = buildStrategyBlock([entry])
    expect(block).toContain('NVDA')
    expect(block).toContain('sma_crossover')
    expect(block).toContain('fastPeriod=10')
    expect(block).toContain('survived')
    expect(entry.fitness).toBeGreaterThanOrEqual(PASS_SCORE)
  })
})
