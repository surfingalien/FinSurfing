'use strict'
/**
 * For route tests that exercise OTHER gates (EV, HRP, citations): a persona
 * screen that admits the symbols those tests use, so the persona check is not
 * what decides their outcome. The screen's own behaviour is tested in
 * tests/persona-screen.test.js and tests/recommendations-persona.test.js.
 */
const actual = jest.requireActual('../../lib/persona-screen')
const STOCKS = ['AAPL', 'MSFT', 'NVDA', 'AMD', 'KO', 'NEWCO']
const CRYPTO = ['BTC-USD', 'DOGE-USD', 'SHIB-USD', 'ETH-USD']
const row = (symbol, assetClass) => ({ symbol, assetClass, price: 100, passed: [] })

function openScreen() {
  return {
    persona: 'default', slate: { Stock: 12, ETF: 4, Crypto: 3 }, periods: ['3m', '6m'], rules: [], notes: [],
    stocks: STOCKS.map(s => row(s, 'Stock')), etfs: [], crypto: CRYPTO.map(s => row(s, 'Crypto')), funds: [],
    screenedOut: { failed: 0, unknown: 0, sector: 0, unpriced: 0 },
  }
}

module.exports = { ...actual, screenLive: async () => ({ screen: openScreen(), measures: {}, failed: [] }) }
