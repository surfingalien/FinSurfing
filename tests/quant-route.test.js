'use strict'
/** Route tests for routes/quant.js — the maths is tested in tests/quant-*.test.js; this pins the HTTP contract. */
const request = require('supertest')
const express = require('express')
const jwt     = require('jsonwebtoken')
const L       = require('../lib/quant/linalg')

const mockBars = jest.fn()
jest.mock('../lib/internal-api', () => ({ fetchDailyBars: (...a) => mockBars(...a) }))

process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-secret-for-jest-only-32chars!!'

let app, token
const T0 = Date.UTC(2021, 0, 4)
const mk = (n, seed, vol = 0.01) => { const g = L.rng(seed); let p = 100; return Array.from({ length: n }, (_, i) => { p *= 1 + vol * g.normal() + 0.0003; return { t: T0 + i * 86400000, o: p, h: p * 1.005, l: p * 0.995, c: p, v: 1e6 } }) }
const DATA = { AAA: mk(900, 1), BBB: mk(900, 2), CCC: mk(900, 3, 0.02), DDD: mk(900, 4, 0.015), SPY: mk(900, 5, 0.008) }

beforeAll(() => {
  token = jwt.sign({ sub: 'u1', email: 'q@test.dev', role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })
  mockBars.mockImplementation(async s => DATA[s] || Object.assign([], { reason: 'unknown symbol' }))
})
// rebuilt per test so the real rate limiter starts clean each time
beforeEach(() => { jest.resetModules(); app = express(); app.use(express.json()); app.use('/api/quant', require('../routes/quant')) })
const post = (path, body, auth = true) => { const r = request(app).post(`/api/quant${path}`).send(body); return auth ? r.set('Authorization', `Bearer ${token}`) : r }

test('option pricing is public, returns every method, and validates inputs', async () => {
  const r = await post('/options/price', { S: 100, K: 100, r: 0.05, sigma: 0.2, T: 1, type: 'put', paths: 4000, n: 200, grid: 120 }, false)
  expect(r.status).toBe(200); expect(r.body.blackScholes.price).toBeCloseTo(5.5735, 3); expect(r.body.binomial.price).toBeGreaterThan(6); expect(r.body.greeks.gamma).toBeGreaterThan(0)
  const bad = await post('/options/price', { S: -1, K: 100, sigma: 0.2, T: 1 }, false)
  expect(bad.status).toBe(400); expect(bad.body.error).toMatch(/S must be/)
  const iv = await post('/options/iv', { S: 100, K: 100, r: 0.05, T: 1, type: 'put', price: 5.5735 }, false)
  expect(iv.body.impliedVol).toBeCloseTo(0.2, 3)
  expect((await post('/options/iv', { S: 100, K: 100, r: 0.05, T: 1, type: 'call', price: 500 }, false)).body.impliedVol).toBeNull()
})
test('calculators are public, whitelisted and size-capped', async () => {
  const list = await request(app).get('/api/quant/calc'); expect(list.body.calculators).toContain('merger-arb')
  const r = await post('/calc/merger-arb', { targetPrice: 47, cash: 50, daysToClose: 120, breakPrice: 35 }, false); expect(r.status).toBe(200); expect(r.body.impliedProbabilityOfClose).toBeCloseTo(0.8, 6)
  expect((await post('/calc/rm-rf', {}, false)).status).toBe(400)
  expect((await post('/calc/merger-arb', { targetPrice: 47, cash: 50, daysToClose: 120, breakPrice: 99 }, false)).status).toBe(400)
  const st = await post('/risk/stress', { positions: [{ symbol: 'A', value: 1000, beta: 1.5 }] }, false); expect(st.body.scenarios.find(s => s.id === 'mkt-20').pnl).toBeCloseTo(-300, 6)
  expect((await post('/risk/bayes', { wins: 60, n: 100 }, false)).body.probAbove).toBeGreaterThan(0.95)
})
test('market-data endpoints need a signed-in user', async () => {
  for (const [p, b] of [['/optimize', { symbols: ['AAA', 'BBB'] }], ['/volatility', { symbol: 'AAA' }], ['/ml/compare', { symbol: 'AAA' }], ['/pairs', { y: 'AAA', x: 'BBB' }]]) expect((await post(p, b, false)).status).toBe(401)
})
test('optimize compares methods out of sample and returns a frontier', async () => {
  const r = await post('/optimize', { symbols: ['AAA', 'BBB', 'CCC', 'DDD'] }); expect(r.status).toBe(200)
  expect(r.body.methods.length).toBeGreaterThanOrEqual(5); expect(r.body.frontier.points.length).toBeGreaterThan(5); expect(r.body.note).toMatch(/out-of-sample/)
  const one = await post('/optimize', { symbols: ['AAA'] }); expect(one.status).toBe(400)
})
test('volatility, timeseries, capm, pairs and statarb answer for known symbols and 400 for unknown ones', async () => {
  const v = await post('/volatility', { symbol: 'AAA' }); expect(v.status).toBe(200); expect(v.body.garch.persistence).toBeGreaterThan(0); expect(v.body.yangZhang).toBeGreaterThan(0)
  const t = await post('/timeseries', { symbol: 'AAA' }); expect(t.status).toBe(200); expect(t.body.arima.forecast).toHaveLength(10); expect(t.body.regimes.states).toHaveLength(2)
  const c = await post('/risk/capm', { symbol: 'AAA', benchmark: 'SPY' }); expect(c.status).toBe(200); expect(typeof c.body.beta).toBe('number')
  const p = await post('/pairs', { y: 'AAA', x: 'BBB' }); expect(p.status).toBe(200); expect(p.body.formation.cointegrated5pct).toBe(false)
  const s = await post('/statarb', { symbols: ['AAA', 'BBB', 'CCC', 'DDD'] }); expect(s.status).toBe(200); expect(s.body.signals).toHaveLength(4)
  const u = await post('/volatility', { symbol: 'ZZZZ' }); expect(u.status).toBe(400); expect(u.body.error).toMatch(/no price history/)
  expect((await post('/pairs', { y: 'AAA', x: 'AAA' })).status).toBe(400)
})
test('ml compare reports the baseline and a verdict; clustering returns embeddings', async () => {
  const m = await post('/ml/compare', { symbol: 'AAA' }); expect(m.status).toBe(200); expect(m.body.baseline.accuracy).toBeGreaterThan(0.3); expect(m.body.verdict).toBeTruthy(); expect(m.body.results.length).toBe(12)
  const k = await post('/ml/cluster', { symbols: ['AAA', 'BBB', 'CCC', 'DDD', 'SPY'] }); expect(k.status).toBe(200); expect(k.body.symbols).toHaveLength(5)
}, 120000)
