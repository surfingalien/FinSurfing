'use strict'
/**
 * Unit tests for lib/fundamental-screen.js.
 *
 * The central claim under test: ranking by yield is not the same as ranking by
 * GOOD yield, and this module must produce the second. A high yield is usually
 * a falling price plus a dividend about to be cut, so an uncovered 12% must
 * rank BELOW a comfortably covered 3%.
 */

const {
  yieldReward, sustainability, scoreYield, scoreProfitability,
  riskFlags, scoreRow, rankCandidates, looksLikeFraction,
  YIELD_SATURATION, HIGH_YIELD_WARN, YIELD_ABSURD,
  PAYOUT_STRAINED, MIN_COVERAGE,
} = require('../lib/fundamental-screen')

/** A healthy dividend payer: covered, profitable, modestly levered. */
const SOLID = {
  symbol: 'SOLID', dividendYield: 3, payoutRatio: 45, fcfPayoutRatio: 55, debtToEquity: 90,
  roe: 28, roic: 18, netMargin: 22, operatingMargin: 26, fcfMargin: 20,
}

/** The classic value trap: enormous yield, nothing behind it. */
const TRAP = {
  symbol: 'TRAP', dividendYield: 12, payoutRatio: 140, fcfPayoutRatio: 160, debtToEquity: 260,
  roe: 4, roic: 2, netMargin: 2, operatingMargin: 3, fcfMargin: 1,
}

describe('yieldReward — reward, then discount', () => {
  test('rises to full reward at the saturation point', () => {
    expect(yieldReward(0)).toBe(0)
    expect(yieldReward(YIELD_SATURATION / 2)).toBe(50)
    expect(yieldReward(YIELD_SATURATION)).toBe(100)
  })

  test('holds full reward through the plateau', () => {
    expect(yieldReward(HIGH_YIELD_WARN)).toBe(100)
  })

  test('DECAYS past the warning level — the number is about the price by then', () => {
    expect(yieldReward(12)).toBeLessThan(100)
    expect(yieldReward(16)).toBeLessThan(yieldReward(12))
    expect(yieldReward(YIELD_ABSURD)).toBe(0)
    expect(yieldReward(40)).toBe(0)
  })

  test('no dividend and nonsense input score zero, not NaN', () => {
    expect(yieldReward(null)).toBe(0)
    expect(yieldReward(-3)).toBe(0)
    expect(yieldReward('lots')).toBe(0)
    expect(yieldReward(NaN)).toBe(0)
  })
})

describe('sustainability', () => {
  test('a comfortably covered payer scores 1', () => {
    expect(sustainability({ payoutRatio: 40, fcfPayoutRatio: 50, debtToEquity: 80 })).toBe(1)
  })

  test('a NEGATIVE payout ratio is the worst case, never a safe-looking small number', () => {
    // Negative earnings. Treating -20 as "below the ideal max" would score it
    // as the safest dividend on the screen.
    expect(sustainability({ payoutRatio: -20 })).toBe(0)
    expect(sustainability({ fcfPayoutRatio: -1 })).toBe(0)
  })

  test('paying out more than it earns degrades the factor', () => {
    const ok     = sustainability({ payoutRatio: 55 })
    const strain = sustainability({ payoutRatio: 120 })
    expect(strain).toBeLessThan(ok)
    expect(sustainability({ payoutRatio: 200 })).toBe(0)
  })

  test('leverage is a modifier, not a veto', () => {
    // A levered utility is not a levered startup, so debt alone never zeroes it.
    expect(sustainability({ debtToEquity: 900 })).toBeGreaterThanOrEqual(0.6)
  })

  test('nothing known about coverage returns null, not a confident 1', () => {
    expect(sustainability({})).toBeNull()
    expect(sustainability()).toBeNull()
  })
})

describe('the central claim', () => {
  test('an uncovered 12% yield ranks BELOW a covered 3% yield', () => {
    const trap  = scoreRow(TRAP)
    const solid = scoreRow(SOLID)
    expect(trap.composite).toBeLessThan(solid.composite)
  })

  test('…and that holds on the yield pillar alone, not just via profitability', () => {
    // If it only worked because SOLID is more profitable, the module would be
    // dodging the question it exists to answer.
    expect(scoreYield(TRAP).score).toBeLessThan(scoreYield(SOLID).score)
  })

  test('coverage, not size, is what separates them', () => {
    // Same 12% yield, but funded. Now it SHOULD win.
    const funded = { ...TRAP, payoutRatio: 40, fcfPayoutRatio: 50, debtToEquity: 70 }
    expect(scoreYield(funded).score).toBeGreaterThan(scoreYield(SOLID).score)
  })
})

describe('scoreYield', () => {
  test('a company that pays no dividend scores 0, which is a fact not a gap', () => {
    const r = scoreYield({ dividendYield: 0 })
    expect(r.score).toBe(0)
  })

  test('an unknown yield is null — absent is not zero', () => {
    expect(scoreYield({}).score).toBeNull()
  })

  test('with no coverage data the reward stands but coverage reports the doubt', () => {
    const r = scoreYield({ dividendYield: 3 })
    expect(r.score).toBe(50)
    expect(r.coverage).toBe(0.25)
  })
})

describe('scoreProfitability', () => {
  test('exceeding every reference level caps at 100', () => {
    expect(scoreProfitability(SOLID).score).toBe(100)
  })

  test('a loss-making business floors at 0 rather than going negative', () => {
    // A negative contribution would let one bad metric cancel genuine strength.
    const r = scoreProfitability({ roe: -40, roic: -30, netMargin: -25, operatingMargin: -20, fcfMargin: -15 })
    expect(r.score).toBe(0)
  })

  test('weights renormalise over the metrics actually supplied', () => {
    // ROE alone at exactly the reference level is a 100 on the one metric present.
    const r = scoreProfitability({ roe: 20 })
    expect(r.score).toBe(100)
    expect(r.coverage).toBe(0.2)
  })

  test('nothing supplied is null, not zero', () => {
    expect(scoreProfitability({}).score).toBeNull()
    expect(scoreProfitability().score).toBeNull()
  })
})

describe('riskFlags', () => {
  test('names the value trap specifically', () => {
    const codes = riskFlags(TRAP).map(f => f.code)
    expect(codes).toContain('value-trap-risk')
    expect(codes).toContain('unfunded-dividend')
    expect(codes).toContain('leveraged')
  })

  test('negative earnings is reported as such, not as a strained payout', () => {
    const codes = riskFlags({ dividendYield: 5, payoutRatio: -30 }).map(f => f.code)
    expect(codes).toContain('negative-earnings')
    expect(codes).not.toContain('strained-payout')
  })

  test('a healthy row raises nothing', () => {
    expect(riskFlags(SOLID)).toEqual([])
  })

  test('a high yield that IS covered is not flagged as a trap', () => {
    expect(riskFlags({ dividendYield: 10, payoutRatio: 50, fcfPayoutRatio: 60 })
      .map(f => f.code)).not.toContain('value-trap-risk')
  })

  test('the detail quantifies the claim', () => {
    expect(riskFlags(TRAP).find(f => f.code === 'unfunded-dividend').detail).toMatch(/160% of free cash flow/)
  })
})

describe('scoreRow', () => {
  test('flags a trap in the verdict without hiding its score', () => {
    const r = scoreRow(TRAP)
    expect(r.verdict).toBe('flagged')
    expect(typeof r.composite).toBe('number')
  })

  test('a growth stock with no dividend still ranks on profitability alone', () => {
    const r = scoreRow({ symbol: 'GROW', roe: 30, roic: 22, netMargin: 25, operatingMargin: 30, fcfMargin: 18 })
    expect(r.verdict).toBe('ok')
    expect(r.pillars).toBe(1)
    expect(r.composite).toBe(100)
  })

  test('a row with too little data is insufficient-data, never a low score', () => {
    // Ranking an unknown company below a measurably bad one is a claim the
    // data does not support.
    const r = scoreRow({ symbol: 'THIN', roe: 12 })
    expect(r.verdict).toBe('insufficient-data')
    expect(r.composite).toBeNull()
  })

  test('the coverage bar is what decides that', () => {
    expect(scoreProfitability({ roe: 12 }).coverage).toBeLessThan(MIN_COVERAGE)
    // Three of five metrics clears it.
    expect(scoreRow({ symbol: 'OK', roe: 12, roic: 10, netMargin: 8 }).verdict).toBe('ok')
  })

  test('weights shift the blend', () => {
    const yieldHeavy  = scoreRow(SOLID, { weights: { yield: 1, profitability: 0 } })
    const profitHeavy = scoreRow(SOLID, { weights: { yield: 0, profitability: 1 } })
    expect(yieldHeavy.composite).toBe(scoreYield(SOLID).score)
    expect(profitHeavy.composite).toBe(100)
  })

  test('malformed input does not throw', () => {
    expect(scoreRow({}).verdict).toBe('insufficient-data')
    expect(scoreRow().verdict).toBe('insufficient-data')
  })
})

describe('rankCandidates', () => {
  const rows = [SOLID, TRAP,
    { symbol: 'GROW', roe: 30, roic: 22, netMargin: 25, operatingMargin: 30, fcfMargin: 18 },
    { symbol: 'THIN', roe: 12 }]

  test('orders by composite and excludes what it cannot score', () => {
    const { ranked, excluded } = rankCandidates(rows)
    expect(ranked.map(r => r.symbol)).toEqual(['GROW', 'SOLID', 'TRAP'])
    expect(excluded).toEqual([{ symbol: 'THIN', reason: 'insufficient-data' }])
  })

  test('a clean row beats a flagged one at the same score', () => {
    const clean   = { symbol: 'CLEAN', roe: 20, roic: 15, netMargin: 15 }
    const flagged = { symbol: 'FLAG',  roe: 20, roic: 15, netMargin: 15,
                      dividendYield: 12, payoutRatio: 140, fcfPayoutRatio: 160 }
    const { ranked } = rankCandidates([flagged, clean], { weights: { yield: 0, profitability: 1 } })
    expect(ranked[0].symbol).toBe('CLEAN')
  })

  test('the limit is applied and the original row fields survive', () => {
    const { ranked } = rankCandidates(rows, { limit: 2 })
    expect(ranked).toHaveLength(2)
    expect(ranked[1]).toMatchObject({ symbol: 'SOLID', dividendYield: 3, payoutRatio: 45 })
  })

  test('a non-array and junk entries are well-formed, not a crash', () => {
    expect(rankCandidates(null).ranked).toEqual([])
    expect(rankCandidates([null, 'AAPL', 42, SOLID]).ranked.map(r => r.symbol)).toEqual(['SOLID'])
  })
})

describe('looksLikeFraction — the units guard', () => {
  test('catches a decimal that was never multiplied out', () => {
    // lib/price-coherence.js exists because a percentage reached a price field.
    expect(looksLikeFraction(0.032)).toBe(true)
    expect(looksLikeFraction(-0.5)).toBe(true)
  })

  test('a genuine percentage and zero pass', () => {
    expect(looksLikeFraction(3.2)).toBe(false)
    expect(looksLikeFraction(0)).toBe(false)
    expect(looksLikeFraction(null)).toBe(false)
    expect(looksLikeFraction(100)).toBe(false)
  })
})
