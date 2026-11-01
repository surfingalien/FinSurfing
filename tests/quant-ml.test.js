'use strict'
const M = require('../lib/quant/ml')
const L = require('../lib/quant/linalg')

// two Gaussian blobs, plus an XOR set (not linearly separable)
function blobs(n, seed, sep = 2) { const g = L.rng(seed), X = [], y = []; for (let i = 0; i < n; i++) { const c = i % 2; X.push([g.normal() + (c ? sep : 0), g.normal() + (c ? sep : 0)]); y.push(c) } return { X, y } }
function xor(n, seed) { const g = L.rng(seed), X = [], y = []; for (let i = 0; i < n; i++) { const a = g.uniform() * 2 - 1, b = g.uniform() * 2 - 1; X.push([a, b]); y.push(a * b > 0 ? 1 : 0) } return { X, y } }
const acc = (p, y) => p.filter((v, i) => (v > 0.5 ? 1 : 0) === y[i]).length / y.length

test.each(['logistic', 'knn', 'gaussianNB', 'decisionTree', 'randomForest', 'gradientBoosting', 'linearSVM', 'lda', 'qda'])('%s separates two blobs out of sample', name => {
  const tr = blobs(400, 1), te = blobs(400, 2), m = M[name]().fit(tr.X, tr.y), p = m.predictProba(te.X)
  expect(acc(p, te.y)).toBeGreaterThan(0.8); p.forEach(v => { expect(v).toBeGreaterThan(0); expect(v).toBeLessThan(1) })
})
test('non-linear models solve XOR; linear ones cannot', () => {
  const tr = xor(800, 3), te = xor(400, 4)
  for (const name of ['decisionTree', 'randomForest', 'gradientBoosting', 'knn', 'qda']) expect(acc(M[name](name === 'decisionTree' ? { maxDepth: 6 } : {}).fit(tr.X, tr.y).predictProba(te.X), te.y)).toBeGreaterThan(0.85)
  for (const name of ['logistic', 'linearSVM']) expect(acc(M[name]().fit(tr.X, tr.y).predictProba(te.X), te.y)).toBeLessThan(0.65)
})
test('on pure noise no model beats a coin by much (the honest result)', () => {
  const g = L.rng(5), mk = n => ({ X: Array.from({ length: n }, () => [g.normal(), g.normal(), g.normal()]), y: Array.from({ length: n }, () => (g.uniform() < 0.5 ? 1 : 0)) })
  const tr = mk(500), te = mk(1000)
  for (const name of ['logistic', 'randomForest', 'gradientBoosting']) { const a = acc(M[name]().fit(tr.X, tr.y).predictProba(te.X), te.y); expect(a).toBeGreaterThan(0.42); expect(a).toBeLessThan(0.58) }
})
test('random forest importance finds the informative feature; fits are deterministic per seed', () => {
  const g = L.rng(6), X = Array.from({ length: 600 }, () => [g.normal(), g.normal(), g.normal()]), y = X.map(r => (r[1] > 0 ? 1 : 0))
  const rf = M.randomForest({ trees: 40 }).fit(X, y), imp = rf.importance()
  expect(Number(Object.entries(imp).sort((a, b) => b[1] - a[1])[0][0])).toBe(1)
  const a = M.randomForest({ trees: 10, seed: 3 }).fit(X, y).predictProba(X.slice(0, 5)), b = M.randomForest({ trees: 10, seed: 3 }).fit(X, y).predictProba(X.slice(0, 5)); expect(a).toEqual(b)
})
function threeBlobs(seed) { const g = L.rng(seed), X = [], truth = []; [[0, 0], [8, 0], [4, 7]].forEach((c, k) => { for (let i = 0; i < 40; i++) { X.push([c[0] + g.normal() * 0.6, c[1] + g.normal() * 0.6]); truth.push(k) } }); return { X, truth } }
const purity = (lab, truth) => { const groups = {}; lab.forEach((l, i) => { (groups[l] = groups[l] || []).push(truth[i]) }); return Object.values(groups).reduce((s, g) => s + Math.max(...[0, 1, 2].map(t => g.filter(v => v === t).length)), 0) / lab.length }
test('k-means, hierarchical clustering and DBSCAN recover three well-separated groups', () => {
  const { X, truth } = threeBlobs(7)
  expect(purity(M.kmeans(X, 3, { seed: 2 }).labels, truth)).toBeGreaterThan(0.97)
  expect(purity(M.hierarchical(X, 3).labels, truth)).toBeGreaterThan(0.97)
  const d = M.dbscan(X, { eps: 1.2, minPts: 4 }); expect(d.clusters).toBe(3); expect(d.noise).toBeLessThan(6)
  expect(M.dbscan([...X, [30, 30]], { eps: 1.2, minPts: 4 }).labels.slice(-1)[0]).toBe(-1)      // an outlier is flagged as noise
  expect(() => M.kmeans(X, 0)).toThrow()
})
test('t-SNE keeps neighbours together: 2-D embedding of three groups stays separable', () => {
  const g = L.rng(8), X = [], truth = []; [0, 1, 2].forEach(k => { for (let i = 0; i < 30; i++) { X.push(Array.from({ length: 6 }, (_, j) => (j === k ? 6 : 0) + g.normal() * 0.5)); truth.push(k) } })
  const { embedding } = M.tsne(X, { perplexity: 10, iters: 300, seed: 3 })
  expect(embedding).toHaveLength(90); expect(purity(M.kmeans(embedding, 3, { seed: 1 }).labels, truth)).toBeGreaterThan(0.9)
})
