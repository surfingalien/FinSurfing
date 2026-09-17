'use strict'
/**
 * Route-level tests for the citation gate in routes/recommendations.js.
 *
 * The property under test is end-to-end: a citation naming a figure the model
 * was never shown must not reach the user as evidence, no matter how plausible
 * it reads. lib/claim-support.js covers the verification rules themselves.
 *
 * Every network collaborator is mocked; no API keys, no LLM, no disk writes.
 */

const request = require('supertest')
const express = require('express')
const jwt     = require('jsonwebtoken')

const mockCall  = jest.fn()
const mockStats = jest.fn()

// The one collaborator that is NOT stubbed empty: it supplies the evidence
// block the citations are checked against.
const EVIDENCE = '\nSOCIAL & TECHNICAL SNAPSHOT:\n' +
  '  NVDA: RSI 28.4 oversold, analyst target $243.00 (42×), fwdP/E 31.2\n' +
  '  AMD: management tone confident; risk factors eased versus the prior year\n'

jest.mock('../lib/ai-router',       () => ({ getRouter: () => ({ call: (...a) => mockCall(...a) }) }))
jest.mock('../lib/brain-learnings', () => ({ computeStats: (...a) => mockStats(...a), readPredictions: () => [] }))
jest.mock('../lib/social-sentiment', () => ({ getSocialSentiment: async () => EVIDENCE }))
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
  token = jwt.sign({ sub: 'cite-user', email: 'cite@test.dev', role: 'user' },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })
})

/** Healthy 20%/10% reward-risk so the EV gate never removes the pick first. */
const pick = (symbol, sources) => ({
  symbol, name: symbol, type: 'Stock', period: '3m', sector: 'Technology',
  targetReturn: 20, stopLoss: 10, entryPrice: 100,
  takeProfitPrice: 120, stopLossPrice: 90,
  risk: 'Medium', thesis: 'Test thesis.', sources,
})

const reply = recs => ({ text: JSON.stringify({ recommendations: recs, marketOutlook: 'Neutral.' }), llmUsed: 'claude' })

const post = () => request(app).post('/api/recommendations')
  .set('Authorization', `Bearer ${token}`)
  .send({ includeMacro: false, focusSymbols: ['NVDA', 'AMD'] })

beforeEach(() => {
  mockCall.mockReset()
  mockStats.mockReset()
  mockStats.mockReturnValue({
    h30: { winRate: 0.45, nTradeable: 60 },
    byAssetType: { stock: { n: 40, winRate: 0.45 } },
  })
})

describe('POST /api/recommendations — citation gate', () => {
  test('a citation naming a figure the model was never shown is dropped', async () => {
    mockCall.mockResolvedValue(reply([
      pick('NVDA', ['RSI 28 — oversold', 'analyst target $280 (42×)']),
    ]))
    const res = await post()

    expect(res.status).toBe(200)
    const rec = res.body.recommendations[0]
    // $243 was injected; $280 was not.
    expect(rec.sources).toEqual(['RSI 28 — oversold'])
    expect(rec.citationCheck).toMatchObject({ claimed: 2, kept: 1, dropped: 1, ungrounded: false })
  })

  test('the pick survives — a weak citation is not proof the thesis is wrong', async () => {
    mockCall.mockResolvedValue(reply([pick('NVDA', ['analyst target $280'])]))
    const res = await post()
    expect(res.body.recommendations.map(r => r.symbol)).toEqual(['NVDA'])
  })

  test('a pick whose every citation fails is reported as ungrounded', async () => {
    mockCall.mockResolvedValue(reply([
      pick('NVDA', ['analyst target $280', 'insider cluster buying last quarter']),
    ]))
    const res = await post()

    expect(res.body.recommendations[0].sources).toEqual([])
    expect(res.body.recommendations[0].citationCheck.ungrounded).toBe(true)
    expect(res.body.citationAudit.ungroundedPicks).toEqual(['NVDA'])
  })

  test('supported citations pass through untouched', async () => {
    mockCall.mockResolvedValue(reply([
      pick('NVDA', ['RSI 28 — oversold', 'analyst target $243 (42×)', 'fwdP/E 31.2 below peers']),
      pick('AMD',  ['management tone confident', 'risk factors eased']),
    ]))
    const res = await post()

    expect(res.body.recommendations[0].sources).toHaveLength(3)
    expect(res.body.recommendations[1].sources).toHaveLength(2)
    expect(res.body.citationAudit.citationsDropped).toBe(0)
  })

  test('the roll-up reports what was checked and what was dropped, with reasons', async () => {
    mockCall.mockResolvedValue(reply([
      pick('NVDA', ['RSI 28 — oversold', 'analyst target $280']),
      pick('AMD',  ['risk factors eased', 'durable moat and pricing power']),
    ]))
    const res = await post()

    const a = res.body.citationAudit
    expect(a).toMatchObject({ picksAudited: 2, citationsChecked: 4, citationsDropped: 2 })
    expect(a.rejected.map(r => r.verdict).sort()).toEqual(['fabricated-number', 'unsupported'])
    expect(a.rejected.find(r => r.symbol === 'NVDA').reason).toMatch(/not present in the injected evidence/)
  })

  test('the audit reports only picks that survived the edge gate', async () => {
    // A pick dropped for a negative edge should not appear as an ungrounded
    // citation problem — it is not in the slate at all.
    mockCall.mockResolvedValue(reply([
      pick('NVDA', ['RSI 28 — oversold']),
      { ...pick('DOGE-USD', ['analyst target $280']), type: 'Crypto', targetReturn: 6, stopLoss: 15,
        takeProfitPrice: 106, stopLossPrice: 85 },
    ]))
    const res = await post()

    expect(res.body.recommendations.map(r => r.symbol)).toEqual(['NVDA'])
    expect(res.body.citationAudit.picksAudited).toBe(1)
    expect(res.body.citationAudit.ungroundedPicks).toEqual([])
  })

  test('a pick citing nothing is not flagged as ungrounded', async () => {
    mockCall.mockResolvedValue(reply([pick('NVDA', [])]))
    const res = await post()
    expect(res.body.recommendations[0].citationCheck).toMatchObject({ claimed: 0, kept: 0, ungrounded: false })
    expect(res.body.citationAudit.ungroundedPicks).toEqual([])
  })
})
