'use strict'

/**
 * lib/crypto-history.js — deep crypto daily history from two keyless sources.
 *
 * Binance (through its market-data mirror, see server.js) returns at most
 * 1,000 candles per request, so a 5-year range came back as ~2.7 years and the
 * BTC regime profile rested on 12 windows. `binanceKlines` pages backwards
 * with endTime until it has the range or reaches the coin's first candle.
 * Coinbase Exchange is the second source before CoinGecko (whose free OHLC is
 * coarse and rate-limited): 300 candles per request, paged by start/end.
 *
 * Fetchers take an injectable fetchImpl. Tests: tests/crypto-history.test.js
 */

const DAY = 86_400_000
const BINANCE_PAGE = 1000
const COINBASE_PAGE = 300

/** Klines ascending, de-duplicated, at most `need` of the newest. Pages backwards up to `maxPages`. */
async function binanceKlines({ base, pair, interval, need, fetchImpl = fetch, maxPages = 4 }) {
  let out = []
  let endTime = null
  for (let page = 0; page < maxPages && out.length < need; page++) {
    const limit = Math.min(BINANCE_PAGE, need - out.length)
    const url = `${base}/api/v3/klines?symbol=${pair}&interval=${interval}&limit=${limit}${endTime != null ? `&endTime=${endTime}` : ''}`
    const r = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const rows = await r.json()
    if (!Array.isArray(rows) || !rows.length) break
    out = [...rows, ...out]
    endTime = rows[0][0] - 1
    if (rows.length < limit) break                     // reached the first candle the pair has
  }
  const seen = new Set()
  return out.filter(k => (seen.has(k[0]) ? false : seen.add(k[0]))).sort((a, b) => a[0] - b[0]).slice(-need)
}

/** Coinbase product id for a symbol like BTC-USD / ETH-USDT / SOL. */
const coinbaseProduct = symbol => `${String(symbol).toUpperCase().replace(/-USDT?$/, '').replace(/USDT?$/, '')}-USD`

/** Daily candles from Coinbase Exchange, oldest first: [{t, o, h, l, c, v}]. */
async function coinbaseDaily({ symbol, days, fetchImpl = fetch, now = Date.now() }) {
  const product = coinbaseProduct(symbol)
  const bars = new Map()
  let end = now
  const start0 = now - days * DAY
  for (let guard = 0; end > start0 && guard < 12; guard++) {
    const start = Math.max(start0, end - COINBASE_PAGE * DAY)
    const url = `https://api.exchange.coinbase.com/products/${product}/candles?granularity=86400&start=${new Date(start).toISOString()}&end=${new Date(end).toISOString()}`
    const r = await fetchImpl(url, { headers: { 'User-Agent': 'FinSurfing/1.0' }, signal: AbortSignal.timeout(15_000) })
    if (r.status === 404) return []                    // no such product
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const rows = await r.json()
    if (!Array.isArray(rows) || !rows.length) break
    // [time(s), low, high, open, close, volume], newest first
    for (const [ts, low, high, open, close, volume] of rows) bars.set(ts * 1000, { t: ts * 1000, o: open, h: high, l: low, c: close, v: volume })
    end = start
  }
  return [...bars.values()].sort((a, b) => a.t - b.t)
}

/** Bars → the Yahoo-shaped chart payload every provider in server.js returns. */
function toChart(symbol, bars) {
  if (!bars?.length) return null
  const closes = bars.map(b => b.c)
  return {
    chart: { result: [{
      meta: { symbol, regularMarketPrice: closes.at(-1), chartPreviousClose: closes.at(-2) ?? null },
      timestamp: bars.map(b => Math.floor(b.t / 1000)),
      indicators: {
        quote: [{ open: bars.map(b => b.o), high: bars.map(b => b.h), low: bars.map(b => b.l), close: closes, volume: bars.map(b => b.v) }],
        adjclose: [{ adjclose: closes }],
      },
    }], error: null },
  }
}

module.exports = { BINANCE_PAGE, COINBASE_PAGE, binanceKlines, coinbaseProduct, coinbaseDaily, toChart }
