'use strict'
/**
 * Route-level tests for the syndication fix in routes/sentiment.js.
 *
 * lib/source-independence.js is tested on its own; these pin the WIRING —
 * that the sentiment route actually counts each story once, on both the
 * natively-scored lane and the headlines-to-Claude lane.
 */

process.env.NODE_ENV   = 'test'
process.env.JWT_SECRET = 'test-secret-for-jest-only-32chars!!'

const { foldSymbol, dedupeHeadlines } = require('../routes/sentiment')

const WIRE = 'NEW YORK, Jan 3 (PRNewswire) -- Acme Corporation today announced record quarterly ' +
             'revenue of $4.2 billion, driven by strong demand across every segment.'
const toTen = avg => Math.round(((avg + 1) / 2) * 9 + 1)
const fold = (articles, over = {}) =>
  foldSymbol('ACME', articles, { source: 'test', toTen, emptySummary: 'none', ...over })

const reprint = (i) => ({
  title: 'Acme Announces Record Q4 Revenue', body: WIRE,
  url: `https://outlet${i}.com/acme`, publishedAt: `2026-01-03T0${i}:00:00Z`,
  score: 0.6, polarity: 1,
})
const bearish = {
  title: 'Acme faces EU antitrust probe over pricing practices',
  body: 'Brussels opened a formal case on Tuesday.',
  url: 'https://ft.com/acme-probe', publishedAt: '2026-01-04T09:00:00Z',
  score: -0.6, polarity: -1,
}

describe('foldSymbol — a press release cannot outvote independent reporting', () => {
  test('three reprints plus one independent story score neutral, not bullish', () => {
    const r = fold([reprint(1), reprint(2), reprint(3), bearish])
    // Naive mean would be (0.6+0.6+0.6-0.6)/4 = +0.3 → score 7, "bullish".
    expect(r.score).toBe(toTen(0))
    expect(r.sentiment).toBe('neutral')
  })

  test('headline_count stays raw and independentCount reports real stories', () => {
    const r = fold([reprint(1), reprint(2), reprint(3), bearish])
    expect(r.headline_count).toBe(4)
    expect(r.independentCount).toBe(2)
    expect(r.syndicated).toBe(true)
  })

  test('the summary prefers an independent headline over a press-release title', () => {
    const r = fold([reprint(1), reprint(2), reprint(3), bearish])
    expect(r.summary).toMatch(/antitrust/)
  })

  test('un-syndicated news is scored exactly as before', () => {
    const rows = [
      { title: 'Acme lands $2B defense contract from Pentagon', url: 'https://a.com/1', score: 0.6, polarity: 1 },
      { title: 'Acme chief financial officer resigns abruptly', url: 'https://b.com/2', score: 0.6, polarity: 1 },
    ]
    const r = fold(rows)
    expect(r.score).toBe(toTen(0.6))
    expect(r.syndicated).toBe(false)
    expect(r.independentCount).toBe(2)
  })

  test('no articles yields a well-formed neutral row', () => {
    const r = fold([])
    expect(r).toMatchObject({ symbol: 'ACME', sentiment: 'neutral', score: 5, headline_count: 0, independentCount: 0, syndicated: false })
  })

  test('provider thresholds are honoured', () => {
    const rows = [{ title: 'a b c d e', url: 'https://a.com/1', score: 0.12, polarity: 1 }]
    expect(fold(rows, { bullish: 0.1 }).sentiment).toBe('bullish')
    expect(fold(rows, { bullish: 0.15 }).sentiment).toBe('neutral')
  })
})

describe('dedupeHeadlines — the Claude lane sees stories, not copies', () => {
  test('collapses syndicated copies before the headline budget is spent', () => {
    const articles = [
      reprint(1), reprint(2), reprint(3), reprint(4),
      bearish,
      { title: 'Acme opens new plant in Ohio creating 900 jobs', url: 'https://c.com/9', publishedAt: '2026-01-05T00:00:00Z' },
    ]
    const r = dedupeHeadlines(articles, 5)
    // Six articles, three stories — and the two that were NOT the press
    // release survive, which is what the old `.slice(0, 5)` could not promise.
    expect(r.total).toBe(6)
    expect(r.independentCount).toBe(3)
    expect(r.headlines).toHaveLength(3)
    expect(r.headlines.join(' ')).toMatch(/antitrust/)
    expect(r.headlines.join(' ')).toMatch(/Ohio/)
  })

  test('honours the limit after de-duplication', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      title: `Acme ${['opens plant','cuts jobs','buys rival','wins appeal','names chief','sells unit','raises payout','files suit','ends venture'][i]} in a separate development`,
      url: `https://x${i}.com/a`,
    }))
    expect(dedupeHeadlines(many, 5).headlines).toHaveLength(5)
  })

  test('an all-syndicated set still yields one headline, not zero', () => {
    const r = dedupeHeadlines([reprint(1), reprint(2), reprint(3)], 5)
    expect(r.headlines).toHaveLength(1)
    expect(r.independentCount).toBe(1)
  })

  test('empty and malformed input are safe', () => {
    expect(dedupeHeadlines([], 5)).toMatchObject({ headlines: [], total: 0, independentCount: 0 })
    expect(dedupeHeadlines(null, 5).headlines).toEqual([])
    expect(dedupeHeadlines([{ url: 'https://a.com' }], 5).headlines).toEqual([])
  })
})
