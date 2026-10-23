'use strict'

const hrp = require('../lib/hrp')

// Deterministic noise.
function rng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return (((t ^ (t >>> 14)) >>> 0) / 4294967296) - 0.5 } }
const DAY = 86_400_000
const T0 = Date.UTC(2026, 0, 5)
const barsFrom = rets => { let p = 100; return [{ t: T0, c: 100 }, ...rets.map((r, i) => ({ t: T0 + (i + 1) * DAY, c: (p *= 1 + r) }))] }

test('five near-identical names share one branch; an independent name keeps its own', () => {
  const common = rng(1), n = 150
  const factor = Array.from({ length: n }, () => common() * 0.04)
  const semis = Object.fromEntries(['NVDA', 'AMD', 'AVGO', 'MU', 'TSM'].map((s, k) => {
    const own = rng(10 + k)
    return [s, barsFrom(factor.map(f => f + own() * 0.004))]
  }))
  const gold = rng(99)
  const bars = { ...semis, GLD: barsFrom(Array.from({ length: n }, () => gold() * 0.04)) }
  const out = hrp.hrpWeights(hrp.alignReturns(bars))
  const total = Object.values(out.weights).reduce((a, b) => a + b, 0)
  expect(total).toBeCloseTo(1, 9)
  const semiTotal = ['NVDA', 'AMD', 'AVGO', 'MU', 'TSM'].reduce((a, s) => a + out.weights[s], 0)
  // Equal weighting would give the semis 5/6 of the money; HRP gives them about one branch.
  expect(semiTotal).toBeLessThan(0.65)
  expect(out.weights.GLD).toBeGreaterThan(0.35)
  // and the correlated names sit together in the order
  const pos = out.order.indexOf('GLD')
  expect(pos === 0 || pos === out.order.length - 1).toBe(true)
})

test('a lower-volatility name gets more weight than an equally-uncorrelated jumpy one', () => {
  const a = rng(3), b = rng(4)
  const out = hrp.hrpWeights(hrp.alignReturns({
    CALM:  barsFrom(Array.from({ length: 120 }, () => a() * 0.01)),
    JUMPY: barsFrom(Array.from({ length: 120 }, () => b() * 0.05)),
  }))
  expect(out.weights.CALM).toBeGreaterThan(out.weights.JUMPY * 5)
})

test('alignment uses only dates every series has; too little history or one name gives no allocation', () => {
  const x = barsFrom(Array(80).fill(0.001)), y = barsFrom(Array(80).fill(-0.001)).filter((_, i) => i % 2 === 0)
  expect(hrp.alignReturns({ X: x, Y: y }).returns.length).toBe(40)
  expect(hrp.hrpWeights(hrp.alignReturns({ X: x, Y: barsFrom(Array(30).fill(0.002)) }))).toBeNull()
  expect(hrp.hrpWeights(hrp.alignReturns({ X: x }))).toBeNull()
})
