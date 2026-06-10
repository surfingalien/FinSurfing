'use strict'
/**
 * Unit tests for lib/crypto-classify.js — extracted verbatim from server.js,
 * giving the quote-pipeline routing classifiers their first test coverage.
 */

const { KNOWN_CRYPTO, isCryptoSymbol, toBinancePair, cgId } = require('../lib/crypto-classify')

describe('isCryptoSymbol', () => {
  test('Yahoo dash format is crypto', () => {
    expect(isCryptoSymbol('BTC-USD')).toBe(true)
    expect(isCryptoSymbol('ETH-BTC')).toBe(true)
  })

  test('known bare tickers are crypto', () => {
    expect(isCryptoSymbol('SOL')).toBe(true)
    expect(isCryptoSymbol('doge')).toBe(true) // case-insensitive
  })

  test('equities and empty input are not crypto', () => {
    expect(isCryptoSymbol('AAPL')).toBe(false)
    expect(isCryptoSymbol('')).toBe(false)
    expect(isCryptoSymbol(null)).toBe(false)
  })
})

describe('toBinancePair', () => {
  test('Yahoo dash USD variants normalize to USDT pairs', () => {
    expect(toBinancePair('BTC-USD')).toBe('BTCUSDT')
    expect(toBinancePair('SOL-USDC')).toBe('SOLUSDT')
  })

  test('cross pairs keep their quote currency', () => {
    expect(toBinancePair('ETH-BTC')).toBe('ETHBTC')
  })

  test('composite and bare tickers normalize', () => {
    expect(toBinancePair('SOLUSD')).toBe('SOLUSDT')
    expect(toBinancePair('SOLUSDT')).toBe('SOLUSDT')
    expect(toBinancePair('SOL')).toBe('SOLUSDT')
  })
})

describe('cgId', () => {
  test('maps base symbols regardless of quote suffix', () => {
    expect(cgId('BTC-USD')).toBe('bitcoin')
    expect(cgId('AVAX')).toBe('avalanche-2')
  })

  test('unknown coins return null (callers fall through to next provider)', () => {
    expect(cgId('UNKNOWNCOIN')).toBe(null)
  })
})

describe('KNOWN_CRYPTO', () => {
  test('is a non-trivial set of bare tickers', () => {
    expect(KNOWN_CRYPTO.size).toBeGreaterThan(50)
    expect(KNOWN_CRYPTO.has('BTC')).toBe(true)
  })
})
