'use strict'
/**
 * lib/fmp.js — the FMP client every route now goes through.
 *
 * What is pinned: a current key is served by the stable API with no legacy
 * call; a legacy-only key still works through the v3 fallback; FMP's in-body
 * refusals are errors, not data; every adapter adds the legacy field names
 * the call sites read without dropping the new ones; and the insider-side
 * classifier no longer reads "S-Sale" as a buy.
 */

const fmp = require('../lib/fmp')

const KEY = 'test-key-123'
const reply = (status, body) => ({
  ok: status >= 200 && status < 300, status,
  text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
})

/** Route by URL substring; unmatched → 404. Records every URL. */
function fakeFetch(routes) {
  const calls = []
  const impl = async (url) => {
    calls.push(url)
    for (const [pattern, status, body] of routes) if (url.includes(pattern)) return reply(status, body)
    return reply(404, {})
  }
  return { impl, calls }
}
const LEGACY_REFUSAL = { 'Error Message': 'Legacy Endpoint : Due to Legacy endpoints being no longer supported - This endpoint is only available for legacy users who have valid subscriptions prior August 31, 2025.' }

describe('errorMessage', () => {
  test('recognises FMP refusals in every shape they arrive in', () => {
    expect(fmp.errorMessage({ 'Error Message': 'Invalid API KEY.' })).toBe('Invalid API KEY.')
    expect(fmp.errorMessage({ error: 'Limit Reach' })).toBe('Limit Reach')
    expect(fmp.errorMessage('Premium Query Parameter: …')).toMatch(/Premium/)
  })
  test('real data is not an error', () => {
    expect(fmp.errorMessage([{ symbol: 'AAPL' }])).toBeNull()
    expect(fmp.errorMessage({ symbol: 'AAPL', historical: [] })).toBeNull()
    expect(fmp.errorMessage(null)).toBeNull()
  })
})

describe('stable first, legacy second', () => {
  test('a current key is answered by the stable API and never touches v3', async () => {
    const f = fakeFetch([['stable/batch-quote', 200, [{ symbol: 'AAPL', price: 331.8, changePercentage: -1.87 }]]])
    const rows = await fmp.quotes(['AAPL'], { key: KEY, fetchImpl: f.impl })
    expect(rows[0].price).toBe(331.8)
    expect(rows[0].changesPercentage).toBe(-1.87)          // legacy name added
    expect(rows[0].changePercentage).toBe(-1.87)           // new name kept
    expect(f.calls.some(u => u.includes('/api/v3/'))).toBe(false)
  })

  test('a legacy-only key still works through v3', async () => {
    const f = fakeFetch([
      ['/stable/', 200, { 'Error Message': 'Restricted Endpoint' }],
      ['api/v3/profile/AAPL', 200, [{ symbol: 'AAPL', mktCap: 3e12, lastDiv: 1.0 }]],
    ])
    const p = await fmp.profile('AAPL', { key: KEY, fetchImpl: f.impl })
    expect(p.mktCap).toBe(3e12)
  })

  test('when both refuse, the STABLE error is reported, not the legacy notice', async () => {
    const f = fakeFetch([
      ['/stable/', 402, 'Premium Query Parameter: this value is not available under your current subscription'],
      ['/api/v3/', 200, LEGACY_REFUSAL],
    ])
    await expect(fmp.profile('AAPL', { key: KEY, fetchImpl: f.impl })).rejects.toThrow(/Premium Query Parameter/)
  })

  test('an empty stable answer is data (unknown symbol), not a failure', async () => {
    const f = fakeFetch([['stable/profile', 200, []], ['/api/v3/', 200, LEGACY_REFUSAL]])
    await expect(fmp.profile('ZZZZ', { key: KEY, fetchImpl: f.impl })).resolves.toBeNull()
  })

  test('the API key never leaks into an error message', async () => {
    const f = fakeFetch([['/', 500, 'Server Error']])
    const err = await fmp.profile('AAPL', { key: KEY, fetchImpl: f.impl }).catch(e => e)
    expect(err).toBeInstanceOf(fmp.FmpError)
    expect(err.message).not.toContain(KEY)
  })

  test('no key → FmpError, no network', async () => {
    const saved = process.env.FMP_API_KEY
    delete process.env.FMP_API_KEY
    const f = fakeFetch([])
    await expect(fmp.profile('AAPL', { fetchImpl: f.impl })).rejects.toThrow(/FMP_API_KEY not set/)
    expect(f.calls).toHaveLength(0)
    if (saved) process.env.FMP_API_KEY = saved
  })

  test('the key rides as the apikey query parameter', () => {
    const u = new URL(fmp.buildUrl(fmp.STABLE, 'quote', { symbol: 'BRK.B', empty: '', nothing: null }, KEY))
    expect(u.pathname).toBe('/stable/quote')
    expect(u.searchParams.get('symbol')).toBe('BRK.B')
    expect(u.searchParams.get('apikey')).toBe(KEY)
    expect(u.searchParams.has('empty')).toBe(false)
    expect(u.searchParams.has('nothing')).toBe(false)
  })
})

describe('quotes', () => {
  test('a plan that refuses batches gets capped per-symbol calls', async () => {
    const f = fakeFetch([
      ['stable/batch-quote', 402, 'Premium'],
      ['stable/quote?symbol=', 200, [{ symbol: 'X', price: 1 }]],
    ])
    const syms = Array.from({ length: 30 }, (_, i) => `S${i}`)
    await fmp.quotes(syms, { key: KEY, fetchImpl: f.impl })
    expect(f.calls.filter(u => u.includes('stable/quote?symbol=')).length).toBe(10)
  })
})

describe('history', () => {
  test('stable flat arrays and legacy {historical} unwrap to the same rows', async () => {
    const row = { date: '2026-07-30', open: 1, high: 2, low: 0.5, close: 1.5, volume: 10 }
    const a = fakeFetch([['stable/historical-price-eod/full', 200, [row]]])
    const b = fakeFetch([['/stable/', 200, LEGACY_REFUSAL], ['historical-price-full/AAPL', 200, { symbol: 'AAPL', historical: [row] }]])
    expect(await fmp.dailyHistory('AAPL', { key: KEY, fetchImpl: a.impl })).toEqual([row])
    expect(await fmp.dailyHistory('AAPL', { key: KEY, fetchImpl: b.impl })).toEqual([row])
  })
})

describe('adapters add legacy names and keep the new ones', () => {
  test('profile', () => {
    const p = fmp.profileToLegacy({ marketCap: 5, lastDividend: 1.05, averageVolume: 9, change: -1, exchange: 'NASDAQ' })
    expect(p).toMatchObject({ mktCap: 5, marketCap: 5, lastDiv: 1.05, lastAnnualDividend: 1.05, volAvg: 9, changes: -1, exchangeShortName: 'NASDAQ' })
  })

  test('TTM metrics merge key-metrics and ratios, both spellings readable', () => {
    const m = fmp.metricsTtmToLegacy(
      { returnOnEquityTTM: 1.46, returnOnInvestedCapitalTTM: 0.49, evToEBITDATTM: 30.7, freeCashFlowYieldTTM: 0.026 },
      { priceToEarningsRatioTTM: 40, priceToBookRatioTTM: 45.8, debtToEquityRatioTTM: 0.79, dividendPayoutRatioTTM: 0.12, dividendYieldTTM: 0.004 },
    )
    expect(m).toMatchObject({
      peRatioTTM: 40, priceToEarningsRatioTTM: 40, pbRatioTTM: 45.8,
      roeTTM: 1.46, roicTTM: 0.49, enterpriseValueOverEBITDATTM: 30.7,
      debtToEquityTTM: 0.79, debtEquityRatioTTM: 0.79, payoutRatioTTM: 0.12,
      freeCashFlowYieldTTM: 0.026, dividendYieldTTM: 0.004,
    })
  })

  test('a legacy field already present is never overwritten', () => {
    expect(fmp.metricsTtmToLegacy({ peRatioTTM: 12 }, { priceToEarningsRatioTTM: 40 }).peRatioTTM).toBe(12)
  })

  test('statements', () => {
    expect(fmp.statementToLegacy({ fiscalYear: '2025', epsDiluted: 7.46, filingDate: 'd', netDividendsPaid: -15 }))
      .toMatchObject({ calendarYear: '2025', epsdiluted: 7.46, fillingDate: 'd', dividendsPaid: -15 })
  })

  test('search', () => {
    expect(fmp.searchToLegacy({ symbol: 'AAPL', exchangeFullName: 'NASDAQ Global Select', exchange: 'NASDAQ' }))
      .toMatchObject({ stockExchange: 'NASDAQ Global Select', exchangeShortName: 'NASDAQ' })
  })

  test('analyst counts from stable consensus and from the legacy lowercase `analystRatingsbuy`', () => {
    expect(fmp.ratingsRowToCounts({ strongBuy: 1, buy: 70, hold: 32, sell: 8, strongSell: 0, consensus: 'Buy' }))
      .toMatchObject({ strongBuy: 1, buy: 70, hold: 32, sell: 8, strongSell: 0, consensus: 'Buy' })
    expect(fmp.ratingsRowToCounts({ analystRatingsStrongBuy: 6, analystRatingsbuy: 23, analystRatingsHold: 17, analystRatingsSell: 2, analystRatingsStrongSell: 2 }))
      .toMatchObject({ strongBuy: 6, buy: 23, hold: 17, sell: 2, strongSell: 2 })
  })
})

describe('earnings', () => {
  test('surprises keep only REPORTED quarters — an upcoming date has no actual', async () => {
    const f = fakeFetch([['stable/earnings?', 200, [
      { date: '2026-10-30', epsActual: null, epsEstimated: 2.0 },
      { date: '2026-07-30', epsActual: 1.9, epsEstimated: 1.88 },
      { date: '2026-04-30', epsActual: 1.6, epsEstimated: 1.61 },
    ]]])
    const rows = await fmp.earningsSurprises('AAPL', { key: KEY, fetchImpl: f.impl, limit: 4 })
    expect(rows.map(r => r.date)).toEqual(['2026-07-30', '2026-04-30'])
    expect(rows[0]).toMatchObject({ actualEarningResult: 1.9, estimatedEarning: 1.88 })
  })

  test('transcripts: dates first, then each quarter, newest first', async () => {
    const f = fakeFetch([
      ['earning-call-transcript-dates', 200, [
        { quarter: 1, fiscalYear: 2026, date: '2026-01-30' },
        { quarter: 2, fiscalYear: 2026, date: '2026-04-30' },
      ]],
      ['quarter=2', 200, [{ symbol: 'AAPL', period: 'Q2', year: 2026, date: '2026-04-30', content: 'Operator: Q2' }]],
      ['quarter=1', 200, [{ symbol: 'AAPL', period: 'Q1', year: 2026, date: '2026-01-30', content: 'Operator: Q1' }]],
    ])
    const rows = await fmp.transcripts('AAPL', { key: KEY, fetchImpl: f.impl, limit: 2 })
    expect(rows.map(r => [r.quarter, r.year])).toEqual([[2, 2026], [1, 2026]])
    expect(rows[0].content).toMatch(/Q2/)
  })
})

describe('insiderSide — the SEC code decides', () => {
  test.each([
    ['S-Sale', 'sell'],                 // the old substring test called this a buy (it contains an A)
    ['S-Sale+OE', 'sell'],
    ['P-Purchase', 'buy'],
    ['A-Award', 'other'],               // a grant is not insider buying
    ['M-Exempt', 'other'],
    ['F-InKind', 'other'],
    ['G-Gift', 'other'],
  ])('%s → %s', (transactionType, side) => {
    expect(fmp.insiderSide({ transactionType })).toBe(side)
  })
  test('no code → acquired/disposed', () => {
    expect(fmp.insiderSide({ acquisitionOrDisposition: 'D' })).toBe('sell')
    expect(fmp.insiderSide({ acquistionOrDisposition: 'A' })).toBe('buy')
    expect(fmp.insiderSide({})).toBe('other')
  })
})

describe('peers', () => {
  test('stable rows and the legacy peersList give the same tickers', async () => {
    const a = fakeFetch([['stable/stock-peers', 200, [{ symbol: 'MSFT' }, { symbol: 'GOOGL' }]]])
    const b = fakeFetch([['/stable/', 200, LEGACY_REFUSAL], ['stock_peers', 200, [{ symbol: 'AAPL', peersList: ['MSFT', 'GOOGL'] }]]])
    expect(await fmp.peers('AAPL', { key: KEY, fetchImpl: a.impl })).toEqual(['MSFT', 'GOOGL'])
    expect(await fmp.peers('AAPL', { key: KEY, fetchImpl: b.impl })).toEqual(['MSFT', 'GOOGL'])
  })
})
