'use strict'
/**
 * Unit tests for lib/exposure-map.js.
 *
 * The bulk of these cover verifyFinding(), because it is the boundary the whole
 * feature rests on: without it, a model's confident-but-invented supply-chain
 * link is indistinguishable from a researched one at the point of use.
 */

const {
  RELATIONS, RELATION_NAMES, MIN_EDGE_SCORE, STALE_DAYS,
  normalizeForMatch, verifyFinding, extractHoldingEvidence,
  recencyFactor, scoreEdge, isActionable,
  buildEdges, toUniverse, exposureBlock, buildClassifyPrompt,
} = require('../lib/exposure-map')

const FILING = 'Item 1. Business. We derive a substantial portion of our revenue from SpaceX, ' +
  'which accounted for 34% of total revenue in fiscal 2025. We also compete with Blue Origin ' +
  'in the small-launch market and maintain a supply agreement with Redwire Corporation.'

const TODAY = new Date('2026-09-09T00:00:00Z').getTime()

describe('verifyFinding — the hallucination gate', () => {
  test('accepts a verbatim quote that names the anchor', () => {
    const r = verifyFinding(
      { relation: 'supplier', quote: 'We derive a substantial portion of our revenue from SpaceX, which accounted for 34% of total revenue', materialityPct: 34 },
      FILING, { anchorAliases: ['SpaceX'] })
    expect(r.ok).toBe(true)
    expect(r.finding.relation).toBe('supplier')
    expect(r.finding.materialityPct).toBe(34)
  })

  test('REJECTS a fabricated quote, however plausible it reads', () => {
    const r = verifyFinding(
      { relation: 'supplier', quote: 'We are the primary launch vehicle supplier to SpaceX under a multi-year contract' },
      FILING, { anchorAliases: ['SpaceX'] })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/not found verbatim/)
  })

  test('REJECTS a real sentence from the filing that is not about the anchor', () => {
    // Genuine text, lifted from the same document — but evidence of nothing.
    const r = verifyFinding(
      { relation: 'supplier', quote: 'maintain a supply agreement with Redwire Corporation.' },
      FILING, { anchorAliases: ['SpaceX'] })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/does not mention the anchor/)
  })

  test('REJECTS an unknown relation rather than coercing it to the nearest one', () => {
    const r = verifyFinding({ relation: 'vendor', quote: 'x'.repeat(60) }, FILING)
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/unknown relation/)
  })

  test('REJECTS a quote too short to be a real sentence', () => {
    const r = verifyFinding({ relation: 'supplier', quote: 'SpaceX' }, FILING, { anchorAliases: ['SpaceX'] })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/too short/)
  })

  test('survives smart quotes, dashes and re-wrapped whitespace', () => {
    const mangled = 'We  derive a substantial\n portion of our revenue from SpaceX'
    const r = verifyFinding({ relation: 'supplier', quote: mangled }, FILING, { anchorAliases: ['SpaceX'] })
    expect(r.ok).toBe(true)
  })

  test('matching is normalisation-only — it never becomes fuzzy', () => {
    // One word changed. A fuzzy matcher would let this through; this must not.
    const r = verifyFinding(
      { relation: 'supplier', quote: 'We derive a substantial portion of our profit from SpaceX' },
      FILING, { anchorAliases: ['SpaceX'] })
    expect(r.ok).toBe(false)
  })

  test('an out-of-range materiality is dropped without failing the finding', () => {
    const quote = 'We derive a substantial portion of our revenue from SpaceX'
    for (const bad of [0, -5, 150, 'lots', null]) {
      const r = verifyFinding({ relation: 'supplier', quote, materialityPct: bad }, FILING, { anchorAliases: ['SpaceX'] })
      expect(r.ok).toBe(true)
      expect(r.finding.materialityPct).toBeNull()
    }
  })

  test('rejects junk input shapes', () => {
    expect(verifyFinding(null, FILING).ok).toBe(false)
    expect(verifyFinding('a string', FILING).ok).toBe(false)
    expect(verifyFinding({ relation: 'supplier' }, FILING).ok).toBe(false)
  })
})

describe('normalizeForMatch', () => {
  test('folds quote/dash variants and whitespace, and lowercases', () => {
    expect(normalizeForMatch('“Hello”  —  World’s')).toBe('"hello" - world\'s')
  })
})

describe('recencyFactor', () => {
  test('a filing from today scores full weight', () => {
    expect(recencyFactor(new Date(TODAY).toISOString(), TODAY)).toBeCloseTo(1, 5)
  })

  test('decays with age and floors at the stale threshold', () => {
    const old = TODAY - STALE_DAYS * 86_400_000
    expect(recencyFactor(new Date(old).toISOString(), TODAY)).toBeCloseTo(0.35, 5)
    // Older than stale does not decay further.
    const ancient = TODAY - STALE_DAYS * 3 * 86_400_000
    expect(recencyFactor(new Date(ancient).toISOString(), TODAY)).toBeCloseTo(0.35, 5)
  })

  test('an unparseable date gets a middling factor, not a throw', () => {
    expect(recencyFactor('not-a-date', TODAY)).toBe(0.5)
  })
})

describe('scoreEdge', () => {
  const base = { relation: 'supplier', form: '10-K', filedAt: new Date(TODAY).toISOString() }

  test('a fresh 10-K supplier edge scores well above the noise floor', () => {
    expect(scoreEdge(base, TODAY)).toBeGreaterThan(MIN_EDGE_SCORE)
  })

  test('relation weight orders supplier above peer above competitor', () => {
    const sup  = scoreEdge({ ...base, relation: 'supplier' }, TODAY)
    const peer = scoreEdge({ ...base, relation: 'peer' }, TODAY)
    const comp = scoreEdge({ ...base, relation: 'competitor' }, TODAY)
    expect(sup).toBeGreaterThan(peer)
    expect(peer).toBeGreaterThan(comp)
  })

  test('a 10-K outweighs a 10-Q for the same relationship', () => {
    expect(scoreEdge(base, TODAY)).toBeGreaterThan(scoreEdge({ ...base, form: '10-Q' }, TODAY))
  })

  test('a disclosed revenue percentage materially raises the score', () => {
    const without = scoreEdge(base, TODAY)
    const with40  = scoreEdge({ ...base, materialityPct: 40 }, TODAY)
    expect(with40).toBeGreaterThan(without)
    expect(with40 - without).toBeGreaterThan(20)
  })

  test('corroborating filings help, with diminishing returns', () => {
    const one   = scoreEdge({ ...base, corroboratingFilings: 1 }, TODAY)
    const three = scoreEdge({ ...base, corroboratingFilings: 3 }, TODAY)
    const ten   = scoreEdge({ ...base, corroboratingFilings: 10 }, TODAY)
    expect(three).toBeGreaterThan(one)
    expect(ten).toBe(scoreEdge({ ...base, corroboratingFilings: 4 }, TODAY))  // capped
  })

  test('always lands in 0-100', () => {
    const max = scoreEdge({ ...base, materialityPct: 100, corroboratingFilings: 50 }, TODAY)
    expect(max).toBeLessThanOrEqual(100)
    expect(scoreEdge({ relation: 'competitor', form: 'unknown', filedAt: '1990-01-01' }, TODAY)).toBeGreaterThanOrEqual(0)
  })

  test('an unknown form gets the conservative default, not full weight', () => {
    expect(scoreEdge({ ...base, form: 'DEF 14A' }, TODAY)).toBeLessThan(scoreEdge(base, TODAY))
  })
})

describe('buildEdges', () => {
  const mk = (symbol, over = {}) => ({
    symbol, relation: 'supplier', quote: 'q'.repeat(50), form: '10-K',
    filedAt: new Date(TODAY).toISOString(), url: 'http://x', ...over,
  })

  test('collapses repeated findings into one edge and counts corroboration', () => {
    const edges = buildEdges('SPACEX', [mk('RKLB'), mk('RKLB'), mk('RKLB')], { now: TODAY })
    expect(edges).toHaveLength(1)
    expect(edges[0].corroboratingFilings).toBe(3)
  })

  test('keeps the evidence that states a revenue share over one that does not', () => {
    const edges = buildEdges('SPACEX', [
      mk('RKLB', { quote: 'no percentage here'.padEnd(50, '.') }),
      mk('RKLB', { quote: 'thirty four percent of revenue'.padEnd(50, '.'), materialityPct: 34 }),
    ], { now: TODAY })
    expect(edges[0].materialityPct).toBe(34)
    expect(edges[0].evidence.quote).toMatch(/thirty four/)
  })

  test('different relations for one symbol stay separate edges', () => {
    const edges = buildEdges('NVDA', [mk('AVGO'), mk('AVGO', { relation: 'competitor' })], { now: TODAY })
    expect(edges).toHaveLength(2)
  })

  test('drops edges below the noise floor and sorts strongest first', () => {
    const edges = buildEdges('NVDA', [
      mk('AAA', { materialityPct: 50 }),
      mk('BBB', { relation: 'competitor', form: 'unknown', filedAt: '2015-01-01' }),
    ], { now: TODAY })
    expect(edges.map(e => e.symbol)).toEqual(['AAA'])
  })

  test('ignores malformed findings instead of throwing', () => {
    expect(buildEdges('X', [null, {}, { symbol: 'A' }, undefined], { now: TODAY })).toEqual([])
    expect(buildEdges('X', null, { now: TODAY })).toEqual([])
  })
})

describe('toUniverse', () => {
  const edges = [
    { symbol: 'AAA', relation: 'supplier', score: 90 },
    { symbol: 'BBB', relation: 'competitor', score: 85 },
    { symbol: 'CCC', relation: 'peer', score: 70 },
    { symbol: 'AAA', relation: 'partner', score: 60 },
  ]

  test('excludes competitors by default — their exposure runs the other way', () => {
    expect(toUniverse(edges)).toEqual(['AAA', 'CCC'])
  })

  test('de-duplicates a symbol appearing under two relations', () => {
    expect(toUniverse(edges).filter(s => s === 'AAA')).toHaveLength(1)
  })

  test('honours the limit and an explicit exclude list', () => {
    expect(toUniverse(edges, { limit: 1 })).toEqual(['AAA'])
    expect(toUniverse(edges, { exclude: [] })).toContain('BBB')
  })
})

describe('exposureBlock', () => {
  test("returns '' when there is nothing evidenced to say", () => {
    expect(exposureBlock('SPACEX', [])).toBe('')
    expect(exposureBlock('SPACEX', null)).toBe('')
  })

  test('renders symbol, relation, score and filing provenance', () => {
    const block = exposureBlock('SPACEX', [{
      symbol: 'RKLB', relation: 'supplier', score: 88, materialityPct: 34,
      evidence: { form: '10-K', filedAt: '2026-02-14' },
    }])
    expect(block).toMatch(/RKLB/)
    expect(block).toMatch(/supplier/)
    expect(block).toMatch(/34% of revenue/)
    expect(block).toMatch(/10-K 2026-02-14/)
  })
})

describe('buildClassifyPrompt', () => {
  test('tells the model its quotes will be checked, and offers a "none" escape', () => {
    const p = buildClassifyPrompt({
      anchorLabel: 'SpaceX', candidateSymbol: 'RKLB',
      candidateCompany: 'Rocket Lab USA, Inc.', windows: [{ text: 'We supply SpaceX.' }],
    })
    expect(p).toMatch(/checked character-for-character/)
    expect(p).toMatch(/"none"/)
    expect(p).toMatch(/Never estimate it/)
    // Every valid relation must be offered, or the model cannot pick correctly.
    for (const r of RELATION_NAMES) expect(p).toContain(r)
  })

  test('accepts plain strings as windows', () => {
    const p = buildClassifyPrompt({ anchorLabel: 'X', candidateSymbol: 'Y', windows: ['raw text'] })
    expect(p).toContain('raw text')
  })
})

describe('RELATIONS registry', () => {
  test('supplier carries the highest weight — revenue actually depends on it', () => {
    for (const r of RELATION_NAMES.filter(x => x !== 'supplier')) {
      expect(RELATIONS.supplier.weight).toBeGreaterThanOrEqual(RELATIONS[r].weight)
    }
  })

  test('every relation documents what it means for the reader', () => {
    for (const r of RELATION_NAMES) expect(RELATIONS[r].desc.length).toBeGreaterThan(10)
  })
})

/**
 * extractHoldingEvidence — the model-free path.
 *
 * A schedule of investments already states the relationship, so the quote is
 * SLICED from the source rather than written by anything. That makes it
 * verbatim by construction; these tests pin that construction, because the
 * moment a quote stops being a literal substring the hallucination gate stops
 * meaning anything on this path.
 */
describe('extractHoldingEvidence', () => {
  const SCHEDULE =
    'Schedule of Investments as of March 31, 2026. Private Company Holdings. ' +
    'Space Exploration Technologies Corp., Class A Common Stock, 1,250,000 shares, ' +
    'fair value $45,600,000, 4.9% of net assets. ' +
    'Stripe, Inc., Series H Preferred, 900,000 shares, fair value $12,000,000, 1.3% of net assets.'

  test('the quote is a literal substring of the source — verbatim by construction', () => {
    const ev = extractHoldingEvidence(SCHEDULE, ['Space Exploration Technologies', 'SpaceX'])
    expect(SCHEDULE).toContain(ev.quote)
  })

  test('the quote passes the same gate the model path must pass', () => {
    const ev = extractHoldingEvidence(SCHEDULE, ['Space Exploration Technologies', 'SpaceX'])
    const check = verifyFinding({ relation: 'holder', quote: ev.quote }, SCHEDULE,
      { anchorAliases: ['Space Exploration Technologies'] })
    expect(check.ok).toBe(true)
  })

  test('prefers the longest matching alias — schedules list legal names', () => {
    const ev = extractHoldingEvidence(SCHEDULE, ['SpaceX', 'Space Exploration Technologies'])
    expect(ev.alias).toBe('Space Exploration Technologies')
  })

  test('reads the share of net assets stated in the same row', () => {
    expect(extractHoldingEvidence(SCHEDULE, ['Space Exploration Technologies']).materialityPct).toBe(4.9)
  })

  test('takes the percentage belonging to the row, not the next holding down', () => {
    const ev = extractHoldingEvidence(SCHEDULE, ['Stripe, Inc.'])
    expect(ev.materialityPct).toBe(1.3)
  })

  test('a bare number with no % sign is never read as a percentage', () => {
    // In an N-PORT XML dump this could be a share count, a dollar value or part
    // of a CUSIP. Guessing would put an invented number on the card.
    const xml = 'Space Exploration Technologies Corp N/A 549300 4.85 Long EC CORP US N ' + 'x'.repeat(80)
    expect(extractHoldingEvidence(xml, ['Space Exploration Technologies']).materialityPct).toBeNull()
  })

  test('a percentage far past the mention belongs to another row', () => {
    const text = 'Space Exploration Technologies Corp' + ' filler'.repeat(60) + ' 7.7% of net assets'
    expect(extractHoldingEvidence(text, ['Space Exploration Technologies']).materialityPct).toBeNull()
  })

  test('an implausible percentage is dropped rather than carried', () => {
    const text = 'Holdings. Space Exploration Technologies Corp 250% of something odd. ' + 'y'.repeat(60)
    expect(extractHoldingEvidence(text, ['Space Exploration Technologies']).materialityPct).toBeNull()
  })

  test('returns null when the anchor is absent — no filler, no guess', () => {
    expect(extractHoldingEvidence(SCHEDULE, ['Anduril Industries'])).toBeNull()
    expect(extractHoldingEvidence('', ['SpaceX'])).toBeNull()
    expect(extractHoldingEvidence(SCHEDULE, [])).toBeNull()
    expect(extractHoldingEvidence(null, ['SpaceX'])).toBeNull()
  })

  test('a mention with too little text around it is not evidence', () => {
    expect(extractHoldingEvidence('SpaceX', ['SpaceX'])).toBeNull()
  })

  test('does not cut a word in half at either edge', () => {
    const text = 'alpha bravo charlie delta '.repeat(30) + 'SpaceX Corp holding ' + 'echo foxtrot golf '.repeat(30)
    const ev = extractHoldingEvidence(text, ['SpaceX'])
    expect(ev.quote).toMatch(/^\S/)
    expect(text).toContain(ev.quote)
    // Every token in the quote is a whole token of the source.
    for (const tok of ev.quote.split(/\s+/)) expect(text.split(/\s+/)).toContain(tok)
  })

  test('clamps to the text bounds when the mention sits at the very start', () => {
    const text = 'SpaceX Corp is held at 3.2% of net assets by this fund as disclosed herein.'
    const ev = extractHoldingEvidence(text, ['SpaceX'])
    expect(ev.quote).toBe(text)
    expect(ev.materialityPct).toBe(3.2)
  })
})

describe('fund form weighting', () => {
  test('every EDGAR fund-form spelling scores above the floor', () => {
    // The label comes back from EDGAR's submissions index, and the N-PORT family
    // has appeared as both 'NPORT-P' and 'N-PORT'. An unlisted spelling falls to
    // the default weight, lands at 24 against a floor of 25, and silently
    // deletes the entire fund-holding discovery path.
    const filedAt = new Date().toISOString().slice(0, 10)
    for (const form of ['NPORT-P', 'N-PORT', 'N-CSR', 'N-CSRS']) {
      expect(scoreEdge({ relation: 'holder', form, filedAt })).toBeGreaterThanOrEqual(MIN_EDGE_SCORE)
    }
  })

  test('a fund holding is not excluded from the tradeable universe', () => {
    // Competitors are; holders are the whole point for a private anchor.
    const edges = buildEdges('SPACEX', [{
      symbol: 'DXYZ', relation: 'holder', quote: 'x'.repeat(50), form: 'NPORT-P',
      filedAt: new Date().toISOString().slice(0, 10), url: 'u', materialityPct: 4.9,
    }])
    expect(toUniverse(edges)).toEqual(['DXYZ'])
  })
})
