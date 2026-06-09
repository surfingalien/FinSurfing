'use strict'
const request = require('supertest')
const { createApp } = require('./helpers/app')

let app, token
const password = 'StrongPass123!'

beforeAll(async () => {
  app = createApp()
  // Register + verify + login to get a valid token
  const email = `ta_${Date.now()}@example.com`
  const reg = await request(app).post('/api/auth/register').send({ email, password })
  await request(app).post('/api/auth/verify-email').send({ email, code: reg.body.demoCode })
  const login = await request(app).post('/api/auth/login').send({ email, password })
  token = login.body.accessToken
})

describe('POST /api/trading-analysis/analyze', () => {
  test('unauthenticated request returns 401', async () => {
    const res = await request(app)
      .post('/api/trading-analysis/analyze')
      .send({ symbol: 'AAPL' })
    expect(res.status).toBe(401)
  })

  test('missing symbol returns 400 with descriptive error', async () => {
    const res = await request(app)
      .post('/api/trading-analysis/analyze')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/symbol/i)
  })

  test('symbol accepted from request body (gets past symbol guard)', async () => {
    const res = await request(app)
      .post('/api/trading-analysis/analyze')
      .set('Authorization', `Bearer ${token}`)
      .send({ symbol: 'AAPL' })
    // No API keys in test env → will fail at LLM call, but must not be 400 "symbol is required"
    if (res.status === 400) {
      expect(res.body.error).not.toMatch(/symbol is required/i)
    }
  })

  test('symbol accepted from query param (backward compat)', async () => {
    const res = await request(app)
      .post('/api/trading-analysis/analyze?symbol=AAPL')
      .set('Authorization', `Bearer ${token}`)
      .send({})
    if (res.status === 400) {
      expect(res.body.error).not.toMatch(/symbol is required/i)
    }
  })
})
