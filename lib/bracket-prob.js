'use strict'

/**
 * lib/bracket-prob.js — the win probability a bracket trade is actually sized on.
 *
 * Kelly sizing and the expected-value gate pay W (the target) on a win and L
 * (the stop) on a loss. The probability fed to them was the 30-day "beat the
 * benchmark" (else up) rate — a fixed-horizon question. A pick that hit its
 * target on day 3 and round-tripped counted as a loss; one that blew through
 * its stop and recovered counted as a win. The event the payoffs describe is
 * the BRACKET outcome, which every resolved prediction already carries
 * (triple-barrier label): target first = win, stop first = loss, neither by
 * day 30 = the sign of where it ended (lib/meta-label.js:labelOf — the same
 * label the second-opinion model is trained on).
 *
 * Forecasting work on LLM probabilities (AIA Forecaster 2025; Beta-Bernoulli
 * calibration 2026) finds them systematically mis-calibrated and corrects
 * them on the forecaster's own record. Two calibrated candidates, fitted on
 * the OLDER 70% of labelled picks:
 *   rate   — the bracket win rate per asset class, shrunk toward 50%
 *            (works for any pick: Advisory, Research Desk)
 *   model  — a logistic on the meta-label's scan-time features (AI Brain-
 *            shaped picks only)
 * and the CURRENT method (kelly.winProbFromStats on the same older picks).
 * Each is scored by Brier on the NEWEST 30% it never saw, against the bracket
 * label. A candidate is adopted only if it beats the current method there with
 * a paired t ≥ MIN_T over the holdout rows; otherwise nothing changes and the
 * reason says why. Pure except the store I/O. Tests: tests/bracket-prob.test.js
 */

const path = require('path')
const meta = require('./meta-label')
const { shrinkRate } = require('./calibration-stats')

const MIN_ROWS = 150
const HOLDOUT_FRAC = 0.3
const MIN_T = 1
const SHRINK = 20
const MIN_SEG = 15

const assetOf = r => {
  const t = String(r.assetType || '').toLowerCase()
  return t === 'equity' ? 'stock' : (t || null)
}

function labelled(records) {
  return (records || [])
    .map(r => ({ r, at: Date.parse(r.generatedAt), y: meta.labelOf(r), asset: assetOf(r) }))
    .filter(o => o.y != null && Number.isFinite(o.at))
    .sort((a, b) => a.at - b.at)
}

/** Shrunk bracket win rate per asset class plus overall, from labelled rows. */
function fitRates(rows) {
  const out = { overall: null, byAsset: {} }
  const seg = list => {
    const wins = list.reduce((a, o) => a + o.y, 0)
    return { n: list.length, wins, raw: list.length ? +(wins / list.length).toFixed(4) : null, p: +shrinkRate(wins, list.length, { prior: 0.5, strength: SHRINK }).toFixed(4) }
  }
  out.overall = seg(rows)
  for (const a of new Set(rows.map(o => o.asset).filter(Boolean))) {
    const list = rows.filter(o => o.asset === a)
    if (list.length >= MIN_SEG) out.byAsset[a] = seg(list)
  }
  return out
}

function rateFor(rates, asset) {
  const s = (asset && rates?.byAsset?.[asset]) || rates?.overall
  return s ? { p: s.p, n: s.n, segment: asset && rates.byAsset?.[asset] ? `assetType:${asset}` : 'overall' } : null
}

function defaultCurrentMethod(trainRecords) {
  const kelly = require('./kelly')
  const stats = require('./brain-learnings').computeStats(trainRecords)
  return r => kelly.winProbFromStats(stats, { assetType: assetOf(r) }).p
}

const brier = (ps, ys) => ps.reduce((a, p, i) => a + (p - ys[i]) ** 2, 0) / ps.length

/** Paired t of (current error − candidate error): positive = candidate better. */
function pairedT(pc, pk, ys) {
  const d = ys.map((y, i) => (pc[i] - y) ** 2 - (pk[i] - y) ** 2)
  const m = d.reduce((a, v) => a + v, 0) / d.length
  const sd = Math.sqrt(d.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, d.length - 1))
  return sd > 0 ? m / (sd / Math.sqrt(d.length)) : 0
}

/**
 * Fit both candidates walk-forward and decide. `currentMethod(trainRecords)` returns
 * (record) => the probability today's method would have given that holdout pick,
 * having seen only the training picks (default: kelly.winProbFromStats over
 * brain-learnings.computeStats of them).
 * Returns the record to save.
 */
function trainFromRecords(records, { currentMethod = defaultCurrentMethod, now = new Date(), minRows = MIN_ROWS } = {}) {
  const rows = labelled(records)
  const base = { trainedAt: now.toISOString(), labelled: rows.length, event: 'target before stop (else the sign at day 30)' }
  if (rows.length < minRows) return { ...base, adopted: null, reason: `${rows.length} labelled picks (need ${minRows})` }

  const cut = Math.floor(rows.length * (1 - HOLDOUT_FRAC))
  const train = rows.slice(0, cut), hold = rows.slice(cut)
  const ys = hold.map(o => o.y)
  const trainRecords = train.map(o => o.r)

  const rates = fitRates(train)
  const model = meta.fit(train.map(o => ({ x: meta.featurize(o.r), y: o.y })))
  const preds = {
    current: (cur => hold.map(o => cur(o.r)))(currentMethod(trainRecords)),
    rate:    hold.map(o => rateFor(rates, o.asset).p),
    model:   hold.map(o => meta.prob(model, meta.featurize(o.r))),
  }
  const scores = Object.fromEntries(Object.entries(preds).map(([k, ps]) => [k, +brier(ps, ys).toFixed(4)]))
  const t = { rate: +pairedT(preds.current, preds.rate, ys).toFixed(2), model: +pairedT(preds.current, preds.model, ys).toFixed(2) }
  const winRate = ys.reduce((a, v) => a + v, 0) / ys.length
  const validation = { holdout: hold.length, bracketWinRate: +winRate.toFixed(3), brier: scores, t }

  const beats = ['model', 'rate'].filter(k => scores[k] < scores.current && t[k] >= MIN_T)
    .sort((a, b) => scores[a] - scores[b])
  const adopted = beats[0] || null
  // Ship refits on everything — the holdout proved the procedure (same as meta-label).
  const finalRates = fitRates(rows)
  const finalModel = beats.includes('model') ? meta.fit(rows.map(o => ({ x: meta.featurize(o.r), y: o.y }))) : null
  const pct = v => `${(v * 100).toFixed(1)}%`
  return {
    ...base, adopted, validation,
    // `rate` stays usable for picks without scan features whenever it beat the current method too.
    rateAdopted: beats.includes('rate'),
    rates: finalRates,
    model: finalModel && { features: meta.FEATURES, bias: finalModel.bias, w: finalModel.w },
    reason: adopted
      ? `${adopted === 'model' ? 'per-pick model' : 'bracket win rate'} predicted the bracket outcome of ${hold.length} newer picks better than the current method (Brier ${scores[adopted]} vs ${scores.current}, paired t ${t[adopted]})`
      : `neither candidate clearly beat the current method on ${hold.length} newer picks (Brier current ${scores.current}, rate ${scores.rate} t ${t.rate}, model ${scores.model} t ${t.model}; bracket win rate ${pct(winRate)})`,
  }
}

/**
 * The probability to size and gate a pick on, in kelly.winProbFromStats's shape
 * ({ p, raw, n, source }), or null when the stored calibration does not apply —
 * the caller then keeps its current method. `pickLike` with AI Brain scan fields
 * gets the per-pick model when that was adopted; anything else gets the rate.
 */
function winProbFor(store, { assetType = null, pickLike = null } = {}) {
  if (!store?.adopted) return null
  const asset = assetType ? String(assetType).toLowerCase().replace(/^equity$/, 'stock') : null
  if (store.adopted === 'model' && store.model && pickLike) {
    const p = meta.prob(store.model, meta.featurize(pickLike))
    if (p != null) return { p: +Math.min(0.95, Math.max(0.05, p)).toFixed(4), raw: null, n: store.labelled, source: `bracket model (n=${store.labelled}, walk-forward adopted)`, bracket: true }
  }
  if (!store.rateAdopted && store.adopted !== 'rate') return null
  const r = rateFor(store.rates, asset)
  return r && { p: r.p, raw: (store.rates.byAsset?.[asset] || store.rates.overall)?.raw ?? null, n: r.n, source: `bracket win rate, ${r.segment} (n=${r.n}, shrunk toward 50%)`, bracket: true }
}

// ── Store ────────────────────────────────────────────────────────────────────
const STORE_FILE = path.join(require('./data-dir').DATA_DIR, 'bracket-prob.json')

function loadStore(file = STORE_FILE) {
  try { return JSON.parse(require('fs').readFileSync(file, 'utf8')) } catch { return null }
}

function saveStore(store, file = STORE_FILE) {
  require('fs').mkdirSync(path.dirname(file), { recursive: true })
  require('./atomic-write').writeJsonAtomic(file, store)
}

module.exports = { MIN_ROWS, MIN_T, STORE_FILE, labelled, fitRates, rateFor, brier, pairedT, trainFromRecords, winProbFor, loadStore, saveStore }
