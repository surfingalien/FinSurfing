'use strict'
/** lib/tv-scanner.js — the optional TradingView market scan. No network: fetch is injected. */
const T = require('../lib/tv-scanner')

const row = (name, extra = {}) => {
  const c = { name, description: `${name} Inc`, close: 100, change: 2, volume: 1e6, relative_volume_10d_calc: 2.5, market_cap_basic: 5e9, sector: 'Technology Services', SMA200: 90, RSI: 55, 'Perf.1M': 4, price_52_week_high: 120, exchange: 'NASDAQ', is_primary: true, typespecs: ['common'], ...extra }
  return { s: `NASDAQ:${name}`, d: T.COLUMNS.map(k => c[k]) }
}
const ok = data => async () => ({ ok: true, status: 200, json: async () => ({ totalCount: data.length, data }) })
const on = { TV_SCANNER_ENABLED: 'true' }
beforeEach(() => T._resetForTests())

test('off unless TV_SCANNER_ENABLED is exactly "true" — and no request is made', async () => {
  const fetchImpl = jest.fn()
  for (const env of [{}, { TV_SCANNER_ENABLED: '1' }, { TV_SCANNER_ENABLED: 'TRUE' }]) {
    expect(T.enabled(env)).toBe(false)
    await expect(T.scan('most-active', { env, fetchImpl })).rejects.toThrow(/switched off/)
  }
  expect(fetchImpl).not.toHaveBeenCalled()
  expect(await T.symbolsFor('most-active', { env: {}, fetchImpl })).toEqual([])
})

test('buildQuery: US common shares above a size, the preset filter, an optional sector', () => {
  const q = T.buildQuery('unusual-volume', { sector: 'Health Care', minCap: 5e9, limit: 20 })
  expect(q.filter).toEqual(expect.arrayContaining([
    { left: 'type', operation: 'equal', right: 'stock' },
    { left: 'market_cap_basic', operation: 'greater', right: 5e9 },
    { left: 'relative_volume_10d_calc', operation: 'greater', right: 2 },
    { left: 'sector', operation: 'in_range', right: ['Health Technology', 'Health Services'] },
  ]))
  expect(q.range).toEqual([0, 20])
  expect(q.sort).toEqual({ sortBy: 'relative_volume_10d_calc', sortOrder: 'desc' })
  expect(() => T.buildQuery('nope')).toThrow(/unknown screen/)
  expect(() => T.buildQuery('gainers', { sector: 'Real Estate' })).toThrow(/unknown sector/)
  expect(T.buildQuery('gainers', { limit: 99999 }).range[1]).toBeLessThanOrEqual(300)
})

test('parseRows keeps plain common shares, maps the sector, and drops what it cannot read', () => {
  const rows = T.parseRows({ data: [
    row('AAPL'), row('AAPL'),                                  // duplicate
    row('RF/PE'),                                              // preferred-style ticker
    row('PREF', { typespecs: ['preferred'] }),
    row('ZERO', { close: 0 }),
    row('ODD', { sector: 'Something New', RSI: 'n/a' }),
    { s: 'X', d: [1, 2] }, null,
  ] })
  expect(rows.map(r => r.symbol)).toEqual(['AAPL', 'ODD'])
  expect(rows[0]).toEqual(expect.objectContaining({ sector: 'Information Technology', relVolume: 2.5, changePct: 2, marketCap: 5e9 }))
  expect(rows[1]).toEqual(expect.objectContaining({ sector: null, tvSector: 'Something New', rsi: null }))   // unknown is null, never zero
  expect(() => T.parseRows({ nope: true })).toThrow(/does not recognise/)
})

test('"at a 52-week high" keeps only names within 2% of it', () => {
  const rows = T.parseRows({ data: [row('NEAR', { close: 119 }), row('FAR', { close: 100 }), row('NOHIGH', { price_52_week_high: null })] }, { preset: 'new-high' })
  expect(rows.map(r => r.symbol)).toEqual(['NEAR'])
})

test('scan: one request per preset per ten minutes; failures are named, never an empty success', async () => {
  const fetchImpl = jest.fn(ok([row('NVDA'), row('AMD')]))
  const a = await T.scan('most-active', { env: on, fetchImpl, now: 1e12 })
  expect(a.rows.map(r => r.symbol)).toEqual(['NVDA', 'AMD'])
  expect(a.cached).toBe(false)
  expect((await T.scan('most-active', { env: on, fetchImpl, now: 1e12 + 60_000 })).cached).toBe(true)
  expect(fetchImpl).toHaveBeenCalledTimes(1)
  await T.scan('most-active', { env: on, fetchImpl, now: 1e12 + T.TTL_MS + 1 })
  expect(fetchImpl).toHaveBeenCalledTimes(2)
  expect(JSON.parse(fetchImpl.mock.calls[0][1].body).markets).toEqual(['america'])

  T._resetForTests()
  await expect(T.scan('gainers', { env: on, fetchImpl: async () => ({ ok: false, status: 403 }) })).rejects.toThrow(/refused the request \(HTTP 403\)/)
  await expect(T.scan('gainers', { env: on, fetchImpl: async () => { throw new Error('ECONNRESET') } })).rejects.toThrow(/could not be reached/)
  await expect(T.scan('gainers', { env: on, fetchImpl: async () => ({ ok: true, json: async () => { throw new Error('x') } }) })).rejects.toThrow(/did not answer with JSON/)
  expect(await T.symbolsFor('gainers', { env: on, fetchImpl: async () => ({ ok: false, status: 500 }) })).toEqual([])
})

test('every preset states its fact, and every sector name is one the rest of the app uses', () => {
  for (const p of T.presetList()) { expect(p.label).toBeTruthy(); expect(p.fact).toMatch(/\.$/) }
  const { FMP_SECTORS } = require('../lib/scan-universe')
  for (const s of Object.keys(T.SECTORS)) expect(FMP_SECTORS[s]).toBeDefined()
})
