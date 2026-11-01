'use strict'
const { diversify } = require('../lib/slate-diversify')
const L = require('../lib/quant/linalg')

const T0 = Date.UTC(2025, 0, 2)
function slate({ n = 4, common = 0.9, seed = 1, days = 200 } = {}) {
  const g = L.rng(seed), m = Array.from({ length: days }, () => 0.012 * g.normal())
  const out = {}
  for (let k = 0; k < n; k++) {
    let p = 100
    out[`S${k}`] = m.map((x, i) => ({ t: T0 + i * 864e5, c: (p *= Math.exp(common * x + Math.sqrt(1 - common * common) * 0.012 * g.normal())) }))
  }
  return out
}

test('names that move together are named, and the slate counts as fewer bets', () => {
  const d = diversify(slate({ n: 5, common: 0.95 }))
  expect(d.avgCorrelation).toBeGreaterThan(0.8)
  expect(d.effectiveBets).toBeLessThan(1.5)
  expect(d.movesWith.S0.length).toBe(4)
  expect(Object.values(d.weights).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 6)
})
test('independent names are not flagged and count as close to one bet each', () => {
  const d = diversify(slate({ n: 5, common: 0, seed: 3 }))
  expect(Object.keys(d.movesWith)).toHaveLength(0)
  expect(d.effectiveBets).toBeGreaterThan(4)
})
test('too little shared history gives nothing rather than a guess', () => {
  expect(diversify(slate({ n: 3, days: 20 }))).toBeNull()
  expect(diversify({ A: slate().S0 })).toBeNull()
})
