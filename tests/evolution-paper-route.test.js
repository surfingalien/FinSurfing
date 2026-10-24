'use strict'
// Admin-only: give pre-bracket paper positions exits from their own price action.

const request = require('supertest')
const express = require('express')
const jwt     = require('jsonwebtoken')

const DAY = 86_400_000
jest.mock('../lib/internal-api', () => ({
  fetchDailyBars: jest.fn(async () => Array.from({ length: 80 }, (_, i) => ({ t: Date.UTC(2026, 6, 1) + i * DAY, o: 100, h: 102, l: 98, c: 100 + (i % 3) - 1 }))),
}))

process.env.JWT_SECRET = 'test-secret-for-jest-only-32chars!!'
process.env.PAPER_TRADING_ENABLED = 'true'
const pb = require('../lib/paper-broker')
const sign = role => jwt.sign({ sub: 'u', email: 'u@test.dev', role }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })

let app
beforeAll(() => { app = express(); app.use(express.json()); app.use('/api/evolution', require('../routes/evolution')) })
afterAll(() => { delete process.env.PAPER_TRADING_ENABLED })

test('only an admin can do it; the bracket comes from the bars and is valid against the last price', async () => {
  pb.savePortfolio({ ...pb.emptyPortfolio(10_000), positions: { OLD: { shares: 10, avgCost: 90, openedAt: '2026-01-01T14:00:00Z' } } })
  expect((await request(app).post('/api/evolution/paper/adopt-brackets').set('Authorization', `Bearer ${sign('user')}`)).status).toBe(403)

  const r = await request(app).post('/api/evolution/paper/adopt-brackets').set('Authorization', `Bearer ${sign('admin')}`)
  expect(r.status).toBe(200)
  expect(r.body.adopted).toHaveLength(1)
  const b = pb.loadPortfolio().positions.OLD.bracket
  expect(b.stop).toBeLessThan(100)
  expect(b.t2).toBeGreaterThan(100)
  expect(b.adopted).toBe(true)
  expect(pb.unmanagedPositions(pb.loadPortfolio())).toEqual([])
})
