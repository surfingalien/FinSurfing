'use strict'
/**
 * Route-level test for the price re-anchor block in routes/recommendations.js.
 *
 * The property under test: takeProfitPrice and stopLossPrice must always equal
 * entryPrice × (1 ± pct/100). They used to be rebuilt ONLY when the live quote
 * had moved the entry by ≥3%, so inside that band the model's own numbers
 * survived untouched — and validateRecommendations never looked at them. A card
 * could print "+20%" beside a target that was nothing of the sort.
 *
 * Every network collaborator is mocked; no API keys, no LLM, no disk writes.
 */

const request = require('supertest')
const express = require('express')
const jwt     = require('jsonwebtoken')

const mockCall  = jest.fn()
const mockStats = jest.fn()

jest.mock('../lib/ai-router', () => ({
  getRouter: () => ({ call: (...a) => mockCall(...a) }),
  GROQ_MODEL: 'openai/gpt-oss-120b',
}))
jest.mock('../lib/brain-learnings', () => ({ computeStats: (...a) => mockStats(...a), readPredictions: () => [] }))
jest.mock('../lib/social-sentiment', () => ({ getSocialSentiment: async () => '' }))
jest.mock('../lib/alt-data',         () => ({ getAltDataSnippet: async () => null }))
jest.mock('../lib/options-flow-cache', () => ({ getOptionsFlowCompact: async () => null }))
jest.mock('../routes/macro',        () => ({ getIndicators: async () => null }))
jest.mock('../db/ai_memory',        () => ({ getUserPrefs: async () => [], saveUserPref: async () => {} }))
jest.mock('../lib/rec-journal',     () => ({ appendEntry: () => {}, buildEntry: () => ({}) }))
jest.mock('../lib/learning-store',  () => ({ recordDecisions: () => {} }))

process.env.NODE_ENV   = 'test'
process.env.JWT_SECRET = 'test-secret-for-jest-only-32chars!!'

let app, token

beforeAll(() => {
  app = express()
  app.use(express.json())
  app.use('/api/recommendations', require('../routes/recommendations'))
  token = jwt.sign({ sub: 'coherence-user', email: 'c@test.dev', role: 'user' },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })
})

/** 20%/10% reward-risk so the EV gate never removes the pick first. */
const pick = (over = {}) => ({
  symbol: 'NVDA', name: 'NVDA', type: 'Stock', period: '3m', sector: 'Technology',
  targetReturn: 20, stopLoss: 10, entryPrice: 100,
  takeProfitPrice: 120, stopLossPrice: 90,
  risk: 'Medium', thesis: 'Test thesis.', sources: [],
  ...over,
})

const reply = recs => ({ text: JSON.stringify({ recommendations: recs, marketOutlook: 'Neutral.' }), llmUsed: 'claude' })

const post = () => request(app).post('/api/recommendations')
  .set('Authorization', `Bearer ${token}`)
  .send({ includeMacro: false, focusSymbols: ['NVDA'] })

beforeEach(() => {
  mockCall.mockReset()
  mockStats.mockReset()
  mockStats.mockReturnValue({
    h30: { winRate: 0.45, nTradeable: 60 },
    byAssetType: { stock: { n: 40, winRate: 0.45 } },
  })
})

describe('POST /api/recommendations — derived prices always follow the percentages', () => {
  test('a target that does not follow from targetReturn is recomputed', async () => {
    // The old escape hatch: no live quote moves the entry, so this pick used to
    // be returned verbatim — $150 printed under a "+20%" label.
    mockCall.mockResolvedValue(reply([pick({ takeProfitPrice: 150 })]))
    const res = await post()

    expect(res.status).toBe(200)
    const r = res.body.recommendations[0]
    expect(r.entryPrice).toBe(100)
    expect(r.takeProfitPrice).toBe(120)
    expect(r.stopLossPrice).toBe(90)
  })

  test('a stop that does not follow from stopLoss is recomputed', async () => {
    mockCall.mockResolvedValue(reply([pick({ stopLossPrice: 10 })]))
    const res = await post()
    expect(res.body.recommendations[0].stopLossPrice).toBe(90)
  })

  test('the percentages themselves are never rewritten — they are the input', async () => {
    mockCall.mockResolvedValue(reply([pick({ takeProfitPrice: 150, stopLossPrice: 10 })]))
    const res = await post()
    const r = res.body.recommendations[0]
    expect(r.targetReturn).toBe(20)
    expect(r.stopLoss).toBe(10)
    // And the levels are consistent with them, which is the whole contract.
    expect(r.takeProfitPrice).toBeCloseTo(r.entryPrice * 1.2, 4)
    expect(r.stopLossPrice).toBeCloseTo(r.entryPrice * 0.9, 4)
  })

  test('an already-consistent pick passes through unchanged', async () => {
    mockCall.mockResolvedValue(reply([pick()]))
    const res = await post()
    expect(res.body.recommendations[0]).toMatchObject({
      entryPrice: 100, takeProfitPrice: 120, stopLossPrice: 90,
    })
  })

  test('sub-$100 prices keep the finer precision the repo uses', async () => {
    mockCall.mockResolvedValue(reply([
      pick({ symbol: 'SOL-USD', type: 'Crypto', entryPrice: 12.5, takeProfitPrice: 99 }),
    ]))
    const res = await post()
    const r = res.body.recommendations.find(x => x.symbol === 'SOL-USD')
    expect(r).toBeDefined()                        // must survive the EV gate to prove anything
    expect(r.takeProfitPrice).toBe(15)             // 12.5 × 1.20
    expect(r.stopLossPrice).toBe(11.25)            // 12.5 × 0.90
  })

  test('a pick with a non-numeric percentage is left alone rather than NaN-ed', async () => {
    // validateRecommendations requires stopLoss to be present but not numeric,
    // so the recompute must not turn a bad row into NaN prices.
    mockCall.mockResolvedValue(reply([pick({ stopLoss: 'tight' })]))
    const res = await post()
    const r = res.body.recommendations[0]
    expect(r).toBeDefined()
    // The row is passed through untouched rather than recomputed into NaN.
    expect(r.takeProfitPrice).toBe(120)
    expect(r.stopLossPrice).toBe(90)
  })
})
