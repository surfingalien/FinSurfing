'use strict'
const H = require('../lib/quant/hedging')
const O = require('../lib/quant/options')

test('hedging at realised vol locks the edge V(σr) − V(σi); hedging at implied has the same mean but more spread', () => {
  const base = { sigmaImplied: 0.2, sigmaRealized: 0.3, T: 0.25, paths: 1500, seed: 3 }
  const atR = H.simulateHedging({ ...base, hedgeVol: 'realized', rehedgesPerDay: 4 }), atI = H.simulateHedging({ ...base, hedgeVol: 'implied', rehedgesPerDay: 4 })
  const edge = O.blackScholes({ S: 100, K: 100, r: 0, sigma: 0.3, T: 0.25, type: 'call' }) - O.blackScholes({ S: 100, K: 100, r: 0, sigma: 0.2, T: 0.25, type: 'call' })
  expect(atR.meanPnl).toBeCloseTo(edge, 0); expect(Math.abs(atR.meanPnl - edge)).toBeLessThan(0.15)
  expect(Math.abs(atI.meanPnl - edge)).toBeLessThan(0.25)
  expect(atR.stdPnl).toBeLessThan(atI.stdPnl)                          // locked total vs path-dependent total
  expect(atR.probLoss).toBeLessThan(0.1)
})
test('Derman–Kamal: hedging noise falls like 1/√N and matches √(π/4)·vega·σ/√N', () => {
  const d = H.discreteHedgingError({ counts: [16, 64, 256], paths: 1500 })
  expect(d.slope).toBeGreaterThan(-0.6); expect(d.slope).toBeLessThan(-0.4)
  d.points.forEach(p => expect(p.stdPnl / p.theory).toBeGreaterThan(0.75)) ; d.points.forEach(p => expect(p.stdPnl / p.theory).toBeLessThan(1.3))
})
test('with transaction costs the Whalley–Wilmott band trades far less than frequent time hedging for comparable risk', () => {
  const base = { sigmaImplied: 0.2, sigmaRealized: 0.2, T: 0.25, costBps: 20, paths: 800, seed: 4 }
  const band = H.simulateHedging({ ...base, strategy: 'band', checksPerDay: 8 }), hourly = H.simulateHedging({ ...base, strategy: 'time', rehedgesPerDay: 8 })
  expect(band.avgTrades).toBeLessThan(hourly.avgTrades / 3); expect(band.avgCost).toBeLessThan(hourly.avgCost)
  expect(band.meanPnl).toBeGreaterThan(hourly.meanPnl)                 // costs saved
  expect(band.stdPnl).toBeLessThan(hourly.stdPnl * 2.5)
  expect(() => H.simulateHedging({ ...base, paths: 50000 })).toThrow()
})
test('compareHedging returns four strategies and a sample path for each daily strategy', () => {
  const c = H.compareHedging({ sigmaImplied: 0.2, sigmaRealized: 0.25, T: 0.1, paths: 300 })
  expect(c.rows).toHaveLength(4); expect(Object.keys(c.samplePaths).length).toBe(3); expect(c.lockedEdge).toBeGreaterThan(0)
})
