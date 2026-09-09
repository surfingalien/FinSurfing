'use strict'

/**
 * lib/ml-baseline.js
 *
 * Transparent mechanical baseline for the AI Brain's calibration loop.
 *
 * Answers one question: do the AI Brain's picks beat a dumb, fully
 * inspectable model fed the same technical data? Each scan pick gets a
 * baseline 7-day direction call (logistic score over 7 TA features) logged
 * alongside it in data/ai-brain-predictions.jsonl; the nightly outcome
 * resolver then lets computeStats() compare AI win rates against baseline
 * accuracy on identical symbols and dates.
 *
 * Weights start as a fixed, documented momentum prior (DEFAULT_WEIGHTS).
 * Once ≥100 resolved records carry baseline features, the nightly
 * brain-learning cycle refits them with plain logistic regression
 * (trainFromPredictionLog) and persists to data/ml-baseline-weights.json.
 * No external dependencies; everything is unit-testable pure math.
 */

const fs   = require('fs')
const path = require('path')
const { computeRSI, computeMACD } = require('./technical-indicators')

const WEIGHTS_FILE = path.join(__dirname, '../data/ml-baseline-weights.json')
const MIN_TRAIN_ROWS = 100

// Walk-forward validation. The nightly job refits these weights unattended and
// ships the result straight into every future scan, so a refit that came out
// WORSE than what it replaced would silently degrade the benchmark the AI Brain
// is measured against — and nothing downstream would notice. The holdout is the
// newest slice by time (never a random split: shuffling would let the model fit
// on next month and be scored on last month), and a candidate must beat both
// the incumbent weights and the majority-class base rate on it before shipping.
const HOLDOUT_FRACTION = 0.25
const MIN_HOLDOUT      = 20

// Feature order is a stable contract — logged records depend on it.
const FEATURE_NAMES = [
  'rsiCentered',    // (RSI14 − 50) / 50                      ∈ ~[−1, 1]
  'macdHistPct',    // MACD histogram / last close × 100
  'smaGap20',       // last / SMA20 − 1
  'smaGap50',       // last / SMA50 − 1
  'momentum5d',     // last / close[−6] − 1
  'momentum20d',    // last / close[−21] − 1
  'volumeRatio',    // lastVol / avg20Vol − 1
]

// Fixed momentum-tilted prior: trend-following on momentum and SMA gaps,
// mild fade on stretched RSI. Chosen for transparency, not optimality —
// the point is a defensible benchmark, and training replaces it over time.
const DEFAULT_WEIGHTS = {
  bias: 0,
  w: [-0.3, 0.5, 2.0, 1.0, 3.0, 1.5, 0.1],
  trainedOn: 0,
  source: 'prior',
}

const clamp = (x, lo = -3, hi = 3) => Math.max(lo, Math.min(hi, x))
const sigmoid = z => 1 / (1 + Math.exp(-z))

function sma(closes, period) {
  if (closes.length < period) return null
  return closes.slice(-period).reduce((s, v) => s + v, 0) / period
}

// ── Featurization ─────────────────────────────────────────────────────────────
// closes/volumes ascending; needs ≥60 bars. Returns fixed-order array or null.
function featurize(closes, volumes = []) {
  if (!Array.isArray(closes) || closes.length < 60) return null
  const last = closes[closes.length - 1]
  if (!last || last <= 0) return null

  const rsi = computeRSI(closes)
  const macd = computeMACD(closes)
  const sma20 = sma(closes, 20)
  const sma50 = sma(closes, 50)
  if (rsi == null || !macd || !sma20 || !sma50) return null

  const vol20 = volumes.length >= 21 ? sma(volumes.slice(0, -1), 20) : null
  const lastVol = volumes[volumes.length - 1]

  return [
    clamp((rsi - 50) / 50, -1, 1),
    clamp((macd.histogram / last) * 100),
    clamp(last / sma20 - 1),
    clamp(last / sma50 - 1),
    clamp(last / closes[closes.length - 6] - 1),
    clamp(last / closes[closes.length - 21] - 1),
    (vol20 && lastVol != null) ? clamp(lastVol / vol20 - 1) : 0,
  ]
}

function predictProb(features, weights = loadWeights()) {
  if (!features || features.length !== FEATURE_NAMES.length) return null
  let z = weights.bias
  for (let i = 0; i < features.length; i++) z += weights.w[i] * features[i]
  return sigmoid(z)
}

// Convenience for callers holding internal-api daily bars [{c, v, ...}].
function baselineFromBars(bars) {
  if (!Array.isArray(bars) || bars.length < 60) return null
  const features = featurize(bars.map(b => b.c), bars.map(b => b.v ?? 0))
  if (!features) return null
  const prob = predictProb(features)
  return {
    prob: +prob.toFixed(4),
    dir:  prob >= 0.5 ? 'UP' : 'DOWN',
    features: features.map(f => +f.toFixed(4)),
  }
}

// ── Validation ───────────────────────────────────────────────────────────────

/**
 * Score a weight set on labelled rows. Pure.
 *
 * `accuracy` is the metric that matters operationally — callers consume
 * `dir` (UP/DOWN), a thresholded decision — while `logLoss` catches a model
 * that is right just as often but far less confident about it. `baseRate` is
 * the accuracy of always predicting the majority class: the floor any model
 * has to clear to be worth more than a constant.
 */
function evaluateWeights(weights, rows) {
  const usable = (rows || []).filter(r => Array.isArray(r.features)
    && r.features.length === FEATURE_NAMES.length && (r.label === 0 || r.label === 1))
  if (!usable.length) return null

  let correct = 0, logLoss = 0, positives = 0
  for (const { features, label } of usable) {
    const p = predictProb(features, weights)
    if (p == null) continue
    if ((p >= 0.5 ? 1 : 0) === label) correct++
    // Clamp away from 0/1 so a single confident miss can't return Infinity.
    const clamped = Math.min(Math.max(p, 1e-9), 1 - 1e-9)
    logLoss += -(label * Math.log(clamped) + (1 - label) * Math.log(1 - clamped))
    positives += label
  }
  const n = usable.length
  const majority = Math.max(positives, n - positives)
  return {
    n,
    accuracy: +(correct / n).toFixed(4),
    logLoss:  +(logLoss / n).toFixed(4),
    baseRate: +(majority / n).toFixed(4),
  }
}

/**
 * Split time-ordered rows into an older training set and a newer holdout.
 * Rows are sorted by `at` ascending first, so callers need not pre-sort.
 * Returns null when either side would be too small to mean anything.
 */
function splitByTime(rows, { holdoutFraction = HOLDOUT_FRACTION, minHoldout = MIN_HOLDOUT } = {}) {
  const sorted = [...(rows || [])].sort((a, b) => (a.at ?? 0) - (b.at ?? 0))
  const holdoutSize = Math.max(minHoldout, Math.round(sorted.length * holdoutFraction))
  const trainSize   = sorted.length - holdoutSize
  if (holdoutSize < minHoldout || trainSize < minHoldout) return null
  return { train: sorted.slice(0, trainSize), holdout: sorted.slice(trainSize) }
}

// ── Training: plain batch-gradient logistic regression with L2 ───────────────
// rows: [{ features: [...], label: 0|1 }]
function train(rows, { epochs = 300, lr = 0.1, l2 = 0.01 } = {}) {
  const usable = rows.filter(r => Array.isArray(r.features)
    && r.features.length === FEATURE_NAMES.length && (r.label === 0 || r.label === 1))
  if (usable.length < 10) return null

  let bias = 0
  let w = new Array(FEATURE_NAMES.length).fill(0)
  const n = usable.length

  for (let e = 0; e < epochs; e++) {
    let gb = 0
    const gw = new Array(w.length).fill(0)
    for (const { features, label } of usable) {
      let z = bias
      for (let i = 0; i < w.length; i++) z += w[i] * features[i]
      const err = sigmoid(z) - label
      gb += err
      for (let i = 0; i < w.length; i++) gw[i] += err * features[i]
    }
    bias -= lr * (gb / n)
    for (let i = 0; i < w.length; i++) w[i] -= lr * (gw[i] / n + l2 * w[i])
  }

  return {
    bias: +bias.toFixed(6),
    w: w.map(x => +x.toFixed(6)),
    trainedOn: n,
    source: 'trained',
    trainedAt: new Date().toISOString(),
  }
}

// ── Weight persistence ────────────────────────────────────────────────────────
let _weights = null
function loadWeights() {
  if (_weights) return _weights
  try {
    const j = JSON.parse(fs.readFileSync(WEIGHTS_FILE, 'utf8'))
    if (Array.isArray(j.w) && j.w.length === FEATURE_NAMES.length) { _weights = j; return j }
  } catch { /* fall through to prior */ }
  _weights = DEFAULT_WEIGHTS
  return _weights
}

function saveWeights(weights) {
  try {
    fs.mkdirSync(path.dirname(WEIGHTS_FILE), { recursive: true })
    fs.writeFileSync(WEIGHTS_FILE, JSON.stringify(weights, null, 2))
    _weights = weights
  } catch (e) { console.warn('[ml-baseline] saveWeights failed:', e.message) }
}

/**
 * Refit weights from resolved prediction records (called by the nightly
 * brain-learning cycle). A record trains on the 7d outcome: label = 1 when
 * price7d > priceAtPrediction. No-op until MIN_TRAIN_ROWS rows exist.
 *
 * WALK-FORWARD WITH A PROMOTION GATE. This runs unattended every night and
 * whatever it saves becomes the benchmark every future scan is scored against,
 * so "refit succeeded" is not the same question as "refit is better". The
 * sequence:
 *
 *   1. Hold out the NEWEST slice by time (never a random split — shuffling
 *      would train on next month to predict last month, and the resulting
 *      accuracy would be fiction).
 *   2. Fit a candidate on the older rows only.
 *   3. Score the candidate, the incumbent weights, and the majority-class
 *      base rate on that untouched holdout.
 *   4. Ship only if the candidate beats BOTH. Otherwise keep the incumbent
 *      and say why.
 *   5. On promotion, refit on ALL rows before saving — the holdout proved the
 *      procedure works, and the shipped model should not be denied the most
 *      recent quarter of evidence. Validation metrics ride along on the saved
 *      weights so a later reader can see what the decision was based on.
 *
 * Returns `{ trained, promoted, rows, validation, reason }`; `trained` stays
 * true whenever a fit ran, so callers can distinguish "no data yet" from
 * "fit ran and was rejected".
 */
function trainFromRecords(records) {
  const rows = (records || [])
    .filter(r => Array.isArray(r.baselineFeatures) && r.price7d != null && r.priceAtPrediction != null)
    .map(r => ({
      features: r.baselineFeatures,
      label:    r.price7d > r.priceAtPrediction ? 1 : 0,
      at:       new Date(r.generatedAt ?? 0).getTime() || 0,
    }))
  if (rows.length < MIN_TRAIN_ROWS) {
    return { trained: false, promoted: false, rows: rows.length, needed: MIN_TRAIN_ROWS }
  }

  const split = splitByTime(rows)
  if (!split) {
    return { trained: false, promoted: false, rows: rows.length, needed: MIN_TRAIN_ROWS,
             reason: 'not enough rows to hold out a validation slice' }
  }

  const candidate = train(split.train)
  if (!candidate) {
    return { trained: false, promoted: false, rows: rows.length, needed: MIN_TRAIN_ROWS,
             reason: 'candidate fit produced no weights' }
  }

  const incumbent    = loadWeights()
  const candScore    = evaluateWeights(candidate, split.holdout)
  const incumbScore  = evaluateWeights(incumbent, split.holdout)
  if (!candScore || !incumbScore) {
    return { trained: true, promoted: false, rows: rows.length,
             reason: 'holdout could not be scored' }
  }

  const validation = {
    holdoutN:  candScore.n,
    trainN:    split.train.length,
    candidate: { accuracy: candScore.accuracy,   logLoss: candScore.logLoss },
    incumbent: { accuracy: incumbScore.accuracy, logLoss: incumbScore.logLoss },
    baseRate:  candScore.baseRate,
    validatedAt: new Date().toISOString(),
  }

  // Beating the base rate proves the features carry signal; matching or beating
  // the incumbent proves this refit is not a regression. A tie with the
  // incumbent promotes — later data is worth having when nothing is lost.
  if (candScore.accuracy <= candScore.baseRate) {
    return { trained: true, promoted: false, rows: rows.length, validation,
             reason: `holdout accuracy ${candScore.accuracy} did not beat base rate ${candScore.baseRate}` }
  }
  if (candScore.accuracy < incumbScore.accuracy) {
    return { trained: true, promoted: false, rows: rows.length, validation,
             reason: `holdout accuracy ${candScore.accuracy} below incumbent ${incumbScore.accuracy}` }
  }

  // Validated — refit on everything (including the holdout) and ship that.
  const shipped = train(rows)
  if (!shipped) {
    return { trained: true, promoted: false, rows: rows.length, validation,
             reason: 'final fit on full data produced no weights' }
  }
  const weights = { ...shipped, validation }
  saveWeights(weights)
  return { trained: true, promoted: true, rows: rows.length, validation, weights }
}

// Test hook: override in-memory weights without touching disk.
function _setWeightsForTests(w) { _weights = w }

module.exports = {
  FEATURE_NAMES, DEFAULT_WEIGHTS, MIN_TRAIN_ROWS, HOLDOUT_FRACTION, MIN_HOLDOUT,
  featurize, predictProb, baselineFromBars,
  train, trainFromRecords, loadWeights, saveWeights, sigmoid,
  evaluateWeights, splitByTime,
  _setWeightsForTests,
}
