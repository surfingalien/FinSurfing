'use strict'
/**
 * GET /api/ai-brain/scan/changes — the route half of lib/scan-diff.js.
 * Stored scan results are seeded through the queue's own journal file; no
 * model, no market data.
 */
const fs      = require('fs')
const request = require('supertest')
const express = require('express')
const jwt     = require('jsonwebtoken')

process.env.JWT_SECRET = 'test-secret-for-jest-only-32chars!!'

const queue = require('../lib/ai-job-queue')

const stock = (symbol, agentVerdict, compositeScore) => ({ symbol, agentVerdict, compositeScore })
const done = (id, userId, at, params, stocks) => ({
  id, userId, kind: 'scan', status: 'done', params, label: params.scanMode,
  enqueuedAt: at, finishedAt: at,
  result: { processedAt: at, horizon: params.horizon, scanMode: params.scanMode, rankedStocks: stocks, universeAnalyzed: stocks.map(s => s.symbol), unpricedSymbols: [] },
})

let app
const tokenFor = sub => jwt.sign({ sub, email: `${sub}@test.dev`, role: 'user' }, process.env.JWT_SECRET, { expiresIn: '5m' })

beforeAll(() => {
  app = express()
  app.use(express.json())
  app.use('/api/ai-brain', require('../routes/ai-brain'))
})

function seed(rows) {
  queue._resetForTests()
  fs.mkdirSync(require('path').dirname(queue.JOBS_FILE), { recursive: true })
  fs.writeFileSync(queue.JOBS_FILE, rows.map(r => JSON.stringify(r)).join('\n') + '\n')
  queue._loadPersistedForTests()
}

const broad = { scanMode: 'broad', horizon: '6m' }

describe('GET /api/ai-brain/scan/changes', () => {
  test('needs a sign-in', async () => {
    const res = await request(app).get('/api/ai-brain/scan/changes')
    expect(res.status).toBe(401)
  })

  test('is not read as a job id, and says when there is no scan', async () => {
    seed([])
    const res = await request(app).get('/api/ai-brain/scan/changes').set('Authorization', `Bearer ${tokenFor('u1')}`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ available: false, reason: 'no-scan' })
  })

  test('compares the newest scan with the previous one of the same mode, for this user only', async () => {
    seed([
      done('scan-1', 'u1', '2026-11-09T14:00:00.000Z', broad, [stock('NVDA', 'Buy', 80), stock('XOM', 'Buy', 60)]),
      done('scan-2', 'u2', '2026-11-09T15:00:00.000Z', broad, [stock('ZZZ', 'Buy', 99)]),
      done('scan-3', 'u1', '2026-11-10T14:00:00.000Z', { scanMode: 'stocks_tech', horizon: '6m' }, [stock('AMD', 'Buy', 70)]),
      done('scan-4', 'u1', '2026-11-11T14:00:00.000Z', broad, [stock('NVDA', 'Avoid', 30), stock('JPM', 'Buy', 65)]),
    ])
    const res = await request(app).get('/api/ai-brain/scan/changes').set('Authorization', `Bearer ${tokenFor('u1')}`)
    expect(res.body.available).toBe(true)
    expect(res.body.prevAt).toBe('2026-11-09T14:00:00.000Z')
    expect(res.body.changed).toEqual([expect.objectContaining({ symbol: 'NVDA', from: 'Buy', to: 'Avoid', severity: 'high' })])
    expect(res.body.added.map(a => a.symbol)).toEqual(['JPM'])
    expect(res.body.dropped).toEqual([expect.objectContaining({ symbol: 'XOM', reason: 'not-in-list' })])
    expect(JSON.stringify(res.body)).not.toContain('ZZZ')   // another user's scan is never the baseline

    const tech = await request(app).get('/api/ai-brain/scan/changes?at=2026-11-10T14:00:00.000Z').set('Authorization', `Bearer ${tokenFor('u1')}`)
    expect(tech.body).toEqual({ available: false, reason: 'no-earlier-scan', label: 'stocks_tech' })
  })
})
