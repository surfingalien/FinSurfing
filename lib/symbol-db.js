'use strict'

/**
 * lib/symbol-db.js
 *
 * Symbol classification + universe construction backed by the community
 * FinanceDatabase (https://github.com/JerBouma/FinanceDatabase) — 300k+
 * symbols with sector / industry / category / market-cap metadata, served
 * as plain CSVs from raw.githubusercontent.com and updated weekly upstream.
 *
 * Design:
 *   - refresh() downloads the per-asset-class CSVs, projects each row to a
 *     slim record (no summaries), and persists the result to
 *     data/symbol-db.json so restarts don't re-download.
 *   - All queries are served from in-memory indexes; first query lazily
 *     loads the persisted snapshot if present.
 *   - Equities are filtered to SYMBOL_DB_COUNTRIES (default United States,
 *     'ALL' disables the filter) to bound memory; other classes keep all rows.
 *   - Read paths never hit the network. No external deps.
 *
 * This complements (does not replace) the hardcoded fast paths in
 * lib/crypto-classify.js and server.js — callers can use classify() as an
 * enrichment / fallback layer.
 */

const fs   = require('fs')
const path = require('path')

const DATA_DIR  = path.join(__dirname, '..', 'data')
const DB_FILE   = path.join(DATA_DIR, 'symbol-db.json')
const RAW_BASE  = 'https://raw.githubusercontent.com/JerBouma/FinanceDatabase/main/database'

const SOURCES = {
  equity: `${RAW_BASE}/equities.csv`,
  etf:    `${RAW_BASE}/etfs.csv`,
  fund:   `${RAW_BASE}/funds.csv`,
  crypto: `${RAW_BASE}/cryptos.csv`,
}

const CAP_RANK = { 'Mega Cap': 6, 'Large Cap': 5, 'Mid Cap': 4, 'Small Cap': 3, 'Micro Cap': 2, 'Nano Cap': 1 }

function allowedCountries() {
  const raw = (process.env.SYMBOL_DB_COUNTRIES || 'United States').trim()
  if (raw.toUpperCase() === 'ALL') return null
  return new Set(raw.split(',').map(s => s.trim()).filter(Boolean))
}

// ── CSV parsing (RFC-4180-ish: quoted fields, escaped quotes, embedded
//    commas/newlines, CRLF). Returns array of string arrays. ─────────────────
function parseCsv(text) {
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++ }
        else inQuotes = false
      } else field += c
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      row.push(field); field = ''
    } else if (c === '\n') {
      row.push(field); field = ''
      rows.push(row); row = []
    } else if (c !== '\r') {
      field += c
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row) }
  return rows
}

// ── Row projection: header-driven so upstream column reordering is safe ──────
function headerIndex(header) {
  const idx = {}
  header.forEach((h, i) => { idx[h.trim().toLowerCase()] = i })
  return idx
}

function projectRow(assetClass, idx, row, countries) {
  const get = name => { const i = idx[name]; return i === undefined ? '' : (row[i] || '').trim() }
  const symbol = get('symbol').toUpperCase()
  if (!symbol) return null

  if (assetClass === 'equity') {
    const country = get('country')
    if (countries && !countries.has(country)) return null
    return {
      symbol,
      name:      get('name'),
      sector:    get('sector'),
      industry:  get('industry'),
      country,
      marketCap: get('market_cap'),
    }
  }
  if (assetClass === 'etf' || assetClass === 'fund') {
    return {
      symbol,
      name:          get('name'),
      categoryGroup: get('category_group'),
      category:      get('category'),
      family:        get('family'),
    }
  }
  if (assetClass === 'crypto') {
    return {
      symbol,
      name: get('name'),
      base: get('cryptocurrency').toUpperCase() || symbol.replace(/-[A-Z]{3,4}$/, ''),
    }
  }
  return null
}

// Parse a full CSV text into slim records for one asset class.
function buildClass(assetClass, csvText, countries = allowedCountries()) {
  const rows = parseCsv(csvText)
  if (rows.length < 2) return []
  const idx = headerIndex(rows[0])
  const out = []
  for (let i = 1; i < rows.length; i++) {
    const rec = projectRow(assetClass, idx, rows[i], countries)
    if (rec) out.push(rec)
  }
  return out
}

// ── Store ─────────────────────────────────────────────────────────────────────
// _store: { fetchedAt, classes: { equity: [...], etf: [...], fund: [...], crypto: [...] } }
let _store  = null
let _index  = null   // Map upperSymbol → { assetClass, ...record } (first match wins: equity > etf > fund > crypto)
let _refreshing = null

function buildIndex(store) {
  const index = new Map()
  for (const assetClass of ['equity', 'etf', 'fund', 'crypto']) {
    for (const rec of store.classes[assetClass] || []) {
      if (!index.has(rec.symbol)) index.set(rec.symbol, { assetClass, ...rec })
      if (assetClass === 'crypto' && rec.base && !index.has(rec.base)) {
        index.set(rec.base, { assetClass, ...rec })
      }
    }
  }
  return index
}

function setStore(store) {
  _store = store
  _index = buildIndex(store)
}

function ensureLoaded() {
  if (_store) return true
  try {
    const raw = fs.readFileSync(DB_FILE, 'utf8')
    setStore(JSON.parse(raw))
    return true
  } catch { return false }
}

function persist() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(DB_FILE, JSON.stringify(_store))
  } catch (e) {
    console.warn('[symbol-db] persist failed:', e.message)
  }
}

// ── Refresh: download + rebuild. Concurrent callers share one in-flight run. ──
async function refresh({ classes = Object.keys(SOURCES), timeoutMs = 120_000 } = {}) {
  if (_refreshing) return _refreshing
  _refreshing = (async () => {
    const countries = allowedCountries()
    const next = { fetchedAt: new Date().toISOString(), classes: {} }
    for (const assetClass of classes) {
      const url = SOURCES[assetClass]
      if (!url) continue
      try {
        const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const text = await res.text()
        next.classes[assetClass] = buildClass(assetClass, text, countries)
        console.log(`[symbol-db] ${assetClass}: ${next.classes[assetClass].length} records`)
      } catch (e) {
        // Keep the previous snapshot for a class that fails to download
        next.classes[assetClass] = _store?.classes?.[assetClass] || []
        console.warn(`[symbol-db] ${assetClass} refresh failed (${e.message}) — kept ${next.classes[assetClass].length} cached records`)
      }
    }
    setStore(next)
    persist()
    return stats()
  })()
  try { return await _refreshing } finally { _refreshing = null }
}

// ── Queries ───────────────────────────────────────────────────────────────────
function classify(symbol) {
  if (!symbol || !ensureLoaded()) return null
  const s = symbol.toUpperCase().trim()
  return _index.get(s)
    || _index.get(s.replace(/-[A-Z]{3,4}$/, ''))   // BTC-USD → BTC
    || null
}

function search(q, limit = 20) {
  if (!q || !ensureLoaded()) return []
  const needle = q.toUpperCase().trim()
  if (!needle) return []
  const scored = []
  for (const rec of _index.values()) {
    let score = 0
    if (rec.symbol === needle) score = 4
    else if (rec.symbol.startsWith(needle)) score = 3
    else if (rec.symbol.includes(needle)) score = 2
    else if (rec.name && rec.name.toUpperCase().includes(needle)) score = 1
    if (score) scored.push({ score, rec })
  }
  scored.sort((a, b) => b.score - a.score || a.rec.symbol.length - b.rec.symbol.length)
  return scored.slice(0, limit).map(x => x.rec)
}

function listSectors() {
  if (!ensureLoaded()) return []
  const counts = {}
  for (const rec of _store.classes.equity || []) {
    if (rec.sector) counts[rec.sector] = (counts[rec.sector] || 0) + 1
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([sector, count]) => ({ sector, count }))
}

// Top-N equities in a sector, largest cap buckets first, alphabetical within.
function sectorUniverse(sector, { size = 25, minCap = 'Mid Cap' } = {}) {
  if (!sector || !ensureLoaded()) return []
  const minRank = CAP_RANK[minCap] ?? 4
  const want = sector.toLowerCase()
  return (_store.classes.equity || [])
    .filter(r => r.sector.toLowerCase() === want && (CAP_RANK[r.marketCap] || 0) >= minRank)
    .sort((a, b) => (CAP_RANK[b.marketCap] || 0) - (CAP_RANK[a.marketCap] || 0) || a.symbol.localeCompare(b.symbol))
    .slice(0, size)
    .map(r => r.symbol)
}

function stats() {
  if (!ensureLoaded()) return { loaded: false }
  const counts = {}
  for (const [cls, arr] of Object.entries(_store.classes)) counts[cls] = arr.length
  return { loaded: true, fetchedAt: _store.fetchedAt, counts }
}

// Test hook: inject a store without touching disk or network.
function _setStoreForTests(store) { setStore(store) }

module.exports = {
  parseCsv, buildClass,
  refresh, classify, search, listSectors, sectorUniverse, stats,
  _setStoreForTests,
}
