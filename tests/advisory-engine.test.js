'use strict'
// The AI Advisory Engine's measured half: its own rule tested walk-forward
// against the base rate, its signals recorded on a server price, and its
// record reported per signal type.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest-only-32chars!!'
const E = require('../lib/advisory-engine')
const L = require('../lib/quant/linalg')

const T0 = Date.UTC(2020, 0, 2)
function bars(n, seed, { drift = 0, vol = 0.25, phi = 0 } = {}) {
  const g = L.rng(seed); let p = 100, e = 0
  return Array.from({ length: n }, (_, i) => {
    e = phi * e + vol / Math.sqrt(252) * g.normal()
    const r = drift / 252 + e, o = p * (1 + 0.002 * g.normal())
    p *= Math.exp(r)
    return { t: T0 + i * 864e5, o, h: Math.max(o, p) * 1.005, l: Math.min(o, p) * 0.995, c: p }
  })
}

describe('indicators match the browser formulas', () => {
  test('RSI is Wilder-smoothed and 100 when nothing fell', () => {
    const up = Array.from({ length: 30 }, (_, i) => 100 + i)
    expect(E.rsi(up)[29]).toBe(100)
    expect(E.rsi(up)[13]).toBeNull()
  })
  test('SMA is the trailing mean and reads no future bar', () => {
    const c = [1, 2, 3, 4, 5, 6]
    expect(E.sma(c, 3)).toEqual([null, null, 2, 3, 4, 5])
    const a = E.series(bars(200, 1).map(b => b.c)), b = E.series(bars(260, 1).map(b => b.c))
    expect(a.rsi[150]).toBe(b.rsi[150]); expect(a.macd[150]).toEqual(b.macd[150]); expect(a.s50[150]).toBe(b.s50[150])
  })
  test('the rule maps the ensemble with the browser thresholds', () => {
    expect(E.signalOf(7.5)).toBe('STRONG_BUY'); expect(E.signalOf(6)).toBe('BUY')
    expect(E.signalOf(4.5)).toBe('WATCHLIST'); expect(E.signalOf(3.5)).toBe('HOLD'); expect(E.signalOf(3.4)).toBe('SELL')
  })
})

describe('walk-forward test', () => {
  test('windows do not overlap, entries are the next open, and costs are charged', () => {
    const b = bars(600, 2)
    const r = E.walkForward(b, { horizon: 20, costBps: 10 })
    expect(r.windows).toBe(26)               // decisions at bars 60, 80, …, 560 — the last one exits at 580
    const free = E.walkForward(b, { horizon: 20, costBps: 0 })
    expect(free.avgReturnAllPct - r.avgReturnAllPct).toBeCloseTo(0.1, 1)
  })
  test('a rising market makes most entries win — the base rate says so, so the buy rule is not credited for it', () => {
    const r = E.walkForward(bars(1260, 3, { drift: 0.35, vol: 0.15 }), { horizon: 20 })
    expect(r.buy.baseRate).toBeGreaterThan(0.6)
    if (r.buy.signals >= E.MIN_TRADES) expect(r.buy.verdict).not.toBe('beats-base-rate')
  })
  test('too few signals is "insufficient", never a hit rate verdict', () => {
    const r = E.walkForward(bars(200, 4), { horizon: 20 })
    expect(r.windows).toBeLessThan(E.MIN_TRADES)
    expect(r.buy.verdict).toBe('insufficient')
    expect(E.walkForward(bars(50, 5))).toBeNull()
  })
  test('the signal at a window depends only on bars up to it', () => {
    const b = bars(800, 6)
    const short = E.walkForward(b.slice(0, 500), { horizon: 20 }), long = E.walkForward(b, { horizon: 20 })
    // every window of the shorter history appears unchanged in the longer one
    expect(long.windows).toBeGreaterThan(short.windows)
    const S1 = E.series(b.slice(0, 500).map(x => x.c)), S2 = E.series(b.map(x => x.c))
    for (const i of [80, 200, 400, 470]) expect(E.priceRuleAt(b.slice(0, 500).map(x => x.c), S1, i)).toEqual(E.priceRuleAt(b.map(x => x.c), S2, i))
  })
})

describe('recording and calibration', () => {
  test('only directional signals are recorded, on the server price', () => {
    expect(E.decisionFromSignal({ symbol: 'aapl', signal: 'HOLD' }, { price: 100 })).toBeNull()
    expect(E.decisionFromSignal({ symbol: 'aapl', signal: 'BUY' }, { price: 0 })).toBeNull()
    const d = E.decisionFromSignal({ symbol: 'aapl', signal: 'STRONG_BUY', ensembleScore: 7.81, factors: { tech: 8.5, fund: 'x' } }, { price: 190.5, userId: 'u1' })
    expect(d).toMatchObject({ surface: 'advisory-engine', symbol: 'AAPL', action: 'buy', price: 190.5 })
    expect(d.meta.factors).toMatchObject({ tech: 8.5, fund: null })
    expect(E.decisionFromSignal({ symbol: 'X', signal: 'SELL' }, { price: 5 }).action).toBe('sell')
  })
  test('calibration is per signal type and withheld below the minimum sample', () => {
    const ls = require('../lib/learning-store')
    const mk = (signal, ret) => ({ surface: 'advisory-engine', symbol: 'A', action: E.SIGNAL_ACTION[signal], price: 100, meta: { signal }, outcome: { retPct: ret } })
    const rows = [...Array.from({ length: 10 }, (_, i) => mk('BUY', i < 7 ? 2 : -2)), mk('SELL', -1)]
    const c = E.engineCalibration(rows, ls.calibrate, { minSample: 8 })
    expect(c.bySignal.BUY).toMatchObject({ recorded: 10, sufficient: true, wins: 7 })
    expect(c.bySignal.SELL.sufficient).toBe(false)
    expect(c.bySignal.SELL.recorded).toBe(1)
  })
})

describe('Advisory page personas', () => {
  test('only directional calls are recorded, on the server price, tagged with the persona outside byPersona', () => {
    expect(E.decisionFromPersona({ symbol: 'aapl', persona: 'growth', action: 'Hold' }, { price: 100 })).toBeNull()
    expect(E.decisionFromPersona({ symbol: 'aapl', persona: 'buffett', action: 'Buy' }, { price: 100 })).toBeNull()
    expect(E.decisionFromPersona({ symbol: 'aapl', persona: 'value', action: 'Buy' }, { price: 0 })).toBeNull()
    const d = E.decisionFromPersona({ symbol: 'aapl', persona: 'value', action: 'Overweight', score: 61.6, missing: ['P/E', 7] }, { price: 190, userId: 'u1' })
    expect(d).toMatchObject({ surface: 'persona-rules', symbol: 'AAPL', action: 'buy', price: 190 })
    expect(d.meta).toMatchObject({ ruleSet: 'value', call: 'Overweight', score: 62, missing: ['P/E'] })
    expect(d.meta.persona).toBeUndefined()
    expect(E.decisionFromPersona({ symbol: 'X', persona: 'defensive', action: 'Underweight' }, { price: 5 }).action).toBe('reduce')
    expect(E.decisionFromPersona({ symbol: 'X', persona: 'momentum', action: 'Sell' }, { price: 5 }).action).toBe('sell')
  })
  test('each persona has a long and a short-side record, withheld below the minimum sample', () => {
    const ls = require('../lib/learning-store')
    const mk = (ruleSet, action, ret) => ({ surface: 'persona-rules', symbol: 'A', action, price: 100, meta: { ruleSet }, outcome: { retPct: ret } })
    const rows = [
      ...Array.from({ length: 9 }, (_, i) => mk('growth', 'buy', i < 6 ? 3 : -3)),
      mk('growth', 'sell', -2), mk('value', 'buy', 1),
      { surface: 'advisory', symbol: 'A', action: 'buy', price: 1, meta: { persona: 'growth' }, outcome: { retPct: 5 } },
    ]
    const c = E.personaCalibration(rows, ls.calibrate, { minSample: 8 })
    expect(c.recorded).toBe(11)
    expect(c.byPersona.growth.long).toMatchObject({ recorded: 9, sufficient: true, wins: 6 })
    expect(c.byPersona.growth.short).toMatchObject({ recorded: 1, sufficient: false })
    expect(c.byPersona.value.long.sufficient).toBe(false)
    expect(c.byPersona.esg.recorded).toBe(0)
  })
})

describe('route', () => {
  const request = require('supertest')
  const express = require('express')
  const jwt = require('jsonwebtoken')
  let app, token
  beforeAll(() => {
    jest.resetModules()
    jest.doMock('../lib/internal-api', () => ({ fetchDailyBars: jest.fn(async () => bars(1300, 9)) }))
    app = express(); app.use(express.json())
    app.use('/api/advisory-engine', require('../routes/advisory-engine'))
    token = jwt.sign({ sub: 'u1', email: 'u1@finsurf.test' }, process.env.JWT_SECRET, { algorithm: 'HS256' })
  })
  afterAll(() => jest.dontMock('../lib/internal-api'))
  const auth = r => r.set('Authorization', `Bearer ${token}`)

  test('every endpoint needs a signed-in user', async () => {
    expect((await request(app).get('/api/advisory-engine/backtest/AAPL')).status).toBe(401)
    expect((await request(app).post('/api/advisory-engine/record').send({ symbol: 'AAPL', signal: 'BUY' })).status).toBe(401)
    expect((await request(app).get('/api/advisory-engine/calibration')).status).toBe(401)
  })
  test('backtest answers with the base rate beside every hit rate', async () => {
    const r = await auth(request(app).get('/api/advisory-engine/backtest/AAPL'))
    const body = JSON.parse(r.text)
    expect(body.error).toBeUndefined()
    expect(body.buy.baseRate).not.toBeNull()
    expect(body.costBps).toBe(10)
    expect(body.caveat).toMatch(/next session's open/)
  })
  test('a signal is recorded once a day on the server price, then shows in the calibration', async () => {
    const first = await auth(request(app).post('/api/advisory-engine/record').send({ symbol: 'AAPL', signal: 'BUY', ensembleScore: 6.4 }))
    expect(first.body.recorded).toBe(true)
    expect(first.body.price).toBeCloseTo(bars(1300, 9).at(-1).c, 6)
    const again = await auth(request(app).post('/api/advisory-engine/record').send({ symbol: 'AAPL', signal: 'BUY' }))
    expect(again.body.recorded).toBe(false)
    const hold = await auth(request(app).post('/api/advisory-engine/record').send({ symbol: 'AAPL', signal: 'HOLD' }))
    expect(hold.body.recorded).toBe(false)
    expect((await auth(request(app).post('/api/advisory-engine/record').send({ symbol: 'AAPL', signal: 'MOON' }))).status).toBe(400)
    const cal = await auth(request(app).get('/api/advisory-engine/calibration'))
    expect(cal.body.bySignal.BUY.recorded).toBe(1)
    expect(cal.body.bySignal.BUY.sufficient).toBe(false)
  })
  test('persona calls are recorded once a day each, Holds skipped, and show in the persona record', async () => {
    expect((await request(app).post('/api/advisory-engine/persona-record').send({ symbol: 'MSFT', calls: [] })).status).toBe(401)
    expect((await auth(request(app).post('/api/advisory-engine/persona-record').send({ symbol: 'MSFT', calls: [] }))).status).toBe(400)
    const calls = [
      { persona: 'growth', action: 'Buy', score: 72 }, { persona: 'value', action: 'Hold', score: 40 },
      { persona: 'defensive', action: 'Underweight', score: 30 }, { persona: 'nonsense', action: 'Buy' },
    ]
    const first = await auth(request(app).post('/api/advisory-engine/persona-record').send({ symbol: 'MSFT', calls }))
    expect(first.body.recorded).toBe(2)
    expect(first.body.personas.sort()).toEqual(['defensive', 'growth'])
    expect(first.body.price).toBeCloseTo(bars(1300, 9).at(-1).c, 6)
    const again = await auth(request(app).post('/api/advisory-engine/persona-record').send({ symbol: 'MSFT', calls }))
    expect(again.body.recorded).toBe(0)
    const cal = await auth(request(app).get('/api/advisory-engine/persona-calibration'))
    expect(cal.body.byPersona.growth.long.recorded).toBe(1)
    expect(cal.body.byPersona.defensive.short.recorded).toBe(1)
    expect(cal.body.byPersona.value.recorded).toBe(0)
  })
})
