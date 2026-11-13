'use strict'
/** Route tests for routes/quant.js — the maths is tested in tests/quant-*.test.js; this pins the HTTP contract. */
const request = require('supertest')
const express = require('express')
const jwt     = require('jsonwebtoken')
const L       = require('../lib/quant/linalg')

const mockBars = jest.fn()
jest.mock('../lib/internal-api', () => ({ fetchDailyBars: (...a) => mockBars(...a) }))
const mockIndex = jest.fn()
jest.mock('../lib/event-study', () => ({ ...jest.requireActual('../lib/event-study'), fetchFilingIndex: (...a) => mockIndex(...a) }))

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
  const hs = await post('/calc/heston', { S: 100, K: 100, r: 0.03, T: 1, v0: 0.04, theta: 0.04, kappa: 2, xi: 0.5, rho: -0.7 }, false); expect(hs.status).toBe(200); expect(hs.body.price).toBeGreaterThan(5); expect(hs.body.impliedVol).toBeGreaterThan(0.15)
  const sb = await post('/calc/sabr', { F: 100, T: 1, alpha: 0.2, beta: 1, rho: -0.4, nu: 0.5 }, false); expect(sb.body.smile).toHaveLength(5)
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
  expect(Object.keys(v.body.family.models).sort()).toEqual(['aparch', 'arch', 'egarch', 'garch', 'gjr', 'ewma'].sort()); expect(v.body.comparison.ranking).toHaveLength(6); expect(v.body.forecastStudy.ran).toBe(false)
  const d = await post('/risk/dcc', { symbols: ['AAA', 'BBB', 'CCC'] }); expect(d.status).toBe(200); expect(d.body.symbols).toEqual(['AAA', 'BBB', 'CCC']); expect(d.body.portfolio.var95_1d_dcc).toBeGreaterThan(0)
  expect((await post('/risk/dcc', { symbols: ['AAA'] })).status).toBe(400)
  const t = await post('/timeseries', { symbol: 'AAA' }); expect(t.status).toBe(200); expect(t.body.arima.forecast).toHaveLength(10); expect(t.body.regimes.states).toHaveLength(2)
  const c = await post('/risk/capm', { symbol: 'AAA', benchmark: 'SPY' }); expect(c.status).toBe(200); expect(typeof c.body.beta).toBe('number')
  const p = await post('/pairs', { y: 'AAA', x: 'BBB' }); expect(p.status).toBe(200); expect(p.body.formation.cointegrated5pct).toBe(false)
  const s = await post('/statarb', { symbols: ['AAA', 'BBB', 'CCC', 'DDD'] }); expect(s.status).toBe(200); expect(s.body.signals).toHaveLength(4)
  const u = await post('/volatility', { symbol: 'ZZZZ' }); expect(u.status).toBe(400); expect(u.body.error).toMatch(/no price history/)
  expect((await post('/pairs', { y: 'AAA', x: 'AAA' })).status).toBe(400)
}, 120000)
test('ml compare reports the baseline and a verdict; clustering returns embeddings', async () => {
  const m = await post('/ml/compare', { symbol: 'AAA' }); expect(m.status).toBe(200); expect(m.body.baseline.accuracy).toBeGreaterThan(0.3); expect(m.body.verdict).toBeTruthy(); expect(m.body.results.length).toBe(14)
  const k = await post('/ml/cluster', { symbols: ['AAA', 'BBB', 'CCC', 'DDD', 'SPY'] }); expect(k.status).toBe(200); expect(k.body.symbols).toHaveLength(5)
}, 120000)

test('bars are cached for a few minutes (tab-flipping must not re-hit the data providers) and failures are not', async () => {
  mockBars.mockClear()
  await post('/volatility', { symbol: 'AAA', compare: false }); await post('/timeseries', { symbol: 'AAA' })   // caching only — skip the model contest
  expect(mockBars.mock.calls.filter(c => c[0] === 'AAA' && c[1].range === '2y')).toHaveLength(1)   // volatility's 2y fetch, reused
  mockBars.mockClear(); await post('/volatility', { symbol: 'ZZZZ', compare: false }); await post('/volatility', { symbol: 'ZZZZ', compare: false })
  expect(mockBars.mock.calls.filter(c => c[0] === 'ZZZZ')).toHaveLength(2)                          // a failure is retried, not remembered
}, 60000)
test('a basket that only partly loads reports how many loaded and why the rest did not', async () => {
  const r = await post('/statarb', { symbols: ['AAA', 'BBB', 'CCC', 'ZZZZ'] })
  expect(r.status).toBe(400); expect(r.body.error).toMatch(/only 3 of 4 symbols loaded \(need 4\).*ZZZZ: no price history/)
})
test('a pair with one unloadable symbol says why', async () => {
  const r = await post('/pairs', { y: 'AAA', x: 'ZZZZ' }); expect(r.status).toBe(400); expect(r.body.error).toMatch(/ZZZZ: no price history/)
})

describe('round 2 endpoints', () => {
  test('hedging lab, SABR calibration and exotics are public pure maths', async () => {
    const h = await post('/options/hedging', { T: 0.1, paths: 200, sigmaImplied: 0.2, sigmaRealized: 0.3 }, false)
    expect(h.status).toBe(200); expect(h.body.rows).toHaveLength(4); expect(h.body.discrete.points).toHaveLength(3)
    const O = require('../lib/quant/options'), quotes = [80, 90, 100, 110, 120].map(K => ({ strike: K, iv: O.sabrVol({ F: 100, K, T: 1, beta: 1, alpha: 0.2, rho: -0.3, nu: 0.5 }) }))
    const s = await post('/options/calibrate-sabr', { F: 100, T: 1, beta: 1, quotes }, false); expect(s.status).toBe(200); expect(s.body.rho).toBeCloseTo(-0.3, 2)
    expect((await post('/options/calibrate-sabr', { F: 100, T: 1, quotes: quotes.slice(0, 2) }, false)).status).toBe(400)
    const a = await post('/options/exotic', { kind: 'asian', paths: 4000 }, false); expect(a.status).toBe(200); expect(a.body.varianceReduction).toBeGreaterThan(5)
    const b = await post('/options/exotic', { kind: 'barrier', H: 80, barrier: 'down-and-out', paths: 4000, steps: 50 }, false); expect(b.body.analytic).toBeGreaterThan(0)
    expect((await post('/options/exotic', { kind: 'barrier', H: 80, barrier: 'sideways' }, false)).status).toBe(400)
    expect((await post('/options/exotic', { kind: 'rainbow' }, false)).status).toBe(400)
  })
  test('new calculators answer', async () => {
    for (const [name, body] of [['parity', { call: 10, put: 5, S: 100, K: 100, r: 0.05, T: 1 }], ['theta-gamma', { S: 100, K: 100, sigma: 0.16, T: 0.25 }], ['capacity', { edgeBps: 20, adv: 1e6, price: 50, dailyVol: 0.02 }], ['leverage', { equity: 1e5, leverage: 2 }], ['short-sale', { price: 50, shares: 100, days: 30 }], ['order-book', { quantity: 10, asks: [{ price: 10, size: 20 }], bids: [{ price: 9.9, size: 5 }] }], ['latency', { dailyVol: 0.02, latencyMs: 50 }], ['ito', { paths: 2000 }], ['turnover', { from: { A: 1 }, to: { B: 1 } }]]) {
      const r = await post(`/calc/${name}`, body, false); expect([name, r.status]).toEqual([name, 200])
    }
  })
  test('market-data round 2 endpoints need sign-in and answer when signed in', async () => {
    for (const p of ['/vrp', '/optimize/walk-forward', '/risk/var-backtest', '/risk/premium', '/ml/walk-forward']) expect((await post(p, { symbol: 'AAA' }, false)).status).toBe(401)
    const v = await post('/vrp', { symbol: 'AAA', impliedVol: 0.3 }); expect(v.status).toBe(200); expect(v.body.snapshot.vrp).toBeDefined(); expect(v.body.history).toBeUndefined()
    const noIv = await post('/vrp', { symbol: 'AAA' }); expect(noIv.status).toBe(400); expect(noIv.body.error).toMatch(/SPY, VOO, IVV/)   // no implied vol and not an S&P tracker
    const w = await post('/optimize/walk-forward', { symbols: ['AAA', 'BBB', 'CCC'], lookback: 126 }); expect(w.status).toBe(200); expect(w.body.methods).toHaveLength(6)
    const vb = await post('/risk/var-backtest', { symbol: 'AAA' }); expect(vb.status).toBe(200); expect(vb.body.methods).toHaveLength(5)
    const rp = await post('/risk/premium', { symbol: 'AAA' }); expect(rp.status).toBe(200); expect(rp.body.lo).toBeLessThan(rp.body.hi)
    const t = await post('/timeseries', { symbol: 'AAA' }); expect(t.body.varianceRatio).toHaveLength(4); expect(t.body.kalmanLevel.series.length).toBe(250)
  })
  test('ML walk-forward CV answers', async () => {
    const m = await post('/ml/walk-forward', { symbol: 'AAA', folds: 3 }); expect(m.status).toBe(200); expect(m.body.results.length).toBeGreaterThan(5); expect(m.body.importance.features).toHaveLength(12)
  }, 120000)
})

test('event study: SEC-dated events, own dates, and the cases with nothing to study', async () => {
  const day = i => new Date(DATA.AAA[i].t).toISOString().slice(0, 10)
  const idx = Array.from({ length: 14 }, (_, k) => 40 + k * 60)
  mockIndex.mockImplementation(async s => (s === 'AAA' ? { name: 'Triple A Inc', recent: { form: idx.map(() => '8-K').concat('10-K'), filingDate: idx.map(day).concat(day(100)), items: idx.map(() => '2.02,9.01').concat('') } } : null))
  expect((await post('/event-study', { symbol: 'AAA' }, false)).status).toBe(401)
  const r = await post('/event-study', { symbol: 'AAA' }); expect(r.status).toBe(200)
  expect(r.body.kind).toBe('earnings'); expect(r.body.benchmark).toBe('SPY'); expect(r.body.events).toBe(14); expect(r.body.name).toBe('Triple A Inc')
  expect(r.body.horizons.map(h => h.horizon)).toEqual([1, 5, 20]); expect(r.body.horizons[2].n).toBe(14); expect(r.body.reaction.n).toBe(14); expect(r.body.path).toHaveLength(20); expect(r.body.summary.length).toBeGreaterThan(1)
  const f = await post('/event-study', { symbol: 'AAA', kind: 'filings' }); expect(f.body.events).toBe(1); expect(f.body.horizons[0].verdict).toBe('insufficient')
  const c = await post('/event-study', { symbol: 'BBB', kind: 'custom', dates: `${day(50)}, ${day(200)} nonsense 2019-01-01` }); expect(c.status).toBe(200); expect(c.body.events).toBe(2); expect(c.body.notes.join(' ')).toMatch(/nonsense/); expect(c.body.skipped.beforeHistory).toBe(1)
  const none = await post('/event-study', { symbol: 'BBB' }); expect(none.status).toBe(400); expect(none.body.error).toMatch(/no SEC filings/)
  expect((await post('/event-study', { symbol: 'BBB', kind: 'custom', dates: 'soon' })).status).toBe(400)
  expect((await post('/event-study', { symbol: 'SPY', kind: 'custom', dates: day(50) })).body.error).toMatch(/benchmark itself/)
  mockIndex.mockImplementation(async () => { throw new Error('timeout') })
  const down = await post('/event-study', { symbol: 'AAA' }); expect(down.status).toBe(400); expect(down.body.error).toMatch(/could not read the SEC filing index/)
})
