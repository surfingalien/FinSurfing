'use strict'
/**
 * lib/score-weights.js — learned weights for the AI Brain's composite score,
 * adopted only when they rank NEWER picks better than the stated weights.
 *
 * The scan orders picks by a composite of five model-rated scores with fixed,
 * hand-set weights (fundamental 25%, technical 20%, sentiment 15%, macro 20%,
 * risk 20% — price-coherence.COMPOSITE_WEIGHTS). Nothing tested them.
 *
 * Nightly, over resolved predictions counted once per outcome window
 * (calibration-stats.independentPicks), in time order:
 *   1. older 70%: every weight vector on a 0.1 grid of the simplex (1,001 of
 *      them) is scored by the Spearman correlation of its composite with the
 *      realised outcome (alpha vs the benchmark when known, else return); the
 *      best is the candidate.
 *   2. newest 30%, never seen: the candidate's correlation minus the stated
 *      weights' correlation, with a seeded bootstrap of the holdout picks. It is
 *      ADOPTED only when the bootstrap's 5th percentile of that difference is
 *      above zero AND the candidate's own holdout correlation is positive.
 *   3. on adoption the weights are refitted on ALL rows (the holdout proved the
 *      procedure) and stored. Otherwise nothing changes and `reason` says why.
 * Adoption is re-decided every night, so a set that stops holding is dropped.
 *
 * The scan then orders its actionable picks by `rankScore` (the learned
 * composite) and says so; the stated compositeScore is still shown.
 *
 * Tests: tests/score-weights.test.js
 */

const path = require('path')
const atomic = require('./atomic-write')
const { independentPicks } = require('./calibration-stats')
const { spearman } = require('./factor-mining')     // plain coefficient (null below 3 points)

const FILE = path.join(require('./data-dir').DATA_DIR, 'score-weights.json')
const FIELDS = ['fundamentalScore', 'technicalScore', 'sentimentScore', 'macroScore', 'riskScore']
const STATED = { fundamentalScore: 0.25, technicalScore: 0.20, sentimentScore: 0.15, macroScore: 0.20, riskScore: 0.20 }
const MIN_TRAIN = 60
const MIN_HOLDOUT = 30
const BOOT = 1000

/** Every weight vector on a `step` grid of the simplex. */
function simplexGrid(k = FIELDS.length, step = 0.1) {
  const units = Math.round(1 / step), out = []
  const rec = (left, parts) => {
    if (parts.length === k - 1) { out.push([...parts, left].map(u => +(u * step).toFixed(2))); return }
    for (let u = 0; u <= left; u++) rec(left - u, [...parts, u])
  }
  rec(units, [])
  return out
}

const composite = (r, w) => FIELDS.reduce((a, f, i) => a + Number(r[f]) * (Array.isArray(w) ? w[i] : w[f]), 0)

/** Rows with all five scores and a resolved outcome at the horizon. */
function rowsFrom(predictions, { horizon = null } = {}) {
  const ok = r => FIELDS.every(f => Number.isFinite(Number(r?.[f])) && r[f] != null)
  const out = (r, h) => {
    const base = r.basePrice ?? r.priceAtPrediction ?? r.entryZoneMid
    const px = r[`price${h}d`]
    if (!base || px == null) return null
    const ret = (px - base) / base * 100
    const bench = r[`benchRet${h}d`]
    return bench != null ? ret - bench : ret
  }
  const has30 = (predictions || []).filter(r => ok(r) && out(r, 30) != null).length
  const h = horizon || (has30 >= MIN_TRAIN + MIN_HOLDOUT ? 30 : 7)
  const resolved = (predictions || []).filter(r => ok(r) && out(r, h) != null && r.actionable !== false && r.entered !== false)
  const thin = independentPicks(resolved, h).sort((a, b) => Date.parse(a.generatedAt) - Date.parse(b.generatedAt))
  return { horizon: h, rows: thin.map(r => ({ ...Object.fromEntries(FIELDS.map(f => [f, Number(r[f])])), out: out(r, h), t: r.generatedAt })) }
}

function bestOn(rows, grid) {
  let best = null
  const y = rows.map(r => r.out)
  for (const w of grid) {
    const rho = spearman(rows.map(r => composite(r, w)), y)
    if (rho != null && (!best || rho > best.rho)) best = { w, rho }
  }
  return best
}

function rng(seed) { let s = seed >>> 0 || 1; return () => { s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0; return s / 4294967296 } }

/** Train / validate / maybe adopt. Pure apart from nothing — returns the store body. */
function fit(predictions, { now = Date.now(), seed = 11 } = {}) {
  const { horizon, rows } = rowsFrom(predictions)
  const base = { at: new Date(now).toISOString(), horizon, n: rows.length, stated: STATED, adopted: false, weights: null }
  const cut = Math.floor(rows.length * 0.7)
  if (cut < MIN_TRAIN || rows.length - cut < MIN_HOLDOUT) {
    return { ...base, reason: `${rows.length} independent resolved picks with all five scores — ${MIN_TRAIN + MIN_HOLDOUT} needed (${MIN_TRAIN} to fit, ${MIN_HOLDOUT} to test)` }
  }
  const grid = simplexGrid()
  const train = rows.slice(0, cut), hold = rows.slice(cut)
  const cand = bestOn(train, grid)
  const statedW = FIELDS.map(f => STATED[f])
  const rhoOn = (rs, w) => spearman(rs.map(r => composite(r, w)), rs.map(r => r.out))
  const candHold = rhoOn(hold, cand.w), statedHold = rhoOn(hold, statedW)
  const r = rng(seed), diffs = []
  for (let b = 0; b < BOOT; b++) {
    const s = Array.from({ length: hold.length }, () => hold[Math.floor(r() * hold.length)])
    const a = rhoOn(s, cand.w), c = rhoOn(s, statedW)
    if (a != null && c != null) diffs.push(a - c)
  }
  diffs.sort((x, y) => x - y)
  const lo = diffs.length ? diffs[Math.floor(diffs.length * 0.05)] : null
  const validation = {
    train: train.length, holdout: hold.length,
    candidate: Object.fromEntries(FIELDS.map((f, i) => [f, cand.w[i]])),
    trainRho: +cand.rho.toFixed(3), holdoutRho: candHold == null ? null : +candHold.toFixed(3),
    statedHoldoutRho: statedHold == null ? null : +statedHold.toFixed(3),
    diffP5: lo == null ? null : +lo.toFixed(3),
  }
  if (!(lo > 0) || !(candHold > 0)) {
    return { ...base, validation, reason: `the weights fitted on older picks did not rank the newest ${hold.length} better than the stated weights (holdout ρ ${validation.holdoutRho} vs ${validation.statedHoldoutRho}; 5th percentile of the gain ${validation.diffP5}) — stated weights kept` }
  }
  const all = bestOn(rows, grid)
  return { ...base, adopted: true, weights: Object.fromEntries(FIELDS.map((f, i) => [f, all.w[i]])), validation, reason: `ranked the newest ${hold.length} picks better than the stated weights (ρ ${validation.holdoutRho} vs ${validation.statedHoldoutRho})` }
}

function load(file = FILE) {
  try { return JSON.parse(require('fs').readFileSync(file, 'utf8')) } catch { return null }
}
function train(predictions, { file = FILE, ...o } = {}) {
  const body = fit(predictions, o)
  atomic.writeJsonAtomic(file, body)
  return body
}

/** The learned composite for one pick, or null when no adopted weights / a score is missing. */
function rankScoreFor(store, pick) {
  if (!store?.adopted || !store.weights) return null
  if (!FIELDS.every(f => Number.isFinite(Number(pick?.[f])) && pick[f] != null)) return null
  return Math.round(composite(pick, store.weights))
}

module.exports = { FILE, FIELDS, STATED, MIN_TRAIN, MIN_HOLDOUT, simplexGrid, rowsFrom, fit, train, load, rankScoreFor }
