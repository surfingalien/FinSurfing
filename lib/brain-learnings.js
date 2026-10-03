'use strict'
/**
 * lib/brain-learnings.js
 *
 * Self-improvement loop for the AI Brain.
 *
 * Flow (runs nightly via scheduled-jobs.js):
 *   1. resolveOutcomes()  — resolve predictions made 7/30d ago against the
 *                           HISTORICAL daily bar closest to exactly +7/+30 days
 *                           (not "whenever the job happened to run"), record
 *                           whether price ever entered the entry zone (a fill
 *                           that never happened is not a win), and record the
 *                           benchmark return (SPY for equities, BTC for crypto)
 *                           over the same window so wins are benchmark-relative
 *   2. runMetaAnalysis()  — stats (win rates, alpha, calibration by confidence)
 *                           are computed deterministically in code; Claude only
 *                           interprets them and writes structured learnings
 *   3. getLearningsBlock() — returns a prompt-injection string with the latest
 *                            learnings for use in the AI Brain system prompt
 *
 * Storage:
 *   data/ai-brain-predictions.jsonl  — append-only prediction log (existing)
 *   data/brain-learnings.json        — latest meta-analysis output (overwritten)
 */

const fs      = require('fs')
const atomic = require('./atomic-write')
const path    = require('path')
const Anthropic = require('@anthropic-ai/sdk')
const { fetchDailyBars: fetchBarsInternal } = require('./internal-api')
const exitQuality = require('./exit-quality')
const learningHealthLib = require('./learning-health')
const crypto = require('crypto')
const { parseAiJson } = require('./ai-json')
const { wilson, validateThreshold } = require('./calibration-stats')

// Same file the scanner appends to — one definition, see lib/prediction-log-path.js.
const PRED_LOG       = require('./prediction-log-path').PREDICTION_LOG
const LEARNINGS_FILE = path.join(require('./data-dir').DATA_DIR, 'brain-learnings.json')
// White-box, user-editable overrides layered on top of the AI-written
// learnings. Kept in a SEPARATE file so the nightly meta-analysis (which
// overwrites LEARNINGS_FILE wholesale) never clobbers a human's corrections.
const OVERRIDES_FILE = path.join(require('./data-dir').DATA_DIR, 'brain-learnings-overrides.json')
const DATA_DIR       = require('./data-dir').DATA_DIR

const DAY = 86400 * 1000

// ── Helpers ───────────────────────────────────────────────────────────────────

// The prediction log is the calibration record. Unreadable lines are reported
// (they are MISSING rows, not absent ones), and a rewrite of a damaged file
// first copies it aside — see lib/atomic-write.js.
function readPredictions() {
  return atomic.readJsonl(PRED_LOG)
}

function writePredictions(records) {
  atomic.rewriteJsonl(PRED_LOG, records)
}

// ── White-box editable memory ─────────────────────────────────────────────────
// The AI writes brain-learnings.json every night; users can't correct a wrong
// or stale finding. These helpers layer a human-owned override file on top so
// the memory injected into the next scan is user-correctable, transparently:
//   pinned     — extra learnings the user always wants injected
//   suppressed — AI learnings to drop (exact-string match, case-insensitive)
//   note       — a free-text directive appended to the prompt injection

const EMPTY_OVERRIDES = { pinned: [], suppressed: [], note: '', updatedAt: null }

function readLearnings() {
  try {
    if (!fs.existsSync(LEARNINGS_FILE)) return null
    return JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8'))
  } catch { return null }
}

function readOverrides() {
  try {
    if (!fs.existsSync(OVERRIDES_FILE)) return { ...EMPTY_OVERRIDES }
    const o = JSON.parse(fs.readFileSync(OVERRIDES_FILE, 'utf8'))
    return {
      pinned:     Array.isArray(o.pinned) ? o.pinned.map(String) : [],
      suppressed: Array.isArray(o.suppressed) ? o.suppressed.map(String) : [],
      note:       typeof o.note === 'string' ? o.note : '',
      updatedAt:  o.updatedAt ?? null,
    }
  } catch { return { ...EMPTY_OVERRIDES } }
}

function writeOverrides(patch = {}, { evidence = null, actor = 'human' } = {}) {
  const current = readOverrides()
  const next = {
    pinned:     Array.isArray(patch.pinned) ? patch.pinned.map(String).filter(Boolean).slice(0, 20) : current.pinned,
    suppressed: Array.isArray(patch.suppressed) ? patch.suppressed.map(String).filter(Boolean).slice(0, 50) : current.suppressed,
    note:       typeof patch.note === 'string' ? patch.note.slice(0, 500) : current.note,
    updatedAt:  new Date().toISOString(),
  }
  atomic.writeJsonAtomic(OVERRIDES_FILE, next)
  // Record the edit as a reviewable, revertible refinement (no-op edits are
  // not logged). Never let logging failure break the save itself.
  try {
    require('./memory-refinement').recordRefinement({
      actor, kind: 'overrides', before: current, after: next, evidence,
    })
  } catch (e) { console.warn('[brain-learnings] refinement log failed:', e.message) }
  return next
}

/**
 * Restore the memory state captured by a past refinement. Both the AI's
 * nightly rewrite and human edits are revertible; the revert is itself logged
 * as a refinement (so rolling back is auditable, and a revert can be reverted).
 * Returns { ok, kind, restored } or { ok:false, error }.
 */
function revertRefinement(seq, { reason = null } = {}) {
  const refinement = require('./memory-refinement')
  const found = refinement.snapshotFor(seq)
  if (!found) return { ok: false, error: `No refinement #${seq} found.` }

  const evidence = { reason: reason || `revert of refinement #${seq}`, revertOf: Number(seq) }

  if (found.kind === 'overrides') {
    // Route through writeOverrides so the revert is logged like any other edit.
    const restored = writeOverrides({
      pinned:     found.snapshot.pinned || [],
      suppressed: found.snapshot.suppressed || [],
      note:       found.snapshot.note || '',
    }, { evidence })
    return { ok: true, kind: 'overrides', restored }
  }

  // learnings: write the prior document back verbatim, then log the revert.
  const before = readLearnings() || {}
  const snapshot = found.snapshot || {}
  if (!snapshot.keyLearnings && !snapshot.updatedAt) {
    return { ok: false, error: 'That refinement has no prior learnings state to restore (it was the first one).' }
  }
  try {
    atomic.writeJsonAtomic(LEARNINGS_FILE, snapshot)
  } catch (e) {
    return { ok: false, error: `Could not restore learnings: ${e.message}` }
  }
  try {
    refinement.recordRefinement({ actor: 'human', kind: 'learnings', before, after: snapshot, evidence })
  } catch {}
  return { ok: true, kind: 'learnings', restored: snapshot }
}

// Pure: apply suppress + pin to a raw keyLearnings list. Suppression matches
// on normalized text so a user pasting a learning back verbatim still hits.
function applyOverrides(keyLearnings = [], overrides = EMPTY_OVERRIDES) {
  const norm = s => String(s).trim().toLowerCase()
  const suppressed = new Set((overrides.suppressed || []).map(norm))
  const kept = (keyLearnings || []).filter(l => !suppressed.has(norm(l)))
  const pins = (overrides.pinned || []).filter(Boolean)
  return [...kept, ...pins.map(p => `${p} [pinned]`)]
}

// Fetch daily OHLC bars via the internal market API (shared helper).
function fetchDailyBars(symbol, range = '1y') {
  return fetchBarsInternal(symbol, { range, headers: { 'x-internal': '1' } })
}

// Close of the bar nearest to targetMs, within toleranceDays (handles weekends
// and holidays for equities). Returns null when no bar is close enough.
function nearestClose(bars, targetMs, toleranceDays = 4) {
  if (!bars?.length) return null
  let best = null, bestDist = Infinity
  for (const b of bars) {
    const dist = Math.abs(b.t - targetMs)
    if (dist < bestDist) { bestDist = dist; best = b }
  }
  if (!best || bestDist > toleranceDays * DAY) return null
  return best.c
}

// Did price ever trade inside [zoneLow, zoneHigh] between fromMs and toMs?
// Returns null when the zone is undefined (legacy records), true/false otherwise.
function zoneTouched(bars, fromMs, toMs, zoneLow, zoneHigh) {
  if (zoneLow == null || zoneHigh == null) return null
  if (!bars?.length) return null
  let sawBars = false
  for (const b of bars) {
    if (b.t < fromMs || b.t > toMs) continue
    sawBars = true
    const lo = b.l ?? b.c
    const hi = b.h ?? b.c
    if (lo <= zoneHigh && hi >= zoneLow) return true
  }
  return sawBars ? false : null
}

/**
 * Which barrier did price touch FIRST — the target, the stop, or the clock?
 *
 * Scoring a pick only at its +7/+30d close answers a question nobody asked.
 * A pick that hit its target on day 3 and round-tripped by day 30 is recorded
 * as a loss; one that blew through its stop on day 2 and recovered is recorded
 * as a win. Neither describes what a reader following the recommendation would
 * have lived through, and both distort every rate derived from them.
 *
 * The fixed-horizon return is kept — it is the right measure for alpha vs a
 * benchmark, which is also held for a fixed horizon. This is the second label,
 * not a replacement.
 *
 * @returns {{label:'target'|'stop'|'time', at:number, days:number}|null}
 *          null when the levels are missing/inconsistent or no bars cover the
 *          window — an unscoreable record, never a guessed one.
 */
function tripleBarrier(bars, { from, to, target, stop, long = true } = {}) {
  if (!bars?.length) return null
  if (!(target > 0) || !(stop > 0)) return null
  // A long's target must sit above its stop. Anything else is a mislogged
  // record, not a trade with a barrier to score.
  if (long ? !(target > stop) : !(target < stop)) return null

  let sawBars = false
  for (const b of bars) {
    if (b.t < from || b.t > to) continue
    sawBars = true
    const hi = b.h ?? b.c
    const lo = b.l ?? b.c
    const hitTarget = long ? hi >= target : lo <= target
    const hitStop   = long ? lo <= stop   : hi >= stop
    // Both levels inside one daily bar: the intraday order is unknowable from
    // daily data, so take the loss. Assuming the win would inflate every rate
    // this feeds, in exactly the direction that flatters the system.
    if (hitStop)   return { label: 'stop',   at: b.t, days: Math.max(0, Math.round((b.t - from) / DAY)) }
    if (hitTarget) return { label: 'target', at: b.t, days: Math.max(0, Math.round((b.t - from) / DAY)) }
  }
  // No bars in the window means no data, not a timeout.
  if (!sawBars) return null
  return { label: 'time', at: to, days: Math.round((to - from) / DAY) }
}

// Barrier PRICES for a logged pick. `stopLoss` on the record is a PERCENT
// (the prompt's schema: "stopLoss": 8 means 8% below entry), while
// tripleBarrier() compares prices — passing it straight through asked whether
// a $11.50 coin fell below $8, so a 40% crash on day 3 read as 'time'. Prefer
// the logged stop-zone price; derive from the percent for older records. The
// anchor is the entry the zones were built from (lib/price-coherence.js).
const BARRIER_VERSION = 2

// 30d outcomes needed before segments switch from the 7d to the 30d horizon.
const SEGMENT_MIN_30D = 20
function barrierLevels(r, long = true) {
  const anchor = [r.entryZoneMid, r.priceAtPrediction, r.basePrice].find(v => Number(v) > 0)
  const pct = Number(r.stopLoss)
  const tr  = Number(r.targetReturn)
  let target = Number(r.targetZoneMid) > 0 ? Number(r.targetZoneMid) : null
  if (target == null && anchor && Number.isFinite(tr) && r.targetReturn != null) {
    target = anchor * (1 + (long ? tr : -tr) / 100)
  }
  let stop = Number(r.stopZoneMid) > 0 ? Number(r.stopZoneMid) : null
  if (stop == null && anchor && pct > 0 && pct < 100) {
    stop = anchor * (1 + (long ? -pct : pct) / 100)
  }
  return { target, stop }
}

// Benchmark to measure alpha against: BTC for crypto, SPY for everything else.
function benchmarkFor(symbol) {
  return /-USD$/.test(symbol || '') ? 'BTC-USD' : 'SPY'
}

// ── 1. Resolve outcomes ───────────────────────────────────────────────────────
// Called nightly. For predictions that are ≥7d or ≥30d old and unresolved,
// resolve against the historical bar at exactly +7/+30 days from generation.

async function resolveOutcomes() {
  const records = readPredictions()
  if (!records.length) return { resolved7d: 0, resolved30d: 0 }

  const now = Date.now()
  let resolved7d = 0, resolved30d = 0, resolved90d = 0

  const toResolve = records.filter(r => {
    const age = now - new Date(r.generatedAt).getTime()
    return (age >= 7  * DAY && r.price7d  == null) ||
           (age >= 30 * DAY && r.price30d == null) ||
           (age >= 90 * DAY && r.price90d == null) ||
           // Barrier backfill. Without this clause a record already resolved at
           // 30d never re-enters, so the triple-barrier stats would start empty
           // and stay that way for a month. It costs one pass: the barrier is
           // written on the first run (null when the bars no longer reach back
           // that far, which is the correct answer and also stops the retry).
           // barrierV: labels computed before the stop-unit fix are recomputed.
           (age >= 30 * DAY && r.barrierV !== BARRIER_VERSION) ||
           // Exit quality (lib/exit-quality.js), same one-pass backfill rule.
           (age >= 30 * DAY && r.exitV !== exitQuality.EXIT_VERSION)
  })
  if (!toResolve.length) return { resolved7d: 0, resolved30d: 0, resolved90d: 0 }

  // Fetch bars once per unique symbol (+ the two possible benchmarks)
  const symbols = [...new Set(toResolve.map(r => r.symbol))]
  const benches = [...new Set(toResolve.map(r => benchmarkFor(r.symbol)))]
  const barsMap = {}
  await Promise.all([...symbols, ...benches].map(async sym => {
    barsMap[sym] = await fetchDailyBars(sym)
  }))

  const updated = records.map(r => {
    const genMs = new Date(r.generatedAt).getTime()
    const age   = now - genMs
    const bars  = barsMap[r.symbol]
    if (!bars?.length) return r

    const benchBars = barsMap[benchmarkFor(r.symbol)] || []
    const copy = { ...r }

    // Baseline price on the prediction date — the honest "you could have bought
    // here" anchor (falls back to entry-zone mid for legacy records)
    if (copy.basePrice == null) {
      copy.basePrice = nearestClose(bars, genMs) ?? copy.priceAtPrediction ?? copy.entryZoneMid ?? null
    }
    const benchBase = nearestClose(benchBars, genMs)

    const resolveHorizon = (days, priceKey, benchKey) => {
      if (age < days * DAY || copy[priceKey] != null) return false
      const px = nearestClose(bars, genMs + days * DAY)
      if (px == null) return false
      copy[priceKey] = px
      const benchPx = nearestClose(benchBars, genMs + days * DAY)
      if (benchBase && benchPx != null) {
        copy[benchKey] = +(((benchPx - benchBase) / benchBase) * 100).toFixed(2)
      }
      return true
    }

    if (resolveHorizon(7,  'price7d',  'benchRet7d'))  resolved7d++
    if (resolveHorizon(30, 'price30d', 'benchRet30d')) resolved30d++
    if (resolveHorizon(90, 'price90d', 'benchRet90d')) resolved90d++

    // Fill check: did price actually enter the entry zone in the first 7 days?
    // Use the real zone bounds when logged; legacy records fall back to mid ±2%
    if (copy.entered === undefined) {
      const zoneLow  = r.entryZoneLow  ?? (r.entryZoneMid != null ? r.entryZoneMid * 0.98 : null)
      const zoneHigh = r.entryZoneHigh ?? (r.entryZoneMid != null ? r.entryZoneMid * 1.02 : null)
      copy.entered = zoneTouched(bars, genMs, genMs + 7 * DAY, zoneLow, zoneHigh)
    }

    // Triple-barrier label over the 30d window. Only once the window has fully
    // elapsed — asking earlier would resolve a still-open trade as 'time'.
    if (copy.barrierV !== BARRIER_VERSION && age >= 30 * DAY) {
      const long = String(r.verdict || 'BUY').toUpperCase() !== 'SELL'
      const { target, stop } = barrierLevels(copy, long)
      copy.barrier = tripleBarrier(bars, { from: genMs, to: genMs + 30 * DAY, target, stop, long })
      copy.barrierV = BARRIER_VERSION
    }

    // Exit quality: best/worst point reached between the FILL and the exit,
    // what was given back, how much of the move was kept. Same levels and the
    // same zone the fill check uses; null when the levels or bars are missing.
    if (copy.exitV !== exitQuality.EXIT_VERSION && age >= 30 * DAY) {
      const long = String(r.verdict || 'BUY').toUpperCase() !== 'SELL'
      const { target, stop } = barrierLevels(copy, long)
      const entry = [copy.entryZoneMid, copy.priceAtPrediction, copy.basePrice].find(v => Number(v) > 0)
      const zoneLow  = r.entryZoneLow  ?? (r.entryZoneMid != null ? r.entryZoneMid * 0.98 : null)
      const zoneHigh = r.entryZoneHigh ?? (r.entryZoneMid != null ? r.entryZoneMid * 1.02 : null)
      copy.exit = exitQuality.measureExit(bars, { from: genMs, to: genMs + 30 * DAY, entry: Number(entry), target, stop, zoneLow, zoneHigh, long })
      copy.exitV = exitQuality.EXIT_VERSION
    }

    copy.resolvedV2 = true
    return copy
  })

  writePredictions(updated)
  console.log(`[brain-learnings] resolved outcomes: ${resolved7d} @ 7d, ${resolved30d} @ 30d, ${resolved90d} @ 90d (exact-date, benchmark-relative)`)
  return { resolved7d, resolved30d, resolved90d }
}

// ── Deterministic stats — computed in code, never by the LLM ─────────────────

function returnsFor(r, priceKey) {
  const base = r.basePrice ?? r.priceAtPrediction ?? r.entryZoneMid
  const px   = r[priceKey]
  if (!base || px == null) return null
  return +(((px - base) / base) * 100).toFixed(2)
}

function computeStats(records, { segmentMin30d = SEGMENT_MIN_30D } = {}) {
  const resolved = records.filter(r => r.price7d != null || r.price30d != null || r.price90d != null)

  const horizon = (priceKey, benchKey) => {
    const rows = resolved
      .map(r => ({
        ret:   returnsFor(r, priceKey),
        bench: r[benchKey] ?? null,
        conf:  r.confidence ?? 'Unknown',
        entered: r.entered,
        hitTarget: r.targetZoneMid != null && r[priceKey] != null ? r[priceKey] >= r.targetZoneMid : null,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) return null

    // "Tradeable" predictions: price actually entered the entry zone (legacy
    // records with unknown fill are kept but flagged separately)
    const tradeable = rows.filter(x => x.entered !== false)
    const withBench = tradeable.filter(x => x.bench != null)
    const withTarget = tradeable.filter(x => x.hitTarget != null)

    const pct = (arr, pred) => arr.length ? +(arr.filter(pred).length / arr.length).toFixed(3) : null
    const avg = (arr, f) => arr.length ? +(arr.reduce((s, x) => s + f(x), 0) / arr.length).toFixed(2) : null

    const wins      = tradeable.filter(x => x.ret > 0).length
    const alphaWins = withBench.filter(x => x.ret > x.bench).length
    const wr = wilson(wins, tradeable.length)
    const ar = wilson(alphaWins, withBench.length)
    return {
      n:             rows.length,
      nTradeable:    tradeable.length,
      neverEntered:  rows.filter(x => x.entered === false).length,
      wins,
      winRate:       pct(tradeable, x => x.ret > 0),
      winRateLo:     wr.lo,
      winRateHi:     wr.hi,
      avgReturn:     avg(tradeable, x => x.ret),
      nBench:        withBench.length,
      alphaWins,
      alphaWinRate:  pct(withBench, x => x.ret > x.bench),
      alphaWinRateLo: ar.lo,
      alphaWinRateHi: ar.hi,
      avgAlpha:      avg(withBench, x => x.ret - x.bench),
      targetHitRate: pct(withTarget, x => x.hitTarget),
    }
  }

  // ── Segments: ONE horizon for every segment ──────────────────────────────
  // Each segment used to take a record's 30d return when resolved and its 7d
  // return otherwise, so a "win rate" pooled two different questions in
  // proportions set by how old the picks happened to be. Now the whole stats
  // run picks one horizon — 30d once enough 30d outcomes exist, 7d until then —
  // and a record without that horizon is excluded, not substituted.
  const n30 = resolved.filter(r => r.price30d != null && r.entered !== false).length
  const segmentHorizon = n30 >= segmentMin30d ? 30 : 7
  const segPx    = segmentHorizon === 30 ? 'price30d'    : 'price7d'
  const segBench = segmentHorizon === 30 ? 'benchRet30d' : 'benchRet7d'

  // One calibration segment, with 95% Wilson intervals on both rates. The
  // alpha rate's denominator is the benchmark-matched subset (nBench), which
  // is what anything comparing alpha rates must use — not n.
  const segment = (predicate) => {
    const rows = resolved
      .filter(r => predicate(r) && r.entered !== false)
      .map(r => ({ ret: returnsFor(r, segPx), bench: r[segBench] ?? null }))
      .filter(x => x.ret != null)
    if (!rows.length) return null
    const withBench = rows.filter(x => x.bench != null)
    const wins      = rows.filter(x => x.ret > 0).length
    const alphaWins = withBench.filter(x => x.ret > x.bench).length
    const wr = wilson(wins, rows.length)
    const ar = wilson(alphaWins, withBench.length)
    return {
      n:              rows.length,
      wins,
      winRate:        +(wins / rows.length).toFixed(3),
      winRateLo:      wr.lo,
      winRateHi:      wr.hi,
      nBench:         withBench.length,
      alphaWins,
      alphaWinRate:   withBench.length ? +(alphaWins / withBench.length).toFixed(3) : null,
      alphaWinRateLo: ar.lo,
      alphaWinRateHi: ar.hi,
      horizon:        segmentHorizon,
    }
  }
  const collect = (pairs) => {
    const out = {}
    for (const [key, pred] of pairs) { const seg = segment(pred); if (seg) out[key] = seg }
    return Object.keys(out).length ? out : null
  }

  // Calibration: does stated confidence predict outcomes?
  const calibration = collect(['High', 'Medium', 'Low'].map(b => [b, r => r.confidence === b])) || {}

  // Ensemble: does cross-model agreement predict better outcomes?
  const ensemble = collect([
    ['confirmed',   r => r.ensembleConfirmed === true],
    ['unconfirmed', r => r.ensembleConfirmed === false],
  ])

  // Baseline: does the AI beat a mechanical TA model shown the same bars?
  // (7d horizon — the baseline's prediction/label horizon; AI picks are
  // implicit buys, so baselineDir==='UP' means the models agree)
  const baselineRows = resolved
    .filter(r => r.baselineDir != null && r.entered !== false)
    .map(r => ({ ret: returnsFor(r, 'price7d'), dir: r.baselineDir }))
    .filter(x => x.ret != null)
  let baseline = null
  if (baselineRows.length) {
    const pct = (arr, pred) => arr.length ? +(arr.filter(pred).length / arr.length).toFixed(3) : null
    const agrees    = baselineRows.filter(x => x.dir === 'UP')
    const disagrees = baselineRows.filter(x => x.dir === 'DOWN')
    baseline = {
      n:                  baselineRows.length,
      baselineAccuracy7d: pct(baselineRows, x => (x.dir === 'UP') === (x.ret > 0)),
      aiWinRate7d:        pct(baselineRows, x => x.ret > 0),
      aiWinWhenBaselineAgrees:    pct(agrees,    x => x.ret > 0),
      aiWinWhenBaselineDisagrees: pct(disagrees, x => x.ret > 0),
    }
  }

  // Asset type. Legacy records logged non-sector stocks as 'equity' — fold them
  // into 'stock' so one asset class never splits into two segments.
  const assetTypeOf = r => (r.assetType === 'equity' ? 'stock' : r.assetType)
  const byAssetType = collect([...new Set(resolved.map(assetTypeOf).filter(Boolean))]
    .map(at => [at, r => assetTypeOf(r) === at]))

  // Sector: top 4 sectors by pick count.
  const sectorCounts = {}
  for (const r of resolved) if (r.sector) sectorCounts[r.sector] = (sectorCounts[r.sector] || 0) + 1
  const bySector = collect(Object.entries(sectorCounts).sort((a, b) => b[1] - a[1]).slice(0, 4)
    .map(([sec]) => [sec, r => r.sector === sec]))

  // TA pattern at scan time (patterns seen ≥5 times).
  const patternCounts = {}
  for (const r of resolved) if (Array.isArray(r.taPatterns)) for (const pt of r.taPatterns) patternCounts[pt] = (patternCounts[pt] || 0) + 1
  const byPattern = collect(Object.entries(patternCounts).filter(([, c]) => c >= 5)
    .map(([pt]) => [pt, r => Array.isArray(r.taPatterns) && r.taPatterns.includes(pt)]))

  // Relative-strength rank: weak (0-30), mid (31-70), strong (71-100).
  const byRsRank = collect([['weak', 0, 30], ['mid', 31, 70], ['strong', 71, 100]]
    .map(([b, lo, hi]) => [b, r => r.rsRankAtScan != null && r.rsRankAtScan >= lo && r.rsRankAtScan <= hi]))

  // Volume signal: does "Confirming" actually predict alpha?
  const byVolumeSignal = collect(['Confirming', 'Weak', 'Diverging', 'Unknown'].map(v => [v, r => r.volumeSignal === v]))

  // Earnings window: imminent ≤7d, upcoming 8-21d, distant >21d or unset.
  const earningsWindowImpact = collect([
    ['imminent', r => r.daysToEarnings != null && r.daysToEarnings <= 7],
    ['upcoming', r => r.daysToEarnings != null && r.daysToEarnings > 7 && r.daysToEarnings <= 21],
    ['distant',  r => r.daysToEarnings == null  || r.daysToEarnings > 21],
  ])

  // Options flow: P/C < 0.70 bullish, 0.70-1.30 neutral, ≥ 1.30 bearish.
  const optionsFlowImpact = collect([
    ['bullish', r => r.optionsPcRatio != null && r.optionsPcRatio < 0.70],
    ['neutral', r => r.optionsPcRatio != null && r.optionsPcRatio >= 0.70 && r.optionsPcRatio < 1.30],
    ['bearish', r => r.optionsPcRatio != null && r.optionsPcRatio >= 1.30],
  ])

  // Agent conflict: when agents disagreed, were outcomes worse?
  const conflictImpact = collect([
    ['conflict',   r => r.agentConflict?.exists === true],
    ['noConflict', r => !r.agentConflict?.exists],
  ])

  // Learnings on/off: picks made with the self-learned block injected vs
  // without it (stamped `learningsVersion` at scan time; 'none' = nothing
  // injected). Records predating the stamp are excluded, not counted as off.
  // lib/learning-health.js judges the difference.
  const byLearnings = collect([
    ['on',  r => r.learningsVersion != null && r.learningsVersion !== 'none'],
    ['off', r => r.learningsVersion === 'none'],
  ])

  // Composite score band: low (<40), mid (40-69), high (70-79), elite (≥80).
  const byCompositeScore = collect([['low', 0, 39], ['mid', 40, 69], ['high', 70, 79], ['elite', 80, 100]]
    .map(([b, lo, hi]) => [b, r => r.compositeScore != null && r.compositeScore >= lo && r.compositeScore <= hi]))

  // High conviction: ≥3 independent confirming signals.
  const byHighConviction = collect([
    ['true',  r => r.highConviction === true],
    ['false', r => r.highConviction === false],
  ])

  // Macro-regime calibration. A strategy that only works risk-on has an overall
  // win rate that describes neither regime — it is an average over two
  // different markets, and it is highest exactly when it is least useful.
  const byRegime = collect([...new Set(resolved.map(r => r.regimeAtScan).filter(Boolean))]
    .map(rg => [rg, r => r.regimeAtScan === rg]))

  // Generator calibration: model id + prompt version, together. Either one
  // changing makes a new system, and pooling the old system's results with the
  // new one's produces a number that describes neither — the same failure the
  // ML baseline's walk-forward gate exists to prevent on the training side.
  // Records predating the stamp are excluded rather than bucketed as 'unknown',
  // which would read as a real generator with a real hit rate.
  const genKey = r => (r.modelVersion ? `${r.modelVersion}${r.promptVersion != null ? `/v${r.promptVersion}` : ''}` : null)
  const byModelVersion = collect([...new Set(resolved.map(genKey).filter(Boolean))]
    .map(g => [g, r => genKey(r) === g]))

  // Triple-barrier outcomes: of the picks whose 30d window has fully elapsed,
  // which touched their target first, which their stop, and which neither?
  //
  // This is deliberately NOT a dimension of the edge report. The barrier label
  // is an OUTCOME, so segmenting returns by it is circular — "picks that hit
  // their target had great returns" is arithmetic, not an edge. What it
  // measures is whether the stated targets and stops were reachable at all.
  const barred = resolved.filter(r => r.barrier?.label)
  const barriers = barred.length ? (() => {
    const count = l => barred.filter(r => r.barrier.label === l).length
    const daysTo = l => {
      const d = barred.filter(r => r.barrier.label === l).map(r => r.barrier.days).filter(Number.isFinite)
      return d.length ? +(d.reduce((a, b) => a + b, 0) / d.length).toFixed(1) : null
    }
    return {
      n:              barred.length,
      targetFirst:    +(count('target') / barred.length).toFixed(3),
      stopFirst:      +(count('stop')   / barred.length).toFixed(3),
      neither:        +(count('time')   / barred.length).toFixed(3),
      avgDaysToTarget: daysTo('target'),
      avgDaysToStop:   daysTo('stop'),
    }
  })() : null

  // Composite-score cutoff, walk-forward validated. The old version tried 11
  // cutoffs on every resolved pick and kept the best — on coin-flip outcomes
  // that reports ~59% above the line, and the line was then applied as a live
  // filter. Now the cutoff is chosen on OLDER picks and adopted only if it
  // beats "no filter" on newer picks it never saw (lib/calibration-stats.js).
  const autoTune = validateThreshold(resolved
    .filter(r => r.compositeScore != null && r.entered !== false)
    .map(r => ({ t: new Date(r.generatedAt).getTime(), score: r.compositeScore, ret: returnsFor(r, segPx), bench: r[segBench] }))
    .filter(x => x.ret != null && x.bench != null)
    .map(x => ({ t: x.t, score: x.score, win: x.ret > x.bench })))
  const autoTunedThreshold = autoTune.validated ? autoTune.threshold : null
  const autoTunedThresholdAlphaWinRate = autoTune.validated ? autoTune.holdout.rate : null

  return {
    totalResolved: resolved.length,
    h7:  horizon('price7d',  'benchRet7d'),
    h30: horizon('price30d', 'benchRet30d'),
    h90: horizon('price90d', 'benchRet90d'),
    segmentHorizon,
    calibration,
    ensemble,
    baseline,
    byAssetType,
    bySector,
    byPattern,
    byRsRank,
    byVolumeSignal,
    earningsWindowImpact,
    optionsFlowImpact,
    conflictImpact,
    byCompositeScore,
    byHighConviction,
    byRegime,
    byModelVersion,
    byLearnings,
    barriers,
    // Outcome, like barriers — never an edge-report dimension.
    exitQuality: exitQuality.summarizeExitQuality(resolved),
    autoTunedThreshold,
    autoTunedThresholdAlphaWinRate,
    autoTune,
  }
}

// ── 2. Meta-analysis — Claude interprets pre-computed stats ──────────────────

async function runMetaAnalysis() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return null
  if (require('./ai-pause').claudePaused()) { console.log('[brain-learnings] Claude paused — skipping nightly meta-analysis'); return null }

  const records  = readPredictions()
  const resolved = records.filter(r => r.price7d != null || r.price30d != null || r.price90d != null)
  if (resolved.length < 5) {
    console.log('[brain-learnings] not enough resolved predictions yet:', resolved.length)
    return null
  }

  const stats = computeStats(records)

  const dataset = resolved.slice(-100).map(r => ({
    symbol:           r.symbol,
    generatedAt:      r.generatedAt?.slice(0, 10),
    verdict:          r.verdict,
    confidence:       r.confidence ?? null,
    compositeScore:   r.compositeScore,
    fundamentalScore: r.fundamentalScore,
    technicalScore:   r.technicalScore,
    sentimentScore:   r.sentimentScore,
    macroScore:       r.macroScore,
    riskScore:        r.riskScore,
    hadConflict:      r.agentConflict?.exists ?? false,
    ensembleConfirmed: r.ensembleConfirmed ?? null,
    volumeSignal:     r.volumeSignal ?? null,
    daysToEarnings:   r.daysToEarnings ?? null,
    optionsPcRatio:   r.optionsPcRatio ?? null,   // P/C ratio at scan time (null = not logged yet)
    taPatterns:       r.taPatterns ?? null,
    entered:          r.entered ?? null,
    ret7d:            returnsFor(r, 'price7d'),
    ret30d:           returnsFor(r, 'price30d'),
    benchRet7d:       r.benchRet7d ?? null,
    benchRet30d:      r.benchRet30d ?? null,
    thesisAssumptions: r.thesisAssumptions?.slice(0, 2),
  }))

  const prompt = `You are the AI Brain's self-improvement engine. You have ${dataset.length} past predictions with actual outcomes.

PRE-COMPUTED STATISTICS (calculated deterministically — trust these, do NOT recompute):
${JSON.stringify(stats, null, 2)}

Notes on the stats:
- winRate counts return > 0; alphaWinRate counts return > benchmark (SPY for equities, BTC for crypto) over the same window — alphaWinRate is the number that matters
- neverEntered = predictions whose entry zone was never touched (excluded from win rates; a fill that never happened is not a win)
- calibration shows whether stated High/Medium/Low confidence actually predicted better outcomes
- ensemble (when present) splits outcomes by cross-model agreement: confirmed = Claude and the second model both picked the symbol with matching verdict
- baseline (when present) compares AI picks against a mechanical TA logistic model on identical symbols/dates: if aiWinRate7d does not beat baselineAccuracy7d the AI is not adding value over momentum; aiWinWhenBaselineDisagrees shows whether contrarian-to-baseline picks pay off

PREDICTION OUTCOMES (last ${dataset.length} resolved):
${JSON.stringify(dataset, null, 2)}

Analyze this history. Identify:
1. Which score combinations (fundamental/technical/sentiment/macro/risk) most reliably led to BENCHMARK-BEATING gains
2. Which verdicts and confidence levels had the highest/lowest alpha — is confidence calibrated?
3. Whether agent conflict (hadConflict=true) was a useful warning signal
4. Score thresholds that separated alpha-winners from losers
5. Any patterns in timing (market regimes, sectors, asset types)
6. What the Brain should weight MORE or LESS going forward
7. Whether volumeSignal="Confirming" picks outperformed "Weak"/"Diverging" picks (volume confirmation as alpha signal)
8. Whether picks with daysToEarnings ≤ 21 had higher or lower alpha vs. non-earnings-window picks (riskScore cut calibration)
9. Whether optionsPcRatio < 0.70 (bullish options flow at scan time) correlated with higher alpha vs. picks with P/C ≥ 0.70 (skip if optionsPcRatio is null for most picks)

CITATIONS (required): end every keyLearnings entry, the promptInjection, and every scoreWeightAdjustments value with the exact key path(s) in PRE-COMPUTED STATISTICS it rests on, in square brackets — e.g. "Confirming volume beat Weak by 14 pts [byVolumeSignal.Confirming, byVolumeSignal.Weak]". State only figures that appear at those paths. A finding with no citation, a path that is not in the statistics, a segment of fewer than 10 picks, or a figure the cited segment does not hold is discarded before it reaches a scan. Each yes/no flag is likewise re-tested against the statistics and dropped unless the data establishes it.

Respond ONLY with a JSON object:
{
  "keyLearnings": [
    "concise actionable finding 1, max 140 chars incl. the citation [stats.path]",
    "concise actionable finding 2",
    ...up to 8
  ],
  "scoreWeightAdjustments": {
    "fundamentalScore": "increase|decrease|maintain — reason [stats.path]",
    "technicalScore":   "increase|decrease|maintain — reason [stats.path]",
    "sentimentScore":   "increase|decrease|maintain — reason [stats.path]",
    "macroScore":       "increase|decrease|maintain — reason [stats.path]",
    "riskScore":        "increase|decrease|maintain — reason [stats.path]"
  },
  "conflictSignalUseful": true|false,
  "volumeConfirmationPredictive": true|false,
  "earningsWindowRisky": true|false,
  "optionsBullishPredictive": true|false,
  "confidenceCalibrated": true|false,
  "bestCompositeThreshold": <score 0-100 above which alpha was highest>,
  "promptInjection": "2-3 sentence summary of what the Brain learned, written as a directive for the next scan [stats.path]",
  "postMortems": [
    {
      "symbol": "<ticker>",
      "date": "<YYYY-MM-DD>",
      "compositeScore": <number>,
      "confidence": "High|Medium|Low",
      "actualReturn30d": <number or null>,
      "benchmarkReturn30d": <number or null>,
      "rootCause": "<≤120 chars: core reason the prediction failed>",
      "thesisFailed": "<≤100 chars: which assumption broke down>",
      "lessonLearned": "<≤100 chars: what the Brain should remember for similar setups>"
    }
  ]
}
Select up to 5 of the worst resolved losses from HIGH-confidence picks (confidence=High OR compositeScore≥70) where ret30d was most negative vs benchmark. If fewer than 3 such losses exist, return postMortems as an empty array [].`

  try {
    const client = new Anthropic({ apiKey })
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2000,
      messages: [{ role: 'user', content: prompt }],
    })
    const text = msg.content?.[0]?.text || ''
    const learnings = parseAiJson(text)
    learnings.updatedAt     = new Date().toISOString()
    learnings.totalResolved = resolved.length
    // Authoritative numbers come from code, not the LLM
    learnings.stats      = stats
    learnings.winRate7d  = stats.h7?.alphaWinRate  ?? stats.h7?.winRate  ?? null
    learnings.winRate30d = stats.h30?.alphaWinRate ?? stats.h30?.winRate ?? null
    learnings.winRate90d = stats.h90?.alphaWinRate ?? stats.h90?.winRate ?? null
    // What survives the deterministic audit (lib/learning-health.js), stored
    // with the document so a reader sees what was dropped and why.
    learnings.audit = learningHealthLib.learningHealth(learnings)

    const previous = readLearnings() || {}
    atomic.writeJsonAtomic(LEARNINGS_FILE, learnings)
    // The nightly rewrite is itself a refinement: log what changed and the
    // outcome evidence that drove it, with the prior document as the revert
    // snapshot. A bad regeneration is now recoverable instead of terminal.
    try {
      require('./memory-refinement').recordRefinement({
        actor: 'ai', kind: 'learnings', before: previous, after: learnings,
        evidence: {
          reason: 'nightly meta-analysis',
          resolvedPredictions: resolved.length,
          alphaWinRate7d:  stats.h7?.alphaWinRate  ?? null,
          alphaWinRate30d: stats.h30?.alphaWinRate ?? null,
          autoTunedThreshold: stats.autoTunedThreshold ?? null,
        },
      })
    } catch (e) { console.warn('[brain-learnings] refinement log failed:', e.message) }
    console.log(`[brain-learnings] meta-analysis complete: ${learnings.keyLearnings?.length} learnings, alpha win rate 30d=${learnings.winRate30d != null ? (learnings.winRate30d * 100).toFixed(0) + '%' : 'n/a'}`)
    return learnings
  } catch (e) {
    console.error('[brain-learnings] meta-analysis failed:', e.message)
    return null
  }
}

// ── 3. Get learnings block for prompt injection ───────────────────────────────
// Called by ai-brain.js at scan time. Returns a string to prepend to the system prompt.

const NO_LEARNINGS = Object.freeze({ block: '', version: 'none', withheld: false, health: null })
let _withheldLogged = null

/**
 * The self-learned block for the scan prompt, AFTER lib/learning-health.js has
 * judged it: flags the stats do not establish are dropped, findings that cite
 * no statistic (or state a figure the stats do not hold) are dropped, and the
 * whole block is withheld when picks made with it measurably did worse than
 * picks made without it. `version` is a hash of what was actually injected —
 * stamped on every prediction so that comparison can be made — or 'none'.
 */
function buildLearnings() {
  try {
    if (!fs.existsSync(LEARNINGS_FILE)) return ''
    const data = JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8'))
    if (!data?.keyLearnings?.length) return NO_LEARNINGS

    const age = Date.now() - new Date(data.updatedAt).getTime()
    const ageDays = Math.floor(age / 86400000)
    if (ageDays > 7) return NO_LEARNINGS // stale — don't inject outdated learnings

    const s = data.stats
    const health = learningHealthLib.learningHealth(data)
    if (health.withheld) {
      if (_withheldLogged !== data.updatedAt) {
        _withheldLogged = data.updatedAt
        const e = health.effect
        console.warn(`[brain-learnings] learnings WITHHELD from scans: picks made with them won ${e.on?.rate} (n=${e.on?.n}) vs ${e.off?.rate} (n=${e.off?.n}) without, p=${e.p}`)
      }
      return { ...NO_LEARNINGS, withheld: true, health }
    }
    // A flag the stats do not establish is not rendered at all.
    const flag = name => (health.flags[name]?.keep ? data[name] : null)
    const gate = list => learningHealthLib.auditLearnings(list, s || {}).kept
    const verdictOf = (a, b) => learningHealthLib.compare(learningHealthLib.counts(a), learningHealthLib.counts(b)).status
    const fmtPct = v => v != null ? `${(v * 100).toFixed(0)}%` : 'n/a'

    const lines = [
      `\n## SELF-LEARNED INTELLIGENCE (from ${data.totalResolved} resolved predictions, updated ${ageDays}d ago)`,
      s?.h7 || s?.h30
        ? `Benchmark-beating (alpha) win rates: 7d=${fmtPct(s?.h7?.alphaWinRate)} | 30d=${fmtPct(s?.h30?.alphaWinRate)}${s?.h90 ? ` | 90d=${fmtPct(s.h90.alphaWinRate)}` : ''} · Raw win rates: 7d=${fmtPct(s?.h7?.winRate)} | 30d=${fmtPct(s?.h30?.winRate)}${s?.h90 ? ` | 90d=${fmtPct(s.h90.winRate)}` : ''}`
        : `Win rates: 7d=${fmtPct(data.winRate7d)} | 30d=${fmtPct(data.winRate30d)}`,
      s?.autoTunedThreshold != null
        ? `Validated composite score cutoff: ${s.autoTunedThreshold}/100 (alpha win rate ${s.autoTunedThresholdAlphaWinRate != null ? (s.autoTunedThresholdAlphaWinRate * 100).toFixed(0) + '%' : 'n/a'} on unseen picks above this line) — picks below it are filtered from scan output`
        : `No validated composite score cutoff (${s?.autoTune?.reason || 'not enough resolved picks'}) — no score filter is applied; do not treat any score level as proven`,
      flag('conflictSignalUseful') != null
        ? `Agent conflict signal useful: ${flag('conflictSignalUseful') ? 'YES — flag conflicts prominently' : 'NO — do not over-weight'}`
        : null,
      flag('volumeConfirmationPredictive') != null
        ? `Volume confirmation (Confirming signal) predictive: ${flag('volumeConfirmationPredictive') ? 'YES — prefer volumeSignal=Confirming picks' : 'NO — volume did not predict alpha'}`
        : null,
      flag('earningsWindowRisky') != null
        ? `Earnings-window picks (≤21d) historically ${flag('earningsWindowRisky') ? 'RISKIER — penalize riskScore more aggressively' : 'NOT riskier than non-earnings picks'}`
        : null,
      flag('optionsBullishPredictive') != null
        ? `Options P/C<0.70 bullish positioning historically ${flag('optionsBullishPredictive') ? 'PREDICTIVE — prefer picks with bullish options flow (P/C<0.70🟢)' : 'NOT predictive of alpha — weight options flow less'}`
        : null,
    ]

    if (s?.calibration && Object.keys(s.calibration).length) {
      lines.push('CONFIDENCE CALIBRATION (stated confidence → actual alpha win rate):')
      for (const [bucket, c] of Object.entries(s.calibration)) {
        lines.push(`  ${bucket}: ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
      if (flag('confidenceCalibrated') === false) {
        lines.push('  ⚠️ Confidence has NOT been predictive — be conservative when claiming High confidence.')
      }
    }

    if (s?.ensemble) {
      lines.push('CROSS-MODEL ENSEMBLE (alpha win rate when both models agreed vs primary-only picks):')
      for (const [k, c] of Object.entries(s.ensemble)) {
        lines.push(`  ${k}: ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
    }

    if (s?.byAssetType) {
      lines.push('ALPHA WIN RATE BY ASSET TYPE:')
      for (const [at, c] of Object.entries(s.byAssetType)) {
        lines.push(`  ${at}: ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
    }

    if (s?.bySector) {
      lines.push('ALPHA WIN RATE BY SECTOR (top sectors by pick volume):')
      for (const [sector, c] of Object.entries(s.bySector)) {
        lines.push(`  ${sector}: ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
    }

    if (s?.byPattern) {
      lines.push('TA PATTERN CALIBRATION (alpha win rate when pattern present at scan time, ≥5 occurrences):')
      for (const [pat, c] of Object.entries(s.byPattern)) {
        lines.push(`  ${pat}: ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
    }

    if (s?.byRegime) {
      lines.push('MACRO REGIME CALIBRATION (alpha win rate by the FRED regime at scan time):')
      for (const [rg, c] of Object.entries(s.byRegime)) {
        lines.push(`  ${rg}: ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
      lines.push('  A rate that only holds in one regime is not an edge in the other — say which one you are in.')
    }

    if (s?.byModelVersion && Object.keys(s.byModelVersion).length > 1) {
      // Only worth injecting when there is something to COMPARE. One generator
      // segment is just the overall rate under a longer name.
      lines.push('GENERATOR CALIBRATION (alpha win rate by model + prompt version that produced the pick):')
      for (const [g, c] of Object.entries(s.byModelVersion)) {
        lines.push(`  ${g}: ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
    }

    if (s?.barriers) {
      lines.push(`TARGET/STOP REACHABILITY (triple-barrier over ${s.barriers.n} fully-elapsed 30d windows — which level price touched FIRST):`)
      lines.push(`  target first ${fmtPct(s.barriers.targetFirst)}${s.barriers.avgDaysToTarget != null ? ` (avg ${s.barriers.avgDaysToTarget}d)` : ''} · stop first ${fmtPct(s.barriers.stopFirst)}${s.barriers.avgDaysToStop != null ? ` (avg ${s.barriers.avgDaysToStop}d)` : ''} · neither ${fmtPct(s.barriers.neither)}`)
      lines.push('  This measures whether your stated targets and stops were REACHABLE, which the fixed-horizon return cannot: a pick that hit its target on day 3 and round-tripped scores as a loss there.')
    }

    const eqLine = exitQuality.exitQualityLine(s?.exitQuality)
    if (eqLine) lines.push(eqLine)

    if (s?.byRsRank) {
      lines.push('RELATIVE STRENGTH RANK CALIBRATION (alpha win rate by intra-universe RS percentile at scan time):')
      for (const [bucket, c] of Object.entries(s.byRsRank)) {
        const range = bucket === 'weak' ? '0-30' : bucket === 'mid' ? '31-70' : '71-100'
        lines.push(`  RSRank ${range} (${bucket}): ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
    }

    if (s?.byVolumeSignal) {
      lines.push('VOLUME SIGNAL CALIBRATION (alpha win rate by volumeSignal at scan time):')
      for (const [sig, c] of Object.entries(s.byVolumeSignal)) {
        lines.push(`  ${sig}: ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
    }

    if (s?.earningsWindowImpact) {
      lines.push('EARNINGS-WINDOW IMPACT (alpha win rate by proximity to earnings at scan time):')
      const labels = { imminent: '≤7d (imminent)', upcoming: '8-21d (upcoming)', distant: '>21d or unknown (distant)' }
      for (const [key, c] of Object.entries(s.earningsWindowImpact)) {
        lines.push(`  ${labels[key] ?? key}: ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
    }

    if (s?.optionsFlowImpact) {
      lines.push('OPTIONS FLOW CALIBRATION (alpha win rate by P/C ratio at scan time):')
      const labels = { bullish: 'P/C<0.70 (bullish flow)', neutral: 'P/C 0.70-1.30 (neutral)', bearish: 'P/C≥1.30 (bearish flow)' }
      for (const [key, c] of Object.entries(s.optionsFlowImpact)) {
        lines.push(`  ${labels[key] ?? key}: ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
    }

    if (s?.conflictImpact) {
      const conf = s.conflictImpact.conflict
      const noConf = s.conflictImpact.noConflict
      if (conf && noConf) {
        lines.push(`AGENT CONFLICT SIGNAL: picks WITH conflict historically ${fmtPct(conf.alphaWinRate ?? conf.winRate)} alpha win rate (${conf.n}×) vs ${fmtPct(noConf.alphaWinRate ?? noConf.winRate)} without conflict — ${verdictOf(conf, noConf) === 'lower' ? '⚠️ conflict IS a warning signal (significant) — down-weight conflicted picks' : 'no significant difference — do not treat conflict as a warning yet'}`)
      }
    }

    if (s?.byCompositeScore) {
      lines.push('COMPOSITE SCORE CALIBRATION (alpha win rate by score band):')
      const scoreRanges = { low: '<40', mid: '40-69', high: '70-79', elite: '≥80' }
      for (const [bucket, c] of Object.entries(s.byCompositeScore)) {
        lines.push(`  Score ${scoreRanges[bucket] ?? bucket} (${bucket}): ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
    }

    if (s?.byHighConviction) {
      const hc = s.byHighConviction['true']
      const std = s.byHighConviction['false']
      if (hc && std) {
        lines.push(`HIGH-CONVICTION PICKS (≥3 independent confirming signals): ${fmtPct(hc.alphaWinRate ?? hc.winRate)} alpha win rate (${hc.n}×) vs ${fmtPct(std.alphaWinRate ?? std.winRate)} standard picks — ${verdictOf(hc, std) === 'higher' ? 'HIGH-CONVICTION IS PREDICTIVE (significant) — prioritize picks with highConviction=true' : 'high-conviction not shown to be predictive yet — no significant difference'}`)
      }
    }


    // Layer the human-owned overrides on top: drop suppressed AI findings,
    // surface pinned ones, and add the user's directive note. This is what
    // makes the memory white-box — the operator can correct the Brain.
    //
    // MEASURED AND HUMAN-AUTHORED CONTENT ARE KEPT IN SEPARATE SECTIONS on
    // purpose. Everything else injected into this prompt was derived from
    // resolved outcomes; a pinned learning or directive is an operator's
    // judgement and is not falsifiable the same way. Rendering them under one
    // "FROM PAST PREDICTIONS" heading would let an opinion inherit the
    // authority of a statistic, which is exactly the confusion this whole
    // calibration loop exists to prevent.
    const overrides = readOverrides()
    // Suppression applies to the AI list; pins are rendered separately below.
    // Only findings that cite a statistic which holds them up survive.
    const measuredLearnings = applyOverrides(gate(data.keyLearnings), { ...overrides, pinned: [] })
    const injection = gate([data.promptInjection])[0] || ''

    if (measuredLearnings.length) {
      lines.push(
        '',
        'KEY LEARNINGS FROM PAST PREDICTIONS (each cites the statistic it rests on; uncited findings were dropped):',
        ...measuredLearnings.map((l, i) => `  ${i + 1}. ${l}`),
      )
    }
    if (injection) lines.push('', injection)

    const pinned = (overrides.pinned || []).filter(Boolean)
    if (pinned.length || overrides.note) {
      lines.push(
        '',
        'OPERATOR GUIDANCE (human-authored — judgement, NOT measured from outcomes; weigh it as an informed prior, and do not cite it as evidence):',
        ...pinned.map((p, i) => `  ${i + 1}. ${p}`),
        overrides.note ? `  Directive: ${overrides.note}` : '',
      )
    }

    const weights = Object.entries(data.scoreWeightAdjustments || {}).filter(([, v]) => gate([v]).length)
    if (weights.length) {
      lines.push('', 'SCORE WEIGHT GUIDANCE:', ...weights.map(([k, v]) => `  ${k}: ${v}`))
    }

    const block = lines.filter(l => l != null).join('\n')
    // Version = what actually steers the model, not the nightly-changing rates:
    // the surviving findings, flags and directives.
    const directive = JSON.stringify({
      learnings: measuredLearnings, injection, weights,
      flags: Object.fromEntries(Object.keys(learningHealthLib.FLAG_TESTS).map(k => [k, flag(k)])),
      pinned: overrides.pinned || [], note: overrides.note || '',
    })
    const version = crypto.createHash('sha1').update(directive).digest('hex').slice(0, 8)
    return { block, version, withheld: false, health }
  } catch { return NO_LEARNINGS }
}

/** The block alone — what the scan prompt injects. */
function getLearningsBlock() { return buildLearnings().block }

/** Health of the stored learnings, for the status surfaces. */
function getLearningHealth() {
  try { return learningHealthLib.learningHealth(readLearnings()) } catch { return { available: false, reason: 'learnings unreadable' } }
}

// ── 4. Entry-zone price watch ─────────────────────────────────────────────────
// Called by the scheduled entry-zone-watch job (every 30 min during market hours).
// priceMap: { SYMBOL: currentPrice (number) }
// Returns array of hits: { symbol, currentPrice, entryZoneLow, entryZoneHigh, generatedAt, verdict }
// Marks matched records with entryAlertedAt so we alert once per prediction.
function checkEntryZones(priceMap = {}, _records = null) {
  if (!Object.keys(priceMap).length) return []
  const now     = Date.now()
  const MAX_AGE = 90 * DAY
  const records = _records ?? readPredictions()
  const hits    = []

  const updated = records.map(r => {
    if (r.entryZoneLow == null || r.entryZoneHigh == null) return r
    if (r.entryAlertedAt != null) return r // already fired
    const age = now - new Date(r.generatedAt).getTime()
    if (age > MAX_AGE) return r // prediction too old
    if (r.price7d != null && r.price30d != null) return r // already resolved

    const price = priceMap[r.symbol]
    if (price == null) return r
    if (price >= r.entryZoneLow && price <= r.entryZoneHigh) {
      hits.push({
        symbol:       r.symbol,
        currentPrice: price,
        entryZoneLow:  r.entryZoneLow,
        entryZoneHigh: r.entryZoneHigh,
        generatedAt:   r.generatedAt,
        verdict:       r.verdict ?? 'Buy',
        compositeScore: r.compositeScore ?? null,
        targetReturn:  r.targetReturn ?? null,
      })
      return { ...r, entryAlertedAt: new Date().toISOString() }
    }
    return r
  })

  if (hits.length && !_records) writePredictions(updated)
  return hits
}

// ── 5. Auto-tuned threshold accessor ─────────────────────────────────────────
// Returns the walk-forward-validated composite score cutoff from the last
// nightly run, or null (= apply no filter) when none was validated or the
// learnings are stale / unavailable.

function getAutoTunedThreshold() {
  try {
    if (!fs.existsSync(LEARNINGS_FILE)) return null
    const data = JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8'))
    if (!data?.updatedAt) return null
    const ageDays = (Date.now() - new Date(data.updatedAt).getTime()) / 86400000
    if (ageDays > 7) return null // stale — don't gate picks on outdated stats
    // ONLY the walk-forward-validated cutoff. The model's interpreted
    // `bestCompositeThreshold` used to be the fallback — an LLM-written number
    // applied as a live filter on real picks. No validated cutoff ⇒ no filter.
    return data.stats?.autoTunedThreshold ?? null
  } catch { return null }
}

module.exports = {
  resolveOutcomes,
  runMetaAnalysis,
  getLearningsBlock,
  buildLearnings,
  getLearningHealth,
  getAutoTunedThreshold,
  readPredictions,
  checkEntryZones,
  // white-box editable memory
  readLearnings,
  readOverrides,
  writeOverrides,
  applyOverrides,
  revertRefinement,
  OVERRIDES_FILE,
  // exported for unit tests
  computeStats,
  nearestClose,
  zoneTouched,
  tripleBarrier, barrierLevels, BARRIER_VERSION,
  benchmarkFor,
}
