'use strict'
/**
 * Unit tests for lib/kelly.js — Kelly sizing math + guardrails + the
 * empirical-win-probability sourcing from brain-learnings stats.
 */

const { fullKelly, edge, suggestedSize, winProbFromStats } = require('../lib/kelly')

describe('fullKelly', () => {
  test('classic asymmetric payoff: (pW − qL)/(WL)', () => {
    // p=0.6, W=0.25, L=0.12 → (0.15 − 0.048)/0.03 = 3.4
    expect(fullKelly(0.6, 0.25, 0.12)).toBeCloseTo(3.4, 5)
  })

  test('non-positive edge clamps to 0 (never size a losing bet)', () => {
    expect(fullKelly(0.4, 0.1, 0.2)).toBe(0)   // edge −0.08
    expect(fullKelly(0.5, 0.1, 0.1)).toBe(0)   // edge 0 exactly
  })

  test('guards bad inputs (p∉(0,1), non-positive W/L) → 0', () => {
    expect(fullKelly(1, 0.2, 0.1)).toBe(0)
    expect(fullKelly(0, 0.2, 0.1)).toBe(0)
    expect(fullKelly(0.6, 0, 0.1)).toBe(0)
    expect(fullKelly(0.6, 0.2, 0)).toBe(0)
  })
})

describe('edge', () => {
  test('expected value per unit = pW − qL', () => {
    expect(edge(0.6, 0.25, 0.12)).toBeCloseTo(0.102, 6)
    expect(edge(0.5, 0.1, 0.1)).toBeCloseTo(0, 6)
  })
})

describe('suggestedSize — fractional Kelly + hard cap', () => {
  test('half-Kelly then capped at maxFraction', () => {
    const s = suggestedSize({ winProb: 0.6, winFrac: 0.25, lossFrac: 0.12, fraction: 0.5, maxFraction: 0.2 })
    expect(s.fullKellyPct).toBeCloseTo(340, 0) // 3.4 → 340%
    expect(s.capped).toBe(true)
    expect(s.suggestedPct).toBe(20)            // half=170% capped to 20%
    expect(s.edgePerUnit).toBeCloseTo(0.102, 4)
  })

  test('uncapped when fractional Kelly is below the cap', () => {
    // modest edge: p=0.55, W=0.1, L=0.1 → full=(0.055−0.045)/0.01=1.0; quarter=0.25 → capped at 0.2
    const s = suggestedSize({ winProb: 0.55, winFrac: 0.1, lossFrac: 0.1, fraction: 0.1, maxFraction: 0.2 })
    expect(s.capped).toBe(false)
    expect(s.suggestedPct).toBeCloseTo(10, 1)  // full 1.0 × 0.1 = 0.10
  })

  test('non-positive edge → 0% suggested', () => {
    const s = suggestedSize({ winProb: 0.45, winFrac: 0.1, lossFrac: 0.2 })
    expect(s.suggestedPct).toBe(0)
  })
})

describe('winProbFromStats — empirical sourcing', () => {
  const stats = {
    h7:  { winRate: 0.52, nTradeable: 40 },
    h30: { winRate: 0.58, nTradeable: 30 },
    calibration: {
      High:   { n: 25, winRate: 0.66 },
      Medium: { n: 8,  winRate: 0.61 },  // too few samples
    },
  }

  test('prefers the per-confidence bucket when it has enough samples', () => {
    expect(winProbFromStats(stats, { confidence: 'High' }).p).toBe(0.66)
  })

  test('falls back to overall (30d) win rate when bucket sample is too small', () => {
    expect(winProbFromStats(stats, { confidence: 'Medium' }).p).toBe(0.58)
  })

  test('uses overall 30d win rate when no confidence given', () => {
    expect(winProbFromStats(stats).p).toBe(0.58)
  })

  test('falls back to a conservative default when no data', () => {
    const r = winProbFromStats(null, { fallback: 0.5 })
    expect(r.p).toBe(0.5)
    expect(r.source).toMatch(/default/)
  })

  test('reports provenance in source', () => {
    expect(winProbFromStats(stats, { confidence: 'High' }).source).toMatch(/calibration:High/)
  })
})
