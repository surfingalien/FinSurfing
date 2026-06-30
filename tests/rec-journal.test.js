'use strict'
/**
 * Unit tests for lib/rec-journal.js — content hashing, diffing, and the
 * append/read JSONL round-trip (against a temp file, no shared state).
 */

const fs   = require('fs')
const os   = require('os')
const path = require('path')
const j = require('../lib/rec-journal')

const recs = [
  { symbol: 'NVDA', type: 'Stock', entryPrice: 120, targetReturn: 25, stopLoss: 10, thesis: 'AI demand' },
  { symbol: 'AAPL', type: 'Stock', entryPrice: 190, targetReturn: 15, stopLoss: 8,  thesis: 'Services growth' },
]

describe('hashEntry', () => {
  test('deterministic and order-independent', () => {
    const h1 = j.hashEntry(recs, 'bull market')
    const h2 = j.hashEntry([recs[1], recs[0]], 'bull market') // reordered
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[0-9a-f]{8}$/)
  })

  test('changes when a pick or the rationale changes', () => {
    const base = j.hashEntry(recs, 'bull market')
    expect(j.hashEntry([{ ...recs[0], targetReturn: 30 }, recs[1]], 'bull market')).not.toBe(base)
    expect(j.hashEntry(recs, 'bear market')).not.toBe(base)
  })

  test('reflects a change in citation sources (evidence is part of the record)', () => {
    const a = j.hashEntry([{ ...recs[0], sources: ['RSI 28 — oversold'] }, recs[1]], 'r')
    const b = j.hashEntry([{ ...recs[0], sources: ['analyst target $210'] }, recs[1]], 'r')
    expect(a).not.toBe(b)
  })
})

describe('citations / sources', () => {
  test('normalizePick preserves sources as a string array (defaults to [])', () => {
    expect(j.normalizePick({ symbol: 'nvda', sources: ['RSI 28', 'macro VIX spike'] }).sources)
      .toEqual(['RSI 28', 'macro VIX spike'])
    expect(j.normalizePick({ symbol: 'nvda' }).sources).toEqual([])
  })

  test('buildEntry carries sources through to the stored pick', () => {
    const e = j.buildEntry({ recommendations: [{ symbol: 'NVDA', sources: ['10-K risk eased'] }], rationale: 'r' })
    expect(e.picks[0].sources).toEqual(['10-K risk eased'])
  })
})

describe('buildEntry', () => {
  test('produces an id, normalized picks, and metadata', () => {
    const e = j.buildEntry({ recommendations: recs, rationale: 'r', persona: 'buffett', userId: 7, at: '2026-06-30T00:00:00Z' })
    expect(e.id).toMatch(/^[0-9a-f]{8}$/)
    expect(e.count).toBe(2)
    expect(e.userId).toBe('7')
    expect(e.persona).toBe('buffett')
    expect(e.picks[0].symbol).toBe('NVDA')
  })
})

describe('diffEntries', () => {
  test('detects added / removed / changed by symbol', () => {
    const prev = recs
    const next = [
      { ...recs[0], targetReturn: 30, thesis: 'AI demand accelerating' }, // NVDA changed
      { symbol: 'MSFT', type: 'Stock', entryPrice: 400, targetReturn: 12, stopLoss: 7, thesis: 'Cloud' }, // added (AAPL removed)
    ]
    const d = j.diffEntries(prev, next)
    expect(d.added).toEqual(['MSFT'])
    expect(d.removed).toEqual(['AAPL'])
    expect(d.changed).toHaveLength(1)
    expect(d.changed[0].symbol).toBe('NVDA')
    expect(d.changed[0].fields.targetReturn).toEqual({ from: 25, to: 30 })
    expect(d.changed[0].fields.thesis.to).toMatch(/accelerating/)
  })

  test('identical lists produce an empty diff', () => {
    const d = j.diffEntries(recs, recs.map(r => ({ ...r })))
    expect(d.added).toEqual([])
    expect(d.removed).toEqual([])
    expect(d.changed).toEqual([])
  })
})

describe('append / read round-trip', () => {
  let file
  beforeEach(() => { file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'recj-')), 'journal.jsonl') })

  test('appends and reads newest-first, filtered by user, limited', () => {
    j.appendEntry(j.buildEntry({ recommendations: recs, rationale: 'v1', userId: 1, at: '2026-06-30T00:00:00Z' }), file)
    j.appendEntry(j.buildEntry({ recommendations: recs, rationale: 'other-user', userId: 2, at: '2026-06-30T00:01:00Z' }), file)
    j.appendEntry(j.buildEntry({ recommendations: [recs[0]], rationale: 'v2', userId: 1, at: '2026-06-30T00:02:00Z' }), file)

    const mine = j.readJournal({ userId: 1, file })
    expect(mine).toHaveLength(2)
    expect(mine[0].rationale).toBe('v2')   // newest first
    expect(mine[1].rationale).toBe('v1')

    expect(j.readJournal({ userId: 1, limit: 1, file })).toHaveLength(1)
    expect(j.readJournal({ file })).toHaveLength(3) // no filter = all users
  })

  test('readJournalWithDiffs annotates each entry vs the previous one', () => {
    j.appendEntry(j.buildEntry({ recommendations: recs, rationale: 'v1', userId: 1, at: '2026-06-30T00:00:00Z' }), file)
    j.appendEntry(j.buildEntry({ recommendations: [recs[0]], rationale: 'v2', userId: 1, at: '2026-06-30T00:02:00Z' }), file)
    const withDiffs = j.readJournalWithDiffs({ userId: 1, file })
    expect(withDiffs[0].diff.removed).toEqual(['AAPL']) // newest vs previous
    expect(withDiffs[1].diff).toBeNull()                // oldest has no predecessor
  })

  test('missing file → empty', () => {
    expect(j.readJournal({ file: path.join(os.tmpdir(), 'does-not-exist-xyz.jsonl') })).toEqual([])
  })
})
