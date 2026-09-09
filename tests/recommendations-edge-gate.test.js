'use strict'
/**
 * Route-level tests for the expected-value gate in routes/recommendations.js.
 *
 * The Advisory prompt asks for a fixed slate (~20 picks) every run, so the
 * model always returns a full list. These tests cover the wiring that lets the
 * server hand back fewer than it was given — and, when nothing clears, none at
 * all. The EV math itself is covered in tests/expected-value.test.js.
 *
 * Every network collaborator is mocked; no API keys, no LLM, no disk writes.
 */

const request = require('supertest')
const express = require('express')
const jwt     = require('jsonwebtoken')

// jest.mock factories may only reference vars prefixed with `mock`.
const mockCall  = jest.fn()
const mockStats = jest.fn()

jest.mock('../lib/ai-router',       () => ({ getRouter: () => ({ call: (...a) => mockCall(...a) }) }))
jest.mock('../lib/brain-learnings', () => ({ computeStats: (...a) => mockStats(...a), readPredictions: () => [] }))
jest.mock('../lib/social-sentiment', () => ({ getSocialSentiment: async () => '' }))
jest.mock('../lib/alt-data',         () => ({ getAltDataSnippet: async () => null }))
jest.mock('../lib/options-flow-cache', () => ({ getOptionsFlowCompact: async () => null }))
jest.mock('../routes/macro',        () => ({ getIndicators: async () => null }))
jest.mock('../db/ai_memory',        () => ({ getUserPrefs: async () => [], saveUserPref: async () => {} }))
// Journalling writes to disk and is best-effort in production; stub it out.
jest.mock('../lib/rec-journal',     () => ({ appendEntry: () => {}, buildEntry: () => ({}) }))

process.env.NODE_ENV   = 'test'
process.env.JWT_SECRET = 'test-secret-for-jest-only-32chars!!'

let app, token

beforeAll(() => {
  app = express()
  app.use(express.json())
  app.use('/api/recommendations', require('../routes/recommendations'))
  token = jwt.sign({ sub: 'ev-user', email: 'ev@test.dev', role: 'user' },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })
})

/** A pick with a healthy 20%/10% reward-risk — clears the gate at any sane win rate. */
const goodPick = (symbol, type = 'Stock') => ({
  symbol, name: symbol, type, period: '3m', sector: 'Technology',
  targetReturn: 20, stopLoss: 10, entryPrice: 100,
  takeProfitPrice: 120, stopLossPrice: 90,
  risk: 'Medium', thesis: 'Test thesis.', sources: ['live price'],
})

/** A pick needing a ~71% hit rate before costs — rejected at a measured 45%. */
const badPick = (symbol, type = 'Crypto') => ({
  ...goodPick(symbol, type), targetReturn: 6, stopLoss: 15,
  takeProfitPrice: 106, stopLossPrice: 85,
})

const reply = recs => ({ text: JSON.stringify({ recommendations: recs, marketOutlook: 'Neutral.' }), llmUsed: 'claude' })

const post = () => request(app).post('/api/recommendations')
  .set('Authorization', `Bearer ${token}`).send({ includeMacro: false })

beforeEach(() => {
  mockCall.mockReset()
  mockStats.mockReset()
  // A calibrated 45% win rate for every asset class.
  mockStats.mockReturnValue({
    h30: { winRate: 0.45, nTradeable: 60 },
    byAssetType: { stock: { n: 40, winRate: 0.45 }, crypto: { n: 40, winRate: 0.45 } },
  })
})

describe('POST /api/recommendations — expected-value gate', () => {
  test('keeps picks with a positive net edge and annotates each one', async () => {
    mockCall.mockResolvedValue(reply([goodPick('AAPL'), goodPick('MSFT')]))
    const res = await post()

    expect(res.status).toBe(200)
    expect(res.body.recommendations).toHaveLength(2)
    expect(res.body.abstained).toBe(false)

    const ev = res.body.recommendations[0].expectedValue
    expect(ev.verdict).toBe('act')
    expect(ev.netEdge).toBeGreaterThan(0)
    expect(ev.breakEvenWinProb).toBeGreaterThan(0)
    expect(ev.costPct).toBeGreaterThan(0)
  })

  test('drops picks whose payoff needs a hit rate the record does not support', async () => {
    mockCall.mockResolvedValue(reply([goodPick('AAPL'), badPick('DOGE-USD'), goodPick('MSFT')]))
    const res = await post()

    expect(res.status).toBe(200)
    expect(res.body.recommendations.map(r => r.symbol)).toEqual(['AAPL', 'MSFT'])
    expect(res.body.edgeGate.evaluated).toBe(3)
    expect(res.body.edgeGate.kept).toBe(2)
    expect(res.body.edgeGate.rejected).toHaveLength(1)
    expect(res.body.edgeGate.rejected[0]).toMatchObject({ symbol: 'DOGE-USD', verdict: 'reject' })
    expect(res.body.edgeGate.rejected[0].reason).toMatch(/win rate/)
  })

  test('abstains — an empty slate is a real answer, not an error', async () => {
    mockCall.mockResolvedValue(reply([badPick('DOGE-USD'), badPick('SHIB-USD')]))
    const res = await post()

    expect(res.status).toBe(200)
    expect(res.body.recommendations).toHaveLength(0)
    expect(res.body.abstained).toBe(true)
    expect(res.body.edgeGate.rejected).toHaveLength(2)
  })

  test('sizes on the SAME cost-adjusted payoffs that produced the verdict', async () => {
    mockCall.mockResolvedValue(reply([goodPick('AAPL')]))
    const res = await post()

    const { sizing, expectedValue: ev } = res.body.recommendations[0]
    expect(sizing.netOfCosts).toBe(true)
    // Kelly's reported edge must equal the net edge the gate judged, not gross.
    expect(sizing.edgePerUnit).toBeCloseTo(ev.netEdge, 3)
    expect(sizing.suggestedPct).toBeGreaterThan(0)
  })

  test('charges crypto more friction than an identical equity pick', async () => {
    mockCall.mockResolvedValue(reply([goodPick('AAPL', 'Stock'), goodPick('BTC-USD', 'Crypto')]))
    const res = await post()

    const [stock, crypto] = res.body.recommendations
    expect(crypto.expectedValue.costPct).toBeGreaterThan(stock.expectedValue.costPct)
    expect(crypto.expectedValue.netEdge).toBeLessThan(stock.expectedValue.netEdge)
  })

  test('reports the win-probability provenance so a number is never unattributed', async () => {
    mockCall.mockResolvedValue(reply([goodPick('AAPL', 'Stock')]))
    const res = await post()

    expect(res.body.recommendations[0].sizing.winProbSource).toMatch(/assetType:stock/)
    expect(res.body.edgeGate.winProbSources).toEqual(expect.arrayContaining([expect.stringMatching(/assetType:stock/)]))
  })

  test('a thin calibration record leaves the gate inert rather than arbitrary', async () => {
    // No resolved picks yet → conservative 0.5 fallback, healthy R:R still passes.
    mockStats.mockReturnValue({})
    mockCall.mockResolvedValue(reply([goodPick('AAPL'), goodPick('MSFT')]))
    const res = await post()

    expect(res.body.recommendations).toHaveLength(2)
    expect(res.body.edgeGate.winProbSources[0]).toMatch(/default/)
  })

  test('kept never contradicts the list actually returned (holdings stripped after)', async () => {
    mockCall.mockResolvedValue(reply([goodPick('AAPL'), goodPick('MSFT')]))
    const res = await request(app).post('/api/recommendations')
      .set('Authorization', `Bearer ${token}`)
      .send({ includeMacro: false, holdings: ['AAPL'] })

    expect(res.body.recommendations.map(r => r.symbol)).toEqual(['MSFT'])
    expect(res.body.edgeGate.kept).toBe(1)          // not 2
    expect(res.body.abstained).toBe(false)
  })

  test('the floor is tunable via ADVISORY_MIN_NET_EDGE', async () => {
    mockCall.mockResolvedValue(reply([goodPick('AAPL')]))
    process.env.ADVISORY_MIN_NET_EDGE = '0.99'   // absurd floor — nothing clears
    try {
      const res = await post()
      expect(res.body.abstained).toBe(true)
      expect(res.body.edgeGate.minNetEdge).toBe(0.99)
      expect(res.body.edgeGate.rejected[0].verdict).toBe('thin')
    } finally {
      delete process.env.ADVISORY_MIN_NET_EDGE
    }
  })
})
