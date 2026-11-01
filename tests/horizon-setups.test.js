'use strict'
/**
 * lib/horizon-setups.js — the AI Advisory "Trade Setup by Time Horizon" cards.
 *
 * Regression: AAPL at $344.63 with nearest "resistance" $346.02 produced a
 * swing TP1 of $346.02 × 0.99 = $342.56, below the entry (R/R −0.19:1), and the
 * card labelled TP1 "(+81% est.)" / the long-term one "(+250% est.)".
 */

const {
  generateHorizonSetups, longSetupProblem, swingTarget, roundPrice,
} = require('../lib/horizon-setups')

const byLabel = (setups, label) => setups.find(s => s.label === label)

// Coherence a valid long must satisfy, on the values the card shows.
function expectCoherentLong(s) {
  const lo = s.entryLow ?? s.entry
  const hi = s.entryHigh ?? s.entry
  expect(s.stop).toBeGreaterThan(0)
  expect(s.stop).toBeLessThan(lo)
  expect(s.tp1).toBeGreaterThan(hi)
  expect(s.tp2).toBeGreaterThanOrEqual(s.tp1)
  // Rounded to 2 dp: a target a few cents above the entry (price pressed just
  // under a resistance more than 1% away) reads 0.00 — never negative.
  expect(s.rr).toBeGreaterThanOrEqual(0)
  expect(s.stopPct).toBeGreaterThan(0)
  expect(s.tp1Pct).toBeGreaterThanOrEqual(0)
}

describe('swing target — only from resistance above the price', () => {
  test('AAPL regression: resistance within 1% of price falls back to the ATR target', () => {
    const price = 344.63, atr = 7.1
    const swing = byLabel(generateHorizonSetups(price, atr, [333.9], [346.02]), 'Swing Trade')
    expect(swing.valid).toBe(true)
    expect(swing.tp1).toBeCloseTo(price + atr * 2.5, 2)   // 362.38, not 342.56
    expect(swing.targetSource).toBe('atr')
    expect(swing.note).toMatch(/\$346\.02/)               // the overhead level is named
    expectCoherentLong(swing)
  })

  test('skips a resistance too close to clear and uses the next level up', () => {
    const t = swingTarget(344.63, 7.1, [346.02, 352])
    expect(t.source).toBe('resistance')
    expect(t.level).toBe(352)
    expect(t.tp1).toBeCloseTo(352 * 0.99, 6)
    expect(t.bypassed).toEqual([346.02])
  })

  test('resistance comfortably above the price caps the target just under it', () => {
    const swing = byLabel(generateHorizonSetups(100, 4, [95], [105]), 'Swing Trade')
    expect(swing.tp1).toBeCloseTo(103.95, 2)              // 105 × 0.99 < 100 + 2.5 × 4
    expect(swing.targetSource).toBe('resistance')
  })

  test('resistance beyond the ATR target leaves the ATR target in charge', () => {
    const t = swingTarget(100, 2, [130])
    expect(t.source).toBe('atr')
    expect(t.tp1).toBeCloseTo(105, 6)
  })

  test('resistance at or below the price (already broken) is ignored', () => {
    for (const r of [100, 99, 98.5]) {
      const t = swingTarget(100, 2, r)
      expect(t.source).toBe('atr')
      expect(t.tp1).toBeCloseTo(105, 6)
    }
  })

  test('a single number is accepted as well as a nearest-first list', () => {
    const a = generateHorizonSetups(100, 4, 95, 105)
    const b = generateHorizonSetups(100, 4, [95, 90], [105, 120])
    expect(byLabel(a, 'Swing Trade').tp1).toBe(byLabel(b, 'Swing Trade').tp1)
  })
})

describe('validation — never a long whose target ≤ entry or stop ≥ entry', () => {
  test('every valid setup is coherent across a grid of prices, ATRs and levels', () => {
    let seed = 7
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    let checked = 0
    for (let i = 0; i < 3000; i++) {
      const price = 0.05 + rand() * 900
      const atr   = price * (0.001 + rand() * 0.2)
      const lv    = () => Array.from({ length: 4 }, () => price * (0.85 + rand() * 0.3))
      const sup   = lv().sort((a, b) => b - a)
      const res   = lv().sort((a, b) => a - b)
      for (const s of generateHorizonSetups(price, atr, sup, res)) {
        if (s.valid) { expectCoherentLong(s); checked++ }
        else {
          expect(typeof s.reason).toBe('string')
          expect([s.stop, s.tp1, s.tp2, s.rr]).toEqual([null, null, null, null])
        }
      }
    }
    expect(checked).toBeGreaterThan(5000)
  })

  test('missing or zero ATR → every horizon invalid, with a reason and no levels', () => {
    for (const atr of [0, -1, NaN, undefined, null]) {
      const setups = generateHorizonSetups(100, atr, [95], [110])
      expect(setups).toHaveLength(3)
      for (const s of setups) {
        expect(s.valid).toBe(false)
        expect(s.reason).toMatch(/could not be computed/)
        expect(s.tp1).toBeNull()
        expect(s.rr).toBeNull()
      }
    }
  })

  test('long-term stop that would be ≤ 0 (extreme volatility) is invalid', () => {
    const lt = byLabel(generateHorizonSetups(1, 0.4, [], []), 'Long-Term Investment')
    expect(lt.valid).toBe(false)
    expect(lt.reason).toMatch(/not a positive price/)
  })

  test('long-term stop inside the scale-in range (low volatility) is invalid, not shown', () => {
    // 4 × ATR = 1.2% < the 3% the range reaches below the price
    const lt = byLabel(generateHorizonSetups(100, 0.3, [99], [110]), 'Long-Term Investment')
    expect(lt.valid).toBe(false)
    expect(lt.reason).toMatch(/inside the entry range/)
  })

  test('longSetupProblem names each incoherence', () => {
    expect(longSetupProblem({ entry: 100, stop: 95, tp1: 110, tp2: 120 })).toBeNull()
    expect(longSetupProblem({ entry: 344.63, stop: 333.9, tp1: 342.56, tp2: 340 }))
      .toMatch(/Target \$342\.56 is not above entry \$344\.63/)
    expect(longSetupProblem({ entry: 100, stop: 100, tp1: 110 })).toMatch(/not below entry/)
    expect(longSetupProblem({ entry: 100, stop: 95, tp1: 110, tp2: 105 })).toMatch(/TP2/)
    expect(longSetupProblem({ entry: 100, entryLow: 97, entryHigh: 101, stop: 95, tp1: 100.5 }))
      .toMatch(/not above the entry range/)
  })

  test('sub-dollar prices keep enough precision that rounding cannot collapse a level onto the entry', () => {
    expect(roundPrice(0.00012346)).toBe(0.0001235)
    expect(roundPrice(344.634)).toBe(344.63)
    for (const s of generateHorizonSetups(0.0001234, 0.000005, [], [])) {
      expect(s.valid).toBe(true)
      expectCoherentLong(s)
    }
  })
})

describe('percent labels — measured from the entry, as percents', () => {
  test('TP / stop percents are (level − entry) / entry × 100', () => {
    const price = 344.63, atr = 7.1
    for (const s of generateHorizonSetups(price, atr, [333.9], [346.02])) {
      expect(s.tp1Pct).toBeCloseTo(((s.tp1 - price) / price) * 100, 2)
      expect(s.tp2Pct).toBeCloseTo(((s.tp2 - price) / price) * 100, 2)
      expect(s.stopPct).toBeCloseTo(((price - s.stop) / price) * 100, 2)
    }
  })

  test('long-term TP1 reads +15%, not the old +250% (and intraday not +250%)', () => {
    const [intraday, , lt] = generateHorizonSetups(100, 2, [95], [110])
    expect(lt.tp1Pct).toBe(15)
    expect(lt.tp2Pct).toBe(30)
    expect(intraday.tp1Pct).toBeCloseTo(2.4, 2)            // 1.2 × ATR at ATR = 2%
  })

  test('long-term entry is a numeric range around the price', () => {
    const lt = byLabel(generateHorizonSetups(200, 4, [], []), 'Long-Term Investment')
    expect(lt.entry).toBe(200)
    expect(lt.entryLow).toBe(194)
    expect(lt.entryHigh).toBe(202)
  })
})
