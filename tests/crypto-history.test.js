'use strict'

const ch = require('../lib/crypto-history')
const DAY = 86_400_000

test('Binance pages backwards past the 1,000-candle cap and stops at the first candle a pair has', async () => {
  const first = Date.UTC(2021, 0, 1), last = first + 2499 * DAY          // 2,500 days of history
  const fetchImpl = jest.fn(async url => {
    const u = new URL(url)
    const limit = Number(u.searchParams.get('limit'))
    const end = u.searchParams.get('endTime') ? Number(u.searchParams.get('endTime')) : last
    const rows = []
    for (let t = Math.floor((end - first) / DAY) * DAY + first; t >= first && rows.length < limit; t -= DAY) rows.unshift([t, '1', '2', '0.5', '1.5', '10'])
    return { ok: true, json: async () => rows }
  })
  const k = await ch.binanceKlines({ base: 'https://b', pair: 'BTCUSDT', interval: '1d', need: 1825, fetchImpl })
  expect(k).toHaveLength(1825)
  expect(k.at(-1)[0]).toBe(last)
  expect(k.every((x, i) => i === 0 || x[0] - k[i - 1][0] === DAY)).toBe(true)
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  const young = await ch.binanceKlines({ base: 'https://b', pair: 'NEWUSDT', interval: '1d', need: 4000, fetchImpl })
  expect(young).toHaveLength(2500)                                        // all it has, no padding
})

test('Coinbase daily candles are paged, de-duplicated and returned oldest first; an unknown product is empty', async () => {
  const now = Date.UTC(2026, 9, 24)
  const fetchImpl = jest.fn(async url => {
    if (url.includes('/products/NOPE-USD/')) return { ok: false, status: 404 }
    const u = new URL(url)
    const s = Date.parse(u.searchParams.get('start')), e = Date.parse(u.searchParams.get('end'))
    const rows = []
    for (let t = e; t >= s; t -= DAY) rows.push([t / 1000, 9, 11, 10, 10.5, 100])
    return { ok: true, status: 200, json: async () => rows }
  })
  const bars = await ch.coinbaseDaily({ symbol: 'ETH-USDT', days: 700, fetchImpl, now })
  expect(fetchImpl.mock.calls[0][0]).toMatch(/\/products\/ETH-USD\/candles\?granularity=86400/)
  expect(bars.length).toBeGreaterThanOrEqual(700)
  expect(bars.every((b, i) => i === 0 || b.t > bars[i - 1].t)).toBe(true)
  expect(await ch.coinbaseDaily({ symbol: 'NOPE', days: 30, fetchImpl, now })).toEqual([])
  expect(ch.toChart('ETH-USD', bars).chart.result[0].indicators.quote[0].close.at(-1)).toBe(10.5)
})
