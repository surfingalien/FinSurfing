'use strict'

/**
 * lib/last-quotes.js
 *
 * Durable last-known quote store — the final fallback of the /api/quote
 * provider cascade. When every provider fails for a symbol, this returns its
 * last real price (flagged stale) instead of null.
 *
 * Storage:
 *   - Postgres `last_quotes` table when DATABASE_URL is set. Railway's
 *     filesystem is ephemeral, so the previous data/last-quotes.json store was
 *     wiped on every deploy — which collapsed Total P&L to a partial number
 *     until quotes slowly backfilled. The DB survives deploys.
 *   - data/last-quotes.json otherwise (local / no-DB mode).
 *
 * The in-memory Map is always the read path so recall() stays SYNCHRONOUS for
 * the inline provider cascade. Postgres is hydrated into the Map on boot
 * (hydrate()) and written back on a 60s flush; disk uses the same flush.
 *
 * Complements the browser-side fallback in src/hooks/usePortfolio.js
 * (finsurf_last_quotes): this one helps every client, including ones that have
 * never priced the symbol before.
 */

const fs   = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, '..', 'data')
let   FILE     = path.join(DATA_DIR, 'last-quotes.json')

const MAX_ENTRIES = 2_000
const FLUSH_MS    = 60_000

let _store     = null         // Map symbol → slim quote (+ savedAt)
let _dirty     = false        // disk flush needed
let _upserts   = new Set()    // symbols changed since the last DB flush
let _evictions = new Set()    // symbols evicted since the last DB flush
let _timer     = null
let _forceDisk = false        // tests pin to disk regardless of env

function _useDb() {
  return !_forceDisk && !!process.env.DATABASE_URL
}

function _emptyStore() { _store = new Map() }

function _loadDisk() {
  if (_store) return
  _emptyStore()
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    for (const [sym, q] of Object.entries(j)) _store.set(sym, q)
  } catch { /* first boot or unreadable — start empty */ }
}

// Synchronously guarantee the store exists for the read path. With a DB,
// hydrate() populates it on boot; a recall that lands before hydration starts
// empty (returns null) rather than blocking — the next flush/hydrate fills in.
function _ensureLoaded() {
  if (_store) return
  if (_useDb()) _emptyStore()   // DB rows arrive via hydrate(); don't read disk
  else _loadDisk()
}

function _slim(q) {
  return {
    symbol:    q.symbol,
    shortName: q.shortName || q.longName || q.name || q.symbol,
    regularMarketPrice:          q.regularMarketPrice,
    regularMarketPreviousClose:  q.regularMarketPreviousClose ?? null,
    regularMarketChange:         q.regularMarketChange ?? null,
    regularMarketChangePercent:  q.regularMarketChangePercent ?? null,
    regularMarketTime:           q.regularMarketTime ?? null,
    savedAt: Date.now(),
  }
}

function _ensureTimer() {
  if (_timer) return
  _timer = setInterval(_flush, FLUSH_MS)
  if (_timer.unref) _timer.unref()   // never keep the process alive
}

// ── Persistence ───────────────────────────────────────────────────────────────

/**
 * Load persisted quotes into memory. Call once on boot, AFTER the schema
 * migration has created the table. Async only because Postgres is; falls back
 * to disk on any DB error so a flaky DB never leaves the cache empty.
 * Ordered oldest-first so Map insertion order drives MAX_ENTRIES eviction.
 */
async function hydrate() {
  if (_useDb()) {
    try {
      const { query } = require('../db/db')
      const { rows } = await query(
        `SELECT symbol, short_name, price, prev_close, change, change_pct, market_time, saved_at
           FROM last_quotes
          ORDER BY saved_at ASC`
      )
      _emptyStore()
      for (const r of rows) {
        _store.set(r.symbol, {
          symbol:    r.symbol,
          shortName: r.short_name || r.symbol,
          regularMarketPrice:         Number(r.price),
          regularMarketPreviousClose: r.prev_close  == null ? null : Number(r.prev_close),
          regularMarketChange:        r.change      == null ? null : Number(r.change),
          regularMarketChangePercent: r.change_pct  == null ? null : Number(r.change_pct),
          regularMarketTime:          r.market_time == null ? null : Number(r.market_time),
          savedAt:   Number(r.saved_at),
        })
      }
      _ensureTimer()
      return _store.size
    } catch (e) {
      console.warn('[last-quotes] DB hydrate failed, falling back to disk:', e.message)
    }
  }
  _loadDisk(); _ensureTimer()
  return _store.size
}

function _flushDisk() {
  if (!_dirty || !_store) return
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(_store)))
    _dirty = false
  } catch (e) { console.warn('[last-quotes] disk flush failed:', e.message) }
}

async function _flushDb() {
  if (!_upserts.size && !_evictions.size) return
  const ups = [..._upserts];   _upserts   = new Set()
  const evs = [..._evictions]; _evictions = new Set()
  try {
    const { query } = require('../db/db')
    for (const sym of ups) {
      const q = _store.get(sym)
      if (!q) continue
      await query(
        `INSERT INTO last_quotes
           (symbol, short_name, price, prev_close, change, change_pct, market_time, saved_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (symbol) DO UPDATE SET
           short_name = $2, price = $3, prev_close = $4, change = $5,
           change_pct = $6, market_time = $7, saved_at = $8`,
        [sym, q.shortName, q.regularMarketPrice, q.regularMarketPreviousClose,
         q.regularMarketChange, q.regularMarketChangePercent, q.regularMarketTime, q.savedAt]
      )
    }
    if (evs.length) await query('DELETE FROM last_quotes WHERE symbol = ANY($1)', [evs])
  } catch (e) {
    console.warn('[last-quotes] DB flush failed:', e.message)
    for (const s of ups) _upserts.add(s)     // re-queue for the next tick
    for (const s of evs) _evictions.add(s)
  }
}

function _flush() {
  if (_useDb()) _flushDb().catch(() => {})
  else _flushDisk()
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Record any quotes that carry a real price. Quotes flagged `stale` (i.e.
 * recalled from this store) are skipped so savedAt stays honest.
 */
function record(quotes) {
  if (!Array.isArray(quotes) || !quotes.length) return
  _ensureLoaded(); _ensureTimer()
  for (const q of quotes) {
    if (!q?.symbol || q.regularMarketPrice == null || q.stale) continue
    // Re-insert to keep Map ordered oldest-first for eviction
    _store.delete(q.symbol)
    _store.set(q.symbol, _slim(q))
    _dirty = true
    _upserts.add(q.symbol)
    _evictions.delete(q.symbol)
  }
  while (_store.size > MAX_ENTRIES) {
    const oldest = _store.keys().next().value
    _store.delete(oldest)
    _upserts.delete(oldest)
    _evictions.add(oldest)
  }
}

/**
 * Last known quote for a symbol, flagged stale, or null if never seen.
 */
function recall(symbol) {
  if (!symbol) return null
  _ensureLoaded()
  const q = _store.get(symbol)
  return q ? { ...q, stale: true } : null
}

function size() { _ensureLoaded(); return _store.size }

// Test hooks: pin to disk, redirect the file, and reset in-memory state.
function _setFileForTests(p) {
  FILE = p; _forceDisk = true
  _store = null; _dirty = false
  _upserts = new Set(); _evictions = new Set()
}
function _flushForTests() { _flushDisk() }

module.exports = { record, recall, size, hydrate, MAX_ENTRIES, _setFileForTests, _flushForTests }
