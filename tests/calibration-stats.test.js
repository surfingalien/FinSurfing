'use strict'

const {
  wilson, shrinkRate, binomialPValue, benjaminiHochberg, validateThreshold, normCdf,
} = require('../lib/calibration-stats')

// Deterministic PRNG so the noise tests are replayable.
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('wilson', () => {
  test('matches the textbook interval', () => {
    // 8/10 → [0.490, 0.943] (standard reference value)
    expect(wilson(8, 10)).toEqual({ lo: 0.49, hi: 0.943 })
  })
  test('stays inside [0,1] at the extremes, where the normal approximation breaks', () => {
    expect(wilson(0, 5).lo).toBe(0)
    expect(wilson(0, 5).hi).toBeGreaterThan(0.4)       // 0/5 does not prove 0%
    expect(wilson(5, 5).hi).toBe(1)
    expect(wilson(5, 5).lo).toBeLessThan(0.6)          // 5/5 does not prove 100%
  })
  test('narrows as n grows at the same rate', () => {
    const w = x => x.hi - x.lo
    expect(w(wilson(60, 100))).toBeLessThan(w(wilson(6, 10)))
  })
  test('no data is no interval, not a zero-width one', () => {
    expect(wilson(0, 0)).toEqual({ lo: null, hi: null })
  })
})

describe('shrinkRate', () => {
  test('is the prior with no data and converges on the measured rate', () => {
    expect(shrinkRate(0, 0)).toBe(0.5)
    expect(shrinkRate(9, 15)).toBeCloseTo((9 + 10) / 35, 10)       // 60% on 15 → ~54%
    expect(shrinkRate(600, 1000)).toBeCloseTo(0.598, 3)
  })
  test('moves smoothly — no jump from fallback to measured at a sample floor', () => {
    const a = shrinkRate(8, 14), b = shrinkRate(9, 15)
    expect(Math.abs(a - b)).toBeLessThan(0.02)
  })
})

describe('binomialPValue / benjaminiHochberg', () => {
  test('normCdf is accurate', () => {
    expect(normCdf(0)).toBeCloseTo(0.5, 6)
    expect(normCdf(1.96)).toBeCloseTo(0.975, 3)
  })
  test('a real difference is significant, a small one is not', () => {
    expect(binomialPValue(80, 100, 0.5)).toBeLessThan(0.001)
    expect(binomialPValue(6, 10, 0.5)).toBeGreaterThan(0.4)
  })
  test('BH keeps the genuinely small p-values and drops the rest', () => {
    expect(benjaminiHochberg([0.001, 0.8, 0.02, 0.5], 0.10)).toEqual([true, false, true, false])
  })
  test('one lucky segment among many does not survive', () => {
    const ps = [0.04, ...Array(19).fill(0.6)]      // p=0.04 would pass alone
    expect(benjaminiHochberg(ps, 0.10).some(Boolean)).toBe(false)
  })
})

describe('validateThreshold', () => {
  const noise = (n, seed) => {
    const rnd = mulberry32(seed)
    return Array.from({ length: n }, (_, i) => ({ t: i, score: 30 + Math.floor(rnd() * 60), win: rnd() < 0.5 }))
  }

  test('on coin-flip outcomes the OLD in-sample search reports an edge; validation rejects it', () => {
    // The previous computeStats(): try every cutoff on ALL rows, keep the best.
    const oldSearch = rows => {
      let best = null
      for (let t = 35; t <= 85; t += 5) {
        const above = rows.filter(r => r.score >= t)
        if (above.length < 5) continue
        const r = above.filter(x => x.win).length / above.length
        if (best == null || r > best) best = r
      }
      return best
    }
    let oldSum = 0, adopted = 0
    const trials = 200
    for (let s = 1; s <= trials; s++) {
      const rows = noise(60, s)
      oldSum += oldSearch(rows)
      if (validateThreshold(rows).validated) adopted++
    }
    // True rate is 50% everywhere; the old search reports well above it.
    expect(oldSum / trials).toBeGreaterThan(0.56)
    // Validation adopts a cutoff on noise only rarely (≈ its 2.5% one-sided error).
    expect(adopted / trials).toBeLessThan(0.06)
  })

  test('a real, persistent separation is adopted', () => {
    const rows = Array.from({ length: 120 }, (_, i) => ({ t: i, score: i % 2 ? 80 : 40, win: i % 2 === 1 }))
    const v = validateThreshold(rows)
    expect(v.validated).toBe(true)
    expect(v.threshold).toBeGreaterThan(40)
    expect(v.holdout.rate).toBe(1)
  })

  test('the holdout is the NEWEST rows — an edge that decayed is rejected', () => {
    const rows = Array.from({ length: 120 }, (_, i) => {
      const high = i % 2 === 1
      return { t: i, score: high ? 80 : 40, win: i < 84 ? high : !high }
    })
    // Shuffle input order: the split must come from t, not array position.
    rows.reverse()
    const v = validateThreshold(rows)
    expect(v.train.rate).toBe(1)
    expect(v.validated).toBe(false)
    expect(v.threshold).toBe(null)
  })

  test('explains itself when there is not enough data', () => {
    expect(validateThreshold([]).reason).toMatch(/insufficient data/)
    expect(validateThreshold(null).threshold).toBe(null)
  })
})
