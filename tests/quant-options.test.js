'use strict'
const O = require('../lib/quant/options')
const base = { S: 100, K: 100, r: 0.05, sigma: 0.2, T: 1 }

test('Black–Scholes European put matches the textbook value 5.5735', () => {
  expect(O.blackScholes({ ...base, type: 'put' })).toBeCloseTo(5.5735, 3)
  expect(O.blackScholes({ ...base, type: 'call' })).toBeCloseTo(10.4506, 3)
})
test('put–call parity holds for Black–Scholes prices', () => {
  const c = O.blackScholes({ ...base, type: 'call' }), p = O.blackScholes({ ...base, type: 'put' })
  expect(Math.abs(O.putCallParity({ call: c, put: p, ...base }).deviation)).toBeLessThan(1e-9)
  expect(O.putCallParity({ call: c + 1, put: p, ...base }).holds).toBe(false)
})
test('Greeks match bump-and-reprice', () => {
  const g = O.greeks({ ...base, type: 'call' }), h = 0.01
  const num = (O.blackScholes({ ...base, S: 100 + h, type: 'call' }) - O.blackScholes({ ...base, S: 100 - h, type: 'call' })) / (2 * h)
  expect(g.delta).toBeCloseTo(num, 5)
  const gam = (O.blackScholes({ ...base, S: 100 + h, type: 'call' }) - 2 * O.blackScholes({ ...base, type: 'call' }) + O.blackScholes({ ...base, S: 100 - h, type: 'call' })) / (h * h)
  expect(g.gamma).toBeCloseTo(gam, 4)
  const vega = (O.blackScholes({ ...base, sigma: 0.2001, type: 'call' }) - O.blackScholes({ ...base, sigma: 0.1999, type: 'call' })) / 0.0002
  expect(g.vega).toBeCloseTo(vega, 3)
  expect(g.theta).toBeLessThan(0)
})
test('impliedVol inverts the price and refuses impossible prices', () => {
  const p = O.blackScholes({ ...base, sigma: 0.37, type: 'put' })
  expect(O.impliedVol({ price: p, ...base, type: 'put' })).toBeCloseTo(0.37, 6)
  expect(O.impliedVol({ price: 0.0001, ...base, type: 'call' })).toBeNull()
  expect(O.impliedVol({ price: 101, ...base, type: 'call' })).toBeNull()
})
test('binomial converges to Black–Scholes (European) and gives the American put ≈ 6.09', () => {
  expect(O.binomial({ ...base, type: 'put', american: false, n: 1000 })).toBeCloseTo(5.5735, 2)
  const am = O.binomial({ ...base, type: 'put', american: true, n: 500 })
  expect(am).toBeGreaterThan(6.07); expect(am).toBeLessThan(6.11)
  expect(O.binomialRichardson({ ...base, type: 'put', n: 500 })).toBeCloseTo(6.09, 1)
})
test('finite differences agree with binomial for American and with BS for European', () => {
  expect(O.finiteDiff({ ...base, type: 'put', american: false, M: 300, N: 300 })).toBeCloseTo(5.5735, 2)
  const am = O.finiteDiff({ ...base, type: 'put', american: true, M: 400, N: 400 })
  expect(am).toBeGreaterThan(6.07); expect(am).toBeLessThan(6.11)
})
test('LSM Monte Carlo lands within its error of the American value and is reproducible', () => {
  const a = O.lsm({ ...base, type: 'put', paths: 30000, steps: 50, seed: 4 })
  expect(a.price).toBeGreaterThan(5.9); expect(a.price).toBeLessThan(6.2)
  expect(a.se).toBeLessThan(0.1)
  expect(O.lsm({ ...base, type: 'put', paths: 4000, steps: 20, seed: 4 }).price).toBe(O.lsm({ ...base, type: 'put', paths: 4000, steps: 20, seed: 4 }).price)
})
test('American put is never worth less than the European, nor than intrinsic', () => {
  const eu = O.blackScholes({ ...base, S: 80, type: 'put' }), am = O.binomial({ ...base, S: 80, type: 'put', american: true, n: 300 })
  expect(am).toBeGreaterThanOrEqual(eu); expect(am).toBeGreaterThanOrEqual(20 - 1e-9)
})
test('priceAll reports every method plus Greeks', () => {
  const o = O.priceAll({ ...base, type: 'put', paths: 8000, n: 300, grid: 200 })
  expect(o.blackScholes.price).toBeCloseTo(5.5735, 3)
  expect(o.greeks.delta).toBeLessThan(0); expect(o.greeks.gamma).toBeGreaterThan(0)
})
test('gamma scalping: realised > implied earns, realised < implied loses; identity and rule of 16', () => {
  const win = O.simulateGammaScalp({ sigmaImplied: 0.2, sigmaRealized: 0.35, days: 60, seed: 5, rehedgesPerDay: 4 })
  const lose = O.simulateGammaScalp({ sigmaImplied: 0.3, sigmaRealized: 0.12, days: 60, seed: 5, rehedgesPerDay: 4 })
  expect(win.pnl).toBeGreaterThan(0); expect(lose.pnl).toBeLessThan(0)
  expect(win.gammaPnl).toBeGreaterThan(Math.abs(win.thetaPnl)); expect(lose.gammaPnl).toBeLessThan(Math.abs(lose.thetaPnl))
  expect(O.ruleOf16(0.16)).toBeCloseTo(1.008, 2)
  const g = O.greeks({ ...base, r: 0, type: 'call' })
  expect(O.thetaGammaIdentity({ S: 100, gamma: g.gamma, sigmaImplied: 0.2 }).thetaYear).toBeCloseTo(O.greeks({ ...base, r: 0, type: 'call' }).theta, 1)
})
