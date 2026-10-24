'use strict'
// The forecast route used to fetch /api/chart/<SYM> (no such route) and read a
// `candles` field the chart never returns — every forecast failed in production
// with "Unexpected token < in JSON" before reaching TimesFM.

const request = require('supertest')
const express = require('express')

const mockBars = Array.from({ length: 60 }, (_, i) => ({ t: Date.UTC(2026, 0, 1) + i * 86400000, o: 100 + i, h: 101 + i, l: 99 + i, c: 100 + i }))
jest.mock('../lib/internal-api', () => ({ fetchDailyBars: jest.fn(async () => mockBars) }))
const { fetchDailyBars } = require('../lib/internal-api')

let app, realFetch
beforeAll(() => { app = express(); app.use('/api/forecast', require('../routes/forecast')) })
beforeEach(() => { realFetch = global.fetch; process.env.TIMESFM_URL = 'http://timesfm.test' })
afterEach(() => { global.fetch = realFetch; delete process.env.TIMESFM_URL })

test('price history comes from the shared bar helper and the closes reach TimesFM', async () => {
  global.fetch = jest.fn(async () => ({ ok: true, json: async () => ({ current_price: 159, model: 'timesfm', forecasts: { '7d': { point: 161 } } }) }))
  const r = await request(app).get('/api/forecast/SPY')
  expect(r.status).toBe(200)
  expect(fetchDailyBars).toHaveBeenCalledWith('SPY', expect.objectContaining({ range: '2y' }))
  const [url, init] = global.fetch.mock.calls[0]
  expect(url).toBe('http://timesfm.test/predict')
  expect(JSON.parse(init.body).closes).toEqual(mockBars.map(b => b.c))
})

test('an unreachable TimesFM says so instead of a bare "fetch failed"', async () => {
  global.fetch = jest.fn(async () => { throw new TypeError('fetch failed') })
  const r = await request(app).get('/api/forecast/QQQ')
  expect(r.status).toBe(503)
  expect(r.body.error).toMatch(/TimesFM service unreachable at http:\/\/timesfm\.test/)
})

test('too little history is a 422 with the count', async () => {
  fetchDailyBars.mockResolvedValueOnce(mockBars.slice(0, 10))
  const r = await request(app).get('/api/forecast/IWM')
  expect(r.status).toBe(422)
  expect(r.body.error).toMatch(/10 bars, need ≥30/)
})
