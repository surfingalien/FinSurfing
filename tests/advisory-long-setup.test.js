'use strict'
/**
 * lib/horizon-setups.js:advisoryLongSetup — the bullish trade setup of the
 * Quantitative Advisory Engine (src/services/research.js:generateAdvisory).
 *
 * Regression: entry zone price×0.97 (or just above support) to price×1.005, R
 * measured from the BOTTOM of the zone, TP1 = min(1.5R target, nearest
 * resistance × 0.995). A resistance in (price, price / 0.995] put TP1 at or
 * under the price — under the top of the zone, so a fill there had its target
 * below its entry — and riskReward was quoted only for a fill at the bottom.
 */

const {
  advisoryLongSetup, targetUnderResistance, longSetupProblem, swingTarget,
} = require('../lib/horizon-setups')

// The formula generateAdvisory used before this change, for the regressions.
function oldBullishTp1(price, atr, support, resistance) {
  const s = support[0], r = resistance[0]
  const entryLow = s ? Math.max(s * 0.998, price * 0.97) : price * 0.97
  const stop     = s ? Math.min(s * 0.985, price - atr * 1.5) : price - atr * 1.5
  let tp1 = entryLow + (entryLow - stop) * 1.5
  if (r && r > price) tp1 = Math.min(tp1, r * 0.995)
  return tp1
}

// What a valid long must satisfy, on the values the card shows.
function expectCoherent(s) {
  expect(s.valid).toBe(true)
  expect(s.reason).toBeNull()
  expect(s.stop).toBeGreaterThan(0)
  expect(s.stop).toBeLessThan(s.entryLow)
  expect(s.entryLow).toBeLessThanOrEqual(s.entry)
  expect(s.entry).toBeLessThanOrEqual(s.entryHigh)
  expect(s.tp1).toBeGreaterThan(s.entryHigh)
  expect(s.tp2).toBeGreaterThanOrEqual(s.tp1)
  expect(s.riskReward).toBeGreaterThanOrEqual(0)
  expect(s.riskRewardBest).toBeGreaterThanOrEqual(s.riskReward)
}

describe('TP1 — resistance caps it only above the top of the entry zone', () => {
  test('regression: resistance in (price, price/0.995] no longer puts TP1 under the price', () => {
    const price = 100, atr = 2, support = [96], resistance = [100.3, 108]
    expect(oldBullishTp1(price, atr, support, resistance)).toBeLessThan(price)   // 99.80

    const s = advisoryLongSetup({ price, atr, support, resistance })
    expectCoherent(s)
    expect(s.targetSource).toBe('resistance')
    expect(s.targetLevel).toBe(108)                 // the next level up
    expect(s.tp1).toBeCloseTo(108 * 0.995, 2)       // 107.46
    expect(s.bypassed).toEqual([100.3])             // named: the target assumes a break above it
  })

  test('a level whose buffered target lands inside the entry zone is skipped too', () => {
    // 100.8 × 0.995 = 100.30: above the price, but under the zone top (100.50)
    const s = advisoryLongSetup({ price: 100, atr: 2, support: [96], resistance: [100.8] })
    expectCoherent(s)
    expect(s.targetSource).toBe('r-multiple')
    expect(s.bypassed).toEqual([100.8])
  })

  test('with no level clearing the zone, the 1.5R target from the top of the zone stands', () => {
    const s = advisoryLongSetup({ price: 100, atr: 2, support: [96], resistance: [100.2, 99.5] })
    expectCoherent(s)
    expect(s.targetSource).toBe('r-multiple')
    const risk = s.entryHigh - s.stop
    expect(s.tp1).toBeCloseTo(s.entryHigh + 1.5 * risk, 2)
    expect(s.tp2).toBeCloseTo(s.entryHigh + 2.5 * risk, 2)
    expect(s.riskReward).toBeCloseTo(1.5, 1)        // by construction at the worst fill
  })

  test('a resistance under the price is ignored, not used as a target', () => {
    const s = advisoryLongSetup({ price: 100, atr: 2, support: [96], resistance: [98.5] })
    expectCoherent(s)
    expect(s.targetSource).toBe('r-multiple')
    expect(s.bypassed).toEqual([])
  })

  test('resistance comfortably above the zone and under the 1.5R target caps it', () => {
    const s = advisoryLongSetup({ price: 100, atr: 2, support: [96], resistance: [104] })
    expectCoherent(s)
    expect(s.targetSource).toBe('resistance')
    expect(s.tp1).toBeCloseTo(104 * 0.995, 2)
  })

  test('regression: support a few % down with a low ATR no longer puts the 1.5R target under the price', () => {
    // R from the bottom of the zone: 97.80 − 96.53 = 1.27 → TP1 99.70, under the price
    const price = 100, atr = 1.2, support = [98], resistance = []
    expect(oldBullishTp1(price, atr, support, resistance)).toBeLessThan(price)
    const s = advisoryLongSetup({ price, atr, support, resistance })
    expectCoherent(s)
    expect(s.tp1).toBeGreaterThan(price * 1.005)
  })
})

describe('support and stop', () => {
  test('a support above the price does not lift the zone over its top; the next one below is used', () => {
    // 101 × 0.998 = 100.80 would have been the zone bottom, over the 100.50 top
    const s = advisoryLongSetup({ price: 100, atr: 2, support: [101, 96], resistance: [] })
    expectCoherent(s)
    expect(s.support).toBe(96)
    expect(s.entryLow).toBe(97)                      // max(96 × 0.998, 97)
  })

  test('stop is the lower of support × 0.985 and price − 1.5×ATR', () => {
    const a = advisoryLongSetup({ price: 100, atr: 2, support: [96], resistance: [] })
    expect(a.stop).toBeCloseTo(96 * 0.985, 2)        // 94.56 < 97
    expect(a.stopSource).toBe('support')
    const b = advisoryLongSetup({ price: 100, atr: 4, support: [96], resistance: [] })
    expect(b.stop).toBe(94)                          // 100 − 6 < 94.56
    expect(b.stopSource).toBe('atr')
  })
})

describe('risk/reward — quoted for both ends of the entry zone', () => {
  test('riskReward is the fill at the top, riskRewardBest the fill at the bottom', () => {
    const s = advisoryLongSetup({ price: 100, atr: 2, support: [96], resistance: [104] })
    expect(s.riskReward).toBeCloseTo((s.tp1 - s.entryHigh) / (s.entryHigh - s.stop), 2)
    expect(s.riskRewardBest).toBeCloseTo((s.tp1 - s.entryLow) / (s.entryLow - s.stop), 2)
    expect(s.riskPerShare).toBeCloseTo(s.entryHigh - s.stop, 2)
  })

  test('percents are measured from the price', () => {
    const s = advisoryLongSetup({ price: 250, atr: 5, support: [240], resistance: [270] })
    expect(s.tp1Pct).toBeCloseTo(((s.tp1 - 250) / 250) * 100, 2)
    expect(s.tp2Pct).toBeCloseTo(((s.tp2 - 250) / 250) * 100, 2)
    expect(s.stopPct).toBeCloseTo(((250 - s.stop) / 250) * 100, 2)
  })
})

describe('invalid setups — a reason and no levels', () => {
  test('no support and a low ATR: the stop lands inside the entry zone', () => {
    // 100 − 1.5 × 1 = 98.50, above the 97.00 zone bottom
    const s = advisoryLongSetup({ price: 100, atr: 1, support: [], resistance: [110] })
    expect(s.valid).toBe(false)
    expect(s.reason).toMatch(/inside the entry range/)
    expect([s.stop, s.tp1, s.tp2, s.riskReward, s.riskRewardBest]).toEqual([null, null, null, null, null])
  })

  test('missing or non-positive ATR / price → could not be computed', () => {
    for (const [price, atr] of [[100, 0], [100, NaN], [100, undefined], [0, 2], [NaN, 2], [null, 2]]) {
      const s = advisoryLongSetup({ price, atr, support: [95], resistance: [110] })
      expect(s.valid).toBe(false)
      expect(s.reason).toMatch(/could not be computed/)
      expect(s.tp1).toBeNull()
    }
  })

  test('extreme volatility: a stop at or under zero is invalid', () => {
    const s = advisoryLongSetup({ price: 1, atr: 0.8, support: [], resistance: [] })
    expect(s.valid).toBe(false)
    expect(s.reason).toMatch(/not a positive price/)
  })
})

describe('coherence sweep', () => {
  test('every valid setup is coherent; every invalid one has a reason and no levels', () => {
    let seed = 11
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    let valid = 0, invalid = 0, oldBad = 0
    for (let i = 0; i < 5000; i++) {
      const price = 0.05 + rand() * 900
      const atr   = price * (0.003 + rand() * 0.08)
      const lv    = (lo, hi) => Array.from({ length: 1 + Math.floor(rand() * 4) }, () => price * (lo + rand() * (hi - lo)))
      // findKeyLevels' windows: support ≤ 102% of the price, resistance ≥ 98%
      const support    = lv(0.8, 1.02).sort((a, b) => b - a)
      const resistance = lv(0.98, 1.25).sort((a, b) => a - b)
      if (oldBullishTp1(price, atr, support, resistance) <= price * 1.005) oldBad++
      const s = advisoryLongSetup({ price, atr, support, resistance })
      if (s.valid) { expectCoherent(s); valid++ }
      else {
        invalid++
        expect(typeof s.reason).toBe('string')
        expect([s.stop, s.tp1, s.tp2, s.riskReward]).toEqual([null, null, null, null])
      }
    }
    expect(oldBad).toBeGreaterThan(500)              // the old formula failed often on these inputs
    expect(valid).toBeGreaterThan(invalid * 4)       // the new one mostly produces a setup
  })
})

describe('shared helpers', () => {
  test('targetUnderResistance: floor defaults to the price; a higher floor skips more levels', () => {
    const atPrice = targetUnderResistance({ price: 100, target: 110, resistance: [101, 105], buffer: 0.995 })
    expect(atPrice.level).toBe(101)                  // 100.495 > 100
    const atTop = targetUnderResistance({ price: 100, floor: 100.5, target: 110, resistance: [101, 105], buffer: 0.995 })
    expect(atTop.level).toBe(105)                    // 100.495 ≤ 100.5
    expect(atTop.bypassed).toEqual([101])
    expect(atTop.source).toBe('resistance')
  })

  test('swingTarget keeps its behaviour through the shared helper', () => {
    expect(swingTarget(344.63, 7.1, [346.02, 352])).toEqual({
      tp1: 352 * 0.99, source: 'resistance', level: 352, bypassed: [346.02],
    })
    expect(swingTarget(100, 2, [130]).source).toBe('atr')
  })

  test('longSetupProblem checks every entry: an inverted range, or a price outside it', () => {
    expect(longSetupProblem({ entry: 100, entryLow: 100.8, entryHigh: 100.5, stop: 95, tp1: 110, tp2: 120 }))
      .toMatch(/inverted/)
    // price above the range top: a target between the range top and the price is under an entry
    expect(longSetupProblem({ entry: 100, entryLow: 97, entryHigh: 99, stop: 95, tp1: 99.5, tp2: 120 }))
      .toMatch(/Target \$99\.50 is not above entry \$100\.00/)
    // price below the range bottom: a stop between them is above an entry
    expect(longSetupProblem({ entry: 100, entryLow: 101, entryHigh: 102, stop: 100.5, tp1: 110, tp2: 120 }))
      .toMatch(/Stop \$100\.50 is not below entry \$100\.00/)
  })
})
