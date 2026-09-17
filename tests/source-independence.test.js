'use strict'
/**
 * Unit tests for lib/source-independence.js.
 *
 * The property under test is the one the module exists for: a story
 * republished N times must argue with the weight of one story, and a genuine
 * disagreement must never be deleted as a duplicate.
 */

const {
  canonicalUrl, normalizeTitle, titleTokens, shingle, jaccard, wireSignature,
  clusterArticles, weightedSentiment, MIN_TITLE_TOKENS,
} = require('../lib/source-independence')

const WIRE_BODY =
  'NEW YORK, Jan 3, 2026 (PRNewswire) -- Acme Corporation today announced record ' +
  'quarterly revenue of $4.2 billion, driven by strong demand across all segments.'

describe('canonicalUrl', () => {
  test('collapses scheme, www and trailing slash', () => {
    expect(canonicalUrl('http://www.example.com/a/')).toBe(canonicalUrl('https://example.com/a'))
  })

  test('strips tracking params but keeps meaningful ones', () => {
    expect(canonicalUrl('https://x.com/a?utm_source=news&id=7&fbclid=zz')).toBe('x.com/a?id=7')
  })

  test('is order-insensitive on query params', () => {
    expect(canonicalUrl('https://x.com/a?b=2&a=1')).toBe(canonicalUrl('https://x.com/a?a=1&b=2'))
  })

  test('unparseable input returns empty, which never clusters', () => {
    expect(canonicalUrl('')).toBe('')
    expect(canonicalUrl(null)).toBe('')
    // Two articles with no URL must not be merged just for both lacking one.
    expect(clusterArticles([{ title: 'a b c d e' }, { title: 'f g h i j' }]).clusters).toEqual([])
  })
})

describe('normalizeTitle', () => {
  test('strips the outlet attribution outlets append to syndicated copy', () => {
    expect(normalizeTitle('Acme Announces Record Revenue - Reuters'))
      .toBe(normalizeTitle('Acme Announces Record Revenue | Bloomberg'))
  })

  test('keeps figures, which are what distinguish financial headlines', () => {
    expect(normalizeTitle('Acme beats by $0.12, revenue up 14%')).toContain('$0.12')
    expect(normalizeTitle('Acme beats by $0.12, revenue up 14%')).toContain('14%')
  })
})

describe('jaccard / shingle', () => {
  test('identical text scores 1, disjoint scores 0', () => {
    expect(jaccard(shingle('a b c d e f'), shingle('a b c d e f'))).toBe(1)
    expect(jaccard(shingle('a b c d e f'), shingle('u v w x y z'))).toBe(0)
  })

  test('empty input scores 0 rather than dividing by zero', () => {
    expect(jaccard(new Set(), new Set())).toBe(0)
    expect(jaccard(shingle(''), shingle('a b c d e'))).toBe(0)
  })
})

describe('wireSignature', () => {
  test('fires on wire boilerplate', () => {
    expect(wireSignature(WIRE_BODY)).toMatch(/^prnewswire\|/)
  })

  test('two outlets carrying the same release produce the same signature', () => {
    const reprint = 'NEW YORK, Jan 3, 2026 (PRNewswire) -- Acme Corporation today announced record ' +
                    'quarterly revenue of $4.2 billion, driven by strong demand across all segments.'
    expect(wireSignature(reprint)).toBe(wireSignature(WIRE_BODY))
  })

  test('returns null for ordinary reporting', () => {
    expect(wireSignature('Brussels opened a formal antitrust investigation on Tuesday.')).toBeNull()
    expect(wireSignature('')).toBeNull()
    expect(wireSignature(null)).toBeNull()
  })

  test('a marker with almost no text after it is not a signature', () => {
    // Too little to fingerprint means too little to be confident about.
    expect(wireSignature('(Reuters)')).toBeNull()
  })
})

describe('clusterArticles', () => {
  const reprint = (over = {}) => ({ title: 'Acme Announces Record Q4 Revenue', body: WIRE_BODY, polarity: 1, ...over })

  test('five reprints of one release become one vote', () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      reprint({ url: `https://outlet${i}.com/acme`, publishedAt: `2026-01-03T0${i}:00:00Z` }))
    const r = clusterArticles(rows)
    expect(r.total).toBe(5)
    expect(r.independentCount).toBe(1)
    expect(r.weights).toEqual([0.2, 0.2, 0.2, 0.2, 0.2])
    expect(r.clusters[0].size).toBe(5)
  })

  test('the cluster root is the EARLIEST published copy, not the first returned', () => {
    const r = clusterArticles([
      reprint({ url: 'https://late.com/a', publishedAt: '2026-01-03T18:00:00Z' }),
      reprint({ url: 'https://first.com/a', publishedAt: '2026-01-03T06:00:00Z' }),
    ])
    expect(r.clusters[0].root).toBe(1)
  })

  test('an undated copy never displaces a dated one as the root', () => {
    const r = clusterArticles([
      reprint({ url: 'https://undated.com/a' }),
      reprint({ url: 'https://dated.com/a', publishedAt: '2026-01-03T06:00:00Z' }),
    ])
    expect(r.clusters[0].root).toBe(1)
  })

  test('the same URL with different tracking params is one article', () => {
    const r = clusterArticles([
      { title: 'Acme wins contract award today', url: 'https://x.com/a?utm_source=twitter' },
      { title: 'Something else entirely different here', url: 'https://x.com/a?utm_source=email' },
    ])
    expect(r.clusters[0].kind).toBe('url')
    expect(r.independentCount).toBe(1)
  })

  test('near-duplicate headlines cluster even when the bodies are absent', () => {
    const r = clusterArticles([
      { title: 'Acme Corp lands $2B defense contract from Pentagon', url: 'https://a.com/1' },
      { title: 'Acme Corp Lands $2B Defense Contract From Pentagon - Reuters', url: 'https://b.com/2' },
    ])
    expect(r.independentCount).toBe(1)
    expect(r.clusters[0].kind).toBe('title')
  })

  test('independent reporting on the same company stays independent', () => {
    const r = clusterArticles([
      { title: 'Acme lands $2B defense contract from Pentagon', url: 'https://a.com/1' },
      { title: 'Acme chief financial officer resigns without explanation', url: 'https://b.com/2' },
    ])
    expect(r.clusters).toEqual([])
    expect(r.independentCount).toBe(2)
  })

  // ── The guard that matters most ───────────────────────────────────────────
  test('opposite sentiment is NEVER merged, however similar the wording', () => {
    // These share four of five content tokens. Merging them would silently
    // delete half of a real disagreement — the worst failure this module has.
    const r = clusterArticles([
      { title: 'Apple Q3 earnings beat analyst expectations', polarity: 1 },
      { title: 'Apple Q3 earnings miss analyst expectations', polarity: -1 },
    ])
    expect(r.clusters).toEqual([])
    expect(r.independentCount).toBe(2)
  })

  test('the polarity guard holds even for a byte-identical URL', () => {
    const r = clusterArticles([
      { title: 'Acme rallies on upgrade', url: 'https://x.com/a', polarity: 1 },
      { title: 'Acme slides on downgrade', url: 'https://x.com/a', polarity: -1 },
    ])
    expect(r.clusters).toEqual([])
  })

  test('unknown polarity does not block clustering', () => {
    // polarity 0/absent means "not scored", not "neutral and therefore different".
    const r = clusterArticles([
      { title: 'Acme Corp lands $2B defense contract from Pentagon', url: 'https://a.com/1' },
      { title: 'Acme Corp lands $2B defense contract from Pentagon', url: 'https://b.com/2' },
    ])
    expect(r.independentCount).toBe(1)
  })

  test('a short headline is not clustered on token overlap alone', () => {
    // Below MIN_TITLE_TOKENS content words there is not enough signal.
    const short = 'Acme up'
    expect(titleTokens(short).size).toBeLessThan(MIN_TITLE_TOKENS)
    expect(clusterArticles([{ title: short }, { title: 'Acme up' }]).clusters).toEqual([])
  })

  test('two separate clusters stay separate', () => {
    const r = clusterArticles([
      { title: 'Acme lands $2B defense contract from Pentagon', url: 'https://a.com/1' },
      { title: 'Acme lands $2B defense contract from Pentagon', url: 'https://b.com/2' },
      { title: 'Beta Corp cuts full year guidance sharply', url: 'https://c.com/3' },
      { title: 'Beta Corp cuts full year guidance sharply', url: 'https://d.com/4' },
    ])
    expect(r.clusters).toHaveLength(2)
    expect(r.independentCount).toBe(2)
  })

  test('empty and malformed input return a well-formed empty result', () => {
    expect(clusterArticles([]).independentCount).toBe(0)
    expect(clusterArticles(null).weights).toEqual([])
    expect(clusterArticles(undefined).clusters).toEqual([])
  })
})

describe('weightedSentiment', () => {
  test('one press release cannot outvote independent reporting', () => {
    // Three reprints of one bullish release + one bearish independent story.
    // Naively that reads 3:1 bullish; it is actually 1:1.
    const rows = [
      { title: 'Acme Announces Record Q4 Revenue', body: WIRE_BODY, url: 'https://a.com/1', score: 0.6, polarity: 1 },
      { title: 'Acme Announces Record Q4 Revenue', body: WIRE_BODY, url: 'https://b.com/2', score: 0.6, polarity: 1 },
      { title: 'Acme Announces Record Q4 Revenue', body: WIRE_BODY, url: 'https://c.com/3', score: 0.6, polarity: 1 },
      { title: 'Acme faces EU antitrust probe over pricing', body: 'Brussels opened a case.', url: 'https://d.com/4', score: -0.6, polarity: -1 },
    ]
    const r = weightedSentiment(rows)
    expect(r.rawMean).toBeCloseTo(0.3, 5)   // the number we were reporting
    expect(r.mean).toBeCloseTo(0, 5)        // the number that is true
    expect(r.independentCount).toBe(2)
    expect(r.total).toBe(4)
    expect(r.syndicated).toBe(true)
  })

  test('an un-syndicated set is left exactly alone', () => {
    const rows = [
      { title: 'Acme lands $2B defense contract from Pentagon', url: 'https://a.com/1', score: 0.6 },
      { title: 'Acme chief financial officer resigns abruptly', url: 'https://b.com/2', score: -0.2 },
    ]
    const r = weightedSentiment(rows)
    expect(r.mean).toBeCloseTo(r.rawMean, 10)
    expect(r.syndicated).toBe(false)
    expect(r.independentCount).toBe(2)
  })

  test('articles with no score are ignored rather than counted as zero', () => {
    const r = weightedSentiment([
      { title: 'a b c d e', score: 0.8 },
      { title: 'f g h i j', score: null },
      { title: 'k l m n o' },
    ])
    expect(r.total).toBe(1)
    expect(r.mean).toBeCloseTo(0.8, 5)
  })

  test('an empty set is a well-formed zero, not a crash', () => {
    const r = weightedSentiment([])
    expect(r).toMatchObject({ mean: 0, rawMean: 0, independentCount: 0, total: 0, syndicated: false })
    expect(weightedSentiment(null).total).toBe(0)
  })

  test('a custom score accessor is honoured', () => {
    const r = weightedSentiment(
      [{ title: 'a b c d e', s: 0.5 }, { title: 'f g h i j', s: -0.5 }],
      { scoreOf: a => a.s },
    )
    expect(r.mean).toBeCloseTo(0, 5)
    expect(r.total).toBe(2)
  })
})
