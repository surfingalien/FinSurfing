'use strict'
/**
 * Unit tests for lib/expected-value.js — cost-aware expected value, the
 * break-even win rate, and the verdict that lets the Advisory abstain.
 */

const {
  ROUND_TRIP_BPS, MIN_NET_EDGE,
  normalizeAssetType, roundTripCost, breakEvenWinProb, evaluateTrade,
} = require('../lib/expected-value')
const { edge } = require('../lib/kelly')

describe('normalizeAssetType', () => {
  test('maps the labels used across the app to one key per asset class', () => {
    expect(normalizeAssetType('Crypto')).toBe('crypto')
    expect(normalizeAssetType('cryptocurrency')).toBe('crypto')
    expect(normalizeAssetType('Digital Asset')).toBe('crypto')
    expect(normalizeAssetType('ETF')).toBe('etf')
    expect(normalizeAssetType('Fund')).toBe('fund')
    expect(normalizeAssetType('Stock')).toBe('stock')
  })

  test("folds the AI Brain's legacy 'equity' label into 'stock'", () => {
    expect(normalizeAssetType('equity')).toBe('stock')
  })

  test('unknown / missing → null (caller falls back to the default cost)', () => {
    expect(normalizeAssetType('warrant')).toBeNull()
    expect(normalizeAssetType(null)).toBeNull()
    expect(normalizeAssetType('')).toBeNull()
  })
})

describe('roundTripCost', () => {
  test('crypto costs materially more to round-trip than equities', () => {
    expect(roundTripCost('Crypto')).toBeGreaterThan(roundTripCost('Stock'))
    expect(roundTripCost('Stock')).toBeGreaterThan(roundTripCost('ETF'))
  })

  test('converts basis points to a fraction', () => {
    expect(roundTripCost('Crypto')).toBeCloseTo(ROUND_TRIP_BPS.crypto / 10_000, 10)
  })

  test('unknown asset class assumes worse than equities, never free', () => {
    const unknown = roundTripCost('warrant')
    expect(unknown).toBeGreaterThan(roundTripCost('Stock'))
  })
})

describe('breakEvenWinProb', () => {
  test('symmetric payoff with no cost breaks even at 50%', () => {
    expect(breakEvenWinProb(0.1, 0.1, 0)).toBeCloseTo(0.5, 10)
  })

  test('a bigger target relative to the stop lowers the required hit rate', () => {
    expect(breakEvenWinProb(0.3, 0.1, 0)).toBeCloseTo(0.25, 10)
  })

  test('costs raise the required hit rate', () => {
    expect(breakEvenWinProb(0.1, 0.1, 0.006)).toBeGreaterThan(0.5)
  })

  test('null when the target cannot clear costs at all', () => {
    expect(breakEvenWinProb(0.004, 0.1, 0.006)).toBeNull()
  })
})

describe('evaluateTrade', () => {
  test('net edge equals gross edge minus the round-trip cost', () => {
    // The identity the module is built on: p(W−c) − q(L+c) ≡ pW − qL − c.
    const ev = evaluateTrade({ winProb: 0.55, targetReturn: 20, stopLoss: 10, assetType: 'Stock' })
    const gross = edge(0.55, 0.2, 0.1)
    expect(ev.grossEdge).toBeCloseTo(gross, 4)
    expect(ev.netEdge).toBeCloseTo(gross - roundTripCost('Stock'), 4)
    // Charging the cost to the payoffs must give the same answer.
    expect(edge(0.55, ev.netWinFrac, ev.netLossFrac)).toBeCloseTo(ev.netEdge, 6)
  })

  test('a healthy reward/risk pick is actionable', () => {
    const ev = evaluateTrade({ winProb: 0.55, targetReturn: 20, stopLoss: 10, assetType: 'Stock' })
    expect(ev.verdict).toBe('act')
    expect(ev.actionable).toBe(true)
    expect(ev.winProbMargin).toBeGreaterThan(0)
  })

  test('rejects a pick whose payoff needs a hit rate the record does not support', () => {
    // +6% target against a −15% stop needs ~71% before costs; measured 50%.
    const ev = evaluateTrade({ winProb: 0.5, targetReturn: 6, stopLoss: 15, assetType: 'Crypto' })
    expect(ev.verdict).toBe('reject')
    expect(ev.actionable).toBe(false)
    expect(ev.netEdge).toBeLessThan(0)
    expect(ev.breakEvenWinProb).toBeGreaterThan(0.5)
    expect(ev.reason).toMatch(/win rate/)
  })

  test('rejects when the target does not even clear the round-trip cost', () => {
    const ev = evaluateTrade({ winProb: 0.9, targetReturn: 0.4, stopLoss: 10, assetType: 'Crypto' })
    expect(ev.verdict).toBe('reject')
    expect(ev.breakEvenWinProb).toBeNull()
    expect(ev.reason).toMatch(/round-trip cost/)
  })

  test("'thin' sits between rejected and actionable, and the floor is tunable", () => {
    // Chosen so the net edge is positive but small.
    const args = { winProb: 0.34, targetReturn: 20, stopLoss: 10, assetType: 'Stock' }
    const thin = evaluateTrade(args)
    expect(thin.netEdge).toBeGreaterThan(0)
    expect(thin.netEdge).toBeLessThan(MIN_NET_EDGE)
    expect(thin.verdict).toBe('thin')
    expect(thin.actionable).toBe(false)
    // Drop the floor below the edge and the same pick becomes actionable.
    expect(evaluateTrade({ ...args, minNetEdge: 0 }).verdict).toBe('act')
  })

  test('identical picks are judged differently by asset class', () => {
    // A 3% target / 2% stop survives ETF friction but not crypto friction.
    const args = { winProb: 0.5, targetReturn: 3, stopLoss: 2 }
    const etf    = evaluateTrade({ ...args, assetType: 'ETF' })
    const crypto = evaluateTrade({ ...args, assetType: 'Crypto' })
    expect(etf.netEdge).toBeGreaterThan(crypto.netEdge)
    expect(crypto.breakEvenWinProb).toBeGreaterThan(etf.breakEvenWinProb)
  })

  test('returns null for inputs that are not a scoreable trade', () => {
    expect(evaluateTrade({ winProb: 0.5, targetReturn: 0,  stopLoss: 10 })).toBeNull()
    expect(evaluateTrade({ winProb: 0.5, targetReturn: 10, stopLoss: 0  })).toBeNull()
    expect(evaluateTrade({ winProb: 1.5, targetReturn: 10, stopLoss: 10 })).toBeNull()
    expect(evaluateTrade({ winProb: 0.5, targetReturn: null, stopLoss: 10 })).toBeNull()
  })

  test('a measured win rate of 0 is respected, not softened', () => {
    const ev = evaluateTrade({ winProb: 0, targetReturn: 20, stopLoss: 10, assetType: 'Stock' })
    expect(ev.actionable).toBe(false)
    expect(ev.netEdge).toBeLessThan(0)
  })
})
