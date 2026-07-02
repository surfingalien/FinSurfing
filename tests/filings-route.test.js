'use strict'
/**
 * Route-level tests for routes/filings.js.
 *
 * The EDGAR network call (lib/filings.getLatestFiling) and the AI router are
 * mocked so the route's own logic — symbol guard, form filtering, response
 * assembly, caching, and error mapping — is verified deterministically with
 * no network access or API keys. (Pure parsing helpers are covered separately
 * in tests/filings.test.js.)
 */

const request = require('supertest')
const jwt     = require('jsonwebtoken')

// jest.mock factories may only reference vars prefixed with `mock`.
const mockGetLatestFiling = jest.fn()
const mockCall = jest.fn()

jest.mock('../lib/filings', () => ({
  getLatestFiling: (...args) => mockGetLatestFiling(...args),
  NARRATIVE_FORMS: ['10-K', '10-Q', '8-K'],
}))

jest.mock('../lib/ai-router', () => ({
  getRouter: () => ({ call: mockCall }),
}))

const { createApp } = require('./helpers/app')

const SAMPLE_FILING = {
  symbol: 'AAPL',
  cik: '0000320193',
  company: 'Apple Inc.',
  form: '10-K',
  filingDate: '2023-11-02',
  reportDate: '2023-09-30',
  accessionNumber: '0000320193-23-000106',
  url: 'https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm',
  excerpt: 'Item 1A. Risk Factors. The company faces material competitive and supply-chain risks. '.repeat(10),
}

const SAMPLE_AI_JSON = JSON.stringify({
  symbol: 'AAPL',
  form: '10-K',
  summary: 'Apple reported a solid year with services growth offsetting hardware softness.',
  keyChanges: ['Services revenue up double digits'],
  riskFactors: ['Supply chain concentration in Asia', 'FX headwinds'],
  managementTone: 'cautious',
  redFlags: [],
  analystTakeaway: 'Durable franchise; watch hardware demand.',
})

let app, token

beforeAll(() => {
  app = createApp()
  token = jwt.sign(
    { sub: 'test-user', email: 'filings@test.dev', role: 'user' },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' },
  )
})

beforeEach(() => {
  mockGetLatestFiling.mockReset()
  mockCall.mockReset()
  mockGetLatestFiling.mockResolvedValue({ ...SAMPLE_FILING })
  mockCall.mockResolvedValue({ text: SAMPLE_AI_JSON, llmUsed: 'claude' })
})

describe('GET /api/filings/:symbol', () => {
  test('requires auth — no token returns 401 and never reaches EDGAR/AI', async () => {
    const res = await request(app).get('/api/filings/AAPL')
    expect(res.status).toBe(401)
    expect(mockGetLatestFiling).not.toHaveBeenCalled()
  })

  test('invalid symbol (sanitizes to empty) returns 400', async () => {
    const res = await request(app).get('/api/filings/%40%40%40').set('Authorization', `Bearer ${token}`) // "@@@"
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/symbol/i)
    expect(mockGetLatestFiling).not.toHaveBeenCalled()
  })

  test('happy path returns the assembled research card', async () => {
    const res = await request(app).get('/api/filings/AAPL').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(200)
    expect(res.body.summary).toMatch(/Apple/)
    expect(res.body.form).toBe('10-K')
    expect(res.body.company).toBe('Apple Inc.')
    expect(res.body.riskFactors).toEqual(expect.arrayContaining(['FX headwinds']))
    expect(res.body.source).toBe(SAMPLE_FILING.url)
    expect(res.body.llmUsed).toBe('claude')
    expect(res.body.fetchedAt).toBeTruthy()
  })

  test('passes a restricted form filter through to getLatestFiling', async () => {
    await request(app).get('/api/filings/MSFT?form=10-Q').set('Authorization', `Bearer ${token}`)
    expect(mockGetLatestFiling).toHaveBeenCalledWith('MSFT', expect.objectContaining({ forms: ['10-Q'] }))
  })

  test('ignores an unknown form value and falls back to all narrative forms', async () => {
    await request(app).get('/api/filings/MSFT?form=S-1').set('Authorization', `Bearer ${token}`)
    expect(mockGetLatestFiling).toHaveBeenCalledWith('MSFT', expect.objectContaining({ forms: ['10-K', '10-Q', '8-K'] }))
  })

  test('second identical request is served from cache (no re-fetch, no re-AI)', async () => {
    const first = await request(app).get('/api/filings/TSLA').set('Authorization', `Bearer ${token}`)
    expect(first.status).toBe(200)
    const second = await request(app).get('/api/filings/TSLA').set('Authorization', `Bearer ${token}`)
    expect(second.status).toBe(200)
    expect(second.body.cached).toBe(true)
    expect(mockGetLatestFiling).toHaveBeenCalledTimes(1)
    expect(mockCall).toHaveBeenCalledTimes(1)
  })

  test('unknown ticker (404 from EDGAR layer) maps to 404', async () => {
    const err = new Error('No SEC CIK found for ZZZZ')
    err.status = 404
    mockGetLatestFiling.mockRejectedValueOnce(err)
    const res = await request(app).get('/api/filings/ZZZZ').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/ZZZZ/)
  })

  test('unparseable AI output returns 500', async () => {
    mockCall.mockResolvedValueOnce({ text: 'not json at all', llmUsed: 'claude' })
    const res = await request(app).get('/api/filings/NFLX').set('Authorization', `Bearer ${token}`)
    expect(res.status).toBe(500)
    expect(res.body.error).toMatch(/JSON/i)
  })
})
