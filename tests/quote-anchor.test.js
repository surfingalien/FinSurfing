'use strict'
/**
 * Unit tests for lib/quote-anchor.js — evidence verification for the
 * earnings-call analyst card's quote-anchored bull/bear points.
 */

const { normalizeForMatch, quoteAppears, anchorPoints } = require('../lib/quote-anchor')

const transcript = normalizeForMatch(`
  Thanks everyone for joining. Revenue grew 24% year-over-year, driven by
  record data-center demand. "We expect gross margins to compress slightly
  in Q3," said the CFO — pricing pressure in consumer remains a headwind.
  We're raising full-year guidance on the strength of our backlog.
`)

describe('normalizeForMatch', () => {
  test('case, punctuation, smart quotes, and whitespace are neutralized', () => {
    expect(normalizeForMatch('  Revenue GREW 24%,   year-over-year! '))
      .toBe('revenue grew 24 year over year')
    expect(normalizeForMatch('“We’re raising”')).toBe("we're raising")
  })
})

describe('quoteAppears', () => {
  test('verbatim quote matches despite formatting differences', () => {
    expect(quoteAppears('Revenue grew 24% year-over-year', transcript)).toBe(true)
    expect(quoteAppears('we expect gross margins to compress slightly in Q3', transcript)).toBe(true)
  })

  test('paraphrased or invented quotes do not match', () => {
    expect(quoteAppears('Revenue increased by a quarter versus last year', transcript)).toBe(false)
    expect(quoteAppears('We are cutting guidance for the full year', transcript)).toBe(false)
  })

  test('trivially short quotes are rejected as evidence', () => {
    expect(quoteAppears('Revenue', transcript)).toBe(false)
  })
})

describe('anchorPoints', () => {
  test('object points get verified quotes; unverifiable are flagged, not dropped', () => {
    const out = anchorPoints([
      { point: 'Strong data-center growth', quote: 'record data-center demand' },
      { point: 'Margin pressure ahead', quote: 'margins will collapse next year' },
    ], transcript)
    expect(out).toEqual([
      { point: 'Strong data-center growth', quote: 'record data-center demand', anchored: true },
      { point: 'Margin pressure ahead', quote: 'margins will collapse next year', anchored: false },
    ])
  })

  test('legacy string points survive as unanchored', () => {
    expect(anchorPoints(['Growth is strong'], transcript))
      .toEqual([{ point: 'Growth is strong', quote: null, anchored: false }])
  })

  test('caps at 4, drops empties, tolerates junk', () => {
    expect(anchorPoints([{}, { point: '' }, null, 'a', 'b', 'c', 'd', 'e'], transcript)).toHaveLength(2)
    expect(anchorPoints('not an array', transcript)).toEqual([])
  })
})
