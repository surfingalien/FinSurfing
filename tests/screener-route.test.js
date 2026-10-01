'use strict'
/**
 * Route-level tests for routes/screener.js.
 *
 * The property under test: the LLM annotates a ranking it did not produce. It
 * must not be able to reorder it, extend it, or have its output decide which
 * symbols the user sees. lib/fundamental-screen.js covers the scoring itself.
 *
 * Every network collaborator is mocked; no API keys, no LLM, no disk.
 */

const request = require('supertest')
const express = require('express')
const jwt     = require('jsonwebtoken')

const mockCall = jest.fn()
jest.mock('../lib/ai-router', () => ({
  getRouter: () => ({ call: (...a) => mockCall(...a) }),
  GROQ_MODEL: 'openai/gpt-oss-120b',
}))
jest.mock('../lib/symbol-db', () => ({
  listSectors: () => [{ sector: 'Technology', count: 900 }],
  sectorUniverse: () => ['AAA', 'BBB'],
}))

process.env.NODE_ENV     = 'test'
process.env.JWT_SECRET   = 'test-secret-for-jest-only-32chars!!'
process.env.FMP_API_KEY  = 'test-fmp-key'

let app, token

// The router is rebuilt per test so the rate limiter and the 6h result cache
// start clean. Testing against the REAL limiter config beats adding a
// test-only escape hatch to production code.
const buildApp = () => {
  jest.resetModules()
  const a = express()
  a.use(express.json())
  a.use('/api/screener', require('../routes/screener'))
  return a
}

beforeAll(() => {
  token = jwt.sign({ sub: 'screen-user', email: 's@test.dev', role: 'user' },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })
})

/** One bulk screener row. */
const candidate = (symbol, price, lastAnnualDividend) => ({
  symbol, companyName: `${symbol} Inc`, sector: 'Technology',
  price, lastAnnualDividend, marketCap: 5e10, beta: 1, exchangeShortName: 'NASDAQ',
  isActivelyTrading: true,
})

/** FMP returns ratios as DECIMALS; the route converts at the boundary. */
const metrics = (over = {}) => [{
  roeTTM: 0.28, roicTTM: 0.18,
  freeCashFlowPerShareTTM: 5, dividendPerShareTTM: 2,
  freeCashFlowYieldTTM: 0.06, ...over,
}]
const ratios = (over = {}) => [{
  payoutRatioTTM: 0.45, debtEquityRatioTTM: 0.9,
  netProfitMarginTTM: 0.22, operatingProfitMarginTTM: 0.26,
  freeCashFlowOperatingCashFlowRatioTTM: 0.20, ...over,
}]

/** Route fetch by URL shape, so tests declare data rather than call order. */
const reply = (ok, status, body) => ({ ok, status, json: async () => body, text: async () => JSON.stringify(body) })
function mockFetch(routes) {
  global.fetch = jest.fn(async (url) => {
    for (const [pattern, body] of routes) {
      if (url.includes(pattern)) return reply(true, 200, body)
    }
    return reply(false, 404, {})
  })
}

const run = (body = {}) => request(app).post('/api/screener/run')
  .set('Authorization', `Bearer ${token}`).send(body)

const realFetch = global.fetch
beforeEach(() => {
  mockCall.mockReset()
  mockCall.mockResolvedValue({ text: '{}' })
  app = buildApp()
})
afterAll(() => { global.fetch = realFetch })

describe('POST /api/screener/run', () => {
  test('ranks on measured fundamentals and converts FMP decimals to percent', async () => {
    mockFetch([
      ['stable/company-screener',  [candidate('SOLID', 100, 3)]],
      ['key-metrics-ttm', metrics()],
      ['ratios-ttm',      ratios()],
    ])
    const res = await run({ explain: false })

    expect(res.status).toBe(200)
    expect(res.body.error).toBeUndefined()
    const top = res.body.ranked[0]
    expect(top.symbol).toBe('SOLID')
    expect(top.dividendYield).toBe(3)     // 3 / 100 → 3%, computed not trusted
    expect(top.roe).toBe(28)              // 0.28 → 28%
    expect(top.payoutRatio).toBe(45)      // 0.45 → 45%
    expect(top.fcfPayoutRatio).toBe(40)   // div 2 / fcf 5 → 40%
  })

  test('the uncovered high yielder ranks below the covered low yielder', async () => {
    mockFetch([
      ['stable/company-screener', [candidate('TRAP', 50, 6), candidate('SOLID', 100, 3)]],
      ['key-metrics-ttm?symbol=TRAP',  metrics({ roeTTM: 0.04, roicTTM: 0.02, freeCashFlowPerShareTTM: 1, dividendPerShareTTM: 6 })],
      ['ratios-ttm?symbol=TRAP',       ratios({ payoutRatioTTM: 1.4, debtEquityRatioTTM: 2.6, netProfitMarginTTM: 0.02, operatingProfitMarginTTM: 0.03, freeCashFlowOperatingCashFlowRatioTTM: 0.01 })],
      ['key-metrics-ttm?symbol=SOLID', metrics()],
      ['ratios-ttm?symbol=SOLID',      ratios()],
    ])
    const res = await run({ explain: false })

    expect(res.body.ranked.map(r => r.symbol)).toEqual(['SOLID', 'TRAP'])
    expect(res.body.ranked[1].flags.map(f => f.code)).toContain('value-trap-risk')
  })

  // ── the LLM annotates; it does not rank ───────────────────────────────────
  test('an explanation for a symbol not in the ranking is discarded', async () => {
    mockFetch([
      ['stable/company-screener',  [candidate('SOLID', 100, 3)]],
      ['key-metrics-ttm', metrics()],
      ['ratios-ttm',      ratios()],
    ])
    mockCall.mockResolvedValue({ text: JSON.stringify({
      SOLID: 'Covered 3% yield with strong margins.',
      MEME:  'Also buy this one, it is going to the moon.',
    }) })
    const res = await run()

    expect(res.body.ranked.map(r => r.symbol)).toEqual(['SOLID'])
    expect(res.body.ranked[0].explanation).toMatch(/Covered 3% yield/)
    expect(JSON.stringify(res.body)).not.toMatch(/MEME/)
  })

  test('a failed or unparseable explanation never costs the ranking', async () => {
    mockFetch([
      ['stable/company-screener',  [candidate('SOLID', 100, 3)]],
      ['key-metrics-ttm', metrics()],
      ['ratios-ttm',      ratios()],
    ])
    mockCall.mockRejectedValue(new Error('provider down'))
    const res = await run()

    expect(res.body.ranked[0].symbol).toBe('SOLID')
    expect(res.body.ranked[0].explanation).toBeNull()
    expect(res.body.notes.join(' ')).toMatch(/explanations unavailable/)
  })

  test('the model is told the ranking is already computed and it may not reorder', async () => {
    mockFetch([
      ['stable/company-screener',  [candidate('SOLID', 100, 3)]],
      ['key-metrics-ttm', metrics()],
      ['ratios-ttm',      ratios()],
    ])
    await run()
    const prompt = mockCall.mock.calls[0][0].prompt
    expect(prompt).toMatch(/ALREADY been scored and ranked/)
    expect(prompt).toMatch(/Do NOT reorder, add, or remove/)
    expect(prompt).toMatch(/Do NOT state any number that is not shown/)
  })

  // ── degradation ───────────────────────────────────────────────────────────
  test('a bulk-screener outage falls back to the local index and says so', async () => {
    mockFetch([
      ['key-metrics-ttm', metrics()],
      ['ratios-ttm',      ratios()],
    ])   // the bulk screener 404s
    const res = await run({ sector: 'Technology', explain: false })

    expect(res.body.candidateSource).toBe('symbol-db')
    expect(res.body.notes.join(' ')).toMatch(/bulk screener unavailable/)
    expect(res.body.ranked.length).toBeGreaterThan(0)
  })

  test('no candidates returns an explicit reason, not a bare empty list', async () => {
    mockFetch([['stable/company-screener', []]])
    const res = await run({ sector: 'Nowhere', explain: false })
    expect(res.body.ranked).toEqual([])
    expect(res.body.error).toMatch(/No candidates/)
  })

  test('candidates with no usable fundamentals report why', async () => {
    mockFetch([['stable/company-screener', [candidate('X', 10, 1)]]])   // enrichment 404s
    const res = await run({ explain: false })
    expect(res.body.error).toMatch(/Fundamentals were unavailable/)
  })

  test('an FMP plan error in a 200 body is surfaced, not swallowed', async () => {
    global.fetch = jest.fn(async () => reply(true, 200, { 'Error Message': 'Exclusive Endpoint' }))
    const res = await run({ explain: false })
    expect(res.body.notes.join(' ')).toMatch(/Exclusive Endpoint/)
  })

  test('the stable API refusing (a legacy-only key) falls back to the v3 paths', async () => {
    global.fetch = jest.fn(async (url) => {
      if (url.includes('/stable/')) return reply(true, 200, { 'Error Message': 'Restricted Endpoint' })
      if (url.includes('api/v3/stock-screener'))       return reply(true, 200, [candidate('SOLID', 100, 3)])
      if (url.includes('api/v3/key-metrics-ttm/SOLID')) return reply(true, 200, metrics())
      if (url.includes('api/v3/ratios-ttm/SOLID'))      return reply(true, 200, ratios())
      return reply(false, 404, {})
    })
    const res = await run({ explain: false })
    expect(res.body.ranked.map(r => r.symbol)).toEqual(['SOLID'])
  })

  test('a current key is served by the stable API alone — no legacy call is made', async () => {
    mockFetch([
      ['stable/company-screener', [candidate('SOLID', 100, 3)]],
      ['stable/key-metrics-ttm',  metrics()],
      ['stable/ratios-ttm',       ratios()],
    ])
    const res = await run({ explain: false })
    expect(res.body.ranked.map(r => r.symbol)).toEqual(['SOLID'])
    expect(global.fetch.mock.calls.map(c => c[0]).filter(u => u.includes('/api/v3/'))).toEqual([])
  })

  // ── inputs ────────────────────────────────────────────────────────────────
  test('weights are normalised, so the scale a caller used does not matter', async () => {
    mockFetch([
      ['stable/company-screener',  [candidate('SOLID', 100, 3)]],
      ['key-metrics-ttm', metrics()],
      ['ratios-ttm',      ratios()],
    ])
    const a = await run({ explain: false, weights: { yield: 70, profitability: 30 } })
    const b = await run({ explain: false, weights: { yield: 0.7, profitability: 0.3 } })
    expect(a.body.weights).toEqual(b.body.weights)
    expect(a.body.weights.yield).toBeCloseTo(0.7, 6)
  })

  test('nonsense weights fall back to the default rather than dividing by zero', async () => {
    mockFetch([
      ['stable/company-screener',  [candidate('SOLID', 100, 3)]],
      ['key-metrics-ttm', metrics()],
      ['ratios-ttm',      ratios()],
    ])
    const res = await run({ explain: false, weights: { yield: 0, profitability: 0 } })
    expect(res.body.weights).toEqual({ yield: 0.5, profitability: 0.5 })
  })

  test('requires auth', async () => {
    await request(app).post('/api/screener/run').send({}).expect(401)
  })
})

describe('GET /api/screener/sectors', () => {
  test('lists sectors from the local index, no auth needed', async () => {
    const res = await request(app).get('/api/screener/sectors').expect(200)
    expect(res.body.sectors[0]).toMatchObject({ sector: 'Technology' })
  })
})
