'use strict'
/**
 * Unit tests for lib/stooq.js — the keyless last-resort quote provider.
 * Parser is pure; no network in tests.
 */

const { parseStooqCsv, eligible } = require('../lib/stooq')

const CSV = [
  'Symbol,Date,Time,Open,High,Low,Close,Volume',
  'AAPL.US,2026-06-12,21:59:58,212.5,215.1,211.8,214.45,48211000',
  'BRK-B.US,2026-06-12,21:59:58,N/D,N/D,N/D,N/D,N/D',           // unknown → N/D
  'GLD.US,2026-06-12,21:59:58,310.2,311.9,309.5,311.02,7150000',
].join('\n')

describe('parseStooqCsv', () => {
  test('parses valid rows into yahoo-shaped quotes', () => {
    const q = parseStooqCsv(CSV)
    expect(q).toHaveLength(2)
    expect(q[0]).toMatchObject({
      symbol: 'AAPL', regularMarketPrice: 214.45,
      regularMarketOpen: 212.5, regularMarketDayHigh: 215.1,
      regularMarketDayLow: 211.8, regularMarketVolume: 48211000,
      provider: 'stooq',
    })
    expect(typeof q[0].regularMarketTime).toBe('number')
  })

  test('strips the .US suffix', () => {
    expect(parseStooqCsv(CSV).map(q => q.symbol)).toEqual(['AAPL', 'GLD'])
  })

  test('drops N/D rows, malformed lines, and empty input', () => {
    expect(parseStooqCsv(CSV).find(q => q.symbol.startsWith('BRK'))).toBeUndefined()
    expect(parseStooqCsv('Symbol,Date\ngarbage')).toEqual([])
    expect(parseStooqCsv('')).toEqual([])
    expect(parseStooqCsv(null)).toEqual([])
  })

  test('rejects zero/negative closes', () => {
    const bad = 'Symbol,Date,Time,Open,High,Low,Close,Volume\nXXX.US,2026-06-12,10:00:00,1,1,1,0,5'
    expect(parseStooqCsv(bad)).toEqual([])
  })
})

describe('eligible', () => {
  test('accepts plain US tickers incl. dotted classes', () => {
    expect(eligible('AAPL')).toBe(true)
    expect(eligible('BRK.B')).toBe(true)
    expect(eligible('GLD')).toBe(true)
  })
  test('rejects crypto, forex, empty', () => {
    expect(eligible('BTC-USD')).toBe(false)
    expect(eligible('EURUSD=X')).toBe(false)
    expect(eligible('')).toBe(false)
    expect(eligible(undefined)).toBe(false)
  })
})
