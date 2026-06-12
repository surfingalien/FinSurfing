'use strict'

/**
 * lib/stooq.js
 *
 * Keyless quote fallback for US equities/ETFs via Stooq's public CSV API
 * (https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&e=csv). No API key, no
 * registration, cloud-friendly — exists so the /api/quote cascade can still
 * price stocks when every keyed provider is down or misconfigured. Quotes
 * may be delayed/EOD; no prevClose is available, so results carry price
 * only (day-change consumers treat them as no-change, which is honest).
 *
 * parseStooqCsv is pure and unit-tested; fetchStooqQuotes is the thin
 * network wrapper used by server.js.
 */

const BASE = 'https://stooq.com/q/l/'

// Only plain US-listed tickers — crypto/futures/forex don't belong here
function eligible(symbol) {
  return /^[A-Z][A-Z.]{0,5}$/.test(symbol || '') && !symbol.includes('-')
}

/**
 * CSV with f=sd2t2ohlcv: Symbol,Date,Time,Open,High,Low,Close,Volume
 * Unknown symbols come back with N/D fields. Returns yahoo-shaped quotes.
 */
function parseStooqCsv(text) {
  const out = []
  const lines = String(text || '').trim().split('\n')
  for (const line of lines.slice(1)) {   // skip header
    const cols = line.split(',')
    if (cols.length < 7) continue
    const [sym, date, time, o, h, l, c] = cols
    const close = parseFloat(c)
    if (!sym || isNaN(close) || close <= 0) continue
    const base = sym.toUpperCase().replace(/\.US$/, '')
    // Date+time are exchange-local-ish; only used for an honest timestamp.
    const ts = Date.parse(`${date}T${time || '00:00:00'}Z`)
    out.push({
      symbol: base,
      shortName: base,
      regularMarketPrice:   close,
      regularMarketOpen:    parseFloat(o) || null,
      regularMarketDayHigh: parseFloat(h) || null,
      regularMarketDayLow:  parseFloat(l) || null,
      regularMarketVolume:  parseFloat(cols[7]) || null,
      regularMarketTime:    isNaN(ts) ? null : Math.floor(ts / 1000),
      provider: 'stooq',
    })
  }
  return out
}

async function fetchStooqQuotes(symbols, { timeoutMs = 8000 } = {}) {
  const list = [...new Set((symbols || []).filter(eligible))].slice(0, 40)
  if (!list.length) return null
  const url = `${BASE}?s=${list.map(s => s.toLowerCase() + '.us').join(',')}&f=sd2t2ohlcv&e=csv`
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) return null
  const quotes = parseStooqCsv(await r.text())
  return quotes.length ? quotes : null
}

module.exports = { parseStooqCsv, fetchStooqQuotes, eligible }
