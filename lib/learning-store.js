'use strict'
/**
 * lib/learning-store.js
 *
 * ONE memory, many surfaces.
 *
 * The AI Brain already had a real learning loop (lib/brain-learnings.js): log a
 * prediction → resolve the outcome against real bars → compute calibration →
 * inject it back into the next scan. But every OTHER surface that makes a call
 * — Advisory recommendations, Strategy Lab, the paper broker, Copilot — threw
 * its decisions away. Five surfaces each learning from a fifth of the data
 * learn far less than one substrate learning from all of it.
 *
 * This is that substrate: a single append-only decision log every surface
 * writes to, with outcomes resolved against the same price history and
 * calibration computed per-surface AND across all of them. Cross-surface
 * calibration is what makes the system compound: "Advisory picks in Energy
 * have a 34% win rate" is a fact no single surface could have discovered on
 * its own.
 *
 * Design constraints kept deliberately:
 *   - append-only JSONL, same pattern as the prediction log (crash-safe, no DB)
 *   - all statistics computed in CODE; the LLM interprets, never calculates
 *   - pure functions separated from I/O so the math is unit-testable
 *   - it AUGMENTS brain-learnings rather than replacing it — the Brain's
 *     existing loop keeps working untouched
 *
 * Tests: tests/learning-store.test.js
 */

const fs   = require('fs')
const path = require('path')

const DATA_DIR      = path.join(__dirname, '../data')
const DECISION_LOG  = path.join(DATA_DIR, 'learning-store.jsonl')

// Surfaces allowed to write. A fixed list keeps segment names from drifting
// ('brain' vs 'ai-brain' vs 'AI Brain' would fragment calibration silently —
// exactly the bug already fixed once for assetType).
const SURFACES = ['ai-brain', 'advisory', 'strategy-lab', 'paper-broker', 'copilot', 'trading-analysis']

// Minimum resolved decisions before a calibration figure is reported at all.
// Below this, a win rate is noise and must not steer anything.
const MIN_SAMPLE = 8

// ── Record shape ──────────────────────────────────────────────────────────────

/**
 * Build a decision record. Pure — caller persists it.
 * @param {object} o
 * @param {string} o.surface   — one of SURFACES
 * @param {string} o.symbol
 * @param {string} o.action    — 'buy' | 'sell' | 'hold' | free-form verdict
 * @param {number} [o.price]   — price at decision time (the honest anchor)
 * @param {string} [o.confidence] — 'High' | 'Medium' | 'Low'
 * @param {object} [o.meta]    — surface-specific extras (sector, persona, score…)
 */
function buildDecision({ surface, symbol, action, price = null, confidence = null, meta = {}, at = null }) {
  if (!SURFACES.includes(surface)) throw new Error(`Unknown surface: ${surface}`)
  return {
    surface,
    symbol:     String(symbol || '').toUpperCase(),
    action:     String(action || '').toLowerCase(),
    price:      price != null ? Number(price) : null,
    confidence: confidence || null,
    meta:       meta && typeof meta === 'object' ? meta : {},
    at:         at || new Date().toISOString(),
    // Filled by the nightly resolver
    outcome:    null,   // { at, price, retPct, benchRetPct, horizonDays }
  }
}

/** Attach a resolved outcome to a decision. Pure. */
function resolveDecision(decision, { price, benchRetPct = null, horizonDays, at = null }) {
  const base = decision?.price
  if (!(base > 0) || !(price > 0)) return decision
  const retPct = +(((price - base) / base) * 100).toFixed(2)
  return {
    ...decision,
    outcome: {
      at: at || new Date().toISOString(),
      price: Number(price),
      retPct,
      benchRetPct: benchRetPct != null ? Number(benchRetPct) : null,
      horizonDays,
    },
  }
}

// ── Calibration (pure math over resolved decisions) ──────────────────────────

// A decision "won" if it made money in its intended direction; for a sell/avoid
// call, a price DROP is the correct call. Treating every record as a buy would
// score correct bearish calls as losses.
function wasCorrect(d) {
  const ret = d?.outcome?.retPct
  if (ret == null) return null
  if (d.action === 'sell' || d.action === 'avoid' || d.action === 'reduce') return ret < 0
  if (d.action === 'hold') return null // no directional claim to score
  return ret > 0
}

// Beat its benchmark in the intended direction.
function beatBenchmark(d) {
  const ret = d?.outcome?.retPct
  const bench = d?.outcome?.benchRetPct
  if (ret == null || bench == null) return null
  if (d.action === 'sell' || d.action === 'avoid' || d.action === 'reduce') return ret < bench
  if (d.action === 'hold') return null
  return ret > bench
}

const rate = (rows, pred) => {
  const scored = rows.map(pred).filter(v => v !== null)
  return scored.length ? +(scored.filter(Boolean).length / scored.length).toFixed(3) : null
}
const avg = (rows, f) => {
  const vals = rows.map(f).filter(v => typeof v === 'number' && Number.isFinite(v))
  return vals.length ? +(vals.reduce((s, v) => s + v, 0) / vals.length).toFixed(2) : null
}

/** Calibration for one set of resolved decisions. */
function calibrate(rows, { minSample = MIN_SAMPLE } = {}) {
  const resolved = (rows || []).filter(d => d?.outcome?.retPct != null)
  if (resolved.length < minSample) {
    return { n: resolved.length, sufficient: false, winRate: null, alphaWinRate: null, avgReturn: null, avgAlpha: null }
  }
  return {
    n:            resolved.length,
    sufficient:   true,
    winRate:      rate(resolved, wasCorrect),
    alphaWinRate: rate(resolved, beatBenchmark),
    avgReturn:    avg(resolved, d => d.outcome.retPct),
    avgAlpha:     avg(resolved, d => d.outcome.benchRetPct != null ? d.outcome.retPct - d.outcome.benchRetPct : null),
  }
}

/**
 * Full cross-surface calibration report.
 * `overall` spans every surface — the compounding view that no single surface
 * could compute alone — plus per-surface, per-confidence and per-symbol splits.
 */
function calibrationReport(decisions, { minSample = MIN_SAMPLE } = {}) {
  const all = (decisions || []).filter(d => d?.outcome?.retPct != null)

  const bySurface = {}
  for (const s of SURFACES) {
    const rows = all.filter(d => d.surface === s)
    if (rows.length) bySurface[s] = calibrate(rows, { minSample })
  }

  const byConfidence = {}
  for (const c of ['High', 'Medium', 'Low']) {
    const rows = all.filter(d => d.confidence === c)
    if (rows.length) byConfidence[c] = calibrate(rows, { minSample })
  }

  // Symbols the system has repeatedly been wrong (or right) about
  const symbolCounts = {}
  for (const d of all) symbolCounts[d.symbol] = (symbolCounts[d.symbol] || 0) + 1
  const bySymbol = {}
  for (const [sym] of Object.entries(symbolCounts).sort((a, b) => b[1] - a[1]).slice(0, 10)) {
    const rows = all.filter(d => d.symbol === sym)
    const c = calibrate(rows, { minSample })
    if (c.sufficient) bySymbol[sym] = c
  }

  return {
    totalDecisions: (decisions || []).length,
    totalResolved:  all.length,
    overall:        calibrate(all, { minSample }),
    bySurface:      Object.keys(bySurface).length    ? bySurface    : null,
    byConfidence:   Object.keys(byConfidence).length ? byConfidence : null,
    bySymbol:       Object.keys(bySymbol).length     ? bySymbol     : null,
  }
}

/**
 * Compact prompt-injection block. '' when nothing is measured yet — an
 * unproven system must not narrate confidence it hasn't earned.
 */
function buildCalibrationBlock(report) {
  if (!report?.overall?.sufficient) return ''
  const pct = v => v != null ? `${Math.round(v * 100)}%` : 'n/a'
  const lines = [
    `\n\nCROSS-SURFACE CALIBRATION (measured over ${report.totalResolved} resolved decisions from every AI surface — computed in code, not estimated):`,
    `Overall: win rate ${pct(report.overall.winRate)}, benchmark-beating ${pct(report.overall.alphaWinRate)}, avg return ${report.overall.avgReturn}%`,
  ]
  if (report.bySurface) {
    const parts = Object.entries(report.bySurface)
      .filter(([, c]) => c.sufficient)
      .map(([s, c]) => `${s} ${pct(c.alphaWinRate ?? c.winRate)} (n=${c.n})`)
    if (parts.length) lines.push('By surface: ' + parts.join(' | '))
  }
  if (report.byConfidence) {
    const parts = Object.entries(report.byConfidence)
      .filter(([, c]) => c.sufficient)
      .map(([k, c]) => `${k} ${pct(c.alphaWinRate ?? c.winRate)} (n=${c.n})`)
    if (parts.length) lines.push('By stated confidence: ' + parts.join(' | ') + ' — if High is not beating Low, your confidence is not calibrated; say so and be conservative.')
  }
  if (report.bySymbol) {
    const weak = Object.entries(report.bySymbol)
      .filter(([, c]) => c.winRate != null && c.winRate < 0.4)
      .map(([s, c]) => `${s} ${pct(c.winRate)} (n=${c.n})`)
    if (weak.length) lines.push('Repeatedly WRONG on: ' + weak.join(', ') + ' — require stronger evidence before picking these again.')
  }
  return lines.join('\n')
}

// ── File I/O ──────────────────────────────────────────────────────────────────

function ensureDir(file) {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readDecisions(file = DECISION_LOG) {
  try {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

function writeDecisions(rows, file = DECISION_LOG) {
  try {
    ensureDir(file)
    fs.writeFileSync(file, rows.map(r => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''))
    return true
  } catch (e) {
    console.warn('[learning-store] write failed:', e.message)
    return false
  }
}

/**
 * Record a decision from any surface. Best-effort and never throws to the
 * caller — a logging failure must never break a user-facing response.
 */
function recordDecision(input, file = DECISION_LOG) {
  try {
    const decision = buildDecision(input)
    ensureDir(file)
    fs.appendFileSync(file, JSON.stringify(decision) + '\n')
    return decision
  } catch (e) {
    console.warn('[learning-store] recordDecision failed:', e.message)
    return null
  }
}

/** Record many decisions at once (one scan / one advisory run). */
function recordDecisions(inputs, file = DECISION_LOG) {
  let n = 0
  for (const i of inputs || []) { if (recordDecision(i, file)) n++ }
  return n
}

/** Calibration over the persisted log. */
function getCalibration(opts = {}) {
  try { return calibrationReport(readDecisions(), opts) } catch {
    return { totalDecisions: 0, totalResolved: 0, overall: calibrate([]), bySurface: null, byConfidence: null, bySymbol: null }
  }
}

/** Prompt-injection block over the persisted log. '' on any failure. */
function getCalibrationBlock(opts = {}) {
  try { return buildCalibrationBlock(getCalibration(opts)) } catch { return '' }
}

/** Decisions still awaiting outcome resolution at the given horizon. */
function pendingDecisions(decisions, { horizonDays = 7, now = Date.now() } = {}) {
  const cutoff = now - horizonDays * 86400000
  return (decisions || []).filter(d =>
    d && !d.outcome && d.price > 0 && new Date(d.at).getTime() <= cutoff)
}

module.exports = {
  DECISION_LOG, SURFACES, MIN_SAMPLE,
  // pure
  buildDecision, resolveDecision, wasCorrect, beatBenchmark,
  calibrate, calibrationReport, buildCalibrationBlock, pendingDecisions,
  // io
  readDecisions, writeDecisions, recordDecision, recordDecisions,
  getCalibration, getCalibrationBlock,
}
