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
const path    = require('path')
const Anthropic = require('@anthropic-ai/sdk')
const { fetchDailyBars: fetchBarsInternal } = require('./internal-api')
const { parseAiJson } = require('./ai-json')

const PRED_LOG       = path.join(__dirname, '../data/ai-brain-predictions.jsonl')
const LEARNINGS_FILE = path.join(__dirname, '../data/brain-learnings.json')
const DATA_DIR       = path.join(__dirname, '../data')

const DAY = 86400 * 1000

// ── Helpers ───────────────────────────────────────────────────────────────────

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
}

function readPredictions() {
  if (!fs.existsSync(PRED_LOG)) return []
  return fs.readFileSync(PRED_LOG, 'utf8')
    .split('\n').filter(Boolean)
    .map(line => { try { return JSON.parse(line) } catch { return null } })
    .filter(Boolean)
}

function writePredictions(records) {
  ensureDataDir()
  fs.writeFileSync(PRED_LOG, records.map(r => JSON.stringify(r)).join('\n') + '\n')
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
           (age >= 90 * DAY && r.price90d == null)
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

function computeStats(records) {
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

    return {
      n:             rows.length,
      nTradeable:    tradeable.length,
      neverEntered:  rows.filter(x => x.entered === false).length,
      winRate:       pct(tradeable, x => x.ret > 0),
      avgReturn:     avg(tradeable, x => x.ret),
      alphaWinRate:  pct(withBench, x => x.ret > x.bench),
      avgAlpha:      avg(withBench, x => x.ret - x.bench),
      targetHitRate: pct(withTarget, x => x.hitTarget),
    }
  }

  // Calibration: does stated confidence predict outcomes? (30d preferred)
  const calibration = {}
  for (const bucket of ['High', 'Medium', 'Low']) {
    const rows = resolved
      .filter(r => r.confidence === bucket && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) continue
    const withBench = rows.filter(x => x.bench != null)
    calibration[bucket] = {
      n:            rows.length,
      winRate:      +(rows.filter(x => x.ret > 0).length / rows.length).toFixed(3),
      alphaWinRate: withBench.length ? +(withBench.filter(x => x.ret > x.bench).length / withBench.length).toFixed(3) : null,
    }
  }

  // Ensemble: does cross-model agreement predict better outcomes? (30d preferred)
  const ensemble = {}
  for (const flag of [true, false]) {
    const rows = resolved
      .filter(r => r.ensembleConfirmed === flag && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) continue
    const withBench = rows.filter(x => x.bench != null)
    ensemble[flag ? 'confirmed' : 'unconfirmed'] = {
      n:            rows.length,
      winRate:      +(rows.filter(x => x.ret > 0).length / rows.length).toFixed(3),
      alphaWinRate: withBench.length ? +(withBench.filter(x => x.ret > x.bench).length / withBench.length).toFixed(3) : null,
    }
  }

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

  // Asset-type calibration: crypto vs equity vs ETF (30d preferred)
  const byAssetType = {}
  const assetTypes = [...new Set(resolved.map(r => r.assetType).filter(Boolean))]
  for (const at of assetTypes) {
    const rows = resolved
      .filter(r => r.assetType === at && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) continue
    const withBench = rows.filter(x => x.bench != null)
    byAssetType[at] = {
      n:            rows.length,
      winRate:      +(rows.filter(x => x.ret > 0).length / rows.length).toFixed(3),
      alphaWinRate: withBench.length ? +(withBench.filter(x => x.ret > x.bench).length / withBench.length).toFixed(3) : null,
    }
  }

  // Sector calibration: top 4 sectors by pick count (30d preferred, equities only)
  const bySector = {}
  const sectorCounts = {}
  for (const r of resolved) {
    if (r.sector) sectorCounts[r.sector] = (sectorCounts[r.sector] || 0) + 1
  }
  const topSectors = Object.entries(sectorCounts).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([s]) => s)
  for (const sector of topSectors) {
    const rows = resolved
      .filter(r => r.sector === sector && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) continue
    const withBench = rows.filter(x => x.bench != null)
    bySector[sector] = {
      n:            rows.length,
      winRate:      +(rows.filter(x => x.ret > 0).length / rows.length).toFixed(3),
      alphaWinRate: withBench.length ? +(withBench.filter(x => x.ret > x.bench).length / withBench.length).toFixed(3) : null,
    }
  }

  // Pattern calibration: which TA patterns at scan time predicted better outcomes?
  // Only patterns with ≥5 appearances are reported (30d preferred)
  const byPattern = {}
  const patternCounts = {}
  for (const r of resolved) {
    if (Array.isArray(r.taPatterns)) {
      for (const p of r.taPatterns) patternCounts[p] = (patternCounts[p] || 0) + 1
    }
  }
  for (const [pat, cnt] of Object.entries(patternCounts)) {
    if (cnt < 5) continue
    const rows = resolved
      .filter(r => Array.isArray(r.taPatterns) && r.taPatterns.includes(pat) && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) continue
    const withBench = rows.filter(x => x.bench != null)
    byPattern[pat] = {
      n:            rows.length,
      winRate:      +(rows.filter(x => x.ret > 0).length / rows.length).toFixed(3),
      alphaWinRate: withBench.length ? +(withBench.filter(x => x.ret > x.bench).length / withBench.length).toFixed(3) : null,
    }
  }

  // Relative-strength rank calibration: do high-RS picks outperform low-RS picks?
  // Buckets: weak (0-30), mid (31-70), strong (71-100) — 30d preferred
  const byRsRank = {}
  for (const [bucket, lo, hi] of [['weak', 0, 30], ['mid', 31, 70], ['strong', 71, 100]]) {
    const rows = resolved
      .filter(r => r.rsRankAtScan != null && r.rsRankAtScan >= lo && r.rsRankAtScan <= hi && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) continue
    const withBench = rows.filter(x => x.bench != null)
    byRsRank[bucket] = {
      n:            rows.length,
      winRate:      +(rows.filter(x => x.ret > 0).length / rows.length).toFixed(3),
      alphaWinRate: withBench.length ? +(withBench.filter(x => x.ret > x.bench).length / withBench.length).toFixed(3) : null,
    }
  }

  // Volume signal calibration: does volumeSignal=Confirming actually predict alpha?
  const byVolumeSignal = {}
  for (const sig of ['Confirming', 'Weak', 'Diverging', 'Unknown']) {
    const rows = resolved
      .filter(r => r.volumeSignal === sig && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) continue
    const withBench = rows.filter(x => x.bench != null)
    byVolumeSignal[sig] = {
      n:            rows.length,
      winRate:      +(rows.filter(x => x.ret > 0).length / rows.length).toFixed(3),
      alphaWinRate: withBench.length ? +(withBench.filter(x => x.ret > x.bench).length / withBench.length).toFixed(3) : null,
    }
  }

  // Earnings-window impact: are near-earnings picks actually riskier?
  // imminent=≤7d, upcoming=8-21d, distant=>21d or not set (30d preferred)
  const earningsWindows = [
    ['imminent', r => r.daysToEarnings != null && r.daysToEarnings <= 7],
    ['upcoming', r => r.daysToEarnings != null && r.daysToEarnings > 7 && r.daysToEarnings <= 21],
    ['distant',  r => r.daysToEarnings == null  || r.daysToEarnings > 21],
  ]
  const earningsWindowImpact = {}
  for (const [label, filter] of earningsWindows) {
    const rows = resolved
      .filter(r => filter(r) && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) continue
    const withBench = rows.filter(x => x.bench != null)
    earningsWindowImpact[label] = {
      n:            rows.length,
      winRate:      +(rows.filter(x => x.ret > 0).length / rows.length).toFixed(3),
      alphaWinRate: withBench.length ? +(withBench.filter(x => x.ret > x.bench).length / withBench.length).toFixed(3) : null,
    }
  }

  // Options flow calibration: P/C < 0.70 (bullish) vs neutral vs ≥ 1.30 (bearish)
  const optionsFlowBuckets = [
    ['bullish', r => r.optionsPcRatio != null && r.optionsPcRatio < 0.70],
    ['neutral', r => r.optionsPcRatio != null && r.optionsPcRatio >= 0.70 && r.optionsPcRatio < 1.30],
    ['bearish', r => r.optionsPcRatio != null && r.optionsPcRatio >= 1.30],
  ]
  const optionsFlowImpact = {}
  for (const [label, filter] of optionsFlowBuckets) {
    const rows = resolved
      .filter(r => filter(r) && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) continue
    const withBench = rows.filter(x => x.bench != null)
    optionsFlowImpact[label] = {
      n:            rows.length,
      winRate:      +(rows.filter(x => x.ret > 0).length / rows.length).toFixed(3),
      alphaWinRate: withBench.length ? +(withBench.filter(x => x.ret > x.bench).length / withBench.length).toFixed(3) : null,
    }
  }

  // Agent conflict calibration: when agents disagreed, were outcomes worse?
  const conflictImpact = {}
  for (const [label, filter] of [['conflict', r => r.agentConflict?.exists === true], ['noConflict', r => !r.agentConflict?.exists]]) {
    const rows = resolved
      .filter(r => filter(r) && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) continue
    const withBench = rows.filter(x => x.bench != null)
    conflictImpact[label] = {
      n:            rows.length,
      winRate:      +(rows.filter(x => x.ret > 0).length / rows.length).toFixed(3),
      alphaWinRate: withBench.length ? +(withBench.filter(x => x.ret > x.bench).length / withBench.length).toFixed(3) : null,
    }
  }

  // Composite score threshold calibration: does a higher composite score predict alpha?
  // Buckets: low (<40), mid (40-69), high (70-79), elite (≥80) — 30d preferred
  const byCompositeScore = {}
  for (const [bucket, lo, hi] of [['low', 0, 39], ['mid', 40, 69], ['high', 70, 79], ['elite', 80, 100]]) {
    const rows = resolved
      .filter(r => r.compositeScore != null && r.compositeScore >= lo && r.compositeScore <= hi && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) continue
    const withBench = rows.filter(x => x.bench != null)
    byCompositeScore[bucket] = {
      n:            rows.length,
      winRate:      +(rows.filter(x => x.ret > 0).length / rows.length).toFixed(3),
      alphaWinRate: withBench.length ? +(withBench.filter(x => x.ret > x.bench).length / withBench.length).toFixed(3) : null,
    }
  }

  // High-conviction tracking: do picks with ≥3 independent confirming signals outperform?
  // highConviction=true when compositeScore≥80 + ensemble + volume + options all align
  const byHighConviction = {}
  for (const [label, filter] of [['true', r => r.highConviction === true], ['false', r => r.highConviction === false]]) {
    const rows = resolved
      .filter(r => filter(r) && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null)
    if (!rows.length) continue
    const withBench = rows.filter(x => x.bench != null)
    byHighConviction[label] = {
      n:            rows.length,
      winRate:      +(rows.filter(x => x.ret > 0).length / rows.length).toFixed(3),
      alphaWinRate: withBench.length ? +(withBench.filter(x => x.ret > x.bench).length / withBench.length).toFixed(3) : null,
    }
  }

  // Auto-tuned composite score threshold — grid search [35..85] step 5.
  // Picks the cutoff that maximises alpha win rate with ≥5 benchmark-matched picks above the line.
  // This is purely deterministic code; the LLM interprets it but never computes it.
  let autoTunedThreshold = null
  let autoTunedThresholdAlphaWinRate = null
  const _MIN_AUTOTUNE_PICKS = 5
  for (let t = 35; t <= 85; t += 5) {
    const rows = resolved
      .filter(r => r.compositeScore != null && r.compositeScore >= t && r.entered !== false)
      .map(r => ({
        ret:   returnsFor(r, r.price30d != null ? 'price30d' : 'price7d'),
        bench: r.price30d != null ? r.benchRet30d : r.benchRet7d,
      }))
      .filter(x => x.ret != null && x.bench != null)
    if (rows.length < _MIN_AUTOTUNE_PICKS) continue
    const awr = +(rows.filter(x => x.ret > x.bench).length / rows.length).toFixed(3)
    if (autoTunedThresholdAlphaWinRate == null || awr > autoTunedThresholdAlphaWinRate) {
      autoTunedThresholdAlphaWinRate = awr
      autoTunedThreshold = t
    }
  }


  return {
    totalResolved: resolved.length,
    h7:  horizon('price7d',  'benchRet7d'),
    h30: horizon('price30d', 'benchRet30d'),
    h90: horizon('price90d', 'benchRet90d'),
    calibration,
    ensemble:            Object.keys(ensemble).length            ? ensemble            : null,
    baseline,
    byAssetType:         Object.keys(byAssetType).length         ? byAssetType         : null,
    bySector:            Object.keys(bySector).length            ? bySector            : null,
    byPattern:           Object.keys(byPattern).length           ? byPattern           : null,
    byRsRank:            Object.keys(byRsRank).length            ? byRsRank            : null,
    byVolumeSignal:      Object.keys(byVolumeSignal).length      ? byVolumeSignal      : null,
    earningsWindowImpact:Object.keys(earningsWindowImpact).length ? earningsWindowImpact : null,
    optionsFlowImpact:   Object.keys(optionsFlowImpact).length   ? optionsFlowImpact   : null,
    conflictImpact:      Object.keys(conflictImpact).length      ? conflictImpact      : null,
    byCompositeScore:    Object.keys(byCompositeScore).length    ? byCompositeScore    : null,
    byHighConviction:    Object.keys(byHighConviction).length    ? byHighConviction    : null,
    autoTunedThreshold,
    autoTunedThresholdAlphaWinRate,
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

Respond ONLY with a JSON object:
{
  "keyLearnings": [
    "concise actionable finding 1 (max 100 chars)",
    "concise actionable finding 2",
    ...up to 8
  ],
  "scoreWeightAdjustments": {
    "fundamentalScore": "increase|decrease|maintain — reason",
    "technicalScore":   "increase|decrease|maintain — reason",
    "sentimentScore":   "increase|decrease|maintain — reason",
    "macroScore":       "increase|decrease|maintain — reason",
    "riskScore":        "increase|decrease|maintain — reason"
  },
  "conflictSignalUseful": true|false,
  "volumeConfirmationPredictive": true|false,
  "earningsWindowRisky": true|false,
  "optionsBullishPredictive": true|false,
  "confidenceCalibrated": true|false,
  "bestCompositeThreshold": <score 0-100 above which alpha was highest>,
  "promptInjection": "2-3 sentence summary of what the Brain learned, written as a directive for the next scan",
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

    ensureDataDir()
    fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(learnings, null, 2))
    console.log(`[brain-learnings] meta-analysis complete: ${learnings.keyLearnings?.length} learnings, alpha win rate 30d=${learnings.winRate30d != null ? (learnings.winRate30d * 100).toFixed(0) + '%' : 'n/a'}`)
    return learnings
  } catch (e) {
    console.error('[brain-learnings] meta-analysis failed:', e.message)
    return null
  }
}

// ── 3. Get learnings block for prompt injection ───────────────────────────────
// Called by ai-brain.js at scan time. Returns a string to prepend to the system prompt.

function getLearningsBlock() {
  try {
    if (!fs.existsSync(LEARNINGS_FILE)) return ''
    const data = JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8'))
    if (!data?.keyLearnings?.length) return ''

    const age = Date.now() - new Date(data.updatedAt).getTime()
    const ageDays = Math.floor(age / 86400000)
    if (ageDays > 7) return '' // stale — don't inject outdated learnings

    const s = data.stats
    const fmtPct = v => v != null ? `${(v * 100).toFixed(0)}%` : 'n/a'

    const lines = [
      `\n## SELF-LEARNED INTELLIGENCE (from ${data.totalResolved} resolved predictions, updated ${ageDays}d ago)`,
      s?.h7 || s?.h30
        ? `Benchmark-beating (alpha) win rates: 7d=${fmtPct(s?.h7?.alphaWinRate)} | 30d=${fmtPct(s?.h30?.alphaWinRate)}${s?.h90 ? ` | 90d=${fmtPct(s.h90.alphaWinRate)}` : ''} · Raw win rates: 7d=${fmtPct(s?.h7?.winRate)} | 30d=${fmtPct(s?.h30?.winRate)}${s?.h90 ? ` | 90d=${fmtPct(s.h90.winRate)}` : ''}`
        : `Win rates: 7d=${fmtPct(data.winRate7d)} | 30d=${fmtPct(data.winRate30d)}`,
      s?.autoTunedThreshold != null
        ? `Auto-tuned composite score threshold: ${s.autoTunedThreshold}/100 (alpha win rate ${s.autoTunedThresholdAlphaWinRate != null ? (s.autoTunedThresholdAlphaWinRate * 100).toFixed(0) + '%' : 'n/a'} above this line) — picks below this threshold are filtered from scan output`
        : `Best composite score threshold: ${data.bestCompositeThreshold ?? 'TBD'}/100`,
      `Agent conflict signal useful: ${data.conflictSignalUseful ? 'YES — flag conflicts prominently' : 'NO — do not over-weight'}`,
      data.volumeConfirmationPredictive != null
        ? `Volume confirmation (Confirming signal) predictive: ${data.volumeConfirmationPredictive ? 'YES — prefer volumeSignal=Confirming picks' : 'NO — volume did not predict alpha'}`
        : null,
      data.earningsWindowRisky != null
        ? `Earnings-window picks (≤21d) historically ${data.earningsWindowRisky ? 'RISKIER — penalize riskScore more aggressively' : 'NOT riskier than non-earnings picks'}`
        : null,
      data.optionsBullishPredictive != null
        ? `Options P/C<0.70 bullish positioning historically ${data.optionsBullishPredictive ? 'PREDICTIVE — prefer picks with bullish options flow (P/C<0.70🟢)' : 'NOT predictive of alpha — weight options flow less'}`
        : null,
    ]

    if (s?.calibration && Object.keys(s.calibration).length) {
      lines.push('CONFIDENCE CALIBRATION (stated confidence → actual alpha win rate):')
      for (const [bucket, c] of Object.entries(s.calibration)) {
        lines.push(`  ${bucket}: ${fmtPct(c.alphaWinRate ?? c.winRate)} over ${c.n} predictions`)
      }
      if (data.confidenceCalibrated === false) {
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
        lines.push(`AGENT CONFLICT SIGNAL: picks WITH conflict historically ${fmtPct(conf.alphaWinRate ?? conf.winRate)} alpha win rate (${conf.n}×) vs ${fmtPct(noConf.alphaWinRate ?? noConf.winRate)} without conflict — ${(conf.alphaWinRate ?? conf.winRate) < (noConf.alphaWinRate ?? noConf.winRate) ? '⚠️ conflict IS a warning signal — down-weight conflicted picks' : 'conflict not predictive of worse outcomes'}`)
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
        lines.push(`HIGH-CONVICTION PICKS (≥3 independent confirming signals): ${fmtPct(hc.alphaWinRate ?? hc.winRate)} alpha win rate (${hc.n}×) vs ${fmtPct(std.alphaWinRate ?? std.winRate)} standard picks — ${(hc.alphaWinRate ?? hc.winRate) > (std.alphaWinRate ?? std.winRate) ? 'HIGH-CONVICTION IS PREDICTIVE — prioritize picks with highConviction=true' : 'high-conviction not predictive yet — insufficient data or signal quality needs improvement'}`)
      }
    }


    lines.push(
      '',
      'KEY LEARNINGS FROM PAST PREDICTIONS:',
      ...(data.keyLearnings || []).map((l, i) => `  ${i + 1}. ${l}`),
      '',
      data.promptInjection || '',
      '',
      'SCORE WEIGHT GUIDANCE:',
      ...Object.entries(data.scoreWeightAdjustments || {}).map(([k, v]) => `  ${k}: ${v}`),
    )

    return lines.filter(l => l != null).join('\n')
  } catch { return '' }
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
// Returns the grid-search-optimal composite score threshold from the last nightly
// meta-analysis, or null if learnings are stale / unavailable.
// Falls back to Claude's interpreted bestCompositeThreshold if grid-search had
// insufficient data (< 5 benchmark-matched picks above any candidate threshold).

function getAutoTunedThreshold() {
  try {
    if (!fs.existsSync(LEARNINGS_FILE)) return null
    const data = JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8'))
    if (!data?.updatedAt) return null
    const ageDays = (Date.now() - new Date(data.updatedAt).getTime()) / 86400000
    if (ageDays > 7) return null // stale — don't gate picks on outdated stats
    return data.stats?.autoTunedThreshold ?? data.bestCompositeThreshold ?? null
  } catch { return null }
}

module.exports = {
  resolveOutcomes,
  runMetaAnalysis,
  getLearningsBlock,
  getAutoTunedThreshold,
  readPredictions,
  checkEntryZones,
  // exported for unit tests
  computeStats,
  nearestClose,
  zoneTouched,
  benchmarkFor,
}
