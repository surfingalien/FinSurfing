'use strict'
const request = require('supertest')
const { createApp } = require('./helpers/app')

// No FMP_API_KEY in test environment — tests cover guard rails only.
// Network-touching paths (actual FMP calls) are exercised in integration.
delete process.env.FMP_API_KEY

let app

beforeAll(() => {
  app = createApp()
})

describe('GET /api/fundamentals/:symbol — input validation', () => {
  test('returns 400 when FMP key is absent', async () => {
    const res = await request(app).get('/api/fundamentals/AAPL')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/FMP_API_KEY/i)
  })

  test('returns 400 for empty symbol after sanitisation', async () => {
    const res = await request(app).get('/api/fundamentals/!!!')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid symbol/i)
  })

  test('returns 400 for symbol exceeding 10 characters', async () => {
    const res = await request(app).get('/api/fundamentals/VERYLONGSYMBOL')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/Invalid symbol/i)
  })

  test('x-fmp-key header is accepted instead of env var', async () => {
    // Providing a fake key bypasses the key-missing guard (will fail at FMP, not here)
    const res = await request(app)
      .get('/api/fundamentals/AAPL')
      .set('x-fmp-key', 'fake-key-for-testing')
    // Should get past validation (400 guard) — any non-400 response means the key was accepted
    expect(res.status).not.toBe(400)
  })
})
