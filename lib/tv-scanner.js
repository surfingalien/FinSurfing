'use strict'
/**
 * lib/tv-scanner.js — whole-market screens from TradingView's scanner.
 *
 * READ THIS FIRST. `scanner.tradingview.com` is the endpoint TradingView's own
 * screener page calls. It is NOT a published API: it is undocumented, it can
 * change or be blocked without notice, and calling it from a hosted app may be
 * against TradingView's terms of use. So:
 *
 *  - It is OFF unless the operator sets TV_SCANNER_ENABLED=true.
 *  - Nothing depends on it. Every caller has a path that works without it and
 *    falls back to that path when a call fails; a failure is reported, never
 *    hidden as an empty result.
 *  - Calls are cached and few: one POST per preset per ten minutes at most.
 *  - Its numbers are TradingView's (delayed for most exchanges). They are used
 *    to FIND names; anything shown as a price or used in a decision is priced
 *    again by this app's own data cascade.
 *
 * A preset is a fixed, plainly worded fact ("trading at twice its usual
 * volume"), not a signal, and none of the thresholds is tuned.
 *
 * Tests: tests/tv-scanner.test.js. Idea from shner-elmo/TradingView-Screener
 * (MIT); no code taken.
 */

const URL_US = 'https://scanner.tradingview.com/america/scan'
const TTL_MS = 10 * 60_000
const MAX_ROWS = 100
const PLAIN = /^[A-Z]{1,5}$/                     // common shares only: no "RF/PE", no "BRK.B" style suffix games
const COLUMNS = ['name', 'description', 'close', 'change', 'volume', 'relative_volume_10d_calc', 'market_cap_basic', 'sector', 'SMA200', 'RSI', 'Perf.1M', 'price_52_week_high', 'exchange', 'is_primary', 'typespecs']

// TradingView's own sector names, grouped under the GICS sectors the rest of the app uses.
const SECTORS = {
  'Information Technology': ['Technology Services', 'Electronic Technology'],
  'Health Care': ['Health Technology', 'Health Services'],
  Financials: ['Finance'],
  'Consumer Discretionary': ['Retail Trade', 'Consumer Durables', 'Consumer Services'],
  'Consumer Staples': ['Consumer Non-Durables'],
  Energy: ['Energy Minerals'],
  Industrials: ['Producer Manufacturing', 'Industrial Services', 'Transportation', 'Commercial Services', 'Distribution Services'],
  Materials: ['Non-Energy Minerals', 'Process Industries'],
  Utilities: ['Utilities'],
  'Communication Services': ['Communications'],
}

const f = (left, operation, right) => ({ left, operation, right })
const PRESETS = {
  'most-active':    { label: 'Most traded today', fact: 'The largest companies by shares traded today.', filters: [], sort: ['volume', 'desc'] },
  'unusual-volume': { label: 'Unusual volume', fact: 'Trading at twice its usual volume or more (today against the ten-day average).', filters: [f('relative_volume_10d_calc', 'greater', 2)], sort: ['relative_volume_10d_calc', 'desc'] },
  gainers:          { label: 'Biggest gainers', fact: 'The largest percentage rises today.', filters: [f('change', 'greater', 0)], sort: ['change', 'desc'] },
  losers:           { label: 'Biggest fallers', fact: 'The largest percentage falls today.', filters: [f('change', 'less', 0)], sort: ['change', 'asc'] },
  'new-high':       { label: 'At a 52-week high', fact: 'Within 2% of the highest price of the past year, among the 180 strongest of the last month.', filters: [], sort: ['Perf.1M', 'desc'], keep: r => r.high52 > 0 && r.close >= r.high52 * 0.98 },
  oversold:         { label: 'RSI under 30', fact: 'A 14-day RSI below 30 — fallen fast, by one common measure.', filters: [f('RSI', 'less', 30)], sort: ['RSI', 'asc'] },
}

class TvScannerError extends Error {}

const enabled = (env = process.env) => env.TV_SCANNER_ENABLED === 'true'

/** The request body for a preset. Pure. */
function buildQuery(preset, { sector = null, minCap = 2e9, limit = 60 } = {}) {
  const p = PRESETS[preset]
  if (!p) throw new TvScannerError(`unknown screen "${preset}"`)
  const filter = [
    f('type', 'equal', 'stock'),
    f('exchange', 'in_range', ['NASDAQ', 'NYSE', 'AMEX']),
    f('is_primary', 'equal', true),
    f('market_cap_basic', 'greater', minCap),
    ...p.filters,
  ]
  if (sector) {
    if (!SECTORS[sector]) throw new TvScannerError(`unknown sector "${sector}"`)
    filter.push(f('sector', 'in_range', SECTORS[sector]))
  }
  // "At a 52-week high" is filtered here after the fact, so ask for more rows than are kept.
  const n = Math.min(MAX_ROWS, Math.max(1, Math.round(limit) || 60)) * (p.keep ? 3 : 1)
  return { filter, columns: COLUMNS, sort: { sortBy: p.sort[0], sortOrder: p.sort[1] }, range: [0, Math.min(300, n)], markets: ['america'], options: { lang: 'en' } }
}

const num = v => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const gicsOf = tv => Object.keys(SECTORS).find(g => SECTORS[g].includes(tv)) || null

/** The scanner's answer → clean rows. Tolerant: a row it cannot read is dropped, not guessed. Pure. */
function parseRows(json, { preset = null, limit = 60 } = {}) {
  if (!json || !Array.isArray(json.data)) throw new TvScannerError('the scanner answered in a shape this app does not recognise')
  const keep = PRESETS[preset]?.keep
  const out = [], seen = new Set()
  for (const row of json.data) {
    const d = row?.d
    if (!Array.isArray(d) || d.length < COLUMNS.length) continue
    const c = Object.fromEntries(COLUMNS.map((k, i) => [k, d[i]]))
    const symbol = String(c.name || '').toUpperCase()
    if (!PLAIN.test(symbol) || seen.has(symbol)) continue
    if (Array.isArray(c.typespecs) && c.typespecs.length && !c.typespecs.includes('common')) continue   // no preferreds, units, notes
    const r = {
      symbol, name: typeof c.description === 'string' ? c.description.slice(0, 80) : null,
      close: num(c.close), changePct: num(c.change), volume: num(c.volume), relVolume: num(c.relative_volume_10d_calc),
      marketCap: num(c.market_cap_basic), sector: gicsOf(c.sector), tvSector: typeof c.sector === 'string' ? c.sector : null,
      sma200: num(c.SMA200), rsi: num(c.RSI), perf1m: num(c['Perf.1M']), high52: num(c.price_52_week_high),
    }
    if (!(r.close > 0)) continue
    if (keep && !keep(r)) continue
    seen.add(symbol)
    out.push(r)
    if (out.length >= limit) break
  }
  return out
}

const _cache = new Map()

/**
 * Run one preset. Throws TvScannerError when switched off, refused or unreadable —
 * the caller decides what to fall back to.
 */
async function scan(preset, { sector = null, minCap = 2e9, limit = 60, fetchImpl = fetch, now = Date.now(), env = process.env } = {}) {
  if (!enabled(env)) throw new TvScannerError('the TradingView scanner is switched off')
  const key = `${preset}|${sector || '*'}|${minCap}|${limit}`
  const hit = _cache.get(key)
  if (hit && now - hit.at < TTL_MS) return { ...hit.value, cached: true }
  const body = buildQuery(preset, { sector, minCap, limit })
  let res
  try {
    res = await fetchImpl(URL_US, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json', 'user-agent': 'Mozilla/5.0' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(12_000),
    })
  } catch (e) { throw new TvScannerError(`the scanner could not be reached (${e.name === 'TimeoutError' ? 'timed out' : e.message})`) }
  if (!res.ok) throw new TvScannerError(`the scanner refused the request (HTTP ${res.status})`)
  let json
  try { json = await res.json() } catch { throw new TvScannerError('the scanner did not answer with JSON') }
  const value = { preset, sector, rows: parseRows(json, { preset, limit }), total: num(json.totalCount), at: new Date(now).toISOString() }
  _cache.set(key, { at: now, value })
  if (_cache.size > 60) _cache.delete(_cache.keys().next().value)
  return { ...value, cached: false }
}

/** Symbols only, or [] on any failure — for callers that use the scanner as one fallback among several. */
async function symbolsFor(preset, opts = {}) {
  try { return (await scan(preset, opts)).rows.map(r => r.symbol) } catch { return [] }
}

const presetList = () => Object.entries(PRESETS).map(([id, p]) => ({ id, label: p.label, fact: p.fact }))

module.exports = { enabled, scan, symbolsFor, buildQuery, parseRows, presetList, PRESETS, SECTORS, COLUMNS, TTL_MS, TvScannerError, _resetForTests: () => _cache.clear() }
