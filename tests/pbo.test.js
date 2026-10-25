'use strict'
// Probability of backtest overfitting (CSCV): is "pick the best backtest" picking luck?

const { pbo, halves, rankOf } = require('../lib/pbo')
const { attachPbo } = require('../lib/strategy-lab')

function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }
const gauss = r => Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r())
const series = (T, mu, r) => Array.from({ length: T }, () => mu + 0.01 * gauss(r))

test('the splits are every half of the blocks; ranks average ties', () => {
  expect([...halves(8)]).toHaveLength(70)
  expect([...halves(4)]).toEqual([[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]])
  expect(rankOf(2, [1, 2, 2, 3])).toBe(2.5)
})

test('pure noise: picking the best backtest is a coin toss (PBO near 0.5)', () => {
  const vals = []
  for (let seed = 1; seed <= 12; seed++) {
    const r = rng(seed * 101)
    vals.push(pbo(Array.from({ length: 10 }, () => series(800, 0, r))).pbo)
  }
  const mean = vals.reduce((a, v) => a + v, 0) / vals.length
  expect(mean).toBeGreaterThan(0.3)
  expect(mean).toBeLessThan(0.7)
})

test('one genuine edge among noise is picked and holds out of sample (PBO near 0)', () => {
  const r = rng(7)
  const out = pbo([series(800, 0.002, r), ...Array.from({ length: 9 }, () => series(800, 0, r))])
  expect(out.pbo).toBeLessThan(0.1)
  expect(out.lossRate).toBeLessThan(0.1)
  expect(out.overfit).toBe(false)
})

test('a batch of similar GOOD strategies is not called overfit, although the pick among them is a coin toss', () => {
  const r = rng(11)
  const out = pbo(Array.from({ length: 8 }, () => series(800, 0.002, r)))
  expect(out.pbo).toBeGreaterThan(0.2)        // which one is best is luck…
  expect(out.lossRate).toBeLessThan(0.1)      // …but the one picked still made money
  expect(out.overfit).toBe(false)
})

test('strategies that only ever fit their own stretch of history: the in-sample best loses out of sample', () => {
  // Each wins in exactly half of the 8 blocks and loses in the rest — zero edge overall.
  const r = rng(13), T = 800, size = T / 8
  const cands = Array.from({ length: 12 }, () => {
    const order = [0, 1, 2, 3, 4, 5, 6, 7].sort(() => r() - 0.5), good = new Set(order.slice(0, 4))
    return Array.from({ length: T }, (_, t) => (good.has(Math.floor(t / size)) ? 0.003 : -0.003) + 0.005 * gauss(r))
  })
  const out = pbo(cands)
  expect(out.pbo).toBeGreaterThan(0.5)
  expect(out.lossRate).toBeGreaterThan(0.5)
  expect(out.degradation).toBeLessThan(0)     // the better it looked in sample, the worse out of sample
  expect(out.overfit).toBe(true)
})

test('too few candidates or too short a history: no verdict', () => {
  const r = rng(3)
  expect(pbo([series(800, 0, r)])).toBeNull()
  expect(pbo([series(50, 0, r), series(50, 0, r)])).toBeNull()
  expect(pbo([series(100, 0, r), series(100, 0, r)], { blocks: 7 })).toBeNull()   // odd block count
})

test('a batch: proposals that failed count as flat trials, and per-bar returns never leave the batch', () => {
  const r = rng(5)
  const items = [{ returns: series(400, 0.002, r) }, { returns: series(400, 0, r) }, { metrics: null }]
  const out = attachPbo(items)
  expect(out.candidates).toBe(3)
  expect(items.every(i => i.pbo === out && !('returns' in i))).toBe(true)
  expect(attachPbo([{ metrics: null }])).toBeNull()
})

test('factor mining reports the selection check over every candidate in both signs', () => {
  const fm = require('../lib/factor-mining')
  const r = rng(21), t0 = Date.UTC(2021, 0, 4), bars = {}
  for (let k = 0; k < 30; k++) { let c = 50 + k; bars[`S${k}`] = Array.from({ length: 1260 }, (_, i) => { c *= 1 + 0.012 * (r() - 0.5); return { t: t0 + i * 86400000, c, h: c * 1.01, l: c * 0.99, v: 1e6 } }) }
  const lib = fm.mineFactors(bars, { diagnostics: false })
  expect(lib.selection).toMatchObject({ candidates: 2 * Object.keys(fm.FACTORS).length, blocks: 8, splits: 70 })
  expect(lib.selection.pbo).toBeGreaterThanOrEqual(0)
})
