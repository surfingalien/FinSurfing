'use strict'
/**
 * Unit tests for lib/edgar-search.js.
 *
 * Every network path takes an injectable fetch and is exercised against
 * recorded response shapes — efts.sec.gov (EDGAR full-text search) is a
 * different host from the endpoints lib/filings.js already uses and was not
 * reachable from the environment this was written in, so the parsing contract
 * is pinned here rather than assumed.
 */

const {
  PRIVATE_ANCHORS, dedupeAliases, resolveAnchor,
  parseFtsHits, fullTextSearch, searchAvailable, findMentions,
} = require('../lib/edgar-search')

const okJson = payload => async () => ({ ok: true, status: 200, json: async () => payload })

/** company_tickers.json shape: keyed by index, not by ticker. */
const TICKER_MAP = {
  '0': { cik_str: 1318605, ticker: 'TSLA', title: 'Tesla, Inc.' },
  '1': { cik_str: 1819994, ticker: 'RKLB', title: 'Rocket Lab USA, Inc.' },
  '2': { cik_str: 1045810, ticker: 'NVDA', title: 'NVIDIA CORP' },
  '3': { cik_str: 1326801, ticker: 'META', title: 'Meta Platforms, Inc.' },
}

const ftsPayload = (rows) => ({
  hits: {
    total: { value: rows.length },
    hits: rows.map(r => ({
      _id: `${r.accession}:doc.htm`,
      _source: {
        ciks: [r.cik],
        display_names: [r.display],
        root_form: r.form,
        file_date: r.date,
      },
    })),
  },
})

describe('dedupeAliases', () => {
  test('drops single generic words that would swamp a full-text search', () => {
    expect(dedupeAliases(['Meta Platforms, Inc.', 'META', 'Meta'])).toEqual(['Meta Platforms, Inc.'])
    expect(dedupeAliases(['Intel Corporation', 'Intel'])).toEqual(['Intel Corporation'])
  })

  test('keeps multi-word names — the phrase itself disambiguates', () => {
    expect(dedupeAliases(['Space Exploration Technologies', 'SpaceX'])).toContain('Space Exploration Technologies')
  })

  test('de-duplicates case-insensitively', () => {
    expect(dedupeAliases(['SpaceX', 'spacex', 'SPACEX'])).toHaveLength(1)
  })

  test('never returns empty — a noisy search still beats no search', () => {
    expect(dedupeAliases(['Meta'])).toEqual(['Meta'])
    expect(dedupeAliases(['Intel'])).toEqual(['Intel'])
  })

  test('ignores blanks and non-strings', () => {
    expect(dedupeAliases(['', null, undefined, '  ', 'Real Name Inc.'])).toEqual(['Real Name Inc.'])
  })
})

describe('resolveAnchor', () => {
  test('resolves a private company from the registry, flagged unlisted', async () => {
    const a = await resolveAnchor('SPACEX')
    expect(a.listed).toBe(false)
    expect(a.label).toBe('SpaceX')
    expect(a.aliases).toContain('Space Exploration Technologies')
  })

  test('every registered private anchor has a label and at least one alias', async () => {
    for (const key of Object.keys(PRIVATE_ANCHORS)) {
      const a = await resolveAnchor(key)
      expect(a.label).toBeTruthy()
      expect(a.aliases.length).toBeGreaterThan(0)
    }
  })

  test('resolves a listed ticker to its EDGAR legal name', async () => {
    const a = await resolveAnchor('RKLB', { fetchImpl: okJson(TICKER_MAP) })
    expect(a.listed).toBe(true)
    expect(a.label).toBe('Rocket Lab USA, Inc.')
    expect(a.cik).toBe('0001819994')
  })

  test('a generic ticker searches on the legal name, not the ticker', async () => {
    const a = await resolveAnchor('META', { fetchImpl: okJson(TICKER_MAP) })
    expect(a.aliases).toEqual(['Meta Platforms, Inc.'])
    expect(a.aliases).not.toContain('META')
  })

  test('sanitises junk and rejects an empty anchor', async () => {
    expect(await resolveAnchor('  nv/da<>  ', { fetchImpl: okJson(TICKER_MAP) })).toBeTruthy()
    expect(await resolveAnchor('')).toBeNull()
    expect(await resolveAnchor('///')).toBeNull()
  })

  test('an unknown ticker still resolves rather than failing the run', async () => {
    const a = await resolveAnchor('ZZZZ', { fetchImpl: okJson(TICKER_MAP) })
    expect(a.key).toBe('ZZZZ')
    expect(a.aliases).toEqual(['ZZZZ'])
  })

  test('a network failure degrades instead of throwing', async () => {
    const a = await resolveAnchor('RKLB', { fetchImpl: async () => { throw new Error('offline') } })
    expect(a.key).toBe('RKLB')
  })
})

describe('parseFtsHits', () => {
  test('flattens the Elasticsearch envelope into CIK/company/form/date', () => {
    const hits = parseFtsHits(ftsPayload([
      { cik: '1819994', display: 'Rocket Lab USA, Inc. (RKLB)', form: '10-K', date: '2026-02-14', accession: '0001193125-26-000123' },
    ]))
    expect(hits).toHaveLength(1)
    expect(hits[0]).toMatchObject({
      cik: '0001819994', company: 'Rocket Lab USA, Inc.',
      form: '10-K', filedAt: '2026-02-14', accession: '0001193125-26-000123',
    })
  })

  test('tolerates field-name variation rather than hard-failing', () => {
    // The envelope's field names have moved before; fewer rows beats none.
    const hits = parseFtsHits({ hits: { hits: [{ _id: 'acc:doc', _source: { cik: '1045810', form: '20-F', filed_at: '2026-01-01' } }] } })
    expect(hits[0]).toMatchObject({ cik: '0001045810', form: '20-F', filedAt: '2026-01-01' })
  })

  test('returns [] for a malformed or empty payload instead of throwing', () => {
    expect(parseFtsHits(null)).toEqual([])
    expect(parseFtsHits({})).toEqual([])
    expect(parseFtsHits({ hits: { hits: 'nope' } })).toEqual([])
  })

  test('skips hits with no CIK — nothing downstream can use them', () => {
    expect(parseFtsHits({ hits: { hits: [{ _id: 'a:b', _source: { form: '10-K' } }] } })).toEqual([])
  })
})

describe('fullTextSearch', () => {
  test('searches the phrase as an exact quoted phrase, scoped to forms', async () => {
    let seen
    const fetchImpl = async (url) => { seen = url; return { ok: true, status: 200, json: async () => ftsPayload([]) } }
    await fullTextSearch('Space Exploration Technologies', { forms: ['10-K', '20-F'], fetchImpl })
    expect(decodeURIComponent(seen).replace(/\+/g, ' ')).toContain('"Space Exploration Technologies"')
    expect(decodeURIComponent(seen)).toContain('forms=10-K,20-F')
  })

  test('an empty phrase never hits the network', async () => {
    const fetchImpl = async () => { throw new Error('should not be called') }
    expect(await fullTextSearch('', { fetchImpl })).toEqual([])
  })

  test('propagates an HTTP failure with its status', async () => {
    const fetchImpl = async () => ({ ok: false, status: 403, json: async () => ({}) })
    await expect(fullTextSearch('x', { fetchImpl })).rejects.toMatchObject({ status: 403 })
  })

  test('honours the result limit', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({
      cik: String(1000000 + i), display: `Co ${i} (C${i})`, form: '10-K', date: '2026-01-01', accession: `a-${i}`,
    }))
    const hits = await fullTextSearch('x', { limit: 3, fetchImpl: okJson(ftsPayload(rows)) })
    expect(hits).toHaveLength(3)
  })
})

describe('searchAvailable', () => {
  test('true when the endpoint answers', async () => {
    expect(await searchAvailable({ fetchImpl: okJson(ftsPayload([])) })).toBe(true)
  })

  test('false — not a throw — when it does not, so callers can degrade to peers', async () => {
    expect(await searchAvailable({ fetchImpl: async () => ({ ok: false, status: 403, json: async () => ({}) }) })).toBe(false)
    expect(await searchAvailable({ fetchImpl: async () => { throw new Error('ENOTFOUND') } })).toBe(false)
  })
})

describe('findMentions', () => {
  const anchorInfo = { key: 'SPACEX', label: 'SpaceX', aliases: ['Space Exploration Technologies', 'SpaceX'], listed: false, cik: null }

  function routedFetch(perAlias) {
    return async (url) => {
      const u = decodeURIComponent(String(url)).replace(/\+/g, ' ')
      if (u.includes('company_tickers.json')) return { ok: true, status: 200, json: async () => TICKER_MAP }
      const alias = Object.keys(perAlias).find(a => u.includes(`"${a}"`))
      return { ok: true, status: 200, json: async () => ftsPayload(perAlias[alias] || []) }
    }
  }

  test('maps CIK hits back to tickers', async () => {
    const out = await findMentions(anchorInfo, {
      fetchImpl: routedFetch({
        'Space Exploration Technologies': [{ cik: '1819994', display: 'Rocket Lab USA, Inc. (RKLB)', form: '10-K', date: '2026-02-14', accession: 'a1' }],
      }),
    })
    expect(out).toHaveLength(1)
    expect(out[0]).toMatchObject({ symbol: 'RKLB', matchedAlias: 'Space Exploration Technologies', discovery: 'filing_search' })
  })

  test('de-duplicates across aliases and counts the mentions', async () => {
    const hit = [{ cik: '1819994', display: 'Rocket Lab USA, Inc. (RKLB)', form: '10-K', date: '2026-02-14', accession: 'a1' }]
    const out = await findMentions(anchorInfo, {
      fetchImpl: routedFetch({ 'Space Exploration Technologies': hit, 'SpaceX': hit }),
    })
    expect(out).toHaveLength(1)
    expect(out[0].mentions).toBe(2)
  })

  test('drops filers with no ticker — an unlisted filer is not actionable', async () => {
    const out = await findMentions(anchorInfo, {
      fetchImpl: routedFetch({
        'Space Exploration Technologies': [{ cik: '9999999', display: 'Private Filer LLC', form: '10-K', date: '2026-01-01', accession: 'a2' }],
      }),
    })
    expect(out).toEqual([])
  })

  test('excludes the anchor company itself', async () => {
    const selfAnchor = { ...anchorInfo, key: 'NVDA', listed: true, cik: '0001045810', aliases: ['NVIDIA CORP'] }
    const out = await findMentions(selfAnchor, {
      fetchImpl: routedFetch({
        'NVIDIA CORP': [{ cik: '1045810', display: 'NVIDIA CORP (NVDA)', form: '10-K', date: '2026-01-01', accession: 'a3' }],
      }),
    })
    expect(out).toEqual([])
  })

  test('one failing alias does not sink the others', async () => {
    const fetchImpl = async (url) => {
      const u = decodeURIComponent(String(url)).replace(/\+/g, ' ')
      if (u.includes('company_tickers.json')) return { ok: true, status: 200, json: async () => TICKER_MAP }
      if (u.includes('"SpaceX"')) throw new Error('rate limited')
      return { ok: true, status: 200, json: async () => ftsPayload([
        { cik: '1819994', display: 'Rocket Lab USA, Inc. (RKLB)', form: '10-K', date: '2026-02-14', accession: 'a1' },
      ]) }
    }
    const out = await findMentions(anchorInfo, { fetchImpl })
    expect(out).toHaveLength(1)
  })
})
