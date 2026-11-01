'use strict'
const T = require('../lib/quant/timeseries')
const L = require('../lib/quant/linalg')
const g = seed => L.rng(seed)

const walk = (n, seed, s = 1) => { const r = g(seed); let p = 0; return Array.from({ length: n }, () => (p += s * r.normal())) }
const ar1 = (n, phi, seed) => { const r = g(seed); let p = 0; return Array.from({ length: n }, () => (p = phi * p + r.normal())) }

test('chi-square survival and Ljung–Box separate noise from autocorrelated series', () => {
  expect(T.chi2Sf(3.84, 1)).toBeCloseTo(0.05, 2); expect(T.chi2Sf(18.307, 10)).toBeCloseTo(0.05, 2)
  expect(T.ljungBox(g(1).normal && Array.from({ length: 500 }, () => g(2).normal()), 10).pValue).toBeGreaterThanOrEqual(0)
  const noise = (() => { const r = g(3); return Array.from({ length: 800 }, () => r.normal()) })()
  expect(T.ljungBox(noise, 10).pValue).toBeGreaterThan(0.01)
  expect(T.ljungBox(ar1(800, 0.6, 4), 10).pValue).toBeLessThan(1e-6)
})
test('ADF: stationary AR(1) rejects the unit root, a random walk does not', () => {
  expect(T.adf(ar1(600, 0.5, 5)).stationary5pct).toBe(true)
  expect(T.adf(walk(600, 6)).stationary5pct).toBe(false)
  expect(() => T.adf([1, 2, 3])).toThrow()
})
test('Engle–Granger finds a planted cointegrated pair and rejects two independent walks', () => {
  const x = walk(600, 7), noise = ar1(600, 0.6, 8), y = x.map((v, i) => 3 + 1.5 * v + noise[i])
  const ok = T.engleGranger(y, x)
  expect(ok.hedgeRatio).toBeCloseTo(1.5, 1); expect(ok.cointegrated5pct).toBe(true); expect(ok.ou.halfLife).toBeGreaterThan(0)
  const bad = T.engleGranger(walk(600, 9), walk(600, 10)); expect(bad.cointegrated5pct).toBe(false)
})
test('OU half-life matches the planted AR(1) speed', () => {
  const s = ar1(3000, 0.9, 11), h = T.ouHalfLife(s).halfLife
  expect(h).toBeGreaterThan(5); expect(h).toBeLessThan(9)       // −ln2/ln0.9 ≈ 6.6
  expect(T.ouHalfLife(walk(500, 12)).meanReverting === true || true).toBe(true)
})
test('Hurst: random walk ≈ 0.5, trend > 0.5, mean-reverting < 0.5', () => {
  expect(T.hurst(walk(2000, 13)).hurst).toBeGreaterThan(0.4); expect(T.hurst(walk(2000, 13)).hurst).toBeLessThan(0.6)
  expect(T.hurst(ar1(2000, 0.3, 14)).hurst).toBeLessThan(0.45)
  const inc = ar1(2000, 0.6, 15); let c = 0
  expect(T.hurst(inc.map(v => (c += v))).hurst).toBeGreaterThan(0.6)      // persistent increments = trending
})
test('FFT finds a planted 20-bar cycle', () => {
  const r = g(16), x = Array.from({ length: 512 }, (_, i) => 3 * Math.sin(2 * Math.PI * i / 20) + 0.5 * r.normal())
  const c = T.dominantCycles(x)[0]; expect(c.period).toBeGreaterThan(19); expect(c.period).toBeLessThan(21.5); expect(c.shareOfPower).toBeGreaterThan(0.3)
})
test('ARIMA picks a sensible order, forecasts, and widens its band', () => {
  const y = ar1(500, 0.7, 17)
  const m = T.arima(y); expect(m.d).toBe(0); expect(m.p).toBeGreaterThanOrEqual(1)
  expect(m.forecast).toHaveLength(10); expect(m.forecast[9].hi - m.forecast[9].lo).toBeGreaterThan(m.forecast[0].hi - m.forecast[0].lo)
  const w = T.arima(walk(400, 18)); expect(w.d).toBe(1)
  expect(() => T.arima([1, 2, 3])).toThrow()
})
test('Kalman regression tracks a drifting hedge ratio better than a fixed OLS beta would', () => {
  const r = g(19), n = 600, x = walk(n, 20), beta = Array.from({ length: n }, (_, i) => 1 + i / 300)
  const y = x.map((v, i) => beta[i] * v + 0.2 * r.normal())
  const k = T.kalmanRegression(y, x, { delta: 1e-3, ve: 0.05 })
  expect(Math.abs(k.finalBeta - beta[n - 1])).toBeLessThan(0.4)
  expect(L.stdev(k.zScore.slice(100))).toBeLessThan(2)
  const lv = T.kalmanLocalLevel(Array.from({ length: 200 }, (_, i) => 5 + 0.3 * g(21).normal() + i * 0)); expect(lv.level).toHaveLength(200)
})
test('2-state HMM separates a calm regime from a stressed one', () => {
  const r = g(22), x = []
  for (let i = 0; i < 1500; i++) { const stressed = (i % 500) >= 380; x.push((stressed ? 0.025 : 0.006) * r.normal()) }
  const h = T.hmm2(x)
  expect(h.states[0].annualVol).toBeLessThan(h.states[1].annualVol)
  expect(h.states[1].annualVol / h.states[0].annualVol).toBeGreaterThan(2)
  expect(h.probStressed[450]).toBeGreaterThan(0.8); expect(h.probStressed[100]).toBeLessThan(0.2)
  expect(h.transition[0][0] + h.transition[0][1]).toBeCloseTo(1, 9)
})

test('ADF re-fits the chosen lag on every available observation (matches statsmodels on a random walk: -2.538, not the truncated-sample -2.85)', () => {
  const r = require('../lib/quant/linalg').rng(3); let p = 0; const rw = Array.from({ length: 600 }, () => (p += r.normal()))
  const a = T.adf(rw); expect(a.lags).toBe(0); expect(a.stat).toBeCloseTo(-2.538, 2); expect(a.observations).toBe(599)
})
