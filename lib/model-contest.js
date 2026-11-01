'use strict'
/**
 * Model contest — champion / challenger for "will this pick reach its target
 * before its stop?", run nightly over the AI Brain's own resolved record.
 *
 * The app has two models that answer that question (lib/meta-label.js decides
 * whether to act on a pick; lib/bracket-prob.js supplies the win rate Kelly
 * and the EV gate size on). Both are logistic regressions. The Quant Lab has a
 * bench of twenty algorithms; this is where they are allowed to compete for
 * the job — and where, honestly, they usually lose.
 *
 * Two tracks, same label (meta-label.labelOf: target first = 1, stop first =
 * 0, neither → the sign at the pick's own horizon):
 *   brain   — every scan-time fact an AI Brain pick carries (the meta-label
 *             features) plus the measured quant stamp and the plan's no-skill
 *             odds (lib/quant-snapshot.js, lib/plan-odds.js);
 *   generic — only what ANY plan has (plan geometry, quant stamp, odds), so a
 *             winner can also score Agent Hub, Research Desk and Buy Signals
 *             plans.
 *
 * Evaluation (the rules every promotion in this repo follows):
 *   - rows in time order; the newest half is tested in five consecutive
 *     blocks, each predicted by models fitted only on rows whose label had
 *     RESOLVED before the block began (purged: a 6-month pick logged last
 *     week has no known outcome yet, so it may not train anything);
 *   - every model scored by Brier on the same predictions, against the
 *     champion (the logistic regression the app uses today) with a paired t;
 *   - a challenger wins only with a lower Brier than the champion AND the base
 *     rate, and a paired t above the one-sided Bonferroni threshold for the
 *     number of challengers tried — the best of eight is selected for luck
 *     otherwise;
 *   - below MIN_ROWS labelled picks nothing runs; the contest says it is waiting.
 * The winner is refitted on every labelled row when it is used. Not adopted ⇒
 * nothing changes anywhere.
 *
 * Pure except the store I/O. Tests: tests/model-contest.test.js
 */

const path = require('path')
const ML = require('./quant/ml')
const { normInv } = require('./quant/linalg')
const meta = require('./meta-label')
const { brier, pairedT } = require('./bracket-prob')

const MIN_ROWS = 150
const MIN_TRAIN = 60
const FOLDS = 5
const TEST_SHARE = 0.5
const ALPHA = 0.05
const DAY = 864e5

const CHAMPION = 'logistic'
const CHALLENGERS = ['knn', 'gaussianNB', 'decisionTree', 'randomForest', 'gradientBoosting', 'linearSVM', 'lda']
const SPECS = {
  logistic:         () => ML.logistic({ epochs: 400, l2: 1e-2 }),
  knn:              () => ML.knn({ k: 25 }),
  gaussianNB:       () => ML.gaussianNB(),
  decisionTree:     () => ML.decisionTree({ maxDepth: 3, minLeaf: 15 }),
  randomForest:     () => ML.randomForest({ trees: 60, maxDepth: 4, minLeaf: 10 }),
  gradientBoosting: () => ML.gradientBoosting({ rounds: 60, lr: 0.05, maxDepth: 2, minLeaf: 15 }),
  linearSVM:        () => ML.linearSVM(),
  lda:              () => ML.lda(),
}

const clip = (v, lo, hi) => Math.max(lo, Math.min(hi, v))
const num = v => (v == null || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null)

const GENERIC_FEATURES = [
  'rewardRisk', 'stopPct', 'crypto', 'hasOdds', 'oddsTarget', 'hasQuant', 'vol21', 'trending', 'meanReverting',
  'var95', 'probStressed', 'beta', 'residualZ', 'stopInNoise',
]

/** Features any plan has: geometry, the quant stamp, the no-skill odds. Missing groups get a flag, not a fake value. */
function genericFeatures(r) {
  const tr = num(r.targetReturn), sl = num(r.stopLoss)
  const q = r.quantAtScan || null, odds = num(r.modelOdds?.pTarget)
  return [
    tr > 0 && sl > 0 ? clip(tr / sl, 0, 5) / 5 : 0,
    sl > 0 ? clip(sl, 0, 30) / 30 : 0,
    r.assetType === 'crypto' ? 1 : 0,
    odds != null ? 1 : 0,
    odds != null ? odds : 0,
    q ? 1 : 0,
    q?.vol21 != null ? clip(q.vol21, 0, 2) / 2 : 0,
    q?.character === 'trending' ? 1 : 0,
    q?.character === 'mean-reverting' ? 1 : 0,
    q?.var95 != null ? clip(q.var95, 0, 0.2) / 0.2 : 0,
    q?.probStressed != null ? clip(q.probStressed, 0, 1) : 0,
    q?.beta != null ? clip(q.beta, -1, 3) / 3 : 0,
    q?.residualZ != null ? clip(q.residualZ, -3, 3) / 3 : 0,
    r.stopNoise === 'inside-noise' ? 1 : 0,
  ]
}

const TRACKS = {
  brain:   { features: [...meta.FEATURES, ...GENERIC_FEATURES], x: r => [...meta.featurize(r), ...genericFeatures(r)] },
  generic: { features: GENERIC_FEATURES, x: genericFeatures },
}

/** Labelled rows in time order, each with the time its label became known. */
function contestRows(records, track = 'brain') {
  const T = TRACKS[track]
  return (records || [])
    .map(r => {
      const at = Date.parse(r.generatedAt), y = meta.labelOf(r)
      return { at, resolvesAt: at + Number(r.horizonDays) * DAY, x: T.x(r), y, odds: num(r.modelOdds?.pTarget) }
    })
    .filter(o => o.y != null && Number.isFinite(o.at) && Number.isFinite(o.resolvesAt))
    .sort((a, b) => a.at - b.at)
}

function fitPredict(name, train, test) {
  const ys = train.map(o => o.y), mean = ys.reduce((a, v) => a + v, 0) / ys.length
  if (mean === 0 || mean === 1) return test.map(() => clip(mean, 0.02, 0.98))   // one class: nothing to separate
  try {
    const m = SPECS[name]().fit(train.map(o => o.x), ys)
    return m.predictProba(test.map(o => o.x)).map(p => (Number.isFinite(p) ? clip(p, 0.01, 0.99) : mean))
  } catch {
    return test.map(() => mean)
  }
}

/** Purged walk-forward predictions for every model (and the two references) on the newest TEST_SHARE of rows. */
function walkForward(rows, { folds = FOLDS, models = [CHAMPION, ...CHALLENGERS] } = {}) {
  const n = rows.length, start = Math.floor(n * (1 - TEST_SHARE)), size = Math.ceil((n - start) / folds)
  const preds = Object.fromEntries(models.map(m => [m, []]))
  const ref = { baseRate: [], odds: [] }, ys = []
  let usedFolds = 0
  for (let a = start; a < n; a += size) {
    const block = rows.slice(a, Math.min(n, a + size))
    const cutoff = block[0].at
    const train = rows.slice(0, a).filter(o => o.resolvesAt < cutoff)       // purge: outcome known before the block
    if (train.length < MIN_TRAIN) continue
    usedFolds++
    const mean = train.reduce((s, o) => s + o.y, 0) / train.length
    for (const m of models) preds[m].push(...fitPredict(m, train, block))
    ref.baseRate.push(...block.map(() => mean))
    ref.odds.push(...block.map(o => (o.odds != null ? clip(o.odds, 0.01, 0.99) : mean)))
    ys.push(...block.map(o => o.y))
  }
  return { preds, ref, ys, folds: usedFolds }
}

/**
 * Run one track. Returns the record to store.
 * @param {object[]} records  prediction log rows
 */
function runTrack(records, track, { minRows = MIN_ROWS, now = new Date() } = {}) {
  const rows = contestRows(records, track)
  const base = { track, features: TRACKS[track].features, labelled: rows.length, ranAt: now.toISOString(), champion: CHAMPION }
  if (rows.length < minRows) return { ...base, ready: false, winner: null, reason: `waiting — ${rows.length} of ${minRows} labelled picks` }
  const wf = walkForward(rows)
  if (!wf.ys.length) return { ...base, ready: false, winner: null, reason: 'no test block had enough resolved history behind it' }
  const ys = wf.ys
  const champ = wf.preds[CHAMPION]
  const zCrit = normInv(1 - ALPHA / CHALLENGERS.length)
  const scored = Object.entries(wf.preds).map(([name, ps]) => ({
    name, brier: +brier(ps, ys).toFixed(4),
    tVsChampion: name === CHAMPION ? null : +pairedT(champ, ps, ys).toFixed(2),
  })).sort((a, b) => a.brier - b.brier)
  const reference = {
    baseRate: +brier(wf.ref.baseRate, ys).toFixed(4),
    noSkillOdds: +brier(wf.ref.odds, ys).toFixed(4),
    targetFirstRate: +(ys.reduce((a, v) => a + v, 0) / ys.length).toFixed(3),
  }
  const champBrier = scored.find(s => s.name === CHAMPION).brier
  const winners = scored.filter(s => s.name !== CHAMPION && s.brier < champBrier && s.brier < reference.baseRate && s.tVsChampion >= zCrit)
  const winner = winners[0]?.name ?? null
  return {
    ...base, ready: true, tested: ys.length, folds: wf.folds, zCritical: +zCrit.toFixed(2),
    models: scored, reference, winner,
    championBeatsBaseRate: champBrier < reference.baseRate,
    reason: winner
      ? `${winner} predicted ${ys.length} newer picks better than the current logistic (Brier ${winners[0].brier} vs ${champBrier}, paired t ${winners[0].tVsChampion} ≥ ${zCrit.toFixed(2)} after correcting for ${CHALLENGERS.length} challengers)`
      : `no challenger beat the current logistic by enough on ${ys.length} newer picks (best ${scored[0].name} Brier ${scored[0].brier}; current ${champBrier}; base rate ${reference.baseRate}; t needed ${zCrit.toFixed(2)})`,
  }
}

function runContest(records, opts = {}) {
  return { ranAt: (opts.now || new Date()).toISOString(), tracks: { brain: runTrack(records, 'brain', opts), generic: runTrack(records, 'generic', opts) } }
}

// ── Live use of an adopted winner ────────────────────────────────────────────
// Closures are not serialisable, so the winner is refitted on every labelled
// row on first use after each contest run, and cached until the next one.
let _cache = { key: null, models: {} }

function winnerModel(store, track, records) {
  const t = store?.tracks?.[track]
  if (!t?.winner) return null
  const key = `${store.ranAt}`
  if (_cache.key !== key) _cache = { key, models: {} }
  if (!_cache.models[track]) {
    const rows = contestRows(records, track)
    if (rows.length < MIN_TRAIN) return null
    try { _cache.models[track] = SPECS[t.winner]().fit(rows.map(o => o.x), rows.map(o => o.y)) } catch { return null }
  }
  return { name: t.winner, model: _cache.models[track], labelled: t.labelled }
}

/**
 * A plan's target-first probability from the adopted winner, in
 * kelly.winProbFromStats's shape — or null (no winner ⇒ callers keep their
 * current method). `planLike` uses the prediction-record field names
 * (targetReturn, stopLoss, assetType, quantAtScan, modelOdds, stopNoise, and
 * for the brain track the meta-label fields).
 */
function winProbFor(store, planLike, { track = 'generic', records = null } = {}) {
  const w = winnerModel(store, track, records || [])
  if (!w) return null
  const p = w.model.predictProba([TRACKS[track].x(planLike)])[0]
  if (!Number.isFinite(p)) return null
  return { p: +clip(p, 0.05, 0.95).toFixed(4), raw: null, n: w.labelled, source: `${w.name} (contest winner, ${track} track, n=${w.labelled})`, contest: true }
}

/** A live surface's plan in prediction-record shape, for winProbFor. */
function planLikeFrom({ targetReturn, stopLoss, assetType = 'stock', quantStamp = null, planOdds = null, extra = {} }) {
  return {
    ...extra, targetReturn, stopLoss, assetType,
    quantAtScan: quantStamp, modelOdds: planOdds?.odds ? { pTarget: planOdds.odds.pTarget } : null, stopNoise: planOdds?.stop?.level ?? null,
  }
}

// ── Store ────────────────────────────────────────────────────────────────────
const STORE_FILE = path.join(require('./data-dir').DATA_DIR, 'model-contest.json')
function loadStore(file = STORE_FILE) { try { return JSON.parse(require('fs').readFileSync(file, 'utf8')) } catch { return null } }
function saveStore(store, file = STORE_FILE) {
  require('fs').mkdirSync(path.dirname(file), { recursive: true })
  require('./atomic-write').writeJsonAtomic(file, store)
}

module.exports = {
  MIN_ROWS, CHAMPION, CHALLENGERS, GENERIC_FEATURES, TRACKS, STORE_FILE,
  genericFeatures, contestRows, walkForward, runTrack, runContest, winProbFor, planLikeFrom, loadStore, saveStore,
  _resetForTests: () => { _cache = { key: null, models: {} } },
}
