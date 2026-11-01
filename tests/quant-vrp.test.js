'use strict'
const P = require('../lib/quant/vrp')
const L = require('../lib/quant/linalg')

const T0 = Date.UTC(2022, 0, 3)
function market(n, seed) {
  const g = L.rng(seed), bars = [], vol = []; let p = 100, v = 0.15
  for (let i = 0; i < n; i++) { v = Math.max(0.08, Math.min(0.6, v + 0.01 * g.normal())); vol.push(v); p *= Math.exp(v / Math.sqrt(252) * g.normal()); bars.push({ t: T0 + i * 86400000, o: p, h: p * 1.004, l: p * 0.996, c: p }) }
  return { bars, vol }
}
test('parseFredCsv skips missing values and the header', () => {
  expect(P.parseFredCsv('observation_date,VIXCLS\n2024-01-02,13.2\n2024-01-03,.\n2024-01-04,14\n')).toEqual([{ date: '2024-01-02', value: 13.2 }, { date: '2024-01-04', value: 14 }])
})
test('vrpHistory measures a planted premium: implied = true vol + 3 points', () => {
  const { bars, vol } = market(900, 1)
  const vix = bars.map((b, i) => ({ date: new Date(b.t).toISOString().slice(0, 10), value: (vol[Math.min(i + 10, vol.length - 1)] + 0.03) * 100 }))
  const h = P.vrpHistory(bars, vix)
  expect(h.meanVrp).toBeGreaterThan(0.015); expect(h.meanVrp).toBeLessThan(0.045); expect(h.shareImpliedAbove).toBeGreaterThan(0.6)
  expect(h.days).toBe(900 - 21); expect(h.byRegime).toHaveLength(4); expect(h.series.length).toBeLessThanOrEqual(460)
  expect(() => P.vrpHistory(bars.slice(0, 50), vix)).toThrow(/need 60/)
})
test('vrpSnapshot compares implied with several forecasts and calls rich/cheap', () => {
  const { bars } = market(500, 2)
  const rich = P.vrpSnapshot(bars, { impliedVol: 0.6 }), cheap = P.vrpSnapshot(bars, { impliedVol: 0.05 })
  expect(rich.vrp).toBeGreaterThan(0.03); expect(rich.verdict).toMatch(/rich/); expect(cheap.verdict).toMatch(/cheap/)
  for (const k of ['garch', 'ewma', 'yangZhang', 'trailing']) expect(rich.forecasts[k]).toBeGreaterThan(0)
  expect(() => P.vrpSnapshot(bars, { impliedVol: 18 })).toThrow(/decimal/)
})
test('fetchVix uses the injected fetch and caches', async () => {
  let calls = 0
  const fake = async () => { calls++; return { ok: true, text: async () => 'observation_date,VIXCLS\n' + Array.from({ length: 200 }, (_, i) => `2024-${String(1 + Math.floor(i / 28)).padStart(2, '0')}-${String(1 + (i % 28)).padStart(2, '0')},${15 + (i % 5)}`).join('\n') } }
  const a = await P.fetchVix({ start: '2024-01-01', fetchImpl: fake }), b = await P.fetchVix({ start: '2024-01-01', fetchImpl: fake })
  expect(a.length).toBe(200); expect(b.length).toBe(200); expect(calls).toBe(1)
})
