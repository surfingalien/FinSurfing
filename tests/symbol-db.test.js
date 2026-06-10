'use strict'
/**
 * Unit tests for lib/symbol-db.js — CSV parsing, row projection, and the
 * classify/search/universe query layer over an injected store (no network).
 */

const {
  parseCsv, buildClass, classify, search, listSectors, sectorUniverse, stats,
  _setStoreForTests,
} = require('../lib/symbol-db')

describe('parseCsv', () => {
  test('plain rows and trailing newline', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([['a', 'b', 'c'], ['1', '2', '3']])
  })

  test('quoted fields with embedded commas', () => {
    expect(parseCsv('symbol,name\nAAPL,"Apple, Inc."')).toEqual([
      ['symbol', 'name'], ['AAPL', 'Apple, Inc.'],
    ])
  })

  test('escaped quotes inside quoted field', () => {
    expect(parseCsv('a\n"He said ""hi"""')).toEqual([['a'], ['He said "hi"']])
  })

  test('embedded newline inside quoted field stays in one row', () => {
    const rows = parseCsv('symbol,summary\nMSFT,"line one\nline two"')
    expect(rows).toHaveLength(2)
    expect(rows[1]).toEqual(['MSFT', 'line one\nline two'])
  })

  test('CRLF line endings are normalised', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']])
  })

  test('empty trailing fields are preserved', () => {
    expect(parseCsv('a,b,c\n1,,')).toEqual([['a', 'b', 'c'], ['1', '', '']])
  })
})

describe('buildClass', () => {
  const equitiesCsv = [
    'symbol,name,summary,sector,industry,country,market_cap',
    'AAPL,"Apple Inc.","Makes iPhones, Macs.",Information Technology,Technology Hardware,United States,Mega Cap',
    'SAP,SAP SE,German software,Information Technology,Software,Germany,Large Cap',
    ',"Headerless orphan",x,Energy,Oil,United States,Mid Cap',
  ].join('\n')

  test('projects slim records and applies the country filter', () => {
    const recs = buildClass('equity', equitiesCsv, new Set(['United States']))
    expect(recs).toEqual([
      { symbol: 'AAPL', name: 'Apple Inc.', sector: 'Information Technology', industry: 'Technology Hardware', country: 'United States', marketCap: 'Mega Cap' },
    ])
  })

  test('null country filter keeps all rows with a symbol', () => {
    const recs = buildClass('equity', equitiesCsv, null)
    expect(recs.map(r => r.symbol)).toEqual(['AAPL', 'SAP'])
  })

  test('column order does not matter (header-driven)', () => {
    const reordered = 'name,market_cap,symbol,country,sector,industry\nNvidia,Mega Cap,NVDA,United States,Information Technology,Semiconductors'
    const recs = buildClass('equity', reordered, null)
    expect(recs[0]).toMatchObject({ symbol: 'NVDA', sector: 'Information Technology', marketCap: 'Mega Cap' })
  })

  test('crypto rows derive the base ticker', () => {
    const csv = 'symbol,name,cryptocurrency\nBTC-USD,Bitcoin USD,BTC\nWEIRD-USD,Weird USD,'
    const recs = buildClass('crypto', csv)
    expect(recs[0]).toMatchObject({ symbol: 'BTC-USD', base: 'BTC' })
    expect(recs[1].base).toBe('WEIRD')
  })
})

describe('query layer (injected store)', () => {
  beforeAll(() => {
    _setStoreForTests({
      fetchedAt: '2026-06-10T00:00:00Z',
      classes: {
        equity: [
          { symbol: 'AAPL', name: 'Apple Inc.',        sector: 'Information Technology', industry: 'Hardware',       country: 'United States', marketCap: 'Mega Cap' },
          { symbol: 'NVDA', name: 'Nvidia Corp',       sector: 'Information Technology', industry: 'Semiconductors', country: 'United States', marketCap: 'Mega Cap' },
          { symbol: 'CRWD', name: 'CrowdStrike',       sector: 'Information Technology', industry: 'Software',       country: 'United States', marketCap: 'Large Cap' },
          { symbol: 'PLTR', name: 'Palantir',          sector: 'Information Technology', industry: 'Software',       country: 'United States', marketCap: 'Mid Cap' },
          { symbol: 'TINY', name: 'Tiny Tech',         sector: 'Information Technology', industry: 'Software',       country: 'United States', marketCap: 'Nano Cap' },
          { symbol: 'XOM',  name: 'Exxon Mobil',       sector: 'Energy',                 industry: 'Oil & Gas',      country: 'United States', marketCap: 'Mega Cap' },
        ],
        etf:    [{ symbol: 'SPY', name: 'SPDR S&P 500 ETF', categoryGroup: 'Equities', category: 'Large Blend', family: 'SPDR' }],
        fund:   [{ symbol: 'VFIAX', name: 'Vanguard 500 Index', categoryGroup: 'Equities', category: 'Large Blend', family: 'Vanguard' }],
        crypto: [{ symbol: 'BTC-USD', name: 'Bitcoin USD', base: 'BTC' }],
      },
    })
  })

  test('classify finds each asset class', () => {
    expect(classify('aapl')).toMatchObject({ assetClass: 'equity', sector: 'Information Technology' })
    expect(classify('SPY')).toMatchObject({ assetClass: 'etf', family: 'SPDR' })
    expect(classify('VFIAX')).toMatchObject({ assetClass: 'fund' })
  })

  test('classify resolves crypto by pair, base, and other quote suffixes', () => {
    expect(classify('BTC-USD')).toMatchObject({ assetClass: 'crypto' })
    expect(classify('BTC')).toMatchObject({ assetClass: 'crypto' })
    expect(classify('BTC-EUR')).toMatchObject({ assetClass: 'crypto' })
  })

  test('classify returns null for unknown symbols', () => {
    expect(classify('ZZZZZZ')).toBeNull()
  })

  test('search ranks exact > prefix > contains > name match', () => {
    const results = search('BTC')
    expect(results[0].symbol).toBe('BTC-USD')
    const apple = search('apple')
    expect(apple[0].symbol).toBe('AAPL')
  })

  test('search respects limit', () => {
    expect(search('A', 2)).toHaveLength(2)
  })

  test('listSectors counts equities per sector, descending', () => {
    expect(listSectors()).toEqual([
      { sector: 'Information Technology', count: 5 },
      { sector: 'Energy', count: 1 },
    ])
  })

  test('sectorUniverse orders by cap bucket and applies minCap floor', () => {
    const syms = sectorUniverse('Information Technology', { size: 10 })
    expect(syms).toEqual(['AAPL', 'NVDA', 'CRWD', 'PLTR'])   // Nano Cap excluded by default Mid Cap floor
    const large = sectorUniverse('Information Technology', { size: 10, minCap: 'Mega Cap' })
    expect(large).toEqual(['AAPL', 'NVDA'])
  })

  test('sectorUniverse size caps the result', () => {
    expect(sectorUniverse('Information Technology', { size: 1 })).toEqual(['AAPL'])
  })

  test('stats reports counts per class', () => {
    expect(stats()).toMatchObject({ loaded: true, counts: { equity: 6, etf: 1, fund: 1, crypto: 1 } })
  })
})
