'use strict'
/**
 * Route-level test for the reported AVAX failure.
 *
 * Searching a single symbol returned a red banner: "AI Brain returned no
 * internally consistent picks — try again". Two things were wrong. The scan
 * schema offered only BUY verdicts, so a model that disliked the symbol could
 * only say so with a negative targetReturn on a "Buy" — which the coherence
 * gate correctly refused to trust. And with one symbol that emptied the slate,
 * which the route reported as a 500.
 *
 * Both halves are under test here: an "Avoid" survives as a non-actionable
 * answer, and an empty slate is a 200 that says which symbol and why.
 *
 * Every network collaborator is mocked; no API keys, no LLM, no disk writes.
 */

const request = require('supertest')
const express = require('express')
const jwt     = require('jsonwebtoken')

const mockCall = jest.fn()

jest.mock('../lib/ai-router', () => ({
  getRouter: () => ({ call: (...a) => mockCall(...a) }),
  GROQ_MODEL: 'openai/gpt-oss-120b',
}))
jest.mock('../lib/brain-learnings', () => ({
  buildLearnings: () => ({ block: '', version: 'none' }), getAutoTunedThreshold: () => null,
  computeStats: () => ({}), readPredictions: () => [],
}))
jest.mock('../lib/strategy-library',  () => ({ getStrategyBlock: () => '' }))
jest.mock('../lib/learning-store',    () => ({ recordDecisions: jest.fn(), getCalibrationBlock: () => '' }))
jest.mock('../lib/social-sentiment',  () => ({
  getSocialSentiment: async () => '', getCryptoFearGreed: async () => null, getBtcDominance: async () => null,
}))
jest.mock('../lib/alt-data', () => ({
  getAltDataSnippet: async () => null, getGeopoliticalRiskSnippet: async () => null,
}))
jest.mock('../lib/options-flow-cache', () => ({ getOptionsFlowCompact: async () => null }))
jest.mock('../routes/macro',           () => ({ getIndicators: async () => null }))

process.env.NODE_ENV   = 'test'
process.env.JWT_SECRET = 'test-secret-for-jest-only-32chars!!'

// data/ai-brain-predictions.jsonl is the real calibration record (mirrored to
// Postgres in production). An actionable pick in this suite calls
// logPrediction, so without this redirect the tests append fake AVAX
// predictions to it — which is exactly how six of them were once committed and
// would have been resolved against real bars and scored as evidence. Set
// BEFORE the route is required, since it reads the path once at module load.
const os   = require('os')
const fsp  = require('fs')
const pathp = require('path')
const TMP_LOG = pathp.join(os.tmpdir(), `ai-brain-predictions-test-${process.pid}.jsonl`)
process.env.AI_BRAIN_PREDICTION_LOG = TMP_LOG

let app, token
const realFetch = global.fetch

beforeAll(() => {
  app = express()
  app.use(express.json())
  app.use('/api/ai-brain', require('../routes/ai-brain'))
  token = jwt.sign({ sub: 'brain-user', email: 'b@test.dev', role: 'user' },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })
})

// Live prices + daily bars the route fetches over loopback. Everything else
// fails, which the route already treats as best-effort. The scan now REFUSES
// to run on remembered prices, so a quote feed is part of the fixture.
const LIVE = { AVAX: 11.5, DOGE: 0.2 }
const DAY = 86400
function barsFor(price) {
  const t0 = Math.floor(Date.now() / 1000) - 80 * DAY
  const n = 80, ts = [], o = [], h = [], l = [], c = [], v = []
  for (let i = 0; i < n; i++) {
    const px = price * (0.9 + 0.1 * (i / (n - 1)))
    ts.push(t0 + i * DAY); o.push(px); h.push(px * 1.02); l.push(px * 0.98); c.push(px); v.push(1e6)
  }
  c[n - 1] = price
  return { chart: { result: [{ timestamp: ts, indicators: { quote: [{ open: o, high: h, low: l, close: c, volume: v }] } }] } }
}
let offline = false
beforeEach(() => {
  mockCall.mockReset()
  offline = false
  global.fetch = jest.fn(async (url) => {
    const u = String(url)
    if (!offline && u.includes('/api/quote?')) {
      const syms = new URL(u).searchParams.get('symbols').split(',')
      const result = syms.filter(s => LIVE[s]).map(s => ({ symbol: s, regularMarketPrice: LIVE[s] }))
      return { ok: true, json: async () => ({ quoteResponse: { result } }) }
    }
    if (!offline && u.includes('/api/chart?')) {
      const sym = new URL(u).searchParams.get('symbol')
      if (LIVE[sym]) return { ok: true, json: async () => barsFor(LIVE[sym]) }
    }
    throw new Error('offline in test')
  })
})
afterAll(() => {
  global.fetch = realFetch
  try { fsp.unlinkSync(TMP_LOG) } catch { /* never created */ }
})

const stock = (over = {}) => ({
  rank: 1, symbol: 'AVAX', name: 'Avalanche', sector: 'Crypto', type: 'Crypto',
  currentPrice: 11.5, compositeScore: 40, confidence: 'Low',
  agentVerdict: 'Moderate Buy', targetReturn: 20, stopLoss: 10,
  entryZoneLow: 11.27, entryZoneHigh: 11.73,
  targetZoneLow: 13.39, targetZoneHigh: 14.21,
  stopZoneLow: 10.19, stopZoneHigh: 10.51,
  fundamentalScore: 40, technicalScore: 40, sentimentScore: 40, macroScore: 40, riskScore: 40,
  ...over,
})

const reply = (...stocks) => ({
  text: JSON.stringify({
    marketRegime: 'Neutral', macroOutlook: 'Mixed', agentConsensusTheme: 'Caution',
    dataSource: 'live', rankedStocks: stocks,
  }),
  llmUsed: 'claude',
})

const scan = (body = {}) => request(app).post('/api/ai-brain/analyze')
  .set('Authorization', `Bearer ${token}`)
  .send({ symbols: ['AVAX'], horizon: '3m', ...body })

// The route fires several loopback fetches with their own timeouts before it
// reaches the gate, so the default 5s budget is not enough.
jest.setTimeout(30_000)

describe('POST /api/ai-brain/analyze — the AVAX regression', () => {
  test('a bearish single-symbol scan is a 200 answer, not a 500 error', async () => {
    // This is the exact shape that produced the red banner: the only way the
    // old schema let a model be bearish was a negative target on a buy.
    mockCall.mockResolvedValue(reply(stock({ targetReturn: -12 })))
    const res = await scan()

    expect(res.status).toBe(200)
    expect(res.body.abstained).toBe(true)
    expect(res.body.rankedStocks).toEqual([])
    // And it says WHICH symbol and WHY, rather than "try again".
    expect(res.body.coherenceAudit.droppedPicks).toEqual([
      { symbol: 'AVAX', reason: expect.stringMatching(/negative targetReturn/) },
    ])
    expect(res.body.notes.join(' ')).toMatch(/AVAX/)
  })

  test('an Avoid verdict is returned as a real, non-actionable answer', async () => {
    mockCall.mockResolvedValue(reply(stock({ agentVerdict: 'Avoid', targetReturn: 0, stopLoss: 0 })))
    const res = await scan()

    expect(res.status).toBe(200)
    expect(res.body.rankedStocks).toHaveLength(1)
    expect(res.body.rankedStocks[0]).toMatchObject({ symbol: 'AVAX', actionable: false })
    expect(res.body.coherenceAudit.actionable).toBe(0)
  })

  test('a healthy pick still comes back actionable with derived levels', async () => {
    mockCall.mockResolvedValue(reply(stock()))
    const res = await scan()

    expect(res.status).toBe(200)
    expect(res.body.abstained).toBeUndefined()
    const p = res.body.rankedStocks[0]
    expect(p.actionable).toBe(true)
    // Derived from entry 11.50 × 1.20, not trusted from the model.
    expect(p.targetZoneLow).toBeCloseTo(13.386, 2)
  })

  test('an Avoid alongside a buy keeps both, and only the buy is tradeable', async () => {
    mockCall.mockResolvedValue(reply(
      stock(),
      stock({ rank: 2, symbol: 'DOGE', agentVerdict: 'Avoid', targetReturn: 0, stopLoss: 0 }),
    ))
    const res = await scan({ symbols: ['AVAX', 'DOGE'] })

    expect(res.body.rankedStocks.map(p => p.symbol)).toEqual(['AVAX', 'DOGE'])
    expect(res.body.coherenceAudit).toMatchObject({ checked: 2, kept: 2, actionable: 1 })
    expect(res.body.coherenceAudit.abstainedPicks).toEqual([{ symbol: 'DOGE', verdict: 'Avoid' }])
  })

  test('predictions go to the redirected log, not the tracked calibration record', async () => {
    // Not circular: this proves the AI_BRAIN_PREDICTION_LOG override is in
    // effect. If it ever stops being honoured the redirect silently fails and
    // this suite resumes appending fake AVAX rows to the real, git-tracked
    // calibration log — which is how this was found in the first place.
    mockCall.mockResolvedValue(reply(stock()))
    await scan()

    expect(fsp.existsSync(TMP_LOG)).toBe(true)
    expect(fsp.readFileSync(TMP_LOG, 'utf8')).toMatch(/"symbol":"AVAX"/)
  })

  test('an abstain writes no prediction at all', async () => {
    // An "Avoid" is not a trade, so it must never reach the calibration record.
    try { fsp.unlinkSync(TMP_LOG) } catch { /* fine */ }
    mockCall.mockResolvedValue(reply(stock({ agentVerdict: 'Avoid', targetReturn: 0, stopLoss: 0 })))
    await scan()
    expect(fsp.existsSync(TMP_LOG)).toBe(false)
  })

  test('the prompt offers the model a way to decline', async () => {
    mockCall.mockResolvedValue(reply(stock()))
    await scan()
    // The rules live in the cached system block (SCAN_SYSTEM), not the per-scan prompt.
    const { system } = mockCall.mock.calls[0][0]
    expect(system).toMatch(/Strong Buy\|Buy\|Moderate Buy\|Avoid/)
    expect(system).toMatch(/Do NOT express a bearish view as a negative targetReturn/)
  })

  test('the cached instruction block is byte-identical across scans; the data is not in it', async () => {
    mockCall.mockResolvedValue(reply(stock()))
    await scan()
    await scan()
    const [a, b] = mockCall.mock.calls.map(c => c[0])
    expect(a.system).toBe(b.system)
    expect(a.system).not.toMatch(/AVAX/)              // universe, prices and dates stay out of the cached prefix
    expect(a.system).not.toMatch(/Today is/)
    expect(a.prompt).toMatch(/Universe: AVAX/)
  })
})

describe('POST /api/ai-brain/analyze — real prices and levels on every card', () => {
  test('with no current price anywhere the scan is refused, not run from memory', async () => {
    offline = true
    mockCall.mockResolvedValue(reply(stock()))
    const res = await scan()
    const body = JSON.parse(res.text.trim())
    expect(body.error).toMatch(/pricing stocks from memory/)
    expect(body.unpricedSymbols).toEqual(['AVAX'])
    expect(mockCall).not.toHaveBeenCalled()
  })

  test("the card shows the live price, not the model's", async () => {
    mockCall.mockResolvedValue(reply(stock({ currentPrice: 99, entryZoneLow: 97, entryZoneHigh: 101 })))
    const res = await scan()
    const p = res.body.rankedStocks[0]
    expect(p.currentPrice).toBe(11.5)
    expect(p.priceSource).toBe('live quote')
    // entry re-anchored to the live price, so the derived target follows it
    expect(p.targetZoneLow).toBeCloseTo(13.386, 2)
  })

  test('an actionable pick carries entry, stop and two profit-booking levels', async () => {
    mockCall.mockResolvedValue(reply(stock()))
    const res = await scan()
    const plan = res.body.rankedStocks[0].tradePlan
    expect(plan.basis).toBe('thesis')
    expect(plan.stop.price).toBeCloseTo(11.5 * 0.9, 3)
    expect(plan.booking.map(b => b.label)).toEqual(['T1 — book partial profit', 'T2 — target'])
    expect(plan.booking[1].price).toBeCloseTo(11.5 * 1.2, 3)
  })

  test('a declined pick still gets clearly-labelled technical reference levels', async () => {
    mockCall.mockResolvedValue(reply(stock({ agentVerdict: 'Avoid', targetReturn: 0, stopLoss: 0 })))
    const res = await scan()
    const p = res.body.rankedStocks[0]
    expect(p.actionable).toBe(false)
    expect(p.tradePlan.basis).toBe('technical')
    expect(p.tradePlan.entry.high).toBe(11.5)
    expect(p.tradePlan.stop.price).toBeLessThan(p.tradePlan.entry.low)
  })

  test('a pick for a symbol outside the priced universe is dropped, not shown with an invented price', async () => {
    mockCall.mockResolvedValue(reply(stock(), stock({ rank: 2, symbol: 'ZZZZ', currentPrice: 42 })))
    const res = await scan()
    expect(res.body.rankedStocks.map(p => p.symbol)).toEqual(['AVAX'])
    expect(res.body.coherenceAudit.droppedPicks).toEqual(expect.arrayContaining([
      { symbol: 'ZZZZ', reason: 'not in the priced scan universe' },
    ]))
  })

  test('the prompt never tells the model to use remembered prices', async () => {
    mockCall.mockResolvedValue(reply(stock()))
    await scan({ symbols: ['AVAX', 'NOPRICE'] })
    const prompt = mockCall.mock.calls[0][0].prompt
    expect(prompt).not.toMatch(/training knowledge/)
    expect(prompt).toMatch(/Universe: AVAX\n/)
    expect(prompt).toMatch(/Removed from this scan \(no current price available\): NOPRICE/)
  })
})
