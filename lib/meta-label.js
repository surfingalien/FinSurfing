'use strict'

/**
 * lib/meta-label.js — a second opinion on each AI Brain pick: given that the
 * scan said "buy", will this one reach its target before its stop?
 *
 * López de Prado's meta-labelling (Advances in Financial ML, ch. 3): the
 * primary model picks the side; a secondary model, trained on the primary's
 * own resolved record, decides whether to act. The labels already exist —
 * every resolved prediction carries a triple-barrier label (target / stop /
 * time) — and so do the inputs, because everything below is stamped on the
 * prediction AT SCAN TIME. Nothing known only afterwards is a feature.
 *
 * Gate (same shape as calibration-stats.validateThreshold and the ML
 * baseline's walk-forward promotion): the model and its cut-off are fitted on
 * the OLDER 70% of labelled picks; it is adopted only if, on the newest 30% it
 * never saw, the picks it keeps hit target-first more often than all picks did
 * — by the Wilson LOWER bound, so a lucky holdout does not count — while still
 * keeping at least MIN_COVERAGE of them. Not adopted ⇒ it filters nothing;
 * its probability is still logged on each pick so the next refit can judge it.
 *
 * Pure except the store I/O. Tests: tests/meta-label.test.js
 */

const path = require('path')
const { wilson } = require('./calibration-stats')

const FEATURES = [
  'composite', 'confHigh', 'confLow', 'ensemble', 'highConviction', 'rsRank',
  'volumeConfirming', 'regimeUp', 'regimeStressed', 'crypto', 'rewardRisk', 'stopPct',
  'baselineEdge', 'earningsSoon',
]
const MIN_ROWS = 150
const HOLDOUT_FRAC = 0.3
const MIN_COVERAGE = 0.2
const MIN_KEPT = 15
// Cut-offs are chosen by the SHARE of picks kept, not by fixed probabilities:
// a lightly-regularised logistic squeezes its outputs together, and a fixed
// 0.5 can keep everything or nothing.
const KEEP_SHARES = [0.2, 0.3, 0.4, 0.5, 0.6]

const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const num = v => (Number.isFinite(Number(v)) ? Number(v) : null)

/** Scan-time features of a prediction record (or a live pick shaped like one). Pure. */
function featurize(r) {
  const conf = String(r.confidence || '').toLowerCase()
  const regime = String(r.priceRegimeAtScan || '')
  const tr = num(r.targetReturn), sl = num(r.stopLoss)
  return [
    clip((num(r.compositeScore) ?? 50) / 100, 0, 1),
    conf === 'high' ? 1 : 0,
    conf === 'low' ? 1 : 0,
    r.ensembleConfirmed === true ? 1 : 0,
    r.highConviction === true ? 1 : 0,
    clip((num(r.rsRankAtScan) ?? 50) / 100, 0, 1),
    r.volumeSignal === 'Confirming' ? 1 : 0,
    regime.startsWith('up') ? 1 : 0,
    regime.endsWith('stressed') ? 1 : 0,
    r.assetType === 'crypto' ? 1 : 0,
    tr > 0 && sl > 0 ? clip(tr / sl, 0, 5) / 5 : 0,
    sl > 0 ? clip(sl, 0, 30) / 30 : 0,
    clip((num(r.baselineProb) ?? 0.5) - 0.5, -0.5, 0.5),
    num(r.daysToEarnings) != null && r.daysToEarnings >= 0 && r.daysToEarnings <= 10 ? 1 : 0,
  ]
}

/** 1 = reached its target first (or ended up at 30d); 0 = stopped or ended down; null = not a trade / unresolved. */
// Only a label measured over the pick's OWN horizon (brain-learnings
// onOwnHorizon): a 6-month target judged over 30 days was a label about the
// window, not the pick. 'Neither' takes the sign at the horizon.
function labelOf(r) {
  if (r.entered === false || !r.barrier?.label) return null
  if (!(Number(r.horizonDays) > 0) || r.barrier.window !== Number(r.horizonDays)) return null
  if (r.barrier.label === 'target') return 1
  if (r.barrier.label === 'stop') return 0
  const base = r.basePrice ?? r.priceAtPrediction ?? r.entryZoneMid
  return base && r.priceHorizon != null ? (r.priceHorizon > base ? 1 : 0) : null
}

function rowsFrom(records) {
  return (records || [])
    .map(r => ({ at: Date.parse(r.generatedAt), x: featurize(r), y: labelOf(r) }))
    .filter(r => r.y != null && Number.isFinite(r.at))
    .sort((a, b) => a.at - b.at)
}

const sigmoid = z => 1 / (1 + Math.exp(-z))

function fit(rows, { epochs = 800, lr = 0.5, l2 = 0.01 } = {}) {
  let b = 0
  const w = new Array(FEATURES.length).fill(0)
  for (let e = 0; e < epochs; e++) {
    let gb = 0
    const gw = new Array(w.length).fill(0)
    for (const { x, y } of rows) {
      const err = sigmoid(b + w.reduce((a, wi, i) => a + wi * x[i], 0)) - y
      gb += err
      for (let i = 0; i < w.length; i++) gw[i] += err * x[i]
    }
    b -= lr * gb / rows.length
    for (let i = 0; i < w.length; i++) w[i] -= lr * (gw[i] / rows.length + l2 * w[i])
  }
  return { bias: +b.toFixed(6), w: w.map(v => +v.toFixed(6)) }
}

function prob(model, x) {
  if (!model?.w || model.w.length !== x.length) return null
  return sigmoid(model.bias + model.w.reduce((a, wi, i) => a + wi * x[i], 0))
}

/** Highest-precision cut-off on the TRAINING rows among the KEEP_SHARES quantiles. */
function chooseCutoff(model, rows) {
  const probs = rows.map(r => prob(model, r.x)).sort((a, b) => b - a)
  let best = null
  for (const share of KEEP_SHARES) {
    const t = probs[Math.max(0, Math.ceil(rows.length * share) - 1)]
    const kept = rows.filter(r => prob(model, r.x) >= t)
    if (kept.length < rows.length * MIN_COVERAGE) continue
    const precision = kept.reduce((a, r) => a + r.y, 0) / kept.length
    if (!best || precision > best.precision) best = { cutoff: +t.toFixed(6), precision, share }
  }
  return best
}

/**
 * Fit, validate walk-forward, and decide. Returns the model record to save:
 * { validated, reason, cutoff, bias, w, features, validation, trainedOn, trainedAt }.
 */
function trainFromRecords(records, { now = new Date(), minRows = MIN_ROWS } = {}) {
  const rows = rowsFrom(records)
  const base = { features: FEATURES, trainedAt: now.toISOString(), labelled: rows.length }
  if (rows.length < minRows) return { ...base, validated: false, reason: `${rows.length} labelled picks (need ${minRows})` }

  const cut = Math.floor(rows.length * (1 - HOLDOUT_FRAC))
  const train = rows.slice(0, cut), hold = rows.slice(cut)
  const candidate = fit(train)
  const pick = chooseCutoff(candidate, train)
  if (!pick) return { ...base, validated: false, reason: 'no cut-off keeps enough training picks' }

  const kept = hold.filter(r => prob(candidate, r.x) >= pick.cutoff)
  const hits = kept.reduce((a, r) => a + r.y, 0)
  const baseRate = hold.reduce((a, r) => a + r.y, 0) / hold.length
  const ci = kept.length ? wilson(hits, kept.length) : null
  const validation = {
    holdout: hold.length, baseRate: +baseRate.toFixed(3),
    kept: kept.length, coverage: +(kept.length / hold.length).toFixed(2),
    precision: kept.length ? +(hits / kept.length).toFixed(3) : null,
    precisionLo: ci ? +ci.lo.toFixed(3) : null,
  }
  // The newer picks can hold fewer of the "good" kind than training did, so the
  // coverage floor here is half the training one; the Wilson lower bound is the
  // real guard against a small lucky kept set.
  const enough = kept.length >= Math.max(MIN_KEPT, hold.length * MIN_COVERAGE / 2)
  const validated = enough && ci != null && ci.lo > baseRate
  // The holdout proved the procedure; ship a model refitted on everything so
  // it does not discard the most recent evidence (same as the ML baseline).
  const final = validated ? fit(rows) : candidate
  return {
    ...base, ...final, cutoff: pick.cutoff, validated, validation, trainedOn: validated ? rows.length : train.length,
    reason: validated
      ? `kept picks hit target-first ${(validation.precision * 100).toFixed(0)}% (lower bound ${(validation.precisionLo * 100).toFixed(0)}%) vs ${(baseRate * 100).toFixed(0)}% for all picks, keeping ${(validation.coverage * 100).toFixed(0)}%`
      : !enough
        ? `kept only ${kept.length} of ${hold.length} newer picks`
        : `kept picks hit ${(validation.precision * 100).toFixed(0)}% (lower bound ${(validation.precisionLo * 100).toFixed(0)}%) — not clearly above ${(baseRate * 100).toFixed(0)}% for all picks`,
  }
}

/** The second opinion on one live pick: { prob, pass, validated } or null with no model. */
function assess(model, pickLike) {
  const p = prob(model, featurize(pickLike))
  if (p == null) return null
  return { prob: +p.toFixed(3), pass: p >= (model.cutoff ?? 0.5), validated: !!model.validated }
}

// ── Store ────────────────────────────────────────────────────────────────────
const MODEL_FILE = path.join(require('./data-dir').DATA_DIR, 'meta-label.json')

function loadModel(file = MODEL_FILE) {
  try { return JSON.parse(require('fs').readFileSync(file, 'utf8')) } catch { return null }
}

function saveModel(model, file = MODEL_FILE) {
  require('fs').mkdirSync(path.dirname(file), { recursive: true })
  require('./atomic-write').writeJsonAtomic(file, model)
}

module.exports = {
  FEATURES, MIN_ROWS, MIN_COVERAGE, MODEL_FILE,
  featurize, labelOf, rowsFrom, fit, prob, chooseCutoff, trainFromRecords, assess, loadModel, saveModel,
}
