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
 */
function trainFromRecords(records) {
  const rows = (records || [])
    .filter(r => Array.isArray(r.baselineFeatures) && r.price7d != null && r.priceAtPrediction != null)
    .map(r => ({ features: r.baselineFeatures, label: r.price7d > r.priceAtPrediction ? 1 : 0 }))
  if (rows.length < MIN_TRAIN_ROWS) {
    return { trained: false, rows: rows.length, needed: MIN_TRAIN_ROWS }
  }
  const weights = train(rows)
  if (!weights) return { trained: false, rows: rows.length, needed: MIN_TRAIN_ROWS }
  saveWeights(weights)
  return { trained: true, rows: rows.length, weights }
}

// Test hook: override in-memory weights without touching disk.
function _setWeightsForTests(w) { _weights = w }

module.exports = {
  FEATURE_NAMES, DEFAULT_WEIGHTS, MIN_TRAIN_ROWS,
  featurize, predictProb, baselineFromBars,
  train, trainFromRecords, loadWeights, saveWeights, sigmoid,
  _setWeightsForTests,
}
