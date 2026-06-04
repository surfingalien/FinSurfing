'use strict'
/**
 * lib/questdb.js
 * QuestDB integration for persistent tick storage.
 *
 * Falls back gracefully when QUESTDB_URL is not configured (same pattern
 * as DATABASE_URL → in-memory fallback). All public functions are no-ops
 * when disabled — callers don't need to check.
 *
 * Env vars:
 *   QUESTDB_URL  e.g. http://localhost:9000  (HTTP REST + ILP endpoint)
 *
 * QuestDB ports (default):
 *   9000 — HTTP (REST exec + ILP /write)
 *   8812 — Postgres wire (not used here)
 *   9009 — ILP TCP (not used here; we use HTTP ILP)
 */

const QUESTDB_URL = (process.env.QUESTDB_URL || '').replace(/\/$/, '') || null

let _enabled   = !!QUESTDB_URL
let _failCount = 0
const MAX_FAIL = 5

// ── Table schema ──────────────────────────────────────────────────────────────
const CREATE_TICKS = `
CREATE TABLE IF NOT EXISTS ticks (
  ts        TIMESTAMP,
  symbol    SYMBOL   CAPACITY 500 CACHE INDEX,
  price     DOUBLE,
  change    DOUBLE,
  change_pct DOUBLE,
  source    SYMBOL   CAPACITY 10  CACHE
) TIMESTAMP(ts) PARTITION BY HOUR WAL DEDUP UPSERT KEYS(ts, symbol);
`.trim()

// ── HTTP helpers ──────────────────────────────────────────────────────────────
async function _exec(sql) {
  const r = await fetch(`${QUESTDB_URL}/exec?count=true&query=${encodeURIComponent(sql)}`, {
    signal: AbortSignal.timeout(8000),
  })
  if (!r.ok) {
    const body = await r.text().catch(() => '')
    throw new Error(`QuestDB HTTP ${r.status}: ${body.slice(0, 200)}`)
  }
  return r.json()
}

// InfluxDB Line Protocol ingestion — faster than REST for high-frequency writes
async function _ilp(lines) {
  const r = await fetch(`${QUESTDB_URL}/write`, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    body:    lines,
    signal:  AbortSignal.timeout(5000),
  })
  if (!r.ok) throw new Error(`QuestDB ILP HTTP ${r.status}`)
}

// ── Startup: create table if not exists ──────────────────────────────────────
async function init() {
  if (!_enabled) {
    console.log('[QuestDB] QUESTDB_URL not set — tick persistence disabled')
    return
  }
  try {
    await _exec(CREATE_TICKS)
    console.log('[QuestDB] Connected — ticks table ready')
  } catch (e) {
    console.warn('[QuestDB] Init failed:', e.message, '— disabling tick persistence')
    _enabled = false
  }
}

// ── Buffered tick writer ──────────────────────────────────────────────────────
let _buf      = []    // pending ILP lines
let _flushRef = null  // pending flush timer

/**
 * Queue a price tick for async batch insertion.
 * No-op when QuestDB is not configured.
 */
function writeTick(symbol, price, change, changePct, source = 'ws') {
  if (!_enabled || price == null) return

  // ILP line format: measurement,tag=value field=value timestamp_ns
  // QuestDB uses designated-timestamp column (ts) via the ILP timestamp field.
  const ts  = BigInt(Date.now()) * 1_000_000n   // ms → ns
  const sym = symbol.replace(/[, ]/g, '_')       // ILP tag must not contain special chars
  const chg = change    ?? 0
  const pct = changePct ?? 0
  const src = source    || 'ws'

  _buf.push(`ticks,symbol=${sym},source=${src} price=${price},change=${chg},change_pct=${pct} ${ts}`)

  if (!_flushRef) _flushRef = setTimeout(_flush, 100)  // batch every 100 ms
}

async function _flush() {
  _flushRef = null
  if (!_buf.length || !_enabled) return
  const batch = _buf.splice(0, _buf.length)
  try {
    await _ilp(batch.join('\n'))
    _failCount = 0
  } catch (e) {
    _failCount++
    console.warn(`[QuestDB] Write failed (${_failCount}/${MAX_FAIL}):`, e.message)
    if (_failCount >= MAX_FAIL) {
      console.warn('[QuestDB] Too many failures — disabling tick persistence')
      _enabled = false
    }
  }
}

// ── Query functions ───────────────────────────────────────────────────────────

/**
 * Raw ticks for a symbol between fromMs and toMs.
 * Returns [{ ts, price, change, changePct }]
 */
async function queryTicks(symbol, fromMs, toMs, limit = 1000) {
  if (!_enabled) return []
  const sym     = symbol.replace(/'/g, "''")
  const fromMcs = fromMs * 1000   // ms → µs (QuestDB TIMESTAMP in µs)
  const toMcs   = toMs   * 1000
  const sql = `SELECT ts, price, change, change_pct FROM ticks WHERE symbol = '${sym}' AND ts BETWEEN ${fromMcs} AND ${toMcs} ORDER BY ts LIMIT ${Math.min(limit, 50000)}`
  try {
    const d = await _exec(sql)
    return (d.dataset || []).map(([ts, price, change, changePct]) => ({ ts, price, change, changePct }))
  } catch (e) {
    console.warn('[QuestDB] queryTicks failed:', e.message)
    return []
  }
}

/**
 * OHLCV aggregated from stored ticks using QuestDB SAMPLE BY.
 * intervalSec: bucket size in seconds (60 = 1m bars, 3600 = 1h bars)
 * Returns [{ ts, o, h, l, c, v }]  (v = tick count in bucket)
 */
async function queryOHLCV(symbol, intervalSec = 60, fromMs, toMs) {
  if (!_enabled) return []
  const sym    = symbol.replace(/'/g, "''")
  const fromMcs = fromMs * 1000
  const toMcs   = toMs   * 1000
  const sql = `SELECT ts, first(price) o, max(price) h, min(price) l, last(price) c, count() v FROM ticks WHERE symbol = '${sym}' AND ts BETWEEN ${fromMcs} AND ${toMcs} SAMPLE BY ${intervalSec}s FILL(NULL) ORDER BY ts`
  try {
    const d = await _exec(sql)
    return (d.dataset || [])
      .filter(r => r[1] != null)
      .map(([ts, o, h, l, c, v]) => ({ ts, o, h, l, c, v }))
  } catch (e) {
    console.warn('[QuestDB] queryOHLCV failed:', e.message)
    return []
  }
}

/**
 * Latest price for each symbol (useful for reconnect / SSE initial flush).
 * Returns { AAPL: 182.5, BTC-USD: 67000, ... }
 */
async function queryLatestPrices(symbols) {
  if (!_enabled || !symbols.length) return {}
  const list = symbols.map(s => `'${s.replace(/'/g, "''")}'`).join(',')
  const sql = `SELECT symbol, price FROM ticks LATEST ON ts PARTITION BY symbol WHERE symbol IN (${list})`
  try {
    const d = await _exec(sql)
    const out = {}
    for (const [sym, price] of (d.dataset || [])) out[sym] = price
    return out
  } catch (e) {
    console.warn('[QuestDB] queryLatestPrices failed:', e.message)
    return {}
  }
}

module.exports = {
  init,
  writeTick,
  queryTicks,
  queryOHLCV,
  queryLatestPrices,
  get enabled() { return _enabled },
}
