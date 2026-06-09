'use strict'
const request = require('supertest')
const { createApp } = require('./helpers/app')

let app
beforeAll(() => { app = createApp() })

describe('POST /api/trading-analysis/analyze', () => {
  test('missing symbol returns 400 with descriptive error', async () => {
    const res = await request(app)
      .post('/api/trading-analysis/analyze')
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/symbol/i)
  })

  test('symbol accepted from request body', async () => {
    // Without an API key the route will return an error, but it must get past
    // the "symbol is required" guard — i.e. status != 400 with a symbol error
    const res = await request(app)
      .post('/api/trading-analysis/analyze')
      .send({ symbol: 'AAPL' })
    // Should not be a 400 "symbol is required" error
    if (res.status === 400) {
      expect(res.body.error).not.toMatch(/symbol is required/i)
    }
  })

  test('symbol accepted from query param (backward compat)', async () => {
    const res = await request(app)
      .post('/api/trading-analysis/analyze?symbol=AAPL')
      .send({})
    if (res.status === 400) {
      expect(res.body.error).not.toMatch(/symbol is required/i)
    }
  })
})
