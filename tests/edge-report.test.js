'use strict'
/**
 * Unit tests for lib/edge-report.js — cross-segment edge mining over
 * computeStats() output.
 */

const { computeEdgeReport, edgeBlock } = require('../lib/edge-report')

const stats = {
  h30: { alphaWinRate: 0.5 },
  calibration: {
    High:   { n: 40, winRate: 0.6, alphaWinRate: 0.65 },
    Medium: { n: 30, winRate: 0.5, alphaWinRate: 0.48 },
    Low:    { n: 5,  winRate: 0.2, alphaWinRate: 0.2 },   // below minN — excluded
  },
  ensemble: {
    confirmed:   { n: 25, winRate: 0.62, alphaWinRate: 0.7 },
    unconfirmed: { n: 45, winRate: 0.45, alphaWinRate: 0.42 },
  },
  byAssetType: { Crypto: { n: 12, winRate: 0.4, alphaWinRate: 0.33 } },
  byCompositeScore: { elite: { n: 15, winRate: 0.7, alphaWinRate: 0.72 } },
}

describe('computeEdgeReport', () => {
  test('ranks segments by edge vs overall, best first', () => {
    const r = computeEdgeReport(stats)
    expect(r.overall).toBe(0.5)
    expect(r.segments[0]).toMatchObject({ dimension: 'composite', segment: 'score ≥80', edge: 0.22 })
    const edges = r.segments.map(s => s.edge)
    expect(edges).toEqual([...edges].sort((a, b) => b - a))
  })

  test('excludes segments below the sample floor', () => {
    const r = computeEdgeReport(stats)
    expect(r.segments.find(s => s.segment === 'Low')).toBeUndefined()
    const strict = computeEdgeReport(stats, { minN: 30 })
    expect(strict.segments.map(s => s.segment)).toEqual(
      expect.arrayContaining(['High', 'Medium', 'unconfirmed']))
    expect(strict.segments.find(s => s.segment === 'confirmed')).toBeUndefined()
  })

  test('topEdges positive-only, topDrags most-negative-first', () => {
    const r = computeEdgeReport(stats)
    expect(r.topEdges.every(s => s.edge > 0)).toBe(true)
    expect(r.topDrags.every(s => s.edge < 0)).toBe(true)
    expect(r.topDrags[0].segment).toBe('Crypto') // -0.17 is the worst drag
  })

  test('empty/missing stats yield an empty report and empty block', () => {
    expect(computeEdgeReport(null).segments).toEqual([])
    expect(computeEdgeReport({}).overall).toBeNull()
    expect(edgeBlock(computeEdgeReport({}))).toBe('')
  })

  test('falls back to 7d overall when 30d is unavailable', () => {
    const r = computeEdgeReport({ h7: { alphaWinRate: 0.55 }, calibration: { High: { n: 20, alphaWinRate: 0.6 } } })
    expect(r.overall).toBe(0.55)
    expect(r.segments[0].edge).toBeCloseTo(0.05, 5)
  })
})

describe('edgeBlock', () => {
  test('renders strongest and weakest lines with percentage points', () => {
    const text = edgeBlock(computeEdgeReport(stats))
    expect(text).toContain('MEASURED EDGE')
    expect(text).toContain('Strongest:')
    expect(text).toContain('Weakest:')
    expect(text).toContain('composite=score ≥80 72% (+22pt, n=15)')
    expect(text).toContain('asset=Crypto 33% (-17pt, n=12)')
  })
})

describe('scan-time dimensions', () => {
  const seg = (winRate, n = 20) => ({ n, alphaWinRate: winRate, winRate })

  test('regime is a dimension — a rate that only holds risk-on is not one rate', () => {
    const r = computeEdgeReport({
      h30: { alphaWinRate: 0.5 },
      byRegime: {
        'Risk-On / Growth Favoured': seg(0.7),
        'Risk-Off / Defensive':      seg(0.3),
      },
    })
    const regimes = r.segments.filter(s => s.dimension === 'regime')
    expect(regimes).toHaveLength(2)
    expect(r.topEdges[0]).toMatchObject({ dimension: 'regime', segment: 'Risk-On / Growth Favoured', edge: 0.2 })
    expect(r.topDrags[0].edge).toBeCloseTo(-0.2, 5)
  })

  test('model version is a dimension — a swap is a new system, not more data', () => {
    const r = computeEdgeReport({
      h30: { alphaWinRate: 0.5 },
      byModelVersion: { 'claude-sonnet-4-6/v1': seg(0.62), 'llama-3.3-70b-versatile/v1': seg(0.41) },
    })
    expect(r.segments.filter(s => s.dimension === 'model')).toHaveLength(2)
    expect(edgeBlock(r)).toMatch(/model=claude-sonnet-4-6\/v1/)
  })

  test('the triple-barrier label is NOT a dimension — it is an outcome', () => {
    // Segmenting returns by an outcome is circular: "the picks that hit their
    // target did well" is arithmetic, not an edge.
    const r = computeEdgeReport({
      h30: { alphaWinRate: 0.5 },
      barriers: { n: 40, targetFirst: 0.5, stopFirst: 0.2, neither: 0.3 },
      byBarrier: { target: seg(1.0), stop: seg(0.0) },
    })
    expect(r.segments.some(s => s.dimension === 'barrier')).toBe(false)
    expect(r.segments).toEqual([])
  })
})
