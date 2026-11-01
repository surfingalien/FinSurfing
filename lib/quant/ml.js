'use strict'
/**
 * lib/quant/ml.js — classical machine-learning models, written from scratch and held to one interface.
 *
 * Classifiers all expose  fit(X, y) → this  and  predictProba(X) → P(y=1)[]  (y in {0,1}, X rows of numbers):
 *   logistic · knn · gaussianNB · decisionTree · randomForest · gradientBoosting · linearSVM · lda · qda
 * Unsupervised / embedding:
 *   kmeans (k-means++) · dbscan · hierarchical (agglomerative, average linkage) · tsne (exact, ≤ ~400 points)
 * Everything is seeded and deterministic. These are small, readable implementations sized for a few thousand
 * rows of daily features — not a replacement for a production ML library. Tests: tests/quant-ml.test.js
 */
const L = require('./linalg')

const sigmoid = z => 1 / (1 + Math.exp(-Math.max(-35, Math.min(35, z))))
const clip = p => Math.min(1 - 1e-9, Math.max(1e-9, p))

/** Per-column z-score scaler fitted on training rows. */
function scaler(X) {
  const cols = L.columns(X), mu = cols.map(L.mean), sd = cols.map(c => L.stdev(c) || 1)
  return { mu, sd, transform: rows => rows.map(r => r.map((v, j) => (v - mu[j]) / sd[j])) }
}
const dist2 = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) { const d = a[i] - b[i]; s += d * d } return s }

/* ── classifiers ─────────────────────────────────────────────────────────────── */

function logistic({ lr = 0.1, epochs = 400, l2 = 1e-3 } = {}) {
  let w = null, b = 0, sc = null
  return {
    name: 'Logistic regression',
    fit(X, y) {
      sc = scaler(X); const Z = sc.transform(X), n = Z.length, d = Z[0].length; w = new Array(d).fill(0); b = 0
      for (let e = 0; e < epochs; e++) {
        const gw = new Array(d).fill(0); let gb = 0
        for (let i = 0; i < n; i++) { const err = sigmoid(L.dot(w, Z[i]) + b) - y[i]; for (let j = 0; j < d; j++) gw[j] += err * Z[i][j]; gb += err }
        for (let j = 0; j < d; j++) w[j] -= lr * (gw[j] / n + l2 * w[j]); b -= lr * gb / n
      }
      return this
    },
    predictProba: X => sc.transform(X).map(r => sigmoid(L.dot(w, r) + b)),
    weights: () => ({ w, b }),
  }
}

function knn({ k = 15 } = {}) {
  let Z = null, y0 = null, sc = null
  return {
    name: 'k-nearest neighbours',
    fit(X, y) { sc = scaler(X); Z = sc.transform(X); y0 = y; return this },
    predictProba(X) {
      return sc.transform(X).map(r => {
        const d = Z.map((z, i) => [dist2(r, z), i]).sort((a, b) => a[0] - b[0]).slice(0, Math.min(k, Z.length))
        let num = 0, den = 0; for (const [dd, i] of d) { const w = 1 / (Math.sqrt(dd) + 1e-6); num += w * y0[i]; den += w }
        return clip(num / den)
      })
    },
  }
}

/** k-nearest-neighbours regression: the (distance-weighted) mean target of the k closest training rows. */
function knnRegressor({ k = 15 } = {}) {
  let Z = null, y0 = null, sc = null
  return {
    name: 'KNN regression',
    fit(X, y) { sc = scaler(X); Z = sc.transform(X); y0 = y; return this },
    predict(X) {
      return sc.transform(X).map(r => {
        const d = Z.map((z, i) => [dist2(r, z), i]).sort((a, b) => a[0] - b[0]).slice(0, Math.min(k, Z.length)); let num = 0, den = 0
        for (const [dd, i] of d) { const w = 1 / (Math.sqrt(dd) + 1e-6); num += w * y0[i]; den += w }
        return num / den
      })
    },
  }
}

function gaussianNB({ smoothing = 1e-6 } = {}) {
  let prior = [0.5, 0.5], mu = null, vr = null
  return {
    name: 'Gaussian naive Bayes',
    fit(X, y) {
      const d = X[0].length; mu = [[], []]; vr = [[], []]
      for (const c of [0, 1]) { const rows = X.filter((_, i) => y[i] === c); prior[c] = (rows.length + 1) / (X.length + 2); for (let j = 0; j < d; j++) { const col = rows.map(r => r[j]); mu[c][j] = col.length ? L.mean(col) : 0; vr[c][j] = (col.length > 1 ? L.variance(col) : 1) + smoothing } }
      return this
    },
    predictProba: X => X.map(r => {
      const ll = [0, 1].map(c => Math.log(prior[c]) + r.reduce((s, v, j) => s - 0.5 * Math.log(2 * Math.PI * vr[c][j]) - (v - mu[c][j]) ** 2 / (2 * vr[c][j]), 0))
      return clip(sigmoid(ll[1] - ll[0]))
    }),
  }
}

/* CART tree. criterion 'gini' for 0/1 targets, 'mse' for residuals. */
function buildTree(X, t, idx, { maxDepth, minLeaf, criterion, mtry, g }, depth = 0) {
  const n = idx.length, mean = idx.reduce((s, i) => s + t[i], 0) / n
  const leaf = () => ({ leaf: true, value: mean, members: idx })
  if (depth >= maxDepth || n < 2 * minLeaf) return leaf()
  const d = X[0].length, feats = [...Array(d).keys()]
  if (mtry && mtry < d) for (let i = d - 1; i > 0; i--) { const j = Math.floor(g.uniform() * (i + 1)); [feats[i], feats[j]] = [feats[j], feats[i]] }
  const use = mtry ? feats.slice(0, mtry) : feats
  const imp = (s, s2, c) => (criterion === 'gini' ? (c ? 2 * (s / c) * (1 - s / c) * c : 0) : s2 - (c ? s * s / c : 0))
  let tS = 0, tS2 = 0; for (const i of idx) { tS += t[i]; tS2 += t[i] * t[i] }
  const parent = imp(tS, tS2, n); let best = null
  for (const f of use) {
    const order = idx.slice().sort((a, b) => X[a][f] - X[b][f]); let ls = 0, ls2 = 0
    for (let k = 0; k < n - 1; k++) {
      const i = order[k]; ls += t[i]; ls2 += t[i] * t[i]
      if (k + 1 < minLeaf || n - k - 1 < minLeaf || X[order[k + 1]][f] === X[i][f]) continue
      const gain = parent - imp(ls, ls2, k + 1) - imp(tS - ls, tS2 - ls2, n - k - 1)
      if (!best || gain > best.gain) best = { gain, f, thr: (X[i][f] + X[order[k + 1]][f]) / 2 }
    }
  }
  if (!best || best.gain <= 1e-12) return leaf()
  const left = idx.filter(i => X[i][best.f] <= best.thr), right = idx.filter(i => X[i][best.f] > best.thr)
  return { leaf: false, f: best.f, thr: best.thr, gain: best.gain, left: buildTree(X, t, left, { maxDepth, minLeaf, criterion, mtry, g }, depth + 1), right: buildTree(X, t, right, { maxDepth, minLeaf, criterion, mtry, g }, depth + 1) }
}
const walk = (node, r) => { while (!node.leaf) node = r[node.f] <= node.thr ? node.left : node.right; return node }
const strip = node => { if (node.leaf) delete node.members; else { strip(node.left); strip(node.right) } }

function decisionTree({ maxDepth = 4, minLeaf = 10, seed = 1 } = {}) {
  let root = null
  return {
    name: 'Decision tree',
    fit(X, y) { root = buildTree(X, y, X.map((_, i) => i), { maxDepth, minLeaf, criterion: 'gini', mtry: 0, g: L.rng(seed) }); strip(root); return this },
    predictProba: X => X.map(r => clip(walk(root, r).value)),
    tree: () => root,
  }
}

function randomForest({ trees = 80, maxDepth = 6, minLeaf = 5, seed = 1 } = {}) {
  let forest = []
  return {
    name: 'Random forest',
    fit(X, y) {
      const g = L.rng(seed), n = X.length, mtry = Math.max(1, Math.round(Math.sqrt(X[0].length))); forest = []
      for (let b = 0; b < trees; b++) { const boot = Array.from({ length: n }, () => Math.floor(g.uniform() * n)), t = buildTree(X, y, boot, { maxDepth, minLeaf, criterion: 'gini', mtry, g }); strip(t); forest.push(t) }
      return this
    },
    predictProba: X => X.map(r => clip(L.mean(forest.map(t => walk(t, r).value)))),
    importance: () => { const imp = {}; const rec = n => { if (!n.leaf) { imp[n.f] = (imp[n.f] || 0) + n.gain; rec(n.left); rec(n.right) } }; forest.forEach(rec); const tot = L.sum(Object.values(imp)) || 1; return Object.fromEntries(Object.entries(imp).map(([k, v]) => [k, v / tot])) },
  }
}

/** Gradient boosting on logistic loss: regression trees fit the residual, leaves take a Newton step (as XGBoost/LightGBM do). */
function gradientBoosting({ rounds = 80, lr = 0.1, maxDepth = 3, minLeaf = 10, subsample = 0.8, seed = 1 } = {}) {
  let f0 = 0, ens = []
  return {
    name: 'Gradient boosting',
    fit(X, y) {
      const g = L.rng(seed), n = X.length, pm = clip(L.mean(y)); f0 = Math.log(pm / (1 - pm)); ens = []
      const F = new Array(n).fill(f0)
      for (let m = 0; m < rounds; m++) {
        const p = F.map(sigmoid), res = y.map((v, i) => v - p[i])
        const idx = []; for (let i = 0; i < n; i++) if (g.uniform() < subsample) idx.push(i)
        if (idx.length < 2 * minLeaf) continue
        const tree = buildTree(X, res, idx, { maxDepth, minLeaf, criterion: 'mse', mtry: 0, g })
        const fix = nd => { if (nd.leaf) { const num = nd.members.reduce((s, i) => s + res[i], 0), den = nd.members.reduce((s, i) => s + p[i] * (1 - p[i]), 0) + 1e-9; nd.value = num / den; delete nd.members } else { fix(nd.left); fix(nd.right) } }
        fix(tree); ens.push(tree)
        for (let i = 0; i < n; i++) F[i] += lr * walk(tree, X[i]).value
      }
      return this
    },
    predictProba: X => X.map(r => clip(sigmoid(f0 + ens.reduce((s, t) => s + lr * walk(t, r).value, 0)))),
  }
}

/** Linear SVM by Pegasos (stochastic sub-gradient on the hinge loss); probabilities by a sigmoid on the margin fitted to the training set. */
function linearSVM({ lambda = 1e-3, epochs = 30, seed = 1 } = {}) {
  let w = null, b = 0, sc = null, a = 1, c0 = 0
  return {
    name: 'Support vector machine (linear)',
    fit(X, y) {
      sc = scaler(X); const Z = sc.transform(X), n = Z.length, d = Z[0].length, g = L.rng(seed); w = new Array(d).fill(0); b = 0; let t = 0
      for (let e = 0; e < epochs; e++) for (let s = 0; s < n; s++) {
        const i = Math.floor(g.uniform() * n), yi = y[i] ? 1 : -1, eta = 1 / (lambda * (++t + 10))
        const margin = yi * (L.dot(w, Z[i]) + b)
        for (let j = 0; j < d; j++) w[j] *= 1 - eta * lambda
        if (margin < 1) { for (let j = 0; j < d; j++) w[j] += eta * yi * Z[i][j]; b += eta * yi * 0.1 }
      }
      // Platt-style calibration: 1-D logistic on the decision value
      const m = Z.map(z => L.dot(w, z) + b); let pa = 1, pb = 0
      for (let it = 0; it < 200; it++) { let ga = 0, gb = 0; for (let i = 0; i < n; i++) { const err = sigmoid(pa * m[i] + pb) - y[i]; ga += err * m[i]; gb += err } pa -= 0.5 * ga / n; pb -= 0.5 * gb / n }
      a = pa; c0 = pb; return this
    },
    predictProba: X => sc.transform(X).map(r => clip(sigmoid(a * (L.dot(w, r) + b) + c0))),
  }
}

/** Linear (shared covariance) or quadratic (per-class covariance) discriminant analysis, with ridge regularisation. */
function discriminant({ quadratic = false, ridge = 1e-3 } = {}) {
  let cls = null
  return {
    name: quadratic ? 'Quadratic discriminant analysis' : 'Linear discriminant analysis',
    fit(X, y) {
      const d = X[0].length, groups = [0, 1].map(c => X.filter((_, i) => y[i] === c)), mu = groups.map(g => L.columns(g).map(L.mean))
      const covOf = g => { const S = L.covMatrix(g); for (let i = 0; i < d; i++) S[i][i] += ridge; return S }
      let covs; if (quadratic) covs = groups.map(covOf); else { const n0 = groups[0].length, n1 = groups[1].length, A = covOf(groups[0]), B = covOf(groups[1]); const S = A.map((r, i) => r.map((v, j) => (v * (n0 - 1) + B[i][j] * (n1 - 1)) / (n0 + n1 - 2))); covs = [S, S] }
      cls = [0, 1].map(c => ({ mu: mu[c], inv: L.inverse(covs[c]), logDet: detLog(covs[c]), prior: groups[c].length / X.length }))
      return this
    },
    predictProba: X => X.map(r => {
      const sc = cls.map(c => { const dlt = r.map((v, j) => v - c.mu[j]); return Math.log(c.prior) - 0.5 * c.logDet - 0.5 * L.dot(dlt, L.matVec(c.inv, dlt)) })
      return clip(sigmoid(sc[1] - sc[0]))
    }),
  }
}
function detLog(S) { try { const Lc = L.cholesky(S); return Lc.reduce((s, row, i) => s + 2 * Math.log(row[i]), 0) } catch { return 0 } }
const lda = o => discriminant({ ...o, quadratic: false }), qda = o => discriminant({ ...o, quadratic: true })

/* ── unsupervised ─────────────────────────────────────────────────────────────── */

function kmeans(X, k, { seed = 1, iters = 100 } = {}) {
  const n = X.length; if (k < 1 || k > n) throw new Error('k must be between 1 and the number of points')
  const g = L.rng(seed); let C = [X[Math.floor(g.uniform() * n)]]
  while (C.length < k) { const d = X.map(x => Math.min(...C.map(c => dist2(x, c)))), tot = L.sum(d); let r = g.uniform() * tot, i = 0; while (i < n - 1 && (r -= d[i]) > 0) i++; C.push(X[i]) }
  let lab = new Array(n).fill(-1)
  for (let it = 0; it < iters; it++) {
    let moved = false; const nl = X.map(x => { let b = 0, bd = Infinity; C.forEach((c, j) => { const dd = dist2(x, c); if (dd < bd) { bd = dd; b = j } }); return b })
    nl.forEach((l, i) => { if (l !== lab[i]) moved = true }); lab = nl
    C = C.map((c, j) => { const m = X.filter((_, i) => lab[i] === j); return m.length ? L.columns(m).map(L.mean) : c })
    if (!moved) break
  }
  const inertia = X.reduce((s, x, i) => s + dist2(x, C[lab[i]]), 0)
  return { labels: lab, centroids: C, inertia, sizes: C.map((_, j) => lab.filter(l => l === j).length) }
}

/** DBSCAN. label −1 = noise. Finds non-spherical clusters and flags outliers (e.g. anomalous names). */
function dbscan(X, { eps = 0.5, minPts = 4 } = {}) {
  const n = X.length, lab = new Array(n).fill(undefined), e2 = eps * eps
  const nb = i => { const o = []; for (let j = 0; j < n; j++) if (dist2(X[i], X[j]) <= e2) o.push(j); return o }
  let c = -1
  for (let i = 0; i < n; i++) {
    if (lab[i] !== undefined) continue
    const N = nb(i); if (N.length < minPts) { lab[i] = -1; continue }
    c++; lab[i] = c; const q = N.filter(j => j !== i)
    while (q.length) { const j = q.shift(); if (lab[j] === -1) lab[j] = c; if (lab[j] !== undefined) continue; lab[j] = c; const M = nb(j); if (M.length >= minPts) q.push(...M) }
  }
  return { labels: lab, clusters: c + 1, noise: lab.filter(l => l === -1).length }
}

/** Agglomerative clustering (average linkage) cut to k clusters; also returns the merge order (dendrogram). */
function hierarchical(X, k) {
  const n = X.length; if (k < 1 || k > n) throw new Error('k must be between 1 and the number of points')
  let clusters = X.map((_, i) => [i]); const D = X.map(a => X.map(b => Math.sqrt(dist2(a, b)))), merges = []
  const link = (A, B) => { let s = 0; for (const i of A) for (const j of B) s += D[i][j]; return s / (A.length * B.length) }
  while (clusters.length > 1) {
    let bi = 0, bj = 1, bd = Infinity
    for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) { const d = link(clusters[i], clusters[j]); if (d < bd) { bd = d; bi = i; bj = j } }
    merges.push({ a: clusters[bi].slice(), b: clusters[bj].slice(), distance: bd })
    const merged = clusters[bi].concat(clusters[bj]); clusters = clusters.filter((_, i) => i !== bi && i !== bj); clusters.push(merged)
    if (clusters.length === k) var cut = clusters.map(c => c.slice())
  }
  const labels = new Array(n).fill(0); (cut || [[...Array(n).keys()]]).forEach((c, j) => c.forEach(i => { labels[i] = j }))
  return { labels, merges }
}

/** Exact t-SNE to 2-D. O(n²) per iteration — keep n ≲ 400. Distances are on standardised features. */
function tsne(X, { perplexity = 15, iters = 400, lr = 100, seed = 1 } = {}) {
  const n = X.length; if (n < 5) throw new Error('t-SNE needs at least 5 points')
  const perp = Math.min(perplexity, (n - 1) / 3), Z = scaler(X).transform(X), D = Z.map(a => Z.map(b => dist2(a, b)))
  const P = Array.from({ length: n }, () => new Float64Array(n)), target = Math.log(perp)
  for (let i = 0; i < n; i++) {
    let lo = 1e-10, hi = 1e10, beta = 1
    for (let t = 0; t < 60; t++) {
      let sum = 0, H = 0; const row = new Float64Array(n)
      for (let j = 0; j < n; j++) if (j !== i) { row[j] = Math.exp(-D[i][j] * beta); sum += row[j] }
      for (let j = 0; j < n; j++) if (j !== i && sum > 0) H += beta * D[i][j] * row[j] / sum
      H += Math.log(sum || 1e-300)
      if (Math.abs(H - target) < 1e-4) { for (let j = 0; j < n; j++) P[i][j] = sum > 0 ? row[j] / sum : 0; break }
      if (H > target) { lo = beta; beta = hi >= 1e10 ? beta * 2 : (beta + hi) / 2 } else { hi = beta; beta = (beta + lo) / 2 }
      for (let j = 0; j < n; j++) P[i][j] = sum > 0 ? row[j] / sum : 0
    }
  }
  const Ps = Array.from({ length: n }, (_, i) => Float64Array.from({ length: n }, (_, j) => Math.max((P[i][j] + P[j][i]) / (2 * n), 1e-12)))
  const g = L.rng(seed); let Y = Array.from({ length: n }, () => [1e-2 * g.normal(), 1e-2 * g.normal()]), V = Y.map(() => [0, 0])
  for (let it = 0; it < iters; it++) {
    const ex = it < 100 ? 4 : 1, mom = it < 100 ? 0.5 : 0.8
    const num = Array.from({ length: n }, () => new Float64Array(n)); let Z2 = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const v = 1 / (1 + dist2(Y[i], Y[j])); num[i][j] = num[j][i] = v; Z2 += 2 * v }
    const grad = Y.map(() => [0, 0])
    for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (i !== j) { const q = Math.max(num[i][j] / Z2, 1e-12), m = 4 * (ex * Ps[i][j] - q) * num[i][j]; grad[i][0] += m * (Y[i][0] - Y[j][0]); grad[i][1] += m * (Y[i][1] - Y[j][1]) }
    for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) { V[i][c] = mom * V[i][c] - lr * grad[i][c]; Y[i][c] += V[i][c] }
    const cx = L.mean(Y.map(y => y[0])), cy = L.mean(Y.map(y => y[1])); Y = Y.map(y => [y[0] - cx, y[1] - cy])
  }
  return { embedding: Y }
}

const MODELS = { logistic, knn, gaussianNB, decisionTree, randomForest, gradientBoosting, linearSVM, lda, qda }

module.exports = { scaler, sigmoid, ...MODELS, knnRegressor, kmeans, dbscan, hierarchical, tsne, MODELS }
