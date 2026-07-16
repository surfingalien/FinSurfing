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

describe('trust scoring', () => {
  const fullPick = { symbol: 'NVDA', entryPrice: 120, targetReturn: 25, stopLoss: 10, thesis: 'AI demand continues to outpace supply', sources: ['10-K'] }

  test('fully accountable pick scores 100; bare ticker scores 0', () => {
    expect(j.scorePick(fullPick)).toBe(100)
    expect(j.scorePick({ symbol: 'X' })).toBe(0)
  })

  test('missing sources costs 25; short thesis does not count', () => {
    expect(j.scorePick({ ...fullPick, sources: [] })).toBe(75)
    expect(j.scorePick({ ...fullPick, thesis: 'buy' })).toBe(75)
  })

  test('scoreEntry averages picks, tiers, and names the weakest', () => {
    const t = j.scoreEntry([fullPick, { symbol: 'AAPL', entryPrice: 190, targetReturn: 15, stopLoss: 8, thesis: 'Services growth with installed-base moat' }])
    expect(t.score).toBe(88)
    expect(t.tier).toBe('gold')
    expect(t.weakest.symbol).toBe('AAPL')
  })

  test('buildEntry carries the trust block', () => {
    expect(j.buildEntry({ recommendations: [fullPick] }).trust)
      .toEqual({ score: 100, tier: 'gold', weakest: { symbol: 'NVDA', score: 100 } })
  })
})

describe('hash chain', () => {
  let file
  beforeEach(() => { file = path.join(os.tmpdir(), `recj-chain-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`) })
  afterEach(() => { try { fs.unlinkSync(file) } catch {} })

  const write = entries => fs.writeFileSync(file, entries.map(e => JSON.stringify(e)).join('\n') + '\n')
  const read  = () => fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(JSON.parse)

  test('appendEntry links each entry to the previous one', () => {
    j.appendEntry(j.buildEntry({ recommendations: recs, rationale: 'a' }), file)
    j.appendEntry(j.buildEntry({ recommendations: recs, rationale: 'b' }), file)
    const [first, second] = read()
    expect(first.prevChainHash).toBe(j.GENESIS_HASH)
    expect(second.prevChainHash).toBe(first.chainHash)
    expect(j.verifyChain(file)).toMatchObject({ valid: true, entries: 2, chained: 2, legacy: 0 })
  })

  test('tampering with a chained entry is detected at the right index', () => {
    j.appendEntry(j.buildEntry({ recommendations: recs, rationale: 'a' }), file)
    j.appendEntry(j.buildEntry({ recommendations: recs, rationale: 'b' }), file)
    const entries = read()
    entries[0].rationale = 'tampered'
    write(entries)
    const v = j.verifyChain(file)
    expect(v.valid).toBe(false)
    expect(v.firstBreak.index).toBe(1)
  })

  test('deleting a chained entry breaks the chain', () => {
    j.appendEntry(j.buildEntry({ recommendations: recs, rationale: 'a' }), file)
    j.appendEntry(j.buildEntry({ recommendations: recs, rationale: 'b' }), file)
    j.appendEntry(j.buildEntry({ recommendations: recs, rationale: 'c' }), file)
    const entries = read()
    entries.splice(1, 1)
    write(entries)
    expect(j.verifyChain(file).valid).toBe(false)
  })

  test('legacy pre-chain entries are tolerated and counted', () => {
    write([{ id: 'legacy', at: '2026-01-01', picks: [] }])
    j.appendEntry(j.buildEntry({ recommendations: recs, rationale: 'a' }), file)
    expect(j.verifyChain(file)).toMatchObject({ valid: true, entries: 2, chained: 1, legacy: 1 })
  })

  test('canonicalJson is key-order independent', () => {
    expect(j.canonicalJson({ a: 1, b: { d: 2, c: 3 } })).toBe(j.canonicalJson({ b: { c: 3, d: 2 }, a: 1 }))
  })
})
