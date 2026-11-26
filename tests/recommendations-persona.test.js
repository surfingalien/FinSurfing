'use strict'
/** Route wiring of the persona screen (lib/persona-screen.js) in POST /api/recommendations. */
const request = require('supertest')
const express = require('express')
const jwt     = require('jsonwebtoken')

const mockCall = jest.fn()
const mockScreenLive = jest.fn()
jest.mock('../lib/persona-screen', () => ({ ...jest.requireActual('../lib/persona-screen'), screenLive: (...a) => mockScreenLive(...a) }))
jest.mock('../lib/ai-router',       () => ({ getRouter: () => ({ call: (...a) => mockCall(...a) }), GROQ_MODEL: 'g' }))
jest.mock('../lib/brain-learnings', () => ({ computeStats: () => ({ totalResolved: 0 }), readPredictions: () => [] }))
jest.mock('../lib/social-sentiment', () => ({ getSocialSentiment: async () => '' }))
jest.mock('../lib/alt-data',         () => ({ getAltDataSnippet: async () => null }))
jest.mock('../lib/options-flow-cache', () => ({ getOptionsFlowCompact: async () => null }))
jest.mock('../routes/macro',        () => ({ getIndicators: async () => null }))
jest.mock('../db/ai_memory',        () => ({ getUserPrefs: async () => [], saveUserPref: async () => {} }))
jest.mock('../lib/rec-journal',     () => ({ appendEntry: () => {}, buildEntry: () => ({}) }))
jest.mock('../lib/internal-api',    () => ({ fetchDailyBars: async () => [] }))

process.env.NODE_ENV   = 'test'
process.env.JWT_SECRET = 'test-secret-for-jest-only-32chars!!'
const ps = jest.requireActual('../lib/persona-screen')

let app, token
beforeAll(() => {
  app = express(); app.use(express.json())
  app.use('/api/recommendations', require('../routes/recommendations'))
  token = jwt.sign({ sub: 'p-user', email: 'p@test.dev', role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })
})

const stock = o => ({ assetClass: 'Stock', sector: 'Information Technology', price: 100, ret63: 4, ret252: 12, vol: 22, pe: 20, roe: 25, fcfYield: 4, debtToEquity: 0.3, ...o })
const buffettScreen = () => ps.screen('buffett', { KO: stock(), MSFT: stock({ pe: 30 }), BAD: stock({ pe: 80 }) })
const pick = (symbol, o = {}) => ({ symbol, name: symbol, type: 'Stock', period: '6m', sector: 'Tech', targetReturn: 20, stopLoss: 8, entryPrice: 100, takeProfitPrice: 120, stopLossPrice: 92, risk: 'Low', thesis: 'T.', sources: [], ...o })
const reply = recs => ({ text: JSON.stringify({ recommendations: recs, marketOutlook: 'x', keyRisks: 'y' }), llmUsed: 'claude' })
const post = body => request(app).post('/api/recommendations').set('Authorization', `Bearer ${token}`).send({ includeMacro: false, ...body })

beforeEach(() => { mockCall.mockReset(); mockScreenLive.mockReset() })

it('the prompt carries the screened list and the persona slate, not a fixed 20', async () => {
  mockScreenLive.mockResolvedValue({ screen: buffettScreen(), measures: {}, failed: [] })
  mockCall.mockResolvedValue(reply([pick('KO')]))
  await post({ persona: 'buffett' })
  const prompt = mockCall.mock.calls[0][0].prompt
  expect(prompt).toMatch(/PERSONA SCREEN/)
  expect(prompt).toMatch(/KO \[Information Technology\]: \$100/)
  expect(prompt).not.toMatch(/\bBAD\b/)
  expect(prompt).toMatch(/up to 2 Stocks/)
  expect(prompt).not.toMatch(/exactly 20/)
})

it('drops picks that break the persona and reports why', async () => {
  mockScreenLive.mockResolvedValue({ screen: buffettScreen(), measures: {}, failed: [] })
  mockCall.mockResolvedValue(reply([pick('KO'), pick('BAD'), pick('MSFT', { period: '3m' }), pick('BTC-USD', { type: 'Crypto' })]))
  const res = await post({ persona: 'buffett' })
  expect(res.status).toBe(200)
  expect(res.body.recommendations.map(r => r.symbol)).toEqual(['KO'])
  expect(res.body.personaCheck.dropped.map(d => d.symbol)).toEqual(['BAD', 'MSFT', 'BTC-USD'])
  expect(res.body.recommendations[0].screen.facts.roe).toBe(25)
})

it('holdings are removed from the candidate list', async () => {
  mockScreenLive.mockResolvedValue({ screen: buffettScreen(), measures: {}, failed: [] })
  mockCall.mockResolvedValue(reply([pick('KO')]))
  const res = await post({ persona: 'buffett', holdings: ['KO'] })
  expect(mockCall.mock.calls[0][0].prompt).not.toMatch(/KO \[/)
  expect(res.body.recommendations).toEqual([])
})

it('the model may return none: an empty answer is an abstain, not an error', async () => {
  mockScreenLive.mockResolvedValue({ screen: buffettScreen(), measures: {}, failed: [] })
  mockCall.mockResolvedValue(reply([]))
  const res = await post({ persona: 'buffett' })
  expect(res.status).toBe(200)
  expect(res.body.abstained).toBe(true)
})

it('no measurable candidate: the AI is not called and the reason is given', async () => {
  mockScreenLive.mockResolvedValue({ screen: ps.screen('buffett', {}), measures: {}, failed: ['KO'] })
  const res = await post({ persona: 'buffett' })
  expect(mockCall).not.toHaveBeenCalled()
  expect(res.body.error).toMatch(/candidate list/)
})
