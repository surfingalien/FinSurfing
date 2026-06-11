'use strict'
/**
 * Unit tests for lib/signal-flips.js — scan-to-scan signal change detection.
 */

const { detectFlips, camp } = require('../lib/signal-flips')

describe('camp', () => {
  test('classifies bullish, bearish, neutral, and empty', () => {
    expect(camp('BUY')).toBe('bullish')
    expect(camp('strong_buy')).toBe('bullish')
    expect(camp('SELL')).toBe('bearish')
    expect(camp('AVOID')).toBe('bearish')
    expect(camp('HOLD')).toBe('neutral')
    expect(camp('WAIT')).toBe('neutral')
    expect(camp('')).toBeNull()
    expect(camp(null)).toBeNull()
  })
})

describe('detectFlips', () => {
  test('no flips when nothing changed', () => {
    expect(detectFlips({ AAPL: 'BUY' }, { AAPL: 'BUY' })).toEqual([])
  })

  test('first sighting of a symbol is not a flip', () => {
    expect(detectFlips({}, { NVDA: 'BUY' })).toEqual([])
  })

  test('symbol leaving the scan is not a flip', () => {
    expect(detectFlips({ NVDA: 'BUY' }, {})).toEqual([])
  })

  test('BUY → SELL is a high-severity flip', () => {
    expect(detectFlips({ TSLA: 'BUY' }, { TSLA: 'SELL' })).toEqual([
      { symbol: 'TSLA', from: 'BUY', to: 'SELL', severity: 'high' },
    ])
  })

  test('transitions through neutral are normal severity', () => {
    expect(detectFlips({ A: 'BUY', B: 'HOLD' }, { A: 'HOLD', B: 'SELL' })).toEqual([
      { symbol: 'A', from: 'BUY', to: 'HOLD', severity: 'normal' },
      { symbol: 'B', from: 'HOLD', to: 'SELL', severity: 'normal' },
    ])
  })

  test('case-insensitive comparison, normalized output', () => {
    expect(detectFlips({ X: 'buy' }, { X: 'Sell' })).toEqual([
      { symbol: 'X', from: 'BUY', to: 'SELL', severity: 'high' },
    ])
  })

  test('verdict vocabulary: STRONG_BUY → AVOID crosses camps', () => {
    expect(detectFlips({ Y: 'STRONG_BUY' }, { Y: 'AVOID' })[0].severity).toBe('high')
  })

  test('mixed batch only reports real changes', () => {
    const prev = { A: 'BUY', B: 'SELL', C: 'HOLD' }
    const curr = { A: 'BUY', B: 'BUY', C: 'HOLD', D: 'SELL' }
    const flips = detectFlips(prev, curr)
    expect(flips).toHaveLength(1)
    expect(flips[0]).toMatchObject({ symbol: 'B', from: 'SELL', to: 'BUY', severity: 'high' })
  })
})
