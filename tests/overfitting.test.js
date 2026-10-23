'use strict'

const of = require('../lib/overfitting')
const { normCdf } = require('../lib/calibration-stats')

// Deterministic noise: mulberry32 + Box–Muller.
function rng(seed) {
  let a = seed >>> 0
  const u = () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  return () => Math.sqrt(-2 * Math.log(u() || 1e-12)) * Math.cos(2 * Math.PI * u())
}
const series = (seed, n, mean = 0, sd = 0.01) => { const g = rng(seed); return Array.from({ length: n }, () => mean + sd * g()) }

test('normInv inverts normCdf', () => {
  for (const p of [0.001, 0.025, 0.2, 0.5, 0.8, 0.975, 0.999]) expect(normCdf(of.normInv(p))).toBeCloseTo(p, 4)
})

test('returnStats: per-period Sharpe, skew, kurtosis; null when there is nothing to measure', () => {
  const s = of.returnStats(series(1, 2000))
  expect(Math.abs(s.skew)).toBeLessThan(0.2)
  expect(s.kurt).toBeGreaterThan(2.6)
  expect(s.kurt).toBeLessThan(3.4)
  expect(of.returnStats([0.01, 0.02])).toBeNull()
  expect(of.returnStats(Array(50).fill(0))).toBeNull()
})

test('PSR is 0.5 at the benchmark and rises with evidence; fat tails make the same Sharpe less convincing', () => {
  expect(of.probabilisticSharpe({ sr: 0.05, n: 500 }, 0.05)).toBeCloseTo(0.5, 6)
  const short = of.probabilisticSharpe({ sr: 0.05, n: 100 })
  const long  = of.probabilisticSharpe({ sr: 0.05, n: 1000 })
  expect(long).toBeGreaterThan(short)
  expect(of.probabilisticSharpe({ sr: 0.1, n: 500, skew: -1, kurt: 12 })).toBeLessThan(of.probabilisticSharpe({ sr: 0.1, n: 500 }))
})

test('the luck benchmark rises with the number of trials, and is zero for one', () => {
  expect(of.expectedMaxSharpe(1, 0.01)).toBe(0)
  const v = 0.03 ** 2
  expect(of.expectedMaxSharpe(10, v)).toBeGreaterThan(of.expectedMaxSharpe(3, v))
  expect(of.expectedMaxSharpe(100, v)).toBeGreaterThan(of.expectedMaxSharpe(10, v))
})

test('the best of 50 noise strategies looks good raw and is rejected once deflated', () => {
  const batch = Array.from({ length: 50 }, (_, i) => ({ id: i, returnStats: of.returnStats(series(100 + i, 500)) }))
  const out = of.attachDeflated(batch)
  const best = out.reduce((a, b) => (b.returnStats.sr > a.returnStats.sr ? b : a))
  expect(of.probabilisticSharpe(best.returnStats)).toBeGreaterThan(0.85)   // the naive test is fooled
  expect(best.deflated.nTrials).toBe(50)
  expect(best.deflated.pass).toBe(false)                                   // the deflated one is not
})

test('a strategy with a real edge survives deflation against the same field', () => {
  const noise = Array.from({ length: 10 }, (_, i) => ({ returnStats: of.returnStats(series(300 + i, 500)) }))
  const real = { real: true, returnStats: of.returnStats(series(999, 500, 0.0012, 0.01)) }   // daily SR ≈ 0.12
  const out = of.attachDeflated([...noise, real]).find(x => x.real)
  // Its own Sharpe widens the field's dispersion, which raises the luck bar —
  // deflation is conservative even for the genuine one, and it still clears.
  expect(out.deflated.pass).toBe(true)
  expect(out.deflated.dsr).toBeGreaterThan(0.6)
})

test('a lone trial is judged against zero; missing stats deflate to null, never to a pass', () => {
  const [one] = of.attachDeflated([{ returnStats: of.returnStats(series(7, 500, 0.0008)) }])
  expect(one.deflated.srStar).toBe(0)
  expect(one.deflated.nTrials).toBe(1)
  expect(of.attachDeflated([{ returnStats: null }])[0].deflated).toBeNull()
})

test('strategy-lab attaches return stats and a deflated Sharpe to every proposal in a batch', () => {
  const { evaluateProposals } = require('../lib/strategy-lab')
  const n = 400
  const g = rng(42)
  let px = 100
  const closes = Array.from({ length: n }, () => (px *= 1 + 0.0005 + 0.012 * g()))
  const timestamps = closes.map((_, i) => 1_700_000_000 + i * 86400)
  const out = evaluateProposals([
    { strategy: 'sma_crossover', params: { fast: 10, slow: 30 } },
    { strategy: 'rsi', params: { period: 14, oversold: 30, overbought: 70 } },
  ], timestamps, closes)
  const traded = out.filter(p => p.returnStats)
  expect(traded.length).toBeGreaterThan(0)
  for (const p of traded) {
    expect(p.returnStats).toEqual(expect.objectContaining({ n: n - 1, sr: expect.any(Number) }))
    // a proposal that never traded still counts as one of the two trials
    expect(p.deflated).toEqual(expect.objectContaining({ nTrials: 2, pass: expect.any(Boolean) }))
  }
})
