'use strict'
/**
 * Discovery sources — names a scan should look at because of how they moved
 * against their own peers, not because they were loud today.
 *
 * Movers find what everyone already sees. These two sources find the quieter
 * thing the Quant Lab measures:
 *
 *   dislocation — a stock whose last five sessions fell well below what its
 *     sector's common factors explain (PCA residual z ≤ −Z_MIN over a 120-day
 *     window, lib/quant/strategies.statArbPca). Lagging its peers for no
 *     factor reason is a candidate, not a signal.
 *   pair — two stocks that tracked each other over the FORMATION window
 *     (Engle–Granger cointegrated, and the spread rule made money out of
 *     sample afterwards), whose spread is now ≥ Z_MIN standard deviations
 *     wide. The cheap leg is the candidate. Testing every pair in a pool of
 *     20 is 190 tests, so ~10 pass at 5% by luck: the out-of-sample filter is
 *     the guard, and the expected false positives are reported with the list.
 *
 * Both are long-side only (the app does not short): the RICH side is listed
 * for context and never enters a scan. Computed by a job after the close from
 * each sector's most-traded names; a scan adds a few, labelled with why.
 * Whatever enters still faces every gate a mover does.
 *
 * Pure except the store I/O and the refresh. Tests: tests/discovery-sources.test.js
 */

const path = require('path')
const S = require('./quant/strategies')

const Z_MIN = 2
const MAX_AGE_MS = 4 * 24 * 3600 * 1000     // a long weekend
const POOL_CAP = 20

/** Names lagging what their sector's factors explain. */
function findDislocations(barsBySymbol, { zMin = Z_MIN } = {}) {
  const n = Object.keys(barsBySymbol || {}).length
  if (n < 6) return { cheap: [], rich: [] }
  try {
    const res = S.statArbPca(barsBySymbol, { k: n >= 12 ? 2 : 1, window: 120, holding: 5 })
    const pick = s => ({ symbol: s.symbol, residualZ: +s.residualZ.toFixed(2), factorR2: +s.factorR2.toFixed(2) })
    return {
      cheap: res.signals.filter(s => s.residualZ <= -zMin).map(pick),
      rich:  res.signals.filter(s => s.residualZ >= zMin).map(pick),
    }
  } catch { return { cheap: [], rich: [] } }
}

/** Cointegrated pairs (formation) that also traded profitably out of sample and are now stretched. */
function findPairDivergences(barsBySymbol, { zMin = Z_MIN } = {}) {
  const syms = Object.keys(barsBySymbol || {})
  if (syms.length < 2) return { pairs: [], tested: 0, expectedFalsePositives: 0 }
  const res = S.screenPairs(barsBySymbol)
  const pairs = res.pairs
    .filter(p => p.cointegrated && p.oosSharpe > 0 && p.trades > 0 && Math.abs(p.currentZ) >= zMin)
    .map(p => {
      // spread = ln y − (α + β ln x): wide (z > 0) means y rich / x cheap
      const cheap = p.currentZ > 0 ? p.x : p.y, rich = p.currentZ > 0 ? p.y : p.x
      return { cheap, rich, z: +p.currentZ.toFixed(2), halfLifeDays: p.halfLife != null ? +Number(p.halfLife).toFixed(1) : null, oosSharpe: +p.oosSharpe.toFixed(2) }
    })
    .sort((a, b) => Math.abs(b.z) - Math.abs(a.z))
  return { pairs, tested: res.pairsTested, cointegrated: res.cointegrated, expectedFalsePositives: res.expectedFalsePositives }
}

/** One sector's discovery result from its pool's bars. */
function discoverSector(barsBySymbol, opts = {}) {
  const d = findDislocations(barsBySymbol, opts), p = findPairDivergences(barsBySymbol, opts)
  return { names: Object.keys(barsBySymbol).length, dislocations: d.cheap, richVsPeers: d.rich, pairs: p.pairs, pairsTested: p.tested, pairsCointegrated: p.cointegrated ?? 0, expectedFalsePositives: p.expectedFalsePositives }
}

/**
 * Candidates for a scan of `sector` (null = every sector) from a fresh store,
 * each with the reason it is there. Stale stores give nothing.
 */
function candidatesFor(store, sector = null, { now = Date.now(), max = 4 } = {}) {
  if (!store?.at || now - Date.parse(store.at) > MAX_AGE_MS) return []
  const sectors = sector ? [sector] : Object.keys(store.sectors || {})
  const out = [], seen = new Set()
  const push = (symbol, source, why) => { if (!seen.has(symbol)) { seen.add(symbol); out.push({ symbol, source, why }) } }
  for (const sec of sectors) {
    const s = store.sectors?.[sec]
    if (!s) continue
    for (const d of s.dislocations || []) push(d.symbol, 'dislocation', `${d.residualZ}σ behind ${sec} peers over 5 sessions`)
    for (const p of s.pairs || []) push(p.cheap, 'pair', `spread with ${p.rich} at ${p.z}σ (cointegrated, held out of sample)`)
  }
  // Interleave by strength is overkill; the lists are already ordered. Cap.
  return out.slice(0, max)
}

// ── Refresh (job) ─────────────────────────────────────────────────────────────

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length); let i = 0
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k]) }
  }))
  return out
}

/**
 * @param {object} o
 * @param {Object<string,string[]>} o.pools   sector → most-traded names
 * @param {(sym:string)=>Promise<Array>} o.fetchBars  one year of daily bars
 */
async function refreshDiscovery({ pools, fetchBars, now = new Date(), concurrency = 3 }) {
  const sectors = {}
  let fetched = 0
  for (const [sector, names] of Object.entries(pools || {})) {
    const list = [...new Set(names)].slice(0, POOL_CAP)
    const bars = await mapLimit(list, concurrency, s => fetchBars(s).catch(() => []))
    const bySym = {}
    list.forEach((s, k) => { if (bars[k]?.length >= 150) bySym[s] = bars[k] })
    fetched += Object.keys(bySym).length
    sectors[sector] = discoverSector(bySym)
  }
  if (fetched < 20) throw new Error(`only ${fetched} names had a year of bars — keeping the stored discovery lists`)
  return { at: now.toISOString(), zMin: Z_MIN, sectors }
}

const STORE_FILE = path.join(require('./data-dir').DATA_DIR, 'discovery.json')
function loadStore(file = STORE_FILE) { try { return JSON.parse(require('fs').readFileSync(file, 'utf8')) } catch { return null } }
function saveStore(store, file = STORE_FILE) {
  require('fs').mkdirSync(path.dirname(file), { recursive: true })
  require('./atomic-write').writeJsonAtomic(file, store)
}

module.exports = { Z_MIN, POOL_CAP, findDislocations, findPairDivergences, discoverSector, candidatesFor, refreshDiscovery, loadStore, saveStore, STORE_FILE }
