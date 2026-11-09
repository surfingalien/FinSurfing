'use strict'
const hs = require('../lib/holdings-scan')
const { rng } = require('../lib/quant/linalg')

const N = 800
const day = i => Date.UTC(2021, 0, 4) + i * 86_400_000
const market = (() => { const r = rng(1); return Array.from({ length: N }, () => 0.0004 + 0.01 * r.normal()) })()
function stock(seed, beta, idio = 0.01, n = N) {
  const r = rng(seed); let p = 100
  return market.slice(-n).map((m, i) => { p *= Math.exp(beta * m + idio * r.normal()); return { t: day(N - n + i), o: p, h: p * 1.01, l: p * 0.99, c: p, v: 1e6 } })
}
const spy = (() => { let s = 400; return market.map((m, i) => ({ t: day(i), o: s, h: s, l: s, c: (s *= Math.exp(m)), v: 1 })) })()

test('portfolio risk: weights from shares × last close, risk shares sum to 1, a near-duplicate pair is flagged', () => {
  const bars = { AAA: stock(2, 1.2, 0.002), BBB: stock(3, 1.2, 0.002), CCC: stock(4, 0.2) }
  const out = hs.portfolioRisk([{ symbol: 'AAA', shares: 10 }, { symbol: 'BBB', shares: 10 }, { symbol: 'CCC', shares: 10 }], bars, { benchBars: spy })
  expect(out.weights.reduce((a, w) => a + w.weight, 0)).toBeCloseTo(1, 6)
  expect(out.riskContributions.reduce((a, r) => a + r.riskShare, 0)).toBeCloseTo(1, 6)
  expect(out.movesTogether).toEqual([expect.objectContaining({ a: 'AAA', b: 'BBB' })])
  expect(out.effectiveBets).toBeGreaterThanOrEqual(1)
  expect(out.effectiveBets).toBeLessThanOrEqual(3)
  expect(out.beta).toBeGreaterThan(0.5)
  expect(out.var95).toBeGreaterThan(0)
  expect(out.es95).toBeGreaterThanOrEqual(out.var95)
  expect(out.stress.find(s => s.id === 'mkt-20').pnl).toBeLessThan(0)
  expect(out.riskParity).toHaveLength(3)
})

test('a holding with too little history is valued but left out of portfolio risk, and named', () => {
  const bars = { AAA: stock(2, 1), NEW: stock(5, 1, 0.01, 60) }
  const out = hs.portfolioRisk([{ symbol: 'AAA', shares: 1 }, { symbol: 'NEW', shares: 1 }], bars)
  expect(out.weights.map(w => w.symbol).sort()).toEqual(['AAA', 'NEW'])
  expect(out.excluded).toEqual(['NEW'])
})

test('strategies are judged on both windows with the asset class costs; crypto pays crypto costs', () => {
  const s = hs.strategyCheck('AAA', stock(2, 1))
  expect(s.rows.map(r => r.strategy).sort()).toEqual(Object.keys(require('../lib/strategy-lab').STRATEGY_CATALOG).sort())
  expect(s.costBps).toBe(10)
  expect(hs.strategyCheck('BTC-USD', stock(2, 1)).costBps).toBe(60)
  for (const r of s.rows) expect(['validated', 'mixed', 'rejected', 'insufficient_trades', 'fragile']).toContain(r.verdict)
  expect(hs.strategyCheck('AAA', stock(2, 1), [{ id: 'x', symbol: 'AAA', name: 'rsi on AAA', status: 'active', validations: [] }]).library).toHaveLength(1)
})

test('the full scan yields between holdings, reports ML luck, and survives a holding with no bars', async () => {
  let yields = 0
  const bars = { AAA: stock(2, 1), BBB: stock(3, 0.5) }
  const out = await hs.scanHoldings([{ symbol: 'AAA', shares: 5 }, { symbol: 'BBB', shares: 5 }, { symbol: 'ZZZ', shares: 1 }], bars, { benchBars: spy, includeMl: true, yieldFn: async () => { yields++ } })
  expect(yields).toBeGreaterThanOrEqual(2)          // at least once per holding (ML adds more)
  expect(out.holdings.find(h => h.symbol === 'ZZZ').error).toMatch(/no price history/)
  expect(out.holdings[0].quant.vol.forecast21).toBeGreaterThan(0)
  expect(out.ml).toMatchObject({ holdingsTested: 2, modelsPerHolding: 8, folds: 5 })
  expect(out.ml.expectedByLuck).toBeCloseTo(2 * 8 / 32, 1)
  // The best model on each holding is also run as a trading rule through the backtester.
  const ms = out.holdings[0].ml.asStrategy
  expect(ms).toMatchObject({ model: out.holdings[0].ml.models[0].model })
  expect(['validated', 'mixed', 'rejected', 'insufficient_trades']).toContain(ms.verdict)
  expect(Array.isArray(out.ml.asStrategyValidated)).toBe(true)
  expect(out.strategies.tested).toBe(2)
})

test('the route needs a sign-in and positions', async () => {
  const express = require('express'), request = require('supertest')
  const app = express(); app.use(express.json()); app.use('/api/quant', require('../routes/quant'))
  expect((await request(app).post('/api/quant/holdings-scan').send({ positions: [{ symbol: 'AAA', shares: 1 }] })).status).toBe(401)
})

// A request that runs past the heartbeat interval used to fail with "Cannot set headers after they are
// sent": route() read res.json BEFORE the handler swapped in the heartbeat-safe one. Heartbeat every 5 ms
// here and make the data slow, so the scan is guaranteed to have flushed bytes before it answers.
describe('a slow, heartbeated scan still answers with its result', () => {
  jest.resetModules()
  jest.doMock('../lib/http-heartbeat', () => {
    const real = jest.requireActual('../lib/http-heartbeat')
    return { ...real, startJsonHeartbeat: res => real.startJsonHeartbeat(res, { intervalMs: 5 }) }
  })
  process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest-only-32chars!!'
  test('positions in, JSON out after heartbeats', async () => {
    const express = require('express'), request = require('supertest'), jwt = require('jsonwebtoken')
    const app = express(); app.use(express.json()); app.use('/api/quant', require('../routes/quant'))
    const token = jwt.sign({ sub: 'u1', email: 'q@test.dev', role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })
    const realFetch = global.fetch
    const chart = b => ({ chart: { result: [{ timestamp: b.map(x => Math.floor(x.t / 1000)), indicators: { quote: [{ open: b.map(x => x.o), high: b.map(x => x.h), low: b.map(x => x.l), close: b.map(x => x.c), volume: b.map(x => x.v) }] } }] } })
    global.fetch = jest.fn(async url => { await new Promise(r => setTimeout(r, 40)); const s = new URL(url).searchParams.get('symbol'); return { ok: true, status: 200, json: async () => chart(s === 'SPY' ? spy : stock(s === 'AAA' ? 2 : 3, 1)) } })
    try {
      const res = await request(app).post('/api/quant/holdings-scan').set('Authorization', `Bearer ${token}`).send({ positions: [{ symbol: 'AAA', shares: 3 }, { symbol: 'BBB', shares: 4 }] })
      expect(res.text.startsWith(' ')).toBe(true)            // heartbeat bytes went out first
      const body = JSON.parse(res.text)
      expect(body.error).toBeUndefined()
      expect(body.holdings.map(h => h.symbol)).toEqual(['AAA', 'BBB'])
      expect(body.portfolio.weights).toHaveLength(2)
    } finally { global.fetch = realFetch }
  })
})
