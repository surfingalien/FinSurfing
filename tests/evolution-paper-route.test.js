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

test('factor library: readable when signed in, without the stored cross-sections; mining is admin-only', async () => {
  const fm = require('../lib/factor-mining')
  fm.saveLibrary({ ranAt: '2026-10-24T09:15:00Z', universe: 3, tested: 1, admitted: ['mom_12_1'],
    factors: [{ name: 'mom_12_1', verdict: 'admitted', latest: { asOf: '2026-10-23', values: [1, 2, 3] } }] })
  expect((await request(app).get('/api/evolution/factors')).status).toBe(401)
  const r = await request(app).get('/api/evolution/factors').set('Authorization', `Bearer ${sign('user')}`)
  expect(r.body.library.factors[0]).toEqual({ name: 'mom_12_1', verdict: 'admitted', latestAsOf: '2026-10-23' })
  expect((await request(app).post('/api/evolution/factors/run').set('Authorization', `Bearer ${sign('user')}`)).status).toBe(403)
})

test('drift study: readable when signed in; running it is admin-only', async () => {
  require('../lib/pead').saveStudy({ ranAt: '2026-10-25T09:30:00Z', events: 3, strategy: { verdict: 'insufficient' } })
  const r = await request(app).get('/api/evolution/pead').set('Authorization', `Bearer ${sign('user')}`)
  expect(r.body.study).toMatchObject({ events: 3, strategy: { verdict: 'insufficient' } })
  expect((await request(app).post('/api/evolution/pead/run').set('Authorization', `Bearer ${sign('user')}`)).status).toBe(403)
})

test('the read endpoints need sign-in', async () => {
  for (const path of ['/status', '/strategies', '/paper', '/paper/trades']) {
    expect((await request(app).get(`/api/evolution${path}`)).status).toBe(401)
    expect((await request(app).get(`/api/evolution${path}`).set('Authorization', `Bearer ${sign('user')}`)).status).toBe(200)
  }
})

test('the insider study endpoints: sign-in to read, admin to run', async () => {
  expect((await request(app).get('/api/evolution/insiders')).status).toBe(401)
  const r = await request(app).get('/api/evolution/insiders').set('Authorization', `Bearer ${sign('user')}`)
  expect(r.status).toBe(200)
  expect(r.body).toEqual({ study: null })
  const s = await request(app).get('/api/evolution/insiders?symbol=pfe').set('Authorization', `Bearer ${sign('user')}`)
  expect(s.body).toEqual({ symbol: 'PFE', recent: null })
  expect((await request(app).post('/api/evolution/insiders/run').set('Authorization', `Bearer ${sign('user')}`)).status).toBe(403)
})
