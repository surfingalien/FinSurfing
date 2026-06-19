'use strict'
/**
 * Unit tests for lib/last-quotes.js — the disk-persisted last-known quote
 * store serving as /api/quote's final fallback. Uses a temp file via the
 * test hook; no network.
 */

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const lastQuotes = require('../lib/last-quotes')
const { record, recall, size, hydrate, MAX_ENTRIES, _setFileForTests, _flushForTests } = lastQuotes

let tmpFile

beforeEach(() => {
  tmpFile = path.join(os.tmpdir(), `last-quotes-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  _setFileForTests(tmpFile)
})

afterEach(() => { try { fs.unlinkSync(tmpFile) } catch {} })

const quote = (over = {}) => ({
  symbol: 'AAPL', shortName: 'Apple Inc.',
  regularMarketPrice: 187.5, regularMarketPreviousClose: 185.2,
  regularMarketChange: 2.3, regularMarketChangePercent: 1.24,
  regularMarketTime: 1765400000,
  ...over,
})

describe('record / recall', () => {
  test('round-trips a slim quote, flagged stale on recall', () => {
    record([quote()])
    const r = recall('AAPL')
    expect(r).toMatchObject({
      symbol: 'AAPL', shortName: 'Apple Inc.',
      regularMarketPrice: 187.5, regularMarketPreviousClose: 185.2,
      regularMarketTime: 1765400000, stale: true,
    })
    expect(typeof r.savedAt).toBe('number')
  })

  test('unknown symbol → null', () => {
    expect(recall('ZZZZ')).toBeNull()
  })

  test('quotes without a price are not recorded', () => {
    record([quote({ symbol: 'FAIL', regularMarketPrice: null })])
    expect(recall('FAIL')).toBeNull()
  })

  test('stale (recalled) quotes are not re-recorded — savedAt stays honest', () => {
    record([quote()])
    const first = recall('AAPL')
    record([{ ...first }])   // simulate the merged response being recorded
    expect(recall('AAPL').savedAt).toBe(first.savedAt)
  })

  test('re-recording a fresh quote updates the stored price', () => {
    record([quote()])
    record([quote({ regularMarketPrice: 190 })])
    expect(recall('AAPL').regularMarketPrice).toBe(190)
  })

  test('extraneous provider fields are stripped (slim storage)', () => {
    record([quote({ giantField: 'x'.repeat(1000), trailingPE: 30 })])
    const r = recall('AAPL')
    expect(r.giantField).toBeUndefined()
    expect(r.trailingPE).toBeUndefined()
  })
})

describe('persistence', () => {
  test('flush + reload from disk survives a "restart"', () => {
    record([quote(), quote({ symbol: 'NVDA', regularMarketPrice: 950 })])
    _flushForTests()
    // Simulate process restart: point at the same file with reset memory
    _setFileForTests(tmpFile)
    expect(recall('NVDA')).toMatchObject({ regularMarketPrice: 950, stale: true })
    expect(size()).toBe(2)
  })

  test('unreadable file starts empty instead of crashing', () => {
    fs.writeFileSync(tmpFile, 'not json{{{')
    _setFileForTests(tmpFile)
    expect(recall('AAPL')).toBeNull()
    expect(size()).toBe(0)
  })

  test('hydrate() loads persisted quotes from disk in no-DB mode', async () => {
    record([quote(), quote({ symbol: 'NVDA', regularMarketPrice: 950 })])
    _flushForTests()
    _setFileForTests(tmpFile)               // reset memory, same file
    const n = await hydrate()
    expect(n).toBe(2)
    expect(recall('AAPL')).toMatchObject({ regularMarketPrice: 187.5, stale: true })
  })
})

describe('eviction', () => {
  test('oldest entries are evicted above MAX_ENTRIES', () => {
    const batch = []
    for (let i = 0; i < MAX_ENTRIES + 50; i++) {
      batch.push(quote({ symbol: `S${i}`, regularMarketPrice: i + 1 }))
    }
    record(batch)
    expect(size()).toBe(MAX_ENTRIES)
    expect(recall('S0')).toBeNull()                       // oldest evicted
    expect(recall(`S${MAX_ENTRIES + 49}`)).not.toBeNull() // newest kept
  })
})
