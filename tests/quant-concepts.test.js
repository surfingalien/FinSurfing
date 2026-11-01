'use strict'
const C = require('../lib/quant/calculators')
const T = require('../lib/quant/timeseries')
const R = require('../lib/quant/risk')
const O = require('../lib/quant/options')
const L = require('../lib/quant/linalg')

test('variance ratio: random walk ≈ 1 and not rejected; trending and reverting series are rejected the right way', () => {
  const walk = (phi, seed) => { const g = L.rng(seed); let p = 0, e = 0; return Array.from({ length: 3000 }, () => { e = phi * e + 0.01 * g.normal(); return (p += e) }) }
  const rw = T.varianceRatio(walk(0, 1), 5); expect(rw.vr).toBeGreaterThan(0.9); expect(rw.vr).toBeLessThan(1.1); expect(rw.verdict).toMatch(/random walk/)
  const mom = T.varianceRatio(walk(0.3, 2), 5); expect(mom.vr).toBeGreaterThan(1.2); expect(mom.verdict).toMatch(/trend/)
  const rev = T.varianceRatio(walk(-0.3, 3), 5); expect(rev.vr).toBeLessThan(0.8); expect(rev.verdict).toMatch(/revert/)
  expect(() => T.varianceRatio([1, 2, 3], 5)).toThrow()
})
test('risk premium: a planted 8% excess return is found with an interval, and the years-needed figure is honest', () => {
  const g = L.rng(4), r = Array.from({ length: 2520 }, () => (0.08 + 0.04) / 252 + 0.16 / Math.sqrt(252) * g.normal())
  const p = R.riskPremium(r, { rf: 0.04, B: 400 }); expect(p.lo).toBeLessThan(0.08); expect(p.hi).toBeGreaterThan(0.08)        // the interval covers the planted truth
  expect(p.lo).toBeLessThan(p.annualExcessReturn); expect(p.hi).toBeGreaterThan(p.annualExcessReturn)
  const calm = R.riskPremium(Array.from({ length: 2520 }, () => (0.08 + 0.04) / 252 + 0.04 / Math.sqrt(252) * g.normal()), { rf: 0.04, B: 400 })
  expect(calm.verdict).toMatch(/positive/)                              // low vol: 10 years is enough to see it
  expect(p.yearsNeededForSignificance).toBeGreaterThan(5)
})
test('parity arbitrage picks conversion vs reversal and respects costs', () => {
  const a = { S: 100, K: 100, r: 0.05, T: 1 }, c = O.blackScholes({ ...a, sigma: 0.2, type: 'call' }), p = O.blackScholes({ ...a, sigma: 0.2, type: 'put' })
  expect(C.parityArbitrage({ call: c, put: p, ...a }).trade).toMatch(/no arbitrage/)
  expect(C.parityArbitrage({ call: c + 1, put: p, ...a }).trade).toMatch(/conversion/)
  expect(C.parityArbitrage({ call: c - 1, put: p, ...a }).trade).toMatch(/reversal/)
  expect(C.parityArbitrage({ call: c + 1, put: p, ...a, costPerShare: 2 }).trade).toMatch(/no arbitrage/)
})
test('theta–gamma: rule of 16 and the break-even move', () => {
  const t = C.thetaGamma({ S: 100, K: 100, sigma: 0.16, T: 0.25 }); expect(t.ruleOf16).toBeCloseTo(1, 9); expect(t.breakevenDailyMovePct).toBeCloseTo(1.008, 2)
  const at = t.pnlIfMove.find(m => m.movePct === 1); expect(Math.abs(at.net)).toBeLessThan(Math.abs(t.pnlIfMove[0].net))   // ~break-even near a 1% move
  expect(t.pnlIfMove[4].net).toBeGreaterThan(0); expect(t.pnlIfMove[0].net).toBeLessThan(0)
})
test('capacity follows the square-root impact law: 4× the edge → 16× the capacity', () => {
  const a = C.capacity({ edgeBps: 20, adv: 5e6, price: 50, dailyVol: 0.02 }), b = C.capacity({ edgeBps: 80, adv: 5e6, price: 50, dailyVol: 0.02 })
  expect(b.capacityAum / a.capacityAum).toBeCloseTo(16, 6)
})
test('margin call thresholds: 2× long at 25% maintenance calls after a 33% fall', () => {
  const l = C.leverageMargin({ equity: 100000, leverage: 2, maintenance: 0.25 }); expect(l.marginCallMove).toBeCloseTo(-1 / 3, 6)
  const s = C.leverageMargin({ equity: 100000, leverage: 1, maintenance: 0.3, side: 'short' }); expect(s.marginCallMove).toBeCloseTo(2 / 1.3 - 1, 6)
})
test('short sale carry, order-book walk, latency and turnover', () => {
  const s = C.shortSale({ price: 50, shares: 1000, days: 365, borrowFeeAnnual: 0.02, dividendYield: 0.03 }); expect(s.breakEvenDeclinePct).toBeCloseTo(5, 9)
  const ob = C.orderBookWalk({ side: 'buy', quantity: 300, bids: [{ price: 99.9, size: 100 }], asks: [{ price: 100.1, size: 100 }, { price: 100.2, size: 100 }, { price: 100.5, size: 500 }] })
  expect(ob.averagePrice).toBeCloseTo((100.1 + 100.2 + 100.5) / 3, 9); expect(ob.levelsUsed).toBe(3); expect(ob.slippageBps).toBeGreaterThan(0)
  expect(C.orderBookWalk({ side: 'buy', quantity: 1000, bids: [], asks: [{ price: 10, size: 5 }] }).unfilled).toBe(995)
  const lat = C.latencyCost({ dailyVol: 0.02, latencyMs: 100 }), lat4 = C.latencyCost({ dailyVol: 0.02, latencyMs: 400 }); expect(lat4.moveStdBps / lat.moveStdBps).toBeCloseTo(2, 6)
  const tv = C.turnover({ from: { A: 0.5, B: 0.5 }, to: { A: 0.2, B: 0.5, C: 0.3 }, costBps: 10, rebalancesPerYear: 12 }); expect(tv.oneWayTurnover).toBeCloseTo(0.3, 9); expect(tv.annualCostDrag).toBeCloseTo(2 * 0.3 * 12 * 0.001, 9)
})
test('Itô demo: simulated median growth ≈ μ − σ²/2, mean growth ≈ μ', () => {
  const d = C.itoDemo({ mu: 0.08, sigma: 0.3, T: 10, paths: 40000 })
  expect(d.simulatedMedianGrowth).toBeCloseTo(0.08 - 0.045, 2); expect(d.simulatedMeanGrowth).toBeCloseTo(0.08, 1)
})
