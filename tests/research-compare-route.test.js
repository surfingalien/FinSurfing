'use strict'
/**
 * GET /api/research-desk/compare and /peers/:symbol — the parts that need no
 * network: sign-in, input validation, and that unpriceable symbols are an
 * explained 422 rather than an empty table. (Live data is exercised by hand;
 * the maths is pinned in tests/research-compare.test.js.)
 */
process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest-only-32chars!!'
const request = require('supertest')
const express = require('express')
const jwt = require('jsonwebtoken')

jest.mock('../lib/internal-api', () => ({ ...jest.requireActual('../lib/internal-api'), fetchDailyBars: jest.fn(async () => []) }))

const token = jwt.sign({ sub: 'u1', email: 'u1@t.dev', role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })
const app = express()
app.use('/api/research-desk', require('../routes/research-desk'))
const get = p => request(app).get(p).set('Authorization', `Bearer ${token}`)

test('compare and peers need a sign-in', async () => {
  expect((await request(app).get('/api/research-desk/compare?symbols=AAPL,MSFT')).status).toBe(401)
  expect((await request(app).get('/api/research-desk/peers/AAPL')).status).toBe(401)
})

test('fewer than two valid symbols is a 400 with a usable message', async () => {
  for (const q of ['', 'AAPL', '<script>,../x']) {
    const r = await get(`/api/research-desk/compare?symbols=${encodeURIComponent(q)}`)
    expect(r.status).toBe(400)
    expect(r.body.error).toMatch(/at least two symbols/)
  }
})

test('symbols that cannot be priced are an explained 422, never an empty comparison', async () => {
  const r = await get('/api/research-desk/compare?symbols=AAAQ,BBBQ')
  expect(r.status).toBe(422)
  expect(r.body.error).toMatch(/AAAQ \(no price history\); BBBQ \(no price history\)/)
})

test('/compare is not swallowed by the /:symbol routes, and peers answers with a list', async () => {
  const r = await get('/api/research-desk/peers/AAPL')
  expect(r.status).toBe(200)
  expect(r.body).toEqual(expect.objectContaining({ symbol: 'AAPL', peers: expect.any(Array) }))
  expect((await get('/api/research-desk/peers/%3Cscript%3E')).status).toBe(400)
})

describe('POST /queue', () => {
  const post = (body) => request(app).post('/api/research-desk/queue').set('Authorization', `Bearer ${token}`).send(body)
  test('needs a sign-in', async () => {
    expect((await request(app).post('/api/research-desk/queue').send({ symbols: ['AAPL'] })).status).toBe(401)
  })
  test('an empty or malformed list is an empty queue, not an error; the flag rules are always sent', async () => {
    for (const body of [{}, { symbols: [] }, { symbols: 'AAPL' }]) {
      const r = await post(body)
      expect(r.status).toBe(200)
      expect(r.body.rows).toEqual([])
      expect(r.body.flagRules.map(f => f.id)).toEqual(['nearHigh', 'drawdown', 'bigMove', 'highVol'])
    }
  })
  test('unpriced symbols come back as rows with a reason; bad tokens are reported; at most 40', async () => {
    const r = await post({ symbols: ['AAAQ', '<x>', 'BBBQ'] })
    expect(r.status).toBe(200)
    expect(r.body.rows.map(x => [x.symbol, x.ok, x.reason])).toEqual([['AAAQ', false, 'no price history'], ['BBBQ', false, 'no price history']])
    expect(r.body.invalid).toEqual(['<X>'])
    const many = await post({ symbols: Array.from({ length: 45 }, (_, i) => `S${i}`) })
    expect(many.body.rows).toHaveLength(40)
    expect(many.body.dropped).toHaveLength(5)
  })
})

describe('GET /:symbol/chart-events', () => {
  const ES = require('../lib/event-study')
  afterEach(() => jest.restoreAllMocks())

  test('needs a sign-in and a valid symbol', async () => {
    expect((await request(app).get('/api/research-desk/AAPL/chart-events')).status).toBe(401)
    expect((await get('/api/research-desk/%3Cscript%3E/chart-events')).status).toBe(400)
  })

  test('marks earnings releases and periodic filings from the SEC index', async () => {
    const day = n => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10)
    jest.spyOn(ES, 'fetchFilingIndex').mockResolvedValue({ name: 'X', recent: { form: ['8-K', '10-Q', '8-K'], filingDate: [day(10), day(40), day(4000)], items: ['2.02', '', '2.02'] } })
    const r = await get('/api/research-desk/AAPL/chart-events')
    expect(r.status).toBe(200)
    expect(r.body.events.map(e => e.kind)).toEqual(['filing', 'earnings'])   // the 11-year-old one is outside five years
    expect(r.body.notes).toEqual([])
  })

  test('an unreadable index is said, never shown as "no events"; a non-filer is explained', async () => {
    jest.spyOn(ES, 'fetchFilingIndex').mockRejectedValue(new Error('timeout'))
    expect((await get('/api/research-desk/AAPL/chart-events')).body.notes[0]).toMatch(/could not be read/)
    jest.spyOn(ES, 'fetchFilingIndex').mockResolvedValue(null)
    expect((await get('/api/research-desk/AAPL/chart-events')).body.notes[0]).toMatch(/no SEC filings/)
  })
})
