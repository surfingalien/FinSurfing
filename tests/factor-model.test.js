'use strict'
/**
 * Unit tests for lib/factor-model.js — deterministic multi-factor scores.
 */

const { factorScores, factorLine, momentumScore, trendScore, lowVolScore, valueScore } = require('../lib/factor-model')

// Steady uptrend: +0.3%/day compounding, tiny oscillation for realism
function uptrend(n = 250) {
  const closes = []
  let p = 100
  for (let i = 0; i < n; i++) { p *= 1.003; closes.push(p * (1 + 0.001 * Math.sin(i))) }
  return closes
}

// Steady downtrend: −0.3%/day
function downtrend(n = 250) {
  const closes = []
  let p = 100
  for (let i = 0; i < n; i++) { p *= 0.997; closes.push(p) }
  return closes
}

describe('momentumScore', () => {
  test('uptrend scores high, downtrend low, both bounded 0-100', () => {
    const up = momentumScore(uptrend())
    const dn = momentumScore(downtrend())
    expect(up).toBeGreaterThan(70)
    expect(dn).toBeLessThan(30)
    expect(up).toBeLessThanOrEqual(100)
    expect(dn).toBeGreaterThanOrEqual(0)
  })
  test('needs ≥21 closes', () => {
    expect(momentumScore(uptrend(15))).toBeNull()
    expect(momentumScore(null)).toBeNull()
  })
})

describe('trendScore', () => {
  test('price above rising EMAs scores high; falling stack scores low', () => {
    const closes = uptrend()
    const up = trendScore(closes, closes.map(c => c * 1.005), closes.map(c => c * 0.995))
    expect(up).toBeGreaterThanOrEqual(80)
    const d = downtrend()
    const dn = trendScore(d, d.map(c => c * 1.005), d.map(c => c * 0.995))
    expect(dn).toBeLessThanOrEqual(20)
  })
  test('works without highs/lows (no ADX check) and needs ≥60 closes', () => {
    expect(trendScore(uptrend(), null, null)).not.toBeNull()
    expect(trendScore(uptrend(40))).toBeNull()
  })
})

describe('lowVolScore', () => {
  test('calm series scores higher than a violent one', () => {
    const calm = uptrend()                              // ~ tiny daily moves
    const wild = uptrend().map((c, i) => c * (1 + 0.05 * Math.sin(i * 2)))  // ±5% swings
    expect(lowVolScore(calm)).toBeGreaterThan(lowVolScore(wild))
    expect(lowVolScore(wild)).toBeGreaterThanOrEqual(0)
  })
  test('needs ≥30 closes', () => {
    expect(lowVolScore(uptrend(20))).toBeNull()
  })
})

describe('valueScore', () => {
  test('low P/E scores high, high P/E low, log-linear in between', () => {
    expect(valueScore(5)).toBe(100)
    expect(valueScore(60)).toBe(0)
    expect(valueScore(17)).toBeGreaterThan(valueScore(30))
  })
  test('null for missing or negative earnings', () => {
    expect(valueScore(null)).toBeNull()
    expect(valueScore(-12)).toBeNull()
    expect(valueScore(0)).toBeNull()
    expect(valueScore(NaN)).toBeNull()
  })
})

describe('factorScores / factorLine', () => {
  test('composite averages the available factors; value omitted without pe', () => {
    const closes = uptrend()
    const s = factorScores({ closes, highs: closes.map(c => c * 1.005), lows: closes.map(c => c * 0.995) })
    expect(s.value).toBeNull()
    expect(s.composite).not.toBeNull()
    const present = [s.momentum, s.trend, s.lowVol]
    expect(s.composite).toBe(Math.round(present.reduce((a, b) => a + b, 0) / present.length))
  })

  test('factorLine renders only computed factors and always includes comp', () => {
    const s = factorScores({ closes: uptrend(), pe: 17 })
    const line = factorLine(s)
    expect(line).toMatch(/^FACTORS /)
    expect(line).toContain(`mom=${s.momentum}`)
    expect(line).toContain(`val=${s.value}`)
    expect(line).toContain(`comp=${s.composite}`)
  })

  test('factorLine null when nothing could be computed', () => {
    expect(factorLine(factorScores({}))).toBeNull()
    expect(factorLine(null)).toBeNull()
  })

  test('deterministic: identical inputs give identical scores', () => {
    const args = { closes: uptrend(), pe: 22 }
    expect(factorScores(args)).toEqual(factorScores(args))
  })
})
