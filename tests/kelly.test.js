'use strict'
/**
 * Unit tests for lib/kelly.js — Kelly sizing math + guardrails + the
 * empirical-win-probability sourcing from brain-learnings stats.
 */

const { fullKelly, edge, suggestedSize, sizeIfCalibrated, winProbFromStats } = require('../lib/kelly')

// Expected shrunk rate: (wins + 0.5·20) / (n + 20) — see winProbFromStats.
const shrunk = (rate, n) => +((Math.round(rate * n) + 10) / (n + 20)).toFixed(4)

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
    expect(winProbFromStats(stats, { confidence: 'High' }).p).toBe(shrunk(0.66, 25))
  })

  test('falls back to overall (30d) win rate when bucket sample is too small', () => {
    expect(winProbFromStats(stats, { confidence: 'Medium' }).p).toBe(shrunk(0.58, 30))
  })

  test('uses overall 30d win rate when no confidence given', () => {
    expect(winProbFromStats(stats).p).toBe(shrunk(0.58, 30))
  })

  test('falls back to a conservative default when no data', () => {
    const r = winProbFromStats(null, { fallback: 0.5 })
    expect(r.p).toBe(0.5)
    expect(r.source).toMatch(/default/)
  })

  test('falls through to 7d when 30d exists but has too few resolved picks', () => {
    const thin30 = {
      h7:  { winRate: 0.52, nTradeable: 40 },
      h30: { winRate: 1.0,  nTradeable: 3 }, // too few to trust
    }
    const r = winProbFromStats(thin30)
    expect(r.p).toBe(shrunk(0.52, 40))
    expect(r.source).toMatch(/7d/)
  })

  test('a measured 0% win rate drags p far below the fallback, never replaced by it', () => {
    const losing = { h30: { winRate: 0, nTradeable: 20 } }
    const r = winProbFromStats(losing, { fallback: 0.5 })
    expect(r.p).toBe(0.25)
    expect(r.raw).toBe(0)
    // and Kelly sizes a p=0 system to zero, never a positive position
    expect(suggestedSize({ winProb: r.p, winFrac: 0.25, lossFrac: 0.12 }).suggestedPct).toBe(0)
  })

  test('reports provenance in source', () => {
    expect(winProbFromStats(stats, { confidence: 'High' }).source).toMatch(/calibration:High/)
  })
})

describe('winProbFromStats — per-asset-class sourcing', () => {
  // Stocks, ETFs and crypto have genuinely different hit rates; a blended
  // number sizes all three wrong, so the asset segment is the most specific
  // evidence available and is checked first.
  const stats = {
    h30: { winRate: 0.58, nTradeable: 30 },
    calibration: { High: { n: 25, winRate: 0.66 } },
    byAssetType: {
      stock:  { n: 40, winRate: 0.61 },
      crypto: { n: 30, winRate: 0.44 },
      etf:    { n: 5,  winRate: 0.80 },   // too few samples to trust
    },
  }

  test('uses the asset-class win rate when it has enough samples', () => {
    expect(winProbFromStats(stats, { assetType: 'crypto' }).raw).toBe(0.44)
    expect(winProbFromStats(stats, { assetType: 'stock' }).raw).toBe(0.61)
  })

  test('asset class outranks the confidence bucket — it is the segment the pick is in', () => {
    const r = winProbFromStats(stats, { assetType: 'crypto', confidence: 'High' })
    expect(r.raw).toBe(0.44)
    expect(r.source).toMatch(/assetType:crypto/)
  })

  test('a thin asset segment falls through rather than sizing off noise', () => {
    const r = winProbFromStats(stats, { assetType: 'etf' })
    expect(r.raw).toBe(0.58)             // overall 30d, not the n=5 80%
    expect(r.source).toMatch(/30d/)
  })

  test("matches computeStats by folding the legacy 'equity' label into 'stock'", () => {
    expect(winProbFromStats(stats, { assetType: 'equity' }).raw).toBe(0.61)
  })

  test('is case-insensitive and unaffected by an unknown asset class', () => {
    expect(winProbFromStats(stats, { assetType: 'CRYPTO' }).raw).toBe(0.44)
    expect(winProbFromStats(stats, { assetType: 'warrant' }).raw).toBe(0.58)
  })

  test('omitting assetType preserves the previous behaviour exactly', () => {
    expect(winProbFromStats(stats, { confidence: 'High' }).p).toBe(shrunk(0.66, 25))
    expect(winProbFromStats(stats).p).toBe(shrunk(0.58, 30))
  })
})

describe('winProbFromStats — shrinkage toward the prior', () => {
  test('a thin 70% is not treated as a known 70%', () => {
    const r = winProbFromStats({ h30: { winRate: 0.7, nTradeable: 20 } })
    expect(r.raw).toBe(0.7)
    expect(r.p).toBeCloseTo(0.6, 4)          // (14 + 10) / (20 + 20)
  })

  test('a well-measured rate is barely moved', () => {
    const r = winProbFromStats({ h30: { winRate: 0.7, nTradeable: 1500 } })
    expect(r.p).toBeGreaterThan(0.695)
  })

  test('size falls with the evidence: same raw rate, fewer picks, smaller position', () => {
    const size = n => suggestedSize({
      winProb: winProbFromStats({ h30: { winRate: 0.65, nTradeable: n } }).p,
      winFrac: 0.2, lossFrac: 0.1, fraction: 0.1, maxFraction: 1,   // uncapped, to compare
    }).suggestedPct
    expect(size(15)).toBeLessThan(size(500))
  })

  test('uses exact win counts when computeStats provides them', () => {
    const r = winProbFromStats({ h30: { winRate: 0.667, wins: 2, nTradeable: 3 } }, { minN: 1 })
    expect(r.p).toBeCloseTo(12 / 23, 4)
  })
})

describe('sizeIfCalibrated — no size off an assumed win rate', () => {
  test('the cold-start fallback gets no size, but keeps the same keys', () => {
    const s = sizeIfCalibrated(winProbFromStats(null), { winFrac: 0.14, lossFrac: 0.06 })
    expect(s).toMatchObject({ uncalibrated: true, suggestedPct: null, fullKellyPct: null })
    expect(s.reason).toMatch(/assumption/)
    // What it replaced: plain Kelly on the assumed 50% says "bet the cap".
    expect(suggestedSize({ winProb: 0.5, winFrac: 0.14, lossFrac: 0.06 }).suggestedPct).toBe(20)
  })

  test('a measured rate is sized normally', () => {
    const wp = winProbFromStats({ h30: { winRate: 0.6, nTradeable: 200 } })
    const s = sizeIfCalibrated(wp, { winFrac: 0.14, lossFrac: 0.06 })
    expect(s.uncalibrated).toBeUndefined()
    expect(s.suggestedPct).toBeGreaterThan(0)
  })
})
