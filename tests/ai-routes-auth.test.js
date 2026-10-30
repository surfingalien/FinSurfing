'use strict'

// Every route that runs or serves AI or scan results needs a signed-in user.
// These were open to anyone: the AI Brain's cached scan and job results, the
// Market Focus list, the prediction timeline, Agentic OS, DCF / dividend /
// pattern runs (paid model calls), forecasts, and the alert stream, which
// pushed every user's alert analyses to every connected visitor.

process.env.JWT_SECRET = process.env.JWT_SECRET || 'test-secret-for-jest-only-32chars!!'
const request = require('supertest')
const express = require('express')

const app = express()
app.use(express.json())
app.use('/api/dcf',          require('../routes/dcf'))
app.use('/api/dividend',     require('../routes/dividend'))
app.use('/api/patterns',     require('../routes/pattern-finder'))
app.use('/api/forecast',     require('../routes/forecast'))
app.use('/api/timeline',     require('../routes/timeline'))
app.use('/api/agentic-os',   require('../routes/agentic-os'))
app.use('/api/market-focus', require('../routes/market-focus').router)
app.use('/api/scheduler',    require('../routes/scheduler'))
app.use('/api/alerts',       require('../routes/alerts'))

const refused = [
  ['post', '/api/dcf', { symbol: 'AAPL' }],
  ['post', '/api/dividend/screen', {}],
  ['get',  '/api/patterns/AAPL'],
  ['get',  '/api/forecast/AAPL'],
  ['get',  '/api/timeline'],
  ['get',  '/api/agentic-os/stats'],
  ['get',  '/api/agentic-os/graph'],
  ['get',  '/api/market-focus'],
  ['get',  '/api/scheduler/jobs'],
  ['get',  '/api/scheduler/cache/scan'],
  ['get',  '/api/scheduler/cache/digest'],
  ['get',  '/api/scheduler/cache/alt/AAPL'],
  ['get',  '/api/alerts/stream'],
  ['post', '/api/alerts/trigger', { symbol: 'AAPL' }],
  ['post', '/api/alerts/watchlist', { symbols: ['AAPL'] }],
]

test.each(refused)('%s %s → 401 without a token', async (method, path, body) => {
  const req = request(app)[method](path)
  const res = body ? await req.send(body) : await req
  expect(res.status).toBe(401)
})

test('the forecast service health check stays public', async () => {
  const res = await request(app).get('/api/forecast/health/status')
  expect(res.status).not.toBe(401)
})

describe('alert broadcaster', () => {
  const broadcaster = require('../lib/alert-broadcaster')
  const sink = () => ({ chunks: [], write(c) { this.chunks.push(c) } })

  test("an alert's analysis reaches only its user; system events reach every subscriber", () => {
    const a = sink(), b = sink()
    const ia = broadcaster.subscribe(a, 'user-a')
    const ib = broadcaster.subscribe(b, 'user-b')
    broadcaster.broadcast({ type: 'analysis', symbol: 'NVDA' }, { userId: 'user-a' })
    broadcaster.broadcast({ type: 'entry_zone', symbol: 'AMD' })
    expect(a.chunks.join('')).toMatch(/NVDA/)
    expect(b.chunks.join('')).not.toMatch(/NVDA/)
    expect(a.chunks.join('')).toMatch(/AMD/)
    expect(b.chunks.join('')).toMatch(/AMD/)
    broadcaster.unsubscribe(ia); broadcaster.unsubscribe(ib)
  })
})
