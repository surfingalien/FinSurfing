'use strict'
const X = require('../lib/quant/exotics')
const O = require('../lib/quant/options')
const base = { S: 100, K: 100, r: 0.05, q: 0, sigma: 0.25, T: 1 }

test('geometric Asian closed form tends to Black–Scholes with one fixing, and the arithmetic Asian ≥ geometric', () => {
  expect(X.geometricAsian({ ...base, n: 1 })).toBeCloseTo(O.blackScholes({ ...base, type: 'call' }), 8)
  const a = X.asian({ ...base, fixings: 52, paths: 20000, seed: 2 })
  expect(a.price).toBeGreaterThan(a.geometricClosedForm); expect(a.price).toBeLessThan(O.blackScholes({ ...base, type: 'call' }))
})
test('the geometric control variate cuts Asian Monte Carlo error by more than 10× in variance', () => {
  const a = X.asian({ ...base, fixings: 52, paths: 20000, seed: 3 })
  expect(a.varianceReduction).toBeGreaterThan(10); expect(Math.abs(a.price - a.plainMcPrice)).toBeLessThan(4 * a.plainMcSe)
})
test('barrier: in + out = vanilla in closed form; MC with the Brownian bridge matches continuous monitoring, without it is biased', () => {
  const h = { ...base, H: 85 }
  const out = X.barrierAnalytic({ ...h, barrier: 'down-and-out' }), inn = X.barrierAnalytic({ ...h, barrier: 'down-and-in' })
  expect(out + inn).toBeCloseTo(O.blackScholes({ ...base, type: 'call' }), 8)
  const mc = X.barrier({ ...h, barrier: 'down-and-out', steps: 50, paths: 20000, seed: 4 })
  expect(Math.abs(mc.price - out)).toBeLessThan(3.5 * mc.se + 0.02)
  const raw = X.barrier({ ...h, barrier: 'down-and-out', steps: 50, paths: 20000, seed: 4, bridge: false })
  expect(raw.price).toBeGreaterThan(out)                                       // discrete monitoring misses crossings → overprices the knock-out
  const upPut = X.barrierAnalytic({ ...base, H: 120, type: 'put', barrier: 'up-and-out' }), upPutMc = X.barrier({ ...base, H: 120, type: 'put', barrier: 'up-and-out', steps: 50, paths: 20000, seed: 5 })
  expect(Math.abs(upPutMc.price - upPut)).toBeLessThan(3.5 * upPutMc.se + 0.02)
  expect(() => X.barrier({ ...base, H: 120, barrier: 'down-and-out' })).toThrow(/already through/)
})
test('floating lookback: MC with the Broadie–Glasserman–Kou shift lands on the closed form', () => {
  for (const type of ['call', 'put']) {
    const mc = X.lookback({ ...base, type, steps: 100, paths: 20000, seed: 6 })
    expect(Math.abs(mc.price - mc.analytic) / mc.analytic).toBeLessThan(0.02)
    expect(mc.analytic).toBeGreaterThan(O.blackScholes({ ...base, type }))     // a lookback is worth more than the vanilla
  }
})
test('SABR calibration recovers planted parameters from a smile', () => {
  const truth = { alpha: 0.25, rho: -0.45, nu: 0.7 }, F = 100, T = 1
  const quotes = [70, 80, 90, 95, 100, 105, 110, 120, 130].map(K => ({ strike: K, iv: O.sabrVol({ F, K, T, beta: 1, ...truth }) }))
  const fit = O.calibrateSabr({ F, T, beta: 1, quotes })
  expect(fit.alpha).toBeCloseTo(0.25, 3); expect(fit.rho).toBeCloseTo(-0.45, 2); expect(fit.nu).toBeCloseTo(0.7, 2); expect(fit.rmseVolPts).toBeLessThan(0.01)
  expect(() => O.calibrateSabr({ F, T, quotes: quotes.slice(0, 2) })).toThrow()
})
test('Heston calibration reproduces a Heston-generated surface to a fraction of a vol point', () => {
  const truth = { v0: 0.05, kappa: 1.5, theta: 0.04, xi: 0.6, rho: -0.6 }, S = 100
  const quotes = []
  for (const T of [0.25, 1]) for (const K of [85, 95, 100, 105, 115]) quotes.push({ strike: K, T, iv: O.hestonImpliedVol({ S, K, r: 0.02, T, ...truth }) })
  const fit = O.calibrateHeston({ S, r: 0.02, quotes, maxIter: 300 })
  expect(fit.rmseVolPts).toBeLessThan(0.3); expect(fit.rho).toBeLessThan(0)
}, 120000)
