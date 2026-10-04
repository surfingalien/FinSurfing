'use strict'

/**
 * lib/nasdaq-asset-classes.js — which Nasdaq quote "assetclass" to ask, in order.
 *
 * api.nasdaq.com answers a quote only for the asset class it is asked about,
 * and the server's keyless fallback asked stocks → etf → index — never
 * mutualfunds. Mutual-fund NAVs therefore came only from FMP, and on an FMP
 * plan that refuses fund symbols VFIAX/FXAIX had no price at all (FSELX showed
 * a stale last-known one). Nasdaq serves current fund NAVs under
 * `assetclass=mutualfunds`.
 *
 * US mutual fund tickers are five letters ending in X (VFIAX, FXAIX, FSELX), so
 * those ask mutualfunds FIRST and skip three wasted lookups; everything else
 * keeps the old order with mutualfunds appended as a last resort.
 *
 * Pure. Tests: tests/nasdaq-asset-classes.test.js
 */
const FUND_TICKER = /^[A-Z]{4}X$/

function nasdaqAssetClasses(symbol) {
  const s = String(symbol || '').toUpperCase()
  return FUND_TICKER.test(s)
    ? ['mutualfunds', 'stocks', 'etf']
    : ['stocks', 'etf', 'index', 'mutualfunds']
}

module.exports = { nasdaqAssetClasses, FUND_TICKER }
