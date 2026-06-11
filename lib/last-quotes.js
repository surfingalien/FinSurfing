'use strict'

/**
 * lib/last-quotes.js
 *
 * Durable last-known quote store — the final fallback of the /api/quote
 * provider cascade. Unlike the in-process TTL cache (wiped on every Railway
 * deploy, expires in seconds), this persists slim quotes to
 * data/last-quotes.json so a symbol whose providers are all failing still
 * returns its last real price (flagged stale) instead of null.
 *
 * Complements the browser-side fallback in src/hooks/usePortfolio.js
 * (finsurf_last_quotes): this one helps every client, including ones that
 * have never priced the symbol before.
 */

const fs   = require('fs')
const path = require('path')

const DATA_DIR = path.join(__dirname, '..', 'data')
let   FILE     = path.join(DATA_DIR, 'last-quotes.json')

const MAX_ENTRIES   = 2_000
const FLUSH_MS      = 60_000

let _store  = null      // Map symbol → slim quote (+ savedAt)
let _dirty  = false
let _timer  = null

function _load() {
  if (_store) return
  _store = new Map()
  try {
    const j = JSON.parse(fs.readFileSync(FILE, 'utf8'))
    for (const [sym, q] of Object.entries(j)) _store.set(sym, q)
  } catch { /* first boot or unreadable — start empty */ }
}

function _flush() {
  if (!_dirty || !_store) return
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(FILE, JSON.stringify(Object.fromEntries(_store)))
    _dirty = false
  } catch (e) { console.warn('[last-quotes] flush failed:', e.message) }
}

function _ensureTimer() {
  if (_timer) return
  _timer = setInterval(_flush, FLUSH_MS)
  if (_timer.unref) _timer.unref()   // never keep the process alive
}

/**
 * Record any quotes that carry a real price. Quotes flagged `stale` (i.e.
 * recalled from this store) are skipped so savedAt stays honest.
 */
function record(quotes) {
  if (!Array.isArray(quotes) || !quotes.length) return
  _load(); _ensureTimer()
  for (const q of quotes) {
    if (!q?.symbol || q.regularMarketPrice == null || q.stale) continue
    // Re-insert to keep Map ordered oldest-first for eviction
    _store.delete(q.symbol)
    _store.set(q.symbol, {
      symbol:    q.symbol,
      shortName: q.shortName || q.longName || q.name || q.symbol,
      regularMarketPrice:          q.regularMarketPrice,
      regularMarketPreviousClose:  q.regularMarketPreviousClose ?? null,
      regularMarketChange:         q.regularMarketChange ?? null,
      regularMarketChangePercent:  q.regularMarketChangePercent ?? null,
      regularMarketTime:           q.regularMarketTime ?? null,
      savedAt: Date.now(),
    })
  }
  while (_store.size > MAX_ENTRIES) {
    const oldest = _store.keys().next().value
    _store.delete(oldest)
  }
  _dirty = true
}

/**
 * Last known quote for a symbol, flagged stale, or null if never seen.
 */
function recall(symbol) {
  if (!symbol) return null
  _load()
  const q = _store.get(symbol)
  return q ? { ...q, stale: true } : null
}

function size() { _load(); return _store.size }

// Test hooks: redirect the file and reset in-memory state.
function _setFileForTests(p) { FILE = p; _store = null; _dirty = false }
function _flushForTests() { _flush() }

module.exports = { record, recall, size, MAX_ENTRIES, _setFileForTests, _flushForTests }
