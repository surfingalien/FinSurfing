'use strict'
/**
 * Route-level tests for routes/exposure.js.
 *
 * The property under test is end-to-end: a model that invents a supply-chain
 * relationship must not be able to get it into the graph, no matter how
 * plausible the invention reads. EDGAR and the AI router are mocked so the
 * route's own wiring is exercised with no network and no keys.
 */

const request = require('supertest')
const express = require('express')
const jwt     = require('jsonwebtoken')
const fs      = require('fs')
const os      = require('os')
const path    = require('path')

// jest.mock factories may only reference vars prefixed with `mock`.
const mockCall         = jest.fn()
const mockFindMentions = jest.fn()
const mockFindPeers    = jest.fn()
const mockGetFiling    = jest.fn()

jest.mock('../lib/ai-router', () => ({ getRouter: () => ({ call: (...a) => mockCall(...a) }) }))

jest.mock('../lib/edgar-search', () => {
  const actual = jest.requireActual('../lib/edgar-search')
  return {
    ...actual,
    findMentions: (...a) => mockFindMentions(...a),
    findPeers:    (...a) => mockFindPeers(...a),
  }
})

jest.mock('../lib/filings', () => {
  const actual = jest.requireActual('../lib/filings')
  return { ...actual, getLatestFiling: (...a) => mockGetFiling(...a) }
})

// Keep the graph off the real data directory.
const mockGraphFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'exp-route-')), 'entity-graph.jsonl')
jest.mock('../lib/entity-graph', () => {
  const actual = jest.requireActual('../lib/entity-graph')
  return {
    ...actual,
    latestEdges:    (anchor) => actual.latestEdges(anchor, mockGraphFile),
    writeSnapshot:  (anchor, edges, opts = {}) => actual.writeSnapshot(anchor, edges, { ...opts, file: mockGraphFile }),
    trackedAnchors: () => actual.trackedAnchors(mockGraphFile),
  }
})

process.env.NODE_ENV   = 'test'
process.env.JWT_SECRET = 'test-secret-for-jest-only-32chars!!'

const FILING_TEXT =
  'Item 1. Business. We derive a substantial portion of our revenue from SpaceX, which ' +
  'accounted for 34% of total revenue in fiscal 2025. We compete with several launch providers.'

let app, token

beforeAll(() => {
  app = express()
  app.use(express.json())
  app.use('/api/exposure', require('../routes/exposure'))
  token = jwt.sign({ sub: 'exp-user', email: 'exp@test.dev', role: 'user' },
    process.env.JWT_SECRET, { algorithm: 'HS256', expiresIn: '5m' })
})

beforeEach(() => {
  mockCall.mockReset(); mockFindMentions.mockReset()
  mockFindPeers.mockReset(); mockGetFiling.mockReset()
  try { fs.unlinkSync(mockGraphFile) } catch { /* first run */ }

  mockFindPeers.mockReturnValue({ basis: 'industry', peers: [] })
  mockFindMentions.mockResolvedValue([
    { cik: '0001819994', symbol: 'RKLB', company: 'Rocket Lab USA, Inc.', form: '10-K',
      filedAt: '2026-02-14', matchedAlias: 'SpaceX', mentions: 3, discovery: 'filing_search' },
  ])
  mockGetFiling.mockResolvedValue({
    symbol: 'RKLB', form: '10-K', filingDate: '2026-02-14',
    url: 'https://sec.gov/x', excerpt: FILING_TEXT,
  })
})

const get = (p) => request(app).get(p).set('Authorization', `Bearer ${token}`)

describe('GET /api/exposure/:anchor', () => {
  test('requires auth', async () => {
    const res = await request(app).get('/api/exposure/SPACEX')
    expect(res.status).toBe(401)
    expect(mockFindMentions).not.toHaveBeenCalled()
  })

  test('a verifiable quote becomes an edge with its evidence attached', async () => {
    mockCall.mockResolvedValue({ text: JSON.stringify({
      relation: 'supplier',
      quote: 'We derive a substantial portion of our revenue from SpaceX, which accounted for 34% of total revenue',
      materialityPct: 34,
    }), llmUsed: 'claude' })

    const res = await get('/api/exposure/SPACEX')
    expect(res.status).toBe(200)
    expect(res.body.edges).toHaveLength(1)
    expect(res.body.edges[0]).toMatchObject({ symbol: 'RKLB', relation: 'supplier', materialityPct: 34 })
    expect(res.body.edges[0].evidence.verified).toBe(true)
    expect(res.body.universe).toEqual(['RKLB'])
  })

  test('a FABRICATED relationship never reaches the graph', async () => {
    // Reads perfectly, cites nothing that exists in the filing.
    mockCall.mockResolvedValue({ text: JSON.stringify({
      relation: 'supplier',
      quote: 'We are the exclusive propulsion supplier to SpaceX under a ten-year master agreement.',
      materialityPct: 60,
    }), llmUsed: 'claude' })

    const res = await get('/api/exposure/SPACEX')
    expect(res.status).toBe(200)
    expect(res.body.edges).toEqual([])
    expect(res.body.universe).toEqual([])
  })

  test('a real quote that does not mention the anchor is rejected', async () => {
    mockCall.mockResolvedValue({ text: JSON.stringify({
      relation: 'supplier', quote: 'We compete with several launch providers.',
    }), llmUsed: 'claude' })
    const res = await get('/api/exposure/SPACEX')
    expect(res.body.edges).toEqual([])
  })

  test('relation "none" produces no edge', async () => {
    mockCall.mockResolvedValue({ text: JSON.stringify({ relation: 'none', quote: '' }), llmUsed: 'claude' })
    const res = await get('/api/exposure/SPACEX')
    expect(res.body.edges).toEqual([])
  })

  test('an unparseable model response is skipped, not surfaced as an edge', async () => {
    mockCall.mockResolvedValue({ text: 'I think Rocket Lab supplies SpaceX!', llmUsed: 'claude' })
    const res = await get('/api/exposure/SPACEX')
    expect(res.status).toBe(200)
    expect(res.body.edges).toEqual([])
  })

  test('peers still return when EDGAR search is unavailable', async () => {
    mockFindMentions.mockRejectedValue(new Error('efts unreachable'))
    mockFindPeers.mockReturnValue({ basis: 'industry', peers: [{
      symbol: 'LMT', company: 'Lockheed Martin', cik: null, relation: 'peer',
      discovery: 'peer_industry', form: 'peer_sic', filedAt: '2026-09-09',
      quote: 'Classified in the same industry as RKLB: Aerospace & Defense.',
    }] })

    const res = await get('/api/exposure/RKLB')
    expect(res.status).toBe(200)
    expect(res.body.edges.map(e => e.symbol)).toContain('LMT')
    expect(res.body.notes.join(' ')).toMatch(/filing search unavailable/)
  })

  test('?suppliers=false skips the expensive path entirely', async () => {
    mockFindPeers.mockReturnValue({ basis: 'industry', peers: [] })
    await get('/api/exposure/RKLB?suppliers=false')
    expect(mockFindMentions).not.toHaveBeenCalled()
    expect(mockCall).not.toHaveBeenCalled()
  })

  test('rejects a junk anchor before doing any work', async () => {
    const res = await get('/api/exposure/%2F%2F%2F')
    expect(res.status).toBe(400)
    expect(mockFindMentions).not.toHaveBeenCalled()
  })

  test('the first run reports no diff — there is no baseline to compare to', async () => {
    mockCall.mockResolvedValue({ text: JSON.stringify({
      relation: 'supplier',
      quote: 'We derive a substantial portion of our revenue from SpaceX, which accounted for 34% of total revenue',
    }), llmUsed: 'claude' })
    const res = await get('/api/exposure/SPACEX')
    expect(res.body.diff).toBeNull()
  })

  test('a relationship disappearing on a later run is reported as dropped', async () => {
    mockCall.mockResolvedValue({ text: JSON.stringify({
      relation: 'supplier',
      quote: 'We derive a substantial portion of our revenue from SpaceX, which accounted for 34% of total revenue',
    }), llmUsed: 'claude' })
    await get('/api/exposure/SPACEX')

    // Next filing no longer names the anchor.
    mockGetFiling.mockResolvedValue({
      symbol: 'RKLB', form: '10-K', filingDate: '2027-02-14',
      url: 'https://sec.gov/y', excerpt: 'Item 1. Business. We build launch vehicles.',
    })
    const res = await get('/api/exposure/SPACEX')
    expect(res.body.diff.dropped).toHaveLength(1)
    expect(res.body.diff.dropped[0].symbol).toBe('RKLB')
  })
})

describe('GET /api/exposure/:anchor/graph', () => {
  test('reads the stored map with no network and no model call', async () => {
    mockCall.mockResolvedValue({ text: JSON.stringify({
      relation: 'supplier',
      quote: 'We derive a substantial portion of our revenue from SpaceX, which accounted for 34% of total revenue',
    }), llmUsed: 'claude' })
    await get('/api/exposure/SPACEX')

    mockCall.mockReset(); mockFindMentions.mockReset()
    const res = await request(app).get('/api/exposure/SPACEX/graph')
    expect(res.status).toBe(200)
    expect(res.body.edges).toHaveLength(1)
    expect(res.body.cached).toBe(true)
    expect(mockCall).not.toHaveBeenCalled()
    expect(mockFindMentions).not.toHaveBeenCalled()
  })

  test('an unmapped anchor returns an empty map, not an error', async () => {
    const res = await request(app).get('/api/exposure/NEVERMAPPED/graph')
    expect(res.status).toBe(200)
    expect(res.body.edges).toEqual([])
  })
})

describe('GET /api/exposure/anchors', () => {
  test('lists private anchors and the relation vocabulary', async () => {
    const res = await request(app).get('/api/exposure/anchors')
    expect(res.status).toBe(200)
    expect(res.body.private.map(a => a.key)).toEqual(expect.arrayContaining(['SPACEX', 'OPENAI']))
    expect(Object.keys(res.body.relations)).toEqual(expect.arrayContaining(['supplier', 'competitor']))
  })
})

describe('POST /api/exposure/:anchor/research', () => {
  test('refuses to research an anchor with no map yet', async () => {
    const res = await request(app).post('/api/exposure/NOTHING/research')
      .set('Authorization', `Bearer ${token}`).send({})
    expect(res.status).toBe(404)
    expect(res.body.error).toMatch(/No exposure map/)
  })
})
