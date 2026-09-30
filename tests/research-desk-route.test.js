'use strict'
/**
 * Route-level tests for routes/research-desk.js.
 *
 * The properties under test: the model's thesis never reaches the reader, the
 * journal or the track record without passing the deterministic judgement; a
 * claim that fails is removed and reported; only an actionable long is scored;
 * and one user never sees another's theses. Every collaborator is mocked — no
 * network, no LLM, and no writes outside a temp file.
 */

const os      = require('os')
const fs      = require('fs')
const path    = require('path')
const request = require('supertest')
const express = require('express')
const jwt     = require('jsonwebtoken')

process.env.NODE_ENV   = 'test'
process.env.JWT_SECRET = 'test-secret-for-jest-only-32chars!!'
const TMP_THESES = path.join(os.tmpdir(), `research-theses-test-${process.pid}.jsonl`)
process.env.RESEARCH_THESES_LOG = TMP_THESES

const mockCall = jest.fn()
jest.mock('../lib/ai-router', () => ({ getRouter: () => ({ call: (...a) => mockCall(...a) }) }))

const DAY = 86400000
const mockBars = jest.fn()
jest.mock('../lib/internal-api', () => ({ fetchDailyBars: (...a) => mockBars(...a) }))

jest.mock('../lib/brain-learnings', () => ({
  readPredictions: () => [],
  computeStats: () => ({ segmentHorizon: 7, h7: null, h30: null }),
}))
jest.mock('./../routes/macro', () => ({ getIndicators: async () => ({ error: 'FRED_API_KEY not set' }) }))
jest.mock('../lib/strategy-library', () => ({ readLibrary: () => [], forwardPasses: () => 0, libraryStats: () => ({ total: 0 }) }))
jest.mock('../lib/entity-graph', () => ({ latestEdges: () => [] }))
const mockRecord = jest.fn()
jest.mock('../lib/learning-store', () => ({ recordDecision: (...a) => mockRecord(...a), getCalibration: () => ({ totalResolved: 0 }) }))

const t0 = Date.UTC(2025, 0, 2)
const bars = Array.from({ length: 300 }, (_, i) => {
  const c = 100 + i * 0.1
  return { t: t0 + i * DAY, o: c, h: c + 1, l: c - 1, c, v: 1e6 }
})
const LAST = bars.at(-1).c

const fundamentals = {
  company: { name: 'Acme Corp' },
  valuation: { pe_ttm: 24.3, ps_ttm: 6.1, roic: 19.1, roe: 28.5 },
  yoy_rev_growth: 12.4,
}

let app, tokenA, tokenB
const realFetch = global.fetch

beforeAll(() => {
  const sign = sub => jwt.sign({ sub, email: `${sub}@t.dev`, role: 'user' }, process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })
  tokenA = sign('user-a'); tokenB = sign('user-b')
})

beforeEach(() => {
  jest.resetModules()
  mockCall.mockReset(); mockRecord.mockReset(); mockBars.mockReset()
  mockBars.mockResolvedValue(bars)
  try { fs.unlinkSync(TMP_THESES) } catch { /* fresh */ }
  global.fetch = jest.fn(async url => (String(url).includes('/api/fundamentals/')
    ? { ok: true, json: async () => fundamentals }
    : { ok: false, status: 404, json: async () => ({}) }))
  app = express()
  app.use(express.json())
  app.use('/api/research-desk', require('../routes/research-desk'))
})
afterAll(() => { global.fetch = realFetch; try { fs.unlinkSync(TMP_THESES) } catch { /* gone */ } })

const thesisReply = over => ({
  text: JSON.stringify({
    stance: 'long', summary: 'Profitable grower at a fair multiple.',
    bull: [{ claim: 'ROIC of 19.1% on a P/E of 24.3', cites: ['VAL'] }],
    bear: [{ claim: 'P/S of 6.1 is demanding', cites: ['VAL'] }],
    targetReturn: 15, stopLoss: 6, horizonDays: 30, invalidation: 'Growth turns negative',
    ...over,
  }),
  llmUsed: 'claude',
})
// The valuation item's id depends on evidence order; resolve it from the dossier.
async function valId() {
  const r = await request(app).get('/api/research-desk/ACME/evidence').set('Authorization', `Bearer ${tokenA}`)
  return r.body.evidence.find(i => i.kind === 'valuation').id
}
const withIds = (reply, id) => ({ ...reply, text: reply.text.replaceAll('"VAL"', `"${id}"`) })

describe('GET /:symbol/evidence', () => {
  test('requires auth', async () => {
    expect((await request(app).get('/api/research-desk/ACME/evidence')).status).toBe(401)
  })

  test('returns a measured dossier and names what it could not check', async () => {
    const r = await request(app).get('/api/research-desk/ACME/evidence').set('Authorization', `Bearer ${tokenA}`)
    expect(r.status).toBe(200)
    expect(r.body.company).toBe('Acme Corp')
    expect(r.body.lastPrice).toBe(LAST)
    expect(r.body.evidence.map(i => i.kind)).toEqual(expect.arrayContaining(['price', 'technicals', 'factors', 'valuation', 'track']))
    expect(r.body.gaps.join(' ')).toMatch(/FRED_API_KEY/)
  })

  test('too little history is a 422, not a thin dossier', async () => {
    mockBars.mockResolvedValue(bars.slice(0, 20))
    const r = await request(app).get('/api/research-desk/ACME/evidence').set('Authorization', `Bearer ${tokenA}`)
    expect(r.status).toBe(422)
  })

  test('rejects a malformed symbol', async () => {
    const r = await request(app).get('/api/research-desk/%3Cscript%3E/evidence').set('Authorization', `Bearer ${tokenA}`)
    expect(r.status).toBe(400)
  })
})

describe('POST /:symbol/thesis', () => {
  test('a supported long is judged actionable, journalled, and recorded for scoring', async () => {
    const id = await valId()
    mockCall.mockResolvedValue(withIds(thesisReply(), id))
    const r = await request(app).post('/api/research-desk/ACME/thesis').set('Authorization', `Bearer ${tokenA}`)
    expect(r.status).toBe(200)
    expect(r.body.error).toBeUndefined()
    expect(r.body.judgement.verdict).toBe('actionable')
    expect(r.body.judgement.zones.target).toBeCloseTo(LAST * 1.15, 3)
    expect(r.body.userId).toBeUndefined()
    expect(mockRecord).toHaveBeenCalledWith(expect.objectContaining({ surface: 'research', symbol: 'ACME', action: 'buy', price: LAST }))
    const lines = fs.readFileSync(TMP_THESES, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(1)
    expect(JSON.parse(lines[0]).userId).toBe('user-a')
  })

  test('an invented figure is removed; with no supported bull claim it is not a trade and is not scored', async () => {
    const id = await valId()
    mockCall.mockResolvedValue(withIds(thesisReply({ bull: [{ claim: 'Revenue grew 45% last quarter', cites: ['VAL'] }] }), id))
    const r = await request(app).post('/api/research-desk/ACME/thesis').set('Authorization', `Bearer ${tokenA}`)
    expect(r.body.judgement.verdict).toBe('no-trade')
    expect(r.body.judgement.droppedClaims[0].reason).toMatch(/45/)
    expect(mockRecord).not.toHaveBeenCalled()
  })

  test('unusable model output is an error in the body (heartbeated route)', async () => {
    mockCall.mockResolvedValue({ text: 'sorry, cannot help', llmUsed: 'claude' })
    const r = await request(app).post('/api/research-desk/ACME/thesis').set('Authorization', `Bearer ${tokenA}`)
    expect(JSON.parse(r.text.trim()).error).toMatch(/no usable thesis/)
  })
})

describe('GET /theses', () => {
  test("lists only the caller's theses, with a live status", async () => {
    const id = await valId()
    mockCall.mockResolvedValue(withIds(thesisReply(), id))
    await request(app).post('/api/research-desk/ACME/thesis').set('Authorization', `Bearer ${tokenA}`)
    const a = await request(app).get('/api/research-desk/theses').set('Authorization', `Bearer ${tokenA}`)
    const b = await request(app).get('/api/research-desk/theses').set('Authorization', `Bearer ${tokenB}`)
    expect(a.body.theses).toHaveLength(1)
    expect(a.body.theses[0].status.state).toBeDefined()
    expect(b.body.theses).toHaveLength(0)
  })
})
