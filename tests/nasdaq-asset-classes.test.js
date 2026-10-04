'use strict'

const { nasdaqAssetClasses } = require('../lib/nasdaq-asset-classes')

test('a mutual-fund ticker asks Nasdaq for mutualfunds first', () => {
  for (const s of ['VFIAX', 'FXAIX', 'FSELX', 'vfiax']) {
    expect(nasdaqAssetClasses(s)[0]).toBe('mutualfunds')
  }
})

test('stocks and ETFs keep the old order, with mutualfunds only as a last resort', () => {
  expect(nasdaqAssetClasses('AAPL')).toEqual(['stocks', 'etf', 'index', 'mutualfunds'])
  expect(nasdaqAssetClasses('SPY')).toEqual(['stocks', 'etf', 'index', 'mutualfunds'])
  expect(nasdaqAssetClasses('XLK')[0]).toBe('stocks')        // 3 letters ending in K, not a fund
  expect(nasdaqAssetClasses('QQQX')[0]).toBe('stocks')       // 4 letters ending in X is not the fund pattern
})

test('every symbol is eventually asked about mutualfunds — no fund is left without a keyless fallback', () => {
  for (const s of ['AAPL', 'BRK-B', 'VFIAX', '']) expect(nasdaqAssetClasses(s)).toContain('mutualfunds')
})
