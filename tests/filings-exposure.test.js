'use strict'
/**
 * Tests for the lib/filings.js extensions that exposure discovery depends on:
 * term-windowed extraction, the reverse CIK index, foreign-issuer form lists,
 * and SIC metadata.
 */

const {
  NARRATIVE_FORMS, FOREIGN_FORMS, ALL_FORMS,
  extractTermWindows, extractSections, loadCikIndex, getCompanyMeta, getLatestFiling,
} = require('../lib/filings')

const TICKER_MAP = {
  '0': { cik_str: 1819994, ticker: 'RKLB', title: 'Rocket Lab USA, Inc.' },
  '1': { cik_str: 1046179, ticker: 'TSM',  title: 'TAIWAN SEMICONDUCTOR MANUFACTURING CO LTD' },
  // A multi-class issuer appears once per ticker under one CIK.
  '2': { cik_str: 1652044, ticker: 'GOOGL', title: 'Alphabet Inc.' },
  '3': { cik_str: 1652044, ticker: 'GOOG',  title: 'Alphabet Inc.' },
}

const okJson = payload => async () => ({ ok: true, status: 200, json: async () => payload })

describe('form lists', () => {
  test('foreign private issuers are covered — a 10-K-only list misses TSM entirely', () => {
    // TSMC, ASML and most ADRs file 20-F, never a 10-K. Asking only for a 10-K
    // returns nothing, which reads as "no filings" rather than "wrong form".
    expect(NARRATIVE_FORMS).not.toContain('20-F')
    expect(FOREIGN_FORMS).toContain('20-F')
    expect(ALL_FORMS).toEqual(expect.arrayContaining(['10-K', '10-Q', '8-K', '20-F', '40-F', '6-K']))
  })
})

describe('extractTermWindows', () => {
  const filler = 'x'.repeat(3000)

  test('returns a window around each mention', () => {
    const text = `A ${filler} we supply SpaceX with avionics ${filler} B`
    const w = extractTermWindows(text, 'SpaceX', { radius: 50 })
    expect(w).toHaveLength(1)
    expect(w[0].text).toContain('SpaceX')
    expect(w[0].text.length).toBeLessThan(150)
  })

  test('merges overlapping mentions into one window and counts the hits', () => {
    const text = `SpaceX and SpaceX and SpaceX ${filler}`
    const w = extractTermWindows(text, 'SpaceX', { radius: 100 })
    expect(w).toHaveLength(1)
    expect(w[0].hits).toBe(3)
  })

  test('ranks the densest passage first — the LLM budget is finite', () => {
    const dense = 'SpaceX SpaceX SpaceX'
    const sparse = 'SpaceX'
    const w = extractTermWindows(`${sparse} ${filler} ${dense}`, 'SpaceX', { radius: 30 })
    expect(w[0].hits).toBeGreaterThan(w[1].hits)
  })

  test('is case-insensitive', () => {
    expect(extractTermWindows('we supply SPACEX parts', 'SpaceX', { radius: 20 })).toHaveLength(1)
  })

  test('honours maxWindows', () => {
    const text = Array.from({ length: 20 }, () => `SpaceX ${filler}`).join(' ')
    expect(extractTermWindows(text, 'SpaceX', { radius: 20, maxWindows: 3 })).toHaveLength(3)
  })

  test('returns [] when the term is absent, or inputs are empty', () => {
    expect(extractTermWindows('nothing here', 'SpaceX')).toEqual([])
    expect(extractTermWindows('', 'SpaceX')).toEqual([])
    expect(extractTermWindows('text', '')).toEqual([])
    expect(extractTermWindows(null, 'x')).toEqual([])
  })

  test('clamps windows to the text bounds', () => {
    const w = extractTermWindows('SpaceX', 'SpaceX', { radius: 5000 })
    expect(w[0].start).toBe(0)
    expect(w[0].text).toBe('SpaceX')
  })

  test('finds names that section-based extraction would miss', () => {
    // Named customers live in Item 1 Business, which extractSections skips in
    // favour of Item 1A / MD&A — the exact gap this function exists to close.
    const filing = 'Item 1. Business. Our largest customer is SpaceX. ' + filler +
                   ' Item 1A. Risk Factors. Markets may decline. ' + filler
    expect(extractSections(filing)).not.toContain('SpaceX')
    expect(extractTermWindows(filing, 'SpaceX', { radius: 60 })[0].text).toContain('SpaceX')
  })
})

describe('getLatestFiling sections:false', () => {
  const LONG_RISK = 'Markets may decline and competition is intense. '.repeat(400)
  const html = '<html><body>Item 1. Business. Our largest customer is SpaceX, at 34% of revenue. ' +
               'Item 1A. Risk Factors. ' + LONG_RISK + '</body></html>'
  const fetchImpl = async (url) => ({
    ok: true, status: 200,
    // The full map, not a one-entry stub: lib/filings caches the ticker index
    // at module scope for 24h, so a narrow map here would poison every later
    // test in this file that resolves a different ticker.
    json: async () => String(url).includes('company_tickers')
      ? TICKER_MAP
      : { name: 'Rocket Lab USA, Inc.', filings: { recent: {
          form: ['10-K'], accessionNumber: ['0001-26-1'], primaryDocument: ['d10k.htm'],
          filingDate: ['2026-02-14'], reportDate: ['2025-12-31'] } } },
    text: async () => html,
  })

  test('the DEFAULT extraction drops a customer named in Item 1 Business', async () => {
    // Regression guard: exposure discovery windowed over this text would find
    // nothing and report a genuine supplier as unevidenced.
    const f = await getLatestFiling('RKLB', { fetchImpl })
    expect(f.excerpt).not.toContain('SpaceX')
  })

  test('sections:false keeps it, which is what term windowing needs', async () => {
    const f = await getLatestFiling('RKLB', { fetchImpl, sections: false, maxChars: 250_000 })
    expect(f.excerpt).toContain('SpaceX')
    expect(extractTermWindows(f.excerpt, 'SpaceX', { radius: 60 })).toHaveLength(1)
  })
})

describe('loadCikIndex', () => {
  test('maps a padded CIK back to ticker and legal name', async () => {
    const idx = await loadCikIndex({ fetchImpl: okJson(TICKER_MAP) })
    expect(idx.get('0001819994')).toEqual({ symbol: 'RKLB', name: 'Rocket Lab USA, Inc.' })
  })

  test('a multi-class issuer collapses to one entry — they share a CIK', async () => {
    const idx = await loadCikIndex({ fetchImpl: okJson(TICKER_MAP) })
    expect(idx.get('0001652044').name).toBe('Alphabet Inc.')
  })

  test('the legal name is what an exact-phrase filing search needs', async () => {
    const idx = await loadCikIndex({ fetchImpl: okJson(TICKER_MAP) })
    expect(idx.get('0001046179').name).toMatch(/TAIWAN SEMICONDUCTOR/)
  })
})

describe('getCompanyMeta', () => {
  function metaFetch(subs) {
    return async (url) => {
      const u = String(url)
      if (u.includes('company_tickers.json')) return { ok: true, status: 200, json: async () => TICKER_MAP }
      return { ok: true, status: 200, json: async () => subs }
    }
  }

  test('exposes SIC — the industry key peer discovery runs on', async () => {
    const meta = await getCompanyMeta('RKLB', {
      fetchImpl: metaFetch({ name: 'Rocket Lab USA, Inc.', sic: '3760', sicDescription: 'Guided Missiles & Space Vehicles', filings: { recent: { form: ['10-K'] } } }),
    })
    expect(meta).toMatchObject({ cik: '0001819994', sic: '3760', sicDescription: 'Guided Missiles & Space Vehicles' })
  })

  test('flags a foreign private issuer from its actual filing history', async () => {
    const meta = await getCompanyMeta('TSM', {
      fetchImpl: metaFetch({ name: 'TSMC', sic: '3674', filings: { recent: { form: ['20-F', '6-K'] } } }),
    })
    expect(meta.foreignIssuer).toBe(true)
  })

  test('a domestic filer is not flagged', async () => {
    const meta = await getCompanyMeta('RKLB', {
      fetchImpl: metaFetch({ name: 'Rocket Lab', sic: '3760', filings: { recent: { form: ['10-K', '10-Q', '8-K'] } } }),
    })
    expect(meta.foreignIssuer).toBe(false)
  })

  test('an unknown ticker returns null rather than throwing', async () => {
    expect(await getCompanyMeta('ZZZZ', { fetchImpl: metaFetch({}) })).toBeNull()
  })
})
