'use strict'
const C = require('../lib/quant/calculators')
const O = require('../lib/quant/options')

test('basis and roll yield: fair value, direction of the trade, contango vs backwardation', () => {
  const b = C.basisTrade({ spot: 100, futures: 105, days: 365, rate: 0.04 })
  expect(b.fairFuture).toBeCloseTo(100 * Math.exp(0.04), 6); expect(b.signal).toMatch(/sell futures/)
  expect(C.basisTrade({ spot: 100, futures: 90, days: 90, rate: 0.04 }).signal).toMatch(/buy futures/)
  expect(C.rollYield({ near: 100, far: 102, daysBetween: 30 })).toMatchObject({ structure: 'contango' })
  expect(C.rollYield({ near: 100, far: 102, daysBetween: 30 }).rollYield).toBeLessThan(0)
  expect(C.rollYield({ near: 102, far: 100, daysBetween: 30 }).rollYield).toBeGreaterThan(0)
})
test('merger arb: spread, implied probability and expected value', () => {
  const m = C.mergerArb({ targetPrice: 47, cash: 50, daysToClose: 120, breakPrice: 35, probabilityOfClose: 0.9 })
  expect(m.grossSpreadPct).toBeCloseTo(3 / 47, 9); expect(m.annualisedSpread).toBeGreaterThan(m.grossSpreadPct)
  expect(m.impliedProbabilityOfClose).toBeCloseTo((47 - 35) / (50 - 35), 9)
  expect(m.expectedGain).toBeCloseTo(0.9 * 50 + 0.1 * 35 - 47, 9); expect(m.verdict).toMatch(/positive/)
  expect(C.mergerArb({ targetPrice: 47, cash: 50, daysToClose: 120, breakPrice: 35, probabilityOfClose: 0.7 }).verdict).toMatch(/negative/)
  expect(() => C.mergerArb({ targetPrice: 47, cash: 50, daysToClose: 120, breakPrice: 60 })).toThrow()
  expect(C.mergerArb({ targetPrice: 40, stockRatio: 0.5, acquirerPrice: 100, daysToClose: 90 }).offerValue).toBe(50)
})
test('convertible: parity, premium and delta hedge', () => {
  const c = C.convertibleArb({ bondPrice: 1100, stockPrice: 50, conversionRatio: 20, bondFloor: 950, delta: 0.6 })
  expect(c.parity).toBe(1000); expect(c.conversionPremiumPct).toBeCloseTo(0.1, 9); expect(c.hedgeSharesToShort).toBeCloseTo(12, 9); expect(c.impliedOptionValue).toBe(150)
})
test('Merton recovers the asset value and a sensible credit spread; spread widens with leverage', () => {
  // build equity from known assets, then recover them
  const V = 150, sV = 0.25, D = 100, r = 0.03, T = 1
  const sq = sV, d1 = (Math.log(V / D) + (r + 0.5 * sV * sV) * T) / sq, d2 = d1 - sq, N = x => require('../lib/quant/linalg').normCdf(x)
  const E = V * N(d1) - D * Math.exp(-r * T) * N(d2), sE = N(d1) * sV * V / E
  const m = C.merton({ equityValue: E, equityVol: sE, debtFace: D, rate: r, years: T })
  expect(m.assetValue).toBeCloseTo(V, 1); expect(m.assetVol).toBeCloseTo(sV, 2); expect(m.impliedSpread).toBeGreaterThan(0)
  const hi = C.merton({ equityValue: 30, equityVol: 0.9, debtFace: 100, rate: r, years: T }), lo = C.merton({ equityValue: 120, equityVol: 0.3, debtFace: 50, rate: r, years: T })
  expect(hi.defaultProbabilityRiskNeutral).toBeGreaterThan(lo.defaultProbabilityRiskNeutral); expect(hi.impliedSpread).toBeGreaterThan(lo.impliedSpread)
  expect(C.merton({ equityValue: E, equityVol: sE, debtFace: D, rate: r, marketSpread: m.impliedSpread * 3 }).signal).toMatch(/cheap/)
})
test('Vasicek: with zero vol and r0 at θ the curve is flat at θ; mean reversion pulls long yields to θ', () => {
  const flat = C.vasicek({ r0: 0.04, kappa: 0.5, theta: 0.04, sigma: 0 }); flat.curve.forEach(p => expect(p.yield).toBeCloseTo(0.04, 9))
  const up = C.vasicek({ r0: 0.01, kappa: 0.5, theta: 0.05, sigma: 0.01 }); expect(up.shape).toBe('upward sloping'); expect(up.curve[up.curve.length - 1].yield).toBeGreaterThan(up.curve[0].yield)
})
test('yield curve, dispersion and term structure', () => {
  const y = C.yieldCurve({ '3m': 5.3, '2y': 4.8, '5y': 4.3, '10y': 4.2, '30y': 4.4 })
  expect(y.slope2s10s).toBeCloseTo(-0.6, 9); expect(y.inverted).toBe(true); expect(y.butterfly2s5s10s).toBeCloseTo(2 * 4.3 - 4.8 - 4.2, 9)
  const d = C.dispersion({ indexVol: 0.2, weights: [0.5, 0.5], vols: [0.3, 0.3], realizedCorr: 0.3 })
  expect(d.impliedCorrelation).toBeCloseTo((0.04 - 2 * (0.15 ** 2)) / (0.09 - 2 * 0.0225), 9)
  const t = C.volTermStructure([{ days: 30, iv: 0.4 }, { days: 90, iv: 0.3 }, { days: 180, iv: 0.28 }])
  expect(t.shape).toMatch(/backwardation/); expect(t.forwards[0].forwardVol).toBeLessThan(0.3)
  expect(() => C.volTermStructure([{ days: 30, iv: 0.2 }])).toThrow()
})
test('skew metrics find a downside skew; skew-aware delta differs from BS delta only when the smile moves', () => {
  const S = 100, T = 0.25, r = 0.02, strikes = [80, 85, 90, 95, 100, 105, 110, 115].map(k => ({ strike: k, iv: 0.2 - 0.004 * (k - 100) }))
  const m = C.skewMetrics({ S, T, r, strikes })
  expect(m.riskReversal25).toBeLessThan(0); expect(m.skew).toMatch(/downside/); expect(m.atmVol).toBeCloseTo(0.2, 1)
  const a = C.skewAwareDelta({ S, K: 100, sigma: 0.2, T, type: 'call', regime: 'sticky-delta', dSigmaDK: -0.004 })
  const b = C.skewAwareDelta({ S, K: 100, sigma: 0.2, T, type: 'call', regime: 'sticky-strike', dSigmaDK: -0.004 })
  expect(b.deltaSkewAware).toBeCloseTo(b.deltaBS, 12); expect(a.deltaSkewAware).toBeGreaterThan(a.deltaBS)
})
test('Avellaneda–Stoikov skews quotes against inventory; VWAP slices sum to the order', () => {
  const flat = C.avellanedaStoikov({ mid: 100, inventory: 0, sigma: 0.5 }), long = C.avellanedaStoikov({ mid: 100, inventory: 10, sigma: 0.5 })
  expect(flat.skewVsMid).toBe(0); expect(long.reservation).toBeLessThan(100); expect(long.ask - long.bid).toBeCloseTo(flat.ask - flat.bid, 9)
  for (const type of ['vwap', 'twap']) { const s = C.executionSchedule({ shares: 10000, slices: 13, type }); expect(s.slices.reduce((a, x) => a + x.shares, 0)).toBe(10000) }
  const v = C.executionSchedule({ shares: 10000, slices: 13 }).slices; expect(v[0].shares).toBeGreaterThan(v[6].shares)
  expect(C.implementationShortfall({ side: 'buy', arrival: 100, avgFill: 100.1 }).bps).toBeCloseTo(10, 6); expect(C.implementationShortfall({ side: 'sell', arrival: 100, avgFill: 99.9 }).bps).toBeCloseTo(10, 6)
  expect(C.carryTrade({ rateLong: 0.05, rateShort: 0.01, fxVol: 0.08 }).carryToVol).toBeCloseTo(0.5, 9)
})
