'use strict'

// fetchDailyBars returned a bare [] for every failure, so the Research Desk
// told a user that a listed stock (SPCX) had "0 daily bars" when the data
// providers had refused it or not answered in time. An empty result now
// carries the reason.

const { fetchDailyBars } = require('../lib/internal-api')

let realFetch
beforeEach(() => { realFetch = global.fetch })
afterEach(() => { global.fetch = realFetch })

test('bars come back ascending with nulls dropped', async () => {
  global.fetch = jest.fn(async () => ({ status: 200, json: async () => ({ chart: { result: [{
    timestamp: [1, 2, 3], indicators: { quote: [{ open: [1, 2, 3], high: [1, 2, 3], low: [1, 2, 3], close: [10, null, 12], volume: [5, 5, 5] }] },
  }] } }) }))
  const bars = await fetchDailyBars('NVDA')
  expect(bars.map(b => b.c)).toEqual([10, 12])
  expect(bars.reason).toBeUndefined()
})

test('the chart route\'s own error is passed on', async () => {
  global.fetch = jest.fn(async () => ({ status: 502, json: async () => ({ error: 'No price history available for SPCX — no data provider returned it; no API key set for AISA', chart: { result: null } }) }))
  const bars = await fetchDailyBars('SPCX')
  expect(bars).toHaveLength(0)
  expect(bars.reason).toMatch(/no API key set for AISA/)
})

test('a timeout says so rather than "no history"', async () => {
  global.fetch = jest.fn(async () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }) })
  const bars = await fetchDailyBars('SPCX', { timeoutMs: 25_000 })
  expect(bars).toHaveLength(0)
  expect(bars.reason).toMatch(/did not answer within 25s.*try again in a minute/)
})
