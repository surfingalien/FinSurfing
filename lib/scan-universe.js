'use strict'

/**
 * lib/scan-universe.js — which symbols an AI Brain scan looks at.
 *
 * Every scan mode used to be a fixed list of 20 hand-picked tickers, so every
 * scan analysed the same 20 names no matter what the market did that day, and
 * nothing outside the list could ever be found. Discovery mode builds the list
 * fresh on every run from three sources, in priority order:
 *
 *   1. MOVERS  — today's most-active / biggest-gaining US stocks (live data,
 *                one bulk call), filtered to the scan's sector when known
 *   2. CORE    — a few names from the curated list, preferring ones the
 *                previous scan did NOT cover
 *   3. POOL    — a rotating draw from the sector's large caps (lib/symbol-db)
 *
 * Symbols scanned last time are pushed to the back of every source, so
 * consecutive scans cover different ground while a genuinely moving name can
 * still reappear if slots are left. `fixed` symbols (e.g. SPY/BTC in the broad
 * scan) are always kept as reference points. Every symbol carries its source,
 * so the UI can say why it is in the scan.
 *
 * Whatever this returns still has to pass the live-price check in the route:
 * a symbol with no real current price is dropped, never priced from memory.
 *
 * Pure. Tests: tests/scan-universe.test.js
 */

// Scan modes → FinanceDatabase GICS sector names (lib/symbol-db.js).
const MODE_SECTORS = {
  // legacy aliases, still selectable
  tech:                 'Information Technology',
  finance:              'Financials',
  healthcare:           'Health Care',
  energy:               'Energy',
  stocks_tech:          'Information Technology',
  stocks_finance:       'Financials',
  stocks_healthcare:    'Health Care',
  stocks_energy:        'Energy',
  stocks_consumer_disc: 'Consumer Discretionary',
  stocks_consumer_stap: 'Consumer Staples',
  stocks_industrials:   'Industrials',
  stocks_materials:     'Materials',
  stocks_utilities:     'Utilities',
  stocks_realestate:    'Real Estate',
  stocks_comms:         'Communication Services',
}

// The same sectors in FMP's taxonomy (stock screener `sector=` values), for
// the live sector pool when the local symbol index is not loaded.
const FMP_SECTORS = {
  'Information Technology': 'Technology',
  'Financials':             'Financial Services',
  'Health Care':            'Healthcare',
  'Energy':                 'Energy',
  'Consumer Discretionary': 'Consumer Cyclical',
  'Consumer Staples':       'Consumer Defensive',
  'Industrials':            'Industrials',
  'Materials':              'Basic Materials',
  'Utilities':              'Utilities',
  'Real Estate':            'Real Estate',
  'Communication Services': 'Communication Services',
}

// Modes that discover. ETF / crypto / fund modes keep their curated lists:
// there is no comparable "large caps in this category" pool to draw from.
const DISCOVERY_MODES = new Set(['broad', 'stocks', ...Object.keys(MODE_SECTORS)])

// Reference points always kept in a broad scan.
const BROAD_FIXED = ['SPY', 'QQQ', 'BTC-USD', 'ETH-USD']

/** Deterministic PRNG for a reproducible shuffle given a seed. */
function mulberry32(seed) {
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) | 0
    let t = Math.imul(s ^ (s >>> 15), 1 | s)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function shuffle(arr, rnd) {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

/** A plain US listing a scan can price: 1-5 letters, optional class suffix. */
const isPlainTicker = s => /^[A-Z]{1,5}(\.[A-Z])?$/.test(s)

/**
 * Filter a movers feed ([{symbol, price, ...}]) to liquid, plain tickers,
 * optionally inside one sector. `sectorOf(sym)` returns a GICS sector or null.
 */
function filterMovers(movers, { sector = null, sectorOf = () => null, minPrice = 5 } = {}) {
  const seen = new Set()
  const out = []
  for (const m of movers || []) {
    const sym = String(m?.symbol || '').toUpperCase()
    if (!isPlainTicker(sym) || seen.has(sym)) continue
    if (m.price != null && !(Number(m.price) >= minPrice)) continue
    if (sector && sectorOf(sym) !== sector) continue
    seen.add(sym)
    out.push(sym)
  }
  return out
}

/**
 * @param {object} o
 * @param {string[]} o.curated   the mode's hand-picked list
 * @param {string[]} [o.movers]  today's movers, already filtered, in rank order
 * @param {string[]} [o.pool]    wider candidate pool (sector large caps)
 * @param {string[]} [o.recent]  symbols the previous scan of this mode covered
 * @param {string[]} [o.fixed]   always included
 * @param {number}   [o.size]
 * @param {number}   [o.seed]
 * @returns {{ symbols: string[], sources: Object<string,string> }}
 */
function buildScanUniverse({
  curated = [], movers = [], pool = [], recent = [], fixed = [],
  size = 20, seed = Date.now(), maxMovers = 8, maxCore = 5,
}) {
  const rnd = mulberry32(seed)
  const recentSet = new Set(recent)
  const chosen = []
  const sources = {}
  const take = (sym, src) => {
    if (chosen.length >= size || sources[sym]) return false
    chosen.push(sym); sources[sym] = src
    return true
  }
  // Fresh names first, names from the last scan only as a fallback.
  const freshFirst = list => [...list.filter(s => !recentSet.has(s)), ...list.filter(s => recentSet.has(s))]

  for (const s of fixed) take(s, 'fixed')

  let n = 0
  for (const s of freshFirst(movers)) { if (n >= maxMovers) break; if (take(s, 'mover')) n++ }

  n = 0
  for (const s of freshFirst(shuffle(curated, rnd))) { if (n >= maxCore) break; if (take(s, 'core')) n++ }

  for (const s of freshFirst(shuffle(pool, rnd))) take(s, 'pool')

  // A thin pool (index not loaded yet) must not shrink the scan: top up from
  // the rest of the curated list, then from last scan's names.
  for (const s of freshFirst(shuffle(curated, rnd))) take(s, 'core')

  return { symbols: chosen, sources }
}

module.exports = { MODE_SECTORS, FMP_SECTORS, DISCOVERY_MODES, BROAD_FIXED, filterMovers, buildScanUniverse, isPlainTicker }
