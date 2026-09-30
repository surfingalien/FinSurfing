'use strict'

const { atr, levelInputs, tradeLevels } = require('../lib/trade-levels')

const DAY = 86400000
const t0 = Date.UTC(2026, 0, 2)

describe('atr', () => {
  test('constant 2-point daily range gives ATR 2', () => {
    const bars = Array.from({ length: 30 }, (_, i) => ({ t: t0 + i * DAY, h: 101, l: 99, c: 100 }))
    expect(atr(bars)).toBeCloseTo(2, 6)
  })
  test('too few bars is null, not zero', () => {
    expect(atr([{ h: 1, l: 1, c: 1 }])).toBeNull()
  })
})

describe('levelInputs', () => {
  test('support/resistance come from the recent window; price and date from the last bar', () => {
    const bars = Array.from({ length: 60 }, (_, i) => ({ t: t0 + i * DAY, h: 100 + i + 1, l: 100 + i - 1, c: 100 + i }))
    const li = levelInputs(bars)
    expect(li.price).toBe(159)
    expect(li.support).toBe(139)       // lowest low of the last 20 bars
    expect(li.resistance).toBe(160)
    expect(li.asOf).toBe(new Date(bars.at(-1).t).toISOString().slice(0, 10))
  })
})

describe('tradeLevels — thesis mode', () => {
  test('levels follow from the percentages, with a partial-booking level halfway', () => {
    const L = tradeLevels({ price: 100, atr: 2, targetReturn: 20, stopLoss: 8 })
    expect(L.basis).toBe('thesis')
    expect(L.entry).toMatchObject({ low: 98, high: 102, mid: 100 })
    expect(L.stop.price).toBe(92)
    expect(L.booking[0].price).toBe(110)
    expect(L.booking[1].price).toBe(120)
    expect(L.booking[1].r).toBe(2.5)
  })

  test('a stop inside one ATR is flagged as noise-level', () => {
    const L = tradeLevels({ price: 100, atr: 4, targetReturn: 10, stopLoss: 2 })
    expect(L.notes.join(' ')).toMatch(/normal day-to-day noise/)
  })
})

describe('tradeLevels — technical reference mode (no actionable thesis)', () => {
  test('entry near support within one ATR, stop below both, booking at 1.5R and 3R', () => {
    const L = tradeLevels({ price: 100, atr: 3, support: 98, resistance: 104 })
    expect(L.basis).toBe('technical')
    expect(L.entry.low).toBe(98)
    expect(L.entry.high).toBe(100)
    expect(L.stop.price).toBeLessThan(98)
    const risk = L.entry.mid - L.stop.price
    expect(L.booking[0].price).toBeCloseTo(L.entry.mid + 1.5 * risk, 2)
    expect(L.booking[1].price).toBeCloseTo(L.entry.mid + 3 * risk, 2)
  })

  test('support further than one ATR away is not chased — entry floor is price − ATR', () => {
    const L = tradeLevels({ price: 100, atr: 2, support: 90, resistance: 110 })
    expect(L.entry.low).toBe(98)
  })

  test('warns when a recent high caps the first booking level', () => {
    const L = tradeLevels({ price: 100, atr: 2, support: 99, resistance: 101 })
    expect(L.notes.join(' ')).toMatch(/may cap it/)
  })

  test('no volatility measure means no reference levels rather than made-up ones', () => {
    expect(tradeLevels({ price: 100 })).toBeNull()
    expect(tradeLevels({ price: 0, atr: 2 })).toBeNull()
  })
})
