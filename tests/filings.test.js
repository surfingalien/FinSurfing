'use strict'
/**
 * Unit tests for lib/filings.js — pure parsing helpers + resolveCik with an
 * injected fetch. No real network access.
 */

const f = require('../lib/filings')

describe('padCik', () => {
  test('zero-pads to 10 digits', () => {
    expect(f.padCik(320193)).toBe('0000320193')
    expect(f.padCik('320193')).toBe('0000320193')
  })
  test('handles already-padded input', () => {
    expect(f.padCik('0000320193')).toBe('0000320193')
  })
})

describe('buildDocUrl', () => {
  test('uses unpadded CIK and dash-stripped accession', () => {
    const url = f.buildDocUrl('0000320193', '0000320193-23-000106', 'aapl-20230930.htm')
    expect(url).toBe('https://www.sec.gov/Archives/edgar/data/320193/000032019323000106/aapl-20230930.htm')
  })
})

describe('pickLatestFiling', () => {
  const recent = {
    form:            ['4', '10-Q', '8-K', '10-K'],
    filingDate:      ['2024-05-02', '2024-05-01', '2024-04-15', '2023-11-02'],
    reportDate:      ['2024-05-01', '2024-03-31', '2024-04-15', '2023-09-30'],
    accessionNumber: ['a-0', 'a-1', 'a-2', 'a-3'],
    primaryDocument: ['d0.htm', 'd1.htm', 'd2.htm', 'd3.htm'],
  }

  test('picks the most recent matching narrative form (arrays are newest-first)', () => {
    const r = f.pickLatestFiling(recent)
    expect(r.form).toBe('10-Q')
    expect(r.accessionNumber).toBe('a-1')
    expect(r.primaryDocument).toBe('d1.htm')
  })

  test('respects a restricted form filter', () => {
    const r = f.pickLatestFiling(recent, ['10-K'])
    expect(r.form).toBe('10-K')
    expect(r.accessionNumber).toBe('a-3')
  })

  test('returns null when nothing matches', () => {
    expect(f.pickLatestFiling(recent, ['S-1'])).toBe(null)
    expect(f.pickLatestFiling(null)).toBe(null)
    expect(f.pickLatestFiling({})).toBe(null)
  })
})

describe('stripHtml', () => {
  test('removes tags, scripts, styles and decodes entities', () => {
    const html = '<style>.a{color:red}</style><div>Risk &amp; reward <script>x()</script>are <b>real</b>.</div>'
    const out = f.stripHtml(html)
    expect(out).not.toMatch(/</)
    expect(out).not.toMatch(/color:red/)
    expect(out).not.toMatch(/x\(\)/)
    expect(out).toContain('Risk & reward')
    expect(out).toContain('real')
  })
  test('empty input → empty string', () => {
    expect(f.stripHtml('')).toBe('')
    expect(f.stripHtml(null)).toBe('')
  })
})

describe('extractSections', () => {
  test('captures Risk Factors and MD&A sections when present', () => {
    const text = 'Cover page boilerplate. ' +
      'Item 1A. Risk Factors ' + 'Our business faces material risks. '.repeat(20) +
      "Management's Discussion and Analysis " + 'Revenue grew this period. '.repeat(20)
    const out = f.extractSections(text)
    expect(out).toContain('Risk Factors')
    expect(out).toContain('Discussion and Analysis')
  })

  test('falls back to a leading excerpt when no headings (e.g. 8-K)', () => {
    const text = 'On this date the registrant announced a new credit agreement. '.repeat(40)
    const out = f.extractSections(text, 500)
    expect(out.length).toBeGreaterThan(0)
    expect(out.length).toBeLessThanOrEqual(500)
    expect(out).toContain('credit agreement')
  })

  test('respects maxChars', () => {
    const text = 'Item 1A. Risk Factors ' + 'x'.repeat(50000)
    const out = f.extractSections(text, 1000)
    expect(out.length).toBeLessThanOrEqual(1000)
  })

  test('empty input → empty string', () => {
    expect(f.extractSections('')).toBe('')
  })
})

describe('resolveCik (injected fetch)', () => {
  const tickerMap = {
    '0': { cik_str: 320193, ticker: 'AAPL', title: 'Apple Inc.' },
    '1': { cik_str: 789019, ticker: 'MSFT', title: 'Microsoft Corp' },
  }
  const fakeFetch = async () => ({ ok: true, json: async () => tickerMap, text: async () => '' })

  test('resolves a known ticker to a padded CIK', async () => {
    const cik = await f.resolveCik('aapl', { fetchImpl: fakeFetch })
    expect(cik).toBe('0000320193')
  })

  test('returns null for an unknown ticker', async () => {
    const cik = await f.resolveCik('NOTREAL', { fetchImpl: fakeFetch })
    expect(cik).toBe(null)
  })

  test('returns null for empty input', async () => {
    expect(await f.resolveCik('', { fetchImpl: fakeFetch })).toBe(null)
  })
})
