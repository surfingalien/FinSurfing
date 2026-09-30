'use strict'

const { buildScanUniverse, filterMovers, DISCOVERY_MODES } = require('../lib/scan-universe')

const curated = Array.from({ length: 20 }, (_, i) => `C${String.fromCharCode(65 + i)}`)
const pool    = Array.from({ length: 150 }, (_, i) => `P${i}`)

describe('buildScanUniverse', () => {
  test('two consecutive scans cover different names', () => {
    const a = buildScanUniverse({ curated, pool, seed: 1 })
    const b = buildScanUniverse({ curated, pool, recent: a.symbols, seed: 2 })
    const overlap = b.symbols.filter(s => a.symbols.includes(s))
    expect(a.symbols).toHaveLength(20)
    expect(b.symbols).toHaveLength(20)
    expect(overlap).toHaveLength(0)
  })

  test("today's movers come first and are labelled", () => {
    const u = buildScanUniverse({ curated, pool, movers: ['MOVA', 'MOVB'], seed: 3 })
    expect(u.symbols.slice(0, 2)).toEqual(['MOVA', 'MOVB'])
    expect(u.sources.MOVA).toBe('mover')
  })

  test('fixed reference symbols are always kept', () => {
    const u = buildScanUniverse({ curated, pool, fixed: ['SPY', 'BTC-USD'], recent: ['SPY', 'BTC-USD'], seed: 4 })
    expect(u.symbols).toEqual(expect.arrayContaining(['SPY', 'BTC-USD']))
    expect(u.sources.SPY).toBe('fixed')
  })

  test('with no pool (index not loaded) it still fills from the curated list', () => {
    const u = buildScanUniverse({ curated, pool: [], seed: 5 })
    expect(u.symbols).toHaveLength(20)
    expect(new Set(u.symbols).size).toBe(20)
  })

  test('a mover scanned last time yields to fresh names but can refill spare slots', () => {
    const u = buildScanUniverse({ curated: ['X'], pool: [], movers: ['OLD', 'NEW'], recent: ['OLD'], size: 3, seed: 6 })
    expect(u.symbols).toEqual(['NEW', 'OLD', 'X'])
  })

  test('same seed and inputs reproduce the same list', () => {
    expect(buildScanUniverse({ curated, pool, seed: 9 })).toEqual(buildScanUniverse({ curated, pool, seed: 9 }))
  })
})

describe('filterMovers', () => {
  test('keeps plain liquid tickers only, deduped, optionally in one sector', () => {
    const movers = [
      { symbol: 'NVDA', price: 120 }, { symbol: 'NVDA', price: 120 },
      { symbol: 'PENNY', price: 1.2 }, { symbol: 'ABCDEF', price: 50 }, { symbol: 'XOM', price: 110 },
      { symbol: 'BRK.B', price: 400 },
    ]
    expect(filterMovers(movers)).toEqual(['NVDA', 'XOM', 'BRK.B'])
    const sectorOf = s => ({ NVDA: 'Information Technology', XOM: 'Energy' }[s] || null)
    expect(filterMovers(movers, { sector: 'Energy', sectorOf })).toEqual(['XOM'])
  })

  test('discovery covers the stock modes, not the crypto/ETF/fund ones', () => {
    expect(DISCOVERY_MODES.has('stocks_tech')).toBe(true)
    expect(DISCOVERY_MODES.has('broad')).toBe(true)
    expect(DISCOVERY_MODES.has('crypto_l1')).toBe(false)
    expect(DISCOVERY_MODES.has('etfs_broad')).toBe(false)
  })
})
