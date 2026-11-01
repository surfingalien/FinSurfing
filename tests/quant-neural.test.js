'use strict'
const N = require('../lib/quant/neural')
const L = require('../lib/quant/linalg')

// Numerical gradient check: analytic backprop must match central finite differences.
function gradCheck(core, make, tol = 1e-5) {
  const g = L.rng(1), p = new Float64Array(core.size).map(() => 0.4 * g.normal()), { x, y } = make(g)
  const an = new Float64Array(core.size); core.grad(p, x, y, an)
  const loss = q => { const pr = core.forward(q, x).p; return -(y * Math.log(pr) + (1 - y) * Math.log(1 - pr)) }
  let worst = 0
  for (let i = 0; i < core.size; i++) { const h = 1e-6, a = Float64Array.from(p), b = Float64Array.from(p); a[i] += h; b[i] -= h; const num = (loss(a) - loss(b)) / (2 * h); worst = Math.max(worst, Math.abs(num - an[i]) / Math.max(1, Math.abs(num), Math.abs(an[i]))) }
  expect(worst).toBeLessThan(tol)
}
test('MLP backprop matches numerical gradients', () => gradCheck(N.mlpCore(4, 5), g => ({ x: Array.from({ length: 4 }, () => g.normal()), y: 1 })))
test('1-D CNN backprop matches numerical gradients', () => gradCheck(N.cnnCore(10, 3, 3), g => ({ x: Array.from({ length: 10 }, () => g.normal()), y: 0 })))
test('LSTM BPTT matches numerical gradients', () => gradCheck(N.lstmCore(3, 4), g => ({ x: Array.from({ length: 6 }, () => Array.from({ length: 3 }, () => g.normal())), y: 1 }), 1e-4))

const acc = (p, y) => p.filter((v, i) => (v > 0.5 ? 1 : 0) === y[i]).length / y.length
test('MLP learns XOR', () => {
  const g = L.rng(2), mk = n => { const X = [], y = []; for (let i = 0; i < n; i++) { const a = g.uniform() * 2 - 1, b = g.uniform() * 2 - 1; X.push([a, b]); y.push(a * b > 0 ? 1 : 0) } return { X, y } }
  const tr = mk(800), te = mk(400), m = N.mlp({ hidden: 10, epochs: 120 }).fit(tr.X, tr.y)
  expect(acc(m.predictProba(te.X), te.y)).toBeGreaterThan(0.85)
})
test('CNN detects a planted local pattern anywhere in the window', () => {
  const g = L.rng(3), mk = n => { const X = [], y = []; for (let i = 0; i < n; i++) { const x = Array.from({ length: 16 }, () => 0.3 * g.normal()), has = g.uniform() < 0.5; if (has) { const t = Math.floor(g.uniform() * 12); x[t] = 2; x[t + 1] = -2; x[t + 2] = 2 } X.push(x); y.push(has ? 1 : 0) } return { X, y } }
  const tr = mk(600), te = mk(300), m = N.cnn1d({ filters: 6, width: 3, epochs: 60 }).fit(tr.X, tr.y)
  expect(acc(m.predictProba(te.X), te.y)).toBeGreaterThan(0.85)
})
test('LSTM learns an order-dependent rule (first value positive ⇒ class 1) across a sequence', () => {
  const g = L.rng(4), mk = n => { const S = [], y = []; for (let i = 0; i < n; i++) { const s = Array.from({ length: 8 }, () => [g.normal()]); S.push(s); y.push(s[0][0] > 0 ? 1 : 0) } return { S, y } }
  const tr = mk(500), te = mk(300), m = N.lstm({ hidden: 8, epochs: 40, lr: 0.02 }).fit(tr.S, tr.y)
  expect(acc(m.predictProba(te.S), te.y)).toBeGreaterThan(0.8)
})
test('Q-learning reports out-of-sample results against buy and hold, and learns a trend rule on a trending market', () => {
  const g = L.rng(5); let p = 100, drift = 0.001; const bars = []
  for (let i = 0; i < 1500; i++) { if (i % 100 === 0) drift = g.uniform() < 0.5 ? 0.002 : -0.002; p *= 1 + drift + 0.008 * g.normal(); bars.push({ c: p }) }
  const q = N.qLearning(bars, { seed: 2 })
  expect(q.test).toBeGreaterThan(300); expect(q.policy).toHaveLength(9); expect(q.exposure).toBeGreaterThanOrEqual(0); expect(q.note).toMatch(/out-of-sample/)
  expect(() => N.qLearning(bars.slice(0, 100))).toThrow()
})
