'use strict'
const B = require('../lib/quant/var-backtest')
const L = require('../lib/quant/linalg')
const OP = require('../lib/quant/optimize')

function garchReturns(n, seed, nu = null) {
  const g = L.rng(seed); let h = 1e-4; const out = []
  for (let i = 0; i < n; i++) { let z = g.normal(); if (nu) { let c = 0; for (let k = 0; k < nu; k++) c += g.normal() ** 2; z = z / Math.sqrt(c / nu) * Math.sqrt((nu - 2) / nu) } const r = Math.sqrt(h) * z; out.push(r); h = 2e-6 + 0.1 * r * r + 0.88 * h }
  return out
}
test('Kupiec: the right number of breaches passes, far too many fails', () => {
  expect(B.kupiec(10, 1000, 0.01).pValue).toBeGreaterThan(0.5); expect(B.kupiec(30, 1000, 0.01).pValue).toBeLessThan(0.001)
  expect(B.kupiec(0, 1000, 0.01).pValue).toBeLessThan(0.01)
})
test('Christoffersen flags clustered breaches', () => {
  const clustered = Array(1000).fill(0); for (const s of [100, 400, 700]) for (let i = 0; i < 4; i++) clustered[s + i] = 1
  const spread = Array(1000).fill(0); for (let k = 0; k < 12; k++) spread[k * 80 + 7] = 1
  expect(B.christoffersen(clustered).pValue).toBeLessThan(0.01); expect(B.christoffersen(spread).pValue).toBeGreaterThan(0.05)
})
test('on volatility-clustered fat-tailed returns, filtered HS passes and the static normal VaR fails', () => {
  const r = garchReturns(4000, 3, 5), res = B.backtestVar(r, { level: 0.99 })
  const by = Object.fromEntries(res.methods.map(m => [m.method, m]))
  expect(by['Filtered HS'].kupiecP).toBeGreaterThan(0.01)
  expect(by.parametric.breaches).toBeGreaterThan(res.expectedBreaches)                 // normal, static: too many breaches
  expect(by['Filtered HS'].breachAfterBreach).toBeLessThan(by.historical.breachAfterBreach + 1e-9)
  expect(res.series.length).toBeGreaterThan(100); expect(() => B.backtestVar(r.slice(0, 100))).toThrow()
})
test('walk-forward portfolio backtest charges turnover and ranks methods', () => {
  const T0 = Date.UTC(2020, 0, 1), g = L.rng(9), f = Array.from({ length: 900 }, () => 0.01 * g.normal())
  const mk = (b, sd) => { let p = 100; return [{ t: T0, c: 100 }, ...f.map((x, i) => ({ t: T0 + (i + 1) * 864e5, c: (p *= 1 + b * x + sd * g.normal() + 0.0002) }))] }
  const bars = { A: mk(1, 0.005), B: mk(0.8, 0.01), C: mk(0.1, 0.012), D: mk(-0.2, 0.008) }
  const r = OP.walkForward(bars, { lookback: 252, rebalance: 21, costBps: 10 })
  expect(r.methods).toHaveLength(6); expect(r.methods[0].sharpe).toBeGreaterThanOrEqual(r.methods[5].sharpe)
  const ew = r.methods.find(m => m.method === 'Equal weight'), mv = r.methods.find(m => m.method === 'Minimum variance')
  expect(ew.annualTurnover).toBeLessThan(mv.annualTurnover + 1e-9); expect(mv.annualCostDrag).toBeGreaterThan(0)
  const free = OP.walkForward(bars, { lookback: 252, rebalance: 21, costBps: 0 }).methods.find(m => m.method === 'Minimum variance')
  expect(free.cagr).toBeGreaterThan(mv.cagr)                                              // costs are actually charged
  expect(() => OP.walkForward({ A: bars.A, B: bars.B }, { lookback: 800 })).toThrow()
})
