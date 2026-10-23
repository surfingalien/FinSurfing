'use strict'
// Advisory: the whole slate gets an HRP split; a name without history is listed, not guessed.

const request = require('supertest')
const express = require('express')
const jwt     = require('jsonwebtoken')

const mockCall = jest.fn()
jest.mock('../lib/ai-router',       () => ({ getRouter: () => ({ call: (...a) => mockCall(...a) }) }))
jest.mock('../lib/brain-learnings', () => ({ computeStats: () => ({ totalResolved: 0 }), readPredictions: () => [] }))
jest.mock('../lib/social-sentiment', () => ({ getSocialSentiment: async () => '' }))
jest.mock('../lib/alt-data',         () => ({ getAltDataSnippet: async () => null }))
jest.mock('../lib/options-flow-cache', () => ({ getOptionsFlowCompact: async () => null }))
jest.mock('../routes/macro',        () => ({ getIndicators: async () => null }))
jest.mock('../db/ai_memory',        () => ({ getUserPrefs: async () => [], saveUserPref: async () => {} }))
jest.mock('../lib/rec-journal',     () => ({ appendEntry: () => {}, buildEntry: () => ({}) }))
jest.mock('../lib/internal-api', () => ({
  fetchDailyBars: jest.fn(async sym => {
    if (sym === 'NEWCO') return []
    let a = [...sym].reduce((s, c) => s + c.charCodeAt(0), 0), p = 100
    const r = () => { a = (a * 1103515245 + 12345) % 2147483648; return a / 2147483648 - 0.5 }
    return Array.from({ length: 120 }, (_, i) => ({ t: Date.UTC(2026, 3, 1) + i * 86_400_000, c: (p *= 1 + r() * (sym === 'KO' ? 0.01 : 0.04)) }))
  }),
}))

process.env.NODE_ENV   = 'test'
process.env.JWT_SECRET = 'test-secret-for-jest-only-32chars!!'

const pick = symbol => ({ symbol, name: symbol, type: 'Stock', period: '3m', sector: 'Technology', targetReturn: 20, stopLoss: 10, entryPrice: 100, takeProfitPrice: 120, stopLossPrice: 90, risk: 'Medium', thesis: 'Test.', sources: [] })

test('surviving picks carry a slate weight that sums to 100%; a name with no history is excluded and named', async () => {
  const app = express(); app.use(express.json()); app.use('/api/recommendations', require('../routes/recommendations'))
  const token = jwt.sign({ sub: 'u', email: 'u@test.dev', role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })
  const realFetch = global.fetch
  global.fetch = jest.fn(async () => ({ ok: false, status: 503, json: async () => ({}) }))
  mockCall.mockResolvedValue({ text: JSON.stringify({ recommendations: ['NVDA', 'AMD', 'KO', 'NEWCO'].map(pick), marketOutlook: 'x' }), llmUsed: 'claude' })
  const res = await request(app).post('/api/recommendations').set('Authorization', `Bearer ${token}`).send({})
  global.fetch = realFetch

  expect(res.body.allocation).toMatchObject({ method: 'HRP', excluded: ['NEWCO'] })
  const weighted = res.body.recommendations.filter(r => r.slateWeightPct != null)
  expect(weighted.map(r => r.symbol).sort()).toEqual(['AMD', 'KO', 'NVDA'])
  expect(weighted.reduce((s, r) => s + r.slateWeightPct, 0)).toBeCloseTo(100, 0)
  expect(res.body.recommendations.find(r => r.symbol === 'KO').slateWeightPct).toBeGreaterThan(40)   // the calm one
})
