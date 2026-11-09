'use strict'
/**
 * lib/quant/ml-compare.js — the harness that makes the ML models answer to the same standard as
 * everything else in this app: out-of-sample, with a purge gap, against the do-nothing baseline,
 * and corrected for the number of models tried.
 *
 * Task: from information known at the close of day t, will the stock be higher h days later?
 * Features are computed from bars ≤ t only; the label uses bars after t; the last `h` training rows
 * (whose labels peek into the test period) are purged. Test rows overlap in time (h-day labels), so the
 * confidence interval uses n_eff = rows / h, and — because thirteen models were tried — a Bonferroni-adjusted
 * level: "beats baseline" means the corrected Wilson lower bound exceeds the majority-class accuracy.
 * Expect "no model beats the baseline" on most liquid stocks; that is the honest answer, not a bug.
 * Tests: tests/quant-ml-compare.test.js
 */
const L = require('./linalg')
const ML = require('./ml')
const NN = require('./neural')

const SEQ = 20

function rsi(c, i, n = 14) { let up = 0, dn = 0; for (let k = i - n + 1; k <= i; k++) { const d = c[k] - c[k - 1]; if (d > 0) up += d; else dn -= d } return dn === 0 ? 100 : 100 - 100 / (1 + up / dn) }
const FEATURES = ['ret1', 'ret5', 'ret10', 'ret20', 'vol20', 'volRatio', 'rsi14', 'distSma20', 'distSma50', 'rangePos20', 'volumeZ', 'dayRange']

/** Feature rows for each index i ≥ 60 with a known label (h days ahead). Everything uses bars ≤ i. */
function buildDataset(bars, { horizon = 5, withTail = false } = {}) {
  const b = bars.filter(x => x.c > 0); if (b.length < 200) throw new Error(`need at least 200 bars (got ${b.length})`)
  const c = b.map(x => x.c), v = b.map(x => x.v || 0), r = c.map((x, i) => (i ? Math.log(x / c[i - 1]) : 0))
  const X = [], y = [], seq = [], idx = [], tailX = [], tailIdx = []
  // withTail: also the last `horizon` bars, whose labels are not known yet — features only, for live predictions.
  for (let i = 60; i < b.length - (withTail ? 0 : horizon); i++) {
    const sma = n => L.mean(c.slice(i - n + 1, i + 1)), hi = Math.max(...c.slice(i - 19, i + 1)), lo = Math.min(...c.slice(i - 19, i + 1))
    const v20 = L.stdev(r.slice(i - 19, i + 1)), v5 = L.stdev(r.slice(i - 4, i + 1)), vv = v.slice(i - 19, i + 1), vsd = L.stdev(vv)
    const row = [r[i], Math.log(c[i] / c[i - 5]), Math.log(c[i] / c[i - 10]), Math.log(c[i] / c[i - 20]), v20, v20 > 0 ? v5 / v20 : 1, rsi(c, i), c[i] / sma(20) - 1, c[i] / sma(50) - 1, hi > lo ? (c[i] - lo) / (hi - lo) : 0.5, vsd > 0 ? (v[i] - L.mean(vv)) / vsd : 0, b[i].h && b[i].l ? (b[i].h - b[i].l) / c[i] : 0]
    if (i >= b.length - horizon) { tailX.push(row); tailIdx.push(i); continue }
    X.push(row); seq.push(r.slice(i - SEQ + 1, i + 1)); y.push(c[i + horizon] > c[i] ? 1 : 0); idx.push(i)
  }
  return { X, y, seq, idx, horizon, bars: b, ...(withTail ? { tailX, tailIdx } : {}) }
}

function auc(p, y) {
  const pairs = p.map((v, i) => [v, y[i]]).sort((a, c) => a[0] - c[0]); let rankSum = 0, pos = 0, neg = 0, i = 0
  while (i < pairs.length) { let j = i; while (j + 1 < pairs.length && pairs[j + 1][0] === pairs[i][0]) j++; const avg = (i + j) / 2 + 1; for (let k = i; k <= j; k++) if (pairs[k][1] === 1) { rankSum += avg; pos++ } else neg++; i = j + 1 }
  return pos && neg ? (rankSum - pos * (pos + 1) / 2) / (pos * neg) : null
}
function wilson(k, n, z) { if (!n) return [0, 1]; const p = k / n, d = 1 + z * z / n, c = p + z * z / (2 * n), m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [(c - m) / d, (c + m) / d] }

const MODEL_SPECS = [
  ['Logistic regression', () => ML.logistic()], ['Elastic-net logistic', () => ML.elasticNetLogistic()], ['k-nearest neighbours', () => ML.knn()], ['Gaussian naive Bayes', () => ML.gaussianNB()],
  ['Decision tree', () => ML.decisionTree()], ['Random forest', () => ML.randomForest({ trees: 60 })], ['Gradient boosting', () => ML.gradientBoosting({ rounds: 60 })],
  ['Support vector machine (linear)', () => ML.linearSVM()], ['Support vector machine (RBF kernel)', () => ML.kernelSVM()], ['Linear discriminant analysis', () => ML.lda()], ['Quadratic discriminant analysis', () => ML.qda()],
  ['Neural network (MLP)', () => NN.mlp({ epochs: 40 })], ['Convolutional network (1-D CNN)', () => NN.cnn1d({ epochs: 30 }), 'seq'], ['Recurrent network (LSTM)', () => NN.lstm({ epochs: 12 }), 'lstm'],
]

/** Train every model on the first `trainShare` of rows, purge `horizon` rows, score on the rest. */
function compareModels(bars, { horizon = 5, trainShare = 0.65, only = null } = {}) {
  const D = buildDataset(bars, { horizon }), n = D.X.length, cut = Math.floor(n * trainShare), testStart = cut + horizon
  if (n - testStart < 100) throw new Error('not enough history left for an out-of-sample test')
  const pick = (A, a, z) => A.slice(a, z)
  const ytr = pick(D.y, 0, cut), yte = pick(D.y, testStart, n)
  const base = L.mean(ytr) >= 0.5 ? 1 : 0, baseAcc = yte.filter(v => v === base).length / yte.length
  const nEff = Math.max(10, Math.floor(yte.length / horizon)), models = (only ? MODEL_SPECS.filter(m => only.includes(m[0])) : MODEL_SPECS), m = models.length
  const zAdj = L.normInv(1 - 0.025 / m), results = []
  for (const [name, make, kind] of models) {
    try {
      const mdl = make(), t0 = Date.now()
      let Xtr = pick(D.X, 0, cut), Xte = pick(D.X, testStart, n)
      if (kind === 'seq') { Xtr = pick(D.seq, 0, cut); Xte = pick(D.seq, testStart, n) }
      if (kind === 'lstm') { Xtr = pick(D.seq, 0, cut).map(s => s.map(x => [x])); Xte = pick(D.seq, testStart, n).map(s => s.map(x => [x])) }
      mdl.fit(Xtr, ytr); const p = mdl.predictProba(Xte)
      const correct = p.filter((q, i) => (q > 0.5 ? 1 : 0) === yte[i]).length, acc = correct / yte.length
      const ll = -L.mean(p.map((q, i) => yte[i] * Math.log(q) + (1 - yte[i]) * Math.log(1 - q))), brier = L.mean(p.map((q, i) => (q - yte[i]) ** 2))
      const [lo, hi] = wilson(Math.round(acc * nEff), nEff, zAdj)
      results.push({ model: name, accuracy: acc, accuracyLoCorrected: lo, accuracyHiCorrected: hi, logLoss: ll, brier, auc: auc(p, yte), beatsBaseline: lo > baseAcc, edgeVsBaseline: acc - baseAcc, seconds: (Date.now() - t0) / 1000 })
    } catch (e) { results.push({ model: name, error: e.message }) }
  }
  const ok = results.filter(r => !r.error).sort((a, b) => b.accuracy - a.accuracy)
  return {
    horizonDays: horizon, trainRows: cut, testRows: yte.length, effectiveTestObservations: nEff, purgedRows: horizon, features: FEATURES,
    baseline: { rule: base ? 'always predict up' : 'always predict down', accuracy: baseAcc }, modelsTried: m, confidenceLevel: `95% family-wise (Bonferroni over ${m} models)`,
    results: [...ok, ...results.filter(r => r.error)], winners: ok.filter(r => r.beatsBaseline).map(r => r.model),
    verdict: ok.some(r => r.beatsBaseline) ? 'At least one model beat the do-nothing baseline after correcting for trying many; re-test on another period before believing it.' : 'No model beat the do-nothing baseline once the number of models tried is accounted for. That is the usual result for liquid stocks over short horizons.',
  }
}

/** Cluster symbols by return/risk fingerprints (k-means, hierarchical, DBSCAN, t-SNE coordinates for plotting). */
function clusterSymbols(barsBySymbol, { k = 3 } = {}) {
  const rows = [], names = []
  for (const [s, bars] of Object.entries(barsBySymbol)) {
    const c = bars.filter(b => b.c > 0).map(b => b.c); if (c.length < 130) continue
    const r = L.logReturnsOf(c), last = r.slice(-250)
    const down = last.filter(x => x < 0), dd = (() => { let pk = c[0], m = 0; for (const x of c.slice(-250)) { pk = Math.max(pk, x); m = Math.min(m, x / pk - 1) } return m })()
    rows.push([L.mean(last) * 252, L.stdev(last) * Math.sqrt(252), Math.log(c[c.length - 1] / c[Math.max(0, c.length - 126)]), down.length ? L.stdev(down) * Math.sqrt(252) : 0, dd]); names.push(s)
  }
  if (rows.length < 4) throw new Error('need at least 4 symbols with 130+ days of history')
  const Z = ML.scaler(rows).transform(rows), kk = Math.min(k, rows.length - 1)
  const km = ML.kmeans(Z, kk), hc = ML.hierarchical(Z, kk), db = ML.dbscan(Z, { eps: 1.1, minPts: 2 })
  const emb = rows.length >= 8 ? ML.tsne(rows, { perplexity: Math.max(2, Math.min(10, rows.length / 4)), iters: 250 }).embedding : null
  return { features: ['annual return', 'annual vol', '6m return', 'downside vol', 'max drawdown'], symbols: names.map((s, i) => ({ symbol: s, kmeans: km.labels[i], hierarchical: hc.labels[i], dbscan: db.labels[i], outlier: db.labels[i] === -1, x: emb ? emb[i][0] : null, y: emb ? emb[i][1] : null, features: rows[i] })), k: kk }
}


/**
 * Purged walk-forward cross-validation (López de Prado): history split into `folds + 1` consecutive blocks; fold k trains
 * on every block before k with the last `horizon` rows PURGED (their labels look into block k) and tests on block k
 * after an EMBARGO of `horizon` rows. A model has to beat the baseline fold after fold, not once. Permutation importance
 * for the best model on the final fold: shuffle one feature in the test set and measure the AUC lost.
 */
function walkForwardModels(bars, { horizon = 5, folds = 5, only = null, seed = 1 } = {}) {
  const D = buildDataset(bars, { horizon }), n = D.X.length, block = Math.floor(n / (folds + 1))
  if (block < 60) throw new Error(`not enough history for ${folds} folds (each fold needs at least 60 rows)`)
  const FAST = ['Logistic regression', 'k-nearest neighbours', 'Gaussian naive Bayes', 'Decision tree', 'Random forest', 'Gradient boosting', 'Support vector machine (linear)', 'Support vector machine (RBF kernel)', 'Linear discriminant analysis', 'Quadratic discriminant analysis', 'Neural network (MLP)']
  const specs = MODEL_SPECS.filter(m => (only ? only.includes(m[0]) : FAST.includes(m[0])))
  const per = Object.fromEntries(specs.map(m => [m[0], { acc: [], auc: [], beat: 0 }])), baseAccs = []
  let last = null
  for (let k = 1; k <= folds; k++) {
    const trEnd = k * block - horizon, teStart = k * block + horizon, teEnd = k === folds ? n : (k + 1) * block
    const Xtr = D.X.slice(0, trEnd), ytr = D.y.slice(0, trEnd), Xte = D.X.slice(teStart, teEnd), yte = D.y.slice(teStart, teEnd)
    if (Xte.length < 20) continue
    const base = L.mean(ytr) >= 0.5 ? 1 : 0, baseAcc = yte.filter(v => v === base).length / yte.length; baseAccs.push(baseAcc)
    for (const [name, make, kind] of specs) {
      if (kind) continue
      try {
        const m = make().fit(Xtr, ytr), p = m.predictProba(Xte), acc = p.filter((q, i) => (q > 0.5 ? 1 : 0) === yte[i]).length / yte.length
        per[name].acc.push(acc); per[name].auc.push(auc(p, yte)); if (acc > baseAcc) per[name].beat++
        if (k === folds) (last = last || {})[name] = { model: m, Xte, yte }
      } catch (e) { per[name].error = e.message }
    }
  }
  const rows = Object.entries(per).filter(([, v]) => v.acc.length).map(([model, v]) => ({ model, meanAccuracy: L.mean(v.acc), sdAccuracy: v.acc.length > 1 ? L.stdev(v.acc) : 0, meanAuc: L.mean(v.auc.filter(x => x != null)), foldsBeatingBaseline: v.beat, folds: v.acc.length, meanEdgeVsBaseline: L.mean(v.acc) - L.mean(baseAccs) }))
    .sort((a, b) => b.meanAuc - a.meanAuc)
  let importance = null
  if (rows.length && last && last[rows[0].model]) {
    const { model, Xte, yte } = last[rows[0].model], g = L.rng(seed), baseAuc = auc(model.predictProba(Xte), yte)
    importance = FEATURES.map((f, j) => {
      const drops = []
      for (let rep = 0; rep < 5; rep++) {
        const col = Xte.map(r => r[j]); for (let i = col.length - 1; i > 0; i--) { const s = Math.floor(g.uniform() * (i + 1)); [col[i], col[s]] = [col[s], col[i]] }
        drops.push(baseAuc - auc(model.predictProba(Xte.map((r, i) => { const c = r.slice(); c[j] = col[i]; return c })), yte))
      }
      return { feature: f, aucDrop: L.mean(drops) }
    }).sort((a, b) => b.aucDrop - a.aucDrop)
  }
  const consistent = rows.filter(r => r.foldsBeatingBaseline === r.folds && r.meanEdgeVsBaseline > 0)
  return { horizonDays: horizon, folds, rowsPerFold: block, purgedAndEmbargoed: horizon, meanBaselineAccuracy: L.mean(baseAccs), results: rows,
    importance: importance && { model: rows[0].model, features: importance, note: 'AUC lost when the feature is shuffled in the final test fold. Near zero for all features means the model learned nothing usable.' },
    verdict: consistent.length ? `${consistent.map(c => c.model).join(', ')} beat the baseline in every fold. Re-test on another symbol before believing it.` : 'No model beat the baseline in every fold. Whatever edge appears in one split does not survive walk-forward testing.' }
}

module.exports = { walkForwardModels, buildDataset, compareModels, clusterSymbols, auc, FEATURES, MODEL_SPECS }
