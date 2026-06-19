'use strict'
/**
 * Unit tests for routes/ai-brain.js buildActivityFeed — pure transform of the
 * prediction log into the "Brain Activity" thought-stream shape. No HTTP.
 */

const { buildActivityFeed } = require('../routes/ai-brain')

const base = {
  symbol: 'AAA', generatedAt: '2026-06-10T12:00:00.000Z',
  verdict: 'BUY', confidence: 'High', assetType: 'equity', sector: 'Tech',
  compositeScore: 82, fundamentalScore: 70, technicalScore: 80,
  sentimentScore: 60, macroScore: 55, riskScore: 40,
  basePrice: 100, priceAtPrediction: 100,
  thesisAssumptions: ['a', 'b', 'c', 'd'],
}

describe('buildActivityFeed', () => {
  test('returns newest first and respects the limit', () => {
    const records = [
      { ...base, symbol: 'OLD', generatedAt: '2026-06-01T00:00:00.000Z' },
      { ...base, symbol: 'NEW', generatedAt: '2026-06-15T00:00:00.000Z' },
      { ...base, symbol: 'MID', generatedAt: '2026-06-10T00:00:00.000Z' },
    ]
    const feed = buildActivityFeed(records, 2)
    expect(feed).toHaveLength(2)
    expect(feed.map(f => f.symbol)).toEqual(['NEW', 'MID'])
  })

  test('maps ensemble flag to confirmed / primary-only / null', () => {
    const feed = buildActivityFeed([
      { ...base, symbol: 'A', ensembleConfirmed: true },
      { ...base, symbol: 'B', ensembleConfirmed: false },
      { ...base, symbol: 'C' },
    ], 10)
    const by = Object.fromEntries(feed.map(f => [f.symbol, f.ensemble]))
    expect(by).toEqual({ A: 'confirmed', B: 'primary-only', C: null })
  })

  test('flags baseline agreement: UP agrees, DOWN is contrarian', () => {
    const feed = buildActivityFeed([
      { ...base, symbol: 'UP', baselineDir: 'UP', baselineProb: 0.7 },
      { ...base, symbol: 'DN', baselineDir: 'DOWN', baselineProb: 0.3 },
    ], 10)
    const up = feed.find(f => f.symbol === 'UP')
    const dn = feed.find(f => f.symbol === 'DN')
    expect(up.baseline).toEqual({ dir: 'UP', prob: 0.7, agrees: true })
    expect(dn.baseline.agrees).toBe(false)
  })

  test('thesis is capped at 3 assumptions', () => {
    const [f] = buildActivityFeed([base], 1)
    expect(f.thesis).toEqual(['a', 'b', 'c'])
  })

  test('outcome is null until resolved, then carries benchmark-relative returns', () => {
    const [unresolved] = buildActivityFeed([base], 1)
    expect(unresolved.outcome).toBeNull()

    const [resolved] = buildActivityFeed([
      { ...base, price7d: 110, price30d: 120, benchRet7d: 2, benchRet30d: 5, entered: true },
    ], 1)
    expect(resolved.outcome.ret7d).toBe(10)   // (110-100)/100
    expect(resolved.outcome.ret30d).toBe(20)  // (120-100)/100
    expect(resolved.outcome.benchRet30d).toBe(5)
    expect(resolved.outcome.entered).toBe(true)
  })

  test('uses entryZoneMid as the return anchor when no base price was logged', () => {
    const [f] = buildActivityFeed([
      { symbol: 'Z', generatedAt: base.generatedAt, entryZoneMid: 50, price7d: 55 },
    ], 1)
    expect(f.outcome.ret7d).toBe(10) // (55-50)/50
  })
})
