'use strict'
/**
 * lib/quant/neural.js — small neural models with hand-written backpropagation, plus tabular Q-learning.
 *
 *   mlp        multi-layer perceptron (one hidden layer, tanh) on tabular features
 *   cnn1d      1-D convolutional net on a window of returns (filters → ReLU → global max-pool → dense)
 *   lstm       single-layer LSTM over a sequence of feature vectors (full back-propagation through time)
 *   qLearning  tabular Q-learning trader on a discretised (trend, volatility, position) state
 *
 * Parameters live in one flat Float64Array so a single Adam optimiser and a single numerical
 * gradient check (tests/quant-neural.test.js) cover all three nets — the check is what makes
 * hand-written backprop trustworthy. Seeded, deterministic, CPU-only; sized for ≤ a few thousand
 * samples. They will not beat the tree models on small tabular data; they are here to be MEASURED.
 */
const L = require('./linalg')
const { scaler, sigmoid } = require('./ml')

const clip = p => Math.min(1 - 1e-9, Math.max(1e-9, p))

/** Adam over a flat parameter vector. */
function adam(n, { lr = 0.01, b1 = 0.9, b2 = 0.999, eps = 1e-8 } = {}) {
  const m = new Float64Array(n), v = new Float64Array(n); let t = 0
  return (params, grad) => { t++; for (let i = 0; i < n; i++) { m[i] = b1 * m[i] + (1 - b1) * grad[i]; v[i] = b2 * v[i] + (1 - b2) * grad[i] * grad[i]; params[i] -= lr * (m[i] / (1 - b1 ** t)) / (Math.sqrt(v[i] / (1 - b2 ** t)) + eps) } }
}

/* ── MLP ─────────────────────────────────────────────────────────────────────── */
function mlpCore(d, H) {
  const size = H * d + H + H + 1
  const off = { W1: 0, b1: H * d, W2: H * d + H, b2: H * d + 2 * H }
  const forward = (p, x) => { const h = new Float64Array(H); for (let j = 0; j < H; j++) { let s = p[off.b1 + j]; for (let k = 0; k < d; k++) s += p[off.W1 + j * d + k] * x[k]; h[j] = Math.tanh(s) } let z = p[off.b2]; for (let j = 0; j < H; j++) z += p[off.W2 + j] * h[j]; return { h, z, p: sigmoid(z) } }
  const grad = (p, x, y, g) => { const f = forward(p, x), e = f.p - y; g[off.b2] += e; for (let j = 0; j < H; j++) { g[off.W2 + j] += e * f.h[j]; const dh = e * p[off.W2 + j] * (1 - f.h[j] ** 2); g[off.b1 + j] += dh; for (let k = 0; k < d; k++) g[off.W1 + j * d + k] += dh * x[k] } return -(y * Math.log(clip(f.p)) + (1 - y) * Math.log(clip(1 - f.p))) }
  return { size, forward, grad }
}
function init(p, seed, blocks) { const g = L.rng(seed); for (const [from, to, fan] of blocks) for (let i = from; i < to; i++) p[i] = g.normal() * Math.sqrt(1 / fan); return p }

function trainLoop(core, p, X, y, { epochs, batch, lr, l2, seed }) {
  const n = X.length, opt = adam(p.length, { lr }), g = L.rng(seed + 100), order = [...Array(n).keys()]
  for (let e = 0; e < epochs; e++) {
    for (let i = n - 1; i > 0; i--) { const j = Math.floor(g.uniform() * (i + 1)); [order[i], order[j]] = [order[j], order[i]] }
    for (let s = 0; s < n; s += batch) {
      const gr = new Float64Array(p.length), idx = order.slice(s, s + batch)
      for (const i of idx) core.grad(p, X[i], y[i], gr)
      for (let k = 0; k < p.length; k++) gr[k] = gr[k] / idx.length + l2 * p[k]
      opt(p, gr)
    }
  }
}

function mlp({ hidden = 12, epochs = 60, batch = 32, lr = 0.01, l2 = 1e-3, seed = 1 } = {}) {
  let core, p, sc
  return {
    name: 'Neural network (MLP)',
    fit(X, y) { sc = scaler(X); const Z = sc.transform(X), d = Z[0].length; core = mlpCore(d, hidden); p = new Float64Array(core.size); init(p, seed, [[0, hidden * d, d], [hidden * d + hidden, hidden * d + 2 * hidden, hidden]]); trainLoop(core, p, Z, y, { epochs, batch, lr, l2, seed }); return this },
    predictProba: X => sc.transform(X).map(r => clip(core.forward(p, r).p)),
    _core: () => mlpCore, 
  }
}

/* ── 1-D CNN ─────────────────────────────────────────────────────────────────── */
function cnnCore(T, F, W) {
  const nOut = T - W + 1, off = { K: 0, bf: F * W, wd: F * W + F, bd: F * W + 2 * F }, size = F * W + 2 * F + 1
  const forward = (p, x) => {
    const pooled = new Float64Array(F), arg = new Int32Array(F).fill(-1)
    for (let f = 0; f < F; f++) { let best = 0; for (let t = 0; t < nOut; t++) { let s = p[off.bf + f]; for (let k = 0; k < W; k++) s += p[off.K + f * W + k] * x[t + k]; if (s > best) { best = s; arg[f] = t } } pooled[f] = best }
    let z = p[off.bd]; for (let f = 0; f < F; f++) z += p[off.wd + f] * pooled[f]
    return { pooled, arg, z, p: sigmoid(z) }
  }
  const grad = (p, x, y, g) => { const r = forward(p, x), e = r.p - y; g[off.bd] += e; for (let f = 0; f < F; f++) { g[off.wd + f] += e * r.pooled[f]; if (r.arg[f] >= 0) { const dp = e * p[off.wd + f]; g[off.bf + f] += dp; for (let k = 0; k < W; k++) g[off.K + f * W + k] += dp * x[r.arg[f] + k] } } return -(y * Math.log(clip(r.p)) + (1 - y) * Math.log(clip(1 - r.p))) }
  return { size, forward, grad }
}
function cnn1d({ filters = 6, width = 4, epochs = 50, batch = 32, lr = 0.01, l2 = 1e-3, seed = 1 } = {}) {
  let core, p, mu = 0, sd = 1
  return {
    name: 'Convolutional network (1-D CNN)',
    fit(X, y) { const flat = X.flat(); mu = L.mean(flat); sd = L.stdev(flat) || 1; const Z = X.map(r => r.map(v => (v - mu) / sd), 0), T = Z[0].length; core = cnnCore(T, filters, width); p = new Float64Array(core.size); init(p, seed, [[0, filters * width, width], [filters * width + filters, filters * width + 2 * filters, filters]]); trainLoop(core, p, Z, y, { epochs, batch, lr, l2, seed }); return this },
    predictProba: X => X.map(r => clip(core.forward(p, r.map(v => (v - mu) / sd)).p)),
  }
}

/* ── LSTM ────────────────────────────────────────────────────────────────────── */
function lstmCore(d, H) {
  const off = { Wx: 0, Wh: 4 * H * d, b: 4 * H * d + 4 * H * H, wd: 4 * H * d + 4 * H * H + 4 * H, bd: 4 * H * d + 4 * H * H + 4 * H + H }
  const size = off.bd + 1
  const forward = (p, seq) => {
    const T = seq.length, hs = [new Float64Array(H)], cs = [new Float64Array(H)], gates = []
    for (let t = 0; t < T; t++) {
      const x = seq[t], hp = hs[t], cp = cs[t], z = new Float64Array(4 * H)
      for (let r = 0; r < 4 * H; r++) { let s = p[off.b + r]; for (let k = 0; k < d; k++) s += p[off.Wx + r * d + k] * x[k]; for (let k = 0; k < H; k++) s += p[off.Wh + r * H + k] * hp[k]; z[r] = s }
      const i = new Float64Array(H), f = new Float64Array(H), gg = new Float64Array(H), o = new Float64Array(H), c = new Float64Array(H), h = new Float64Array(H)
      for (let j = 0; j < H; j++) { i[j] = sigmoid(z[j]); f[j] = sigmoid(z[H + j]); gg[j] = Math.tanh(z[2 * H + j]); o[j] = sigmoid(z[3 * H + j]); c[j] = f[j] * cp[j] + i[j] * gg[j]; h[j] = o[j] * Math.tanh(c[j]) }
      hs.push(h); cs.push(c); gates.push({ i, f, g: gg, o })
    }
    let z = p[off.bd]; const hl = hs[T]; for (let j = 0; j < H; j++) z += p[off.wd + j] * hl[j]
    return { hs, cs, gates, z, p: sigmoid(z) }
  }
  const grad = (p, seq, y, g) => {
    const r = forward(p, seq), T = seq.length, e = r.p - y; g[off.bd] += e
    let dh = new Float64Array(H), dc = new Float64Array(H); for (let j = 0; j < H; j++) { g[off.wd + j] += e * r.hs[T][j]; dh[j] = e * p[off.wd + j] }
    for (let t = T - 1; t >= 0; t--) {
      const { i, f, g: gg, o } = r.gates[t], c = r.cs[t + 1], cp = r.cs[t], hp = r.hs[t], x = seq[t], dz = new Float64Array(4 * H)
      for (let j = 0; j < H; j++) {
        const tc = Math.tanh(c[j]), do_ = dh[j] * tc, dcj = dc[j] + dh[j] * o[j] * (1 - tc * tc)
        dz[j] = dcj * gg[j] * i[j] * (1 - i[j]); dz[H + j] = dcj * cp[j] * f[j] * (1 - f[j]); dz[2 * H + j] = dcj * i[j] * (1 - gg[j] * gg[j]); dz[3 * H + j] = do_ * o[j] * (1 - o[j]); dc[j] = dcj * f[j]
      }
      const dhp = new Float64Array(H)
      for (let rr = 0; rr < 4 * H; rr++) { const dzr = dz[rr]; if (!dzr) continue; g[off.b + rr] += dzr; for (let k = 0; k < d; k++) g[off.Wx + rr * d + k] += dzr * x[k]; for (let k = 0; k < H; k++) { g[off.Wh + rr * H + k] += dzr * hp[k]; dhp[k] += p[off.Wh + rr * H + k] * dzr } }
      dh = dhp
    }
    return -(y * Math.log(clip(r.p)) + (1 - y) * Math.log(clip(1 - r.p)))
  }
  return { size, forward, grad, off }
}
/** seqs: [samples][T][d]. */
function lstm({ hidden = 8, epochs = 25, batch = 32, lr = 0.01, l2 = 1e-3, seed = 1 } = {}) {
  let core, p, mu, sd
  return {
    name: 'Recurrent network (LSTM)',
    fit(S, y) {
      const d = S[0][0].length, rows = S.flat(); mu = L.columns(rows).map(L.mean); sd = L.columns(rows).map(c => L.stdev(c) || 1)
      const Z = S.map(s => s.map(v => v.map((x, j) => (x - mu[j]) / sd[j]))); core = lstmCore(d, hidden); p = new Float64Array(core.size)
      init(p, seed, [[0, core.off.b, hidden]]); for (let j = 0; j < hidden; j++) p[core.off.b + hidden + j] = 1   // forget-gate bias 1: remember by default
      init(p, seed + 1, [[core.off.wd, core.off.wd + hidden, hidden]]); trainLoop(core, p, Z, y, { epochs, batch, lr, l2, seed }); return this
    },
    predictProba: S => S.map(s => clip(core.forward(p, s.map(v => v.map((x, j) => (x - mu[j]) / sd[j]))).p)),
  }
}

/* ── Q-learning ──────────────────────────────────────────────────────────────── */
/**
 * Tabular Q-learning on one symbol. State = (5-day return tercile, 20-day vol tercile, current position); actions =
 * flat or long. Reward = position·next-day return − cost on position changes. Terciles come from the TRAINING
 * segment only; the learned greedy policy is then run on the untouched final segment and compared with buy-and-hold.
 */
function qLearning(bars, { trainShare = 0.6, episodes = 60, alpha = 0.1, gamma = 0.9, epsilon = 0.2, costBps = 10, seed = 1 } = {}) {
  const c = bars.map(b => b.c).filter(v => v > 0); if (c.length < 250) throw new Error('need at least 250 bars')
  const r = L.returnsOf(c), n = r.length, cut = Math.floor(n * trainShare), lb = 20
  const feat = i => ({ m: c[i + 1] / c[Math.max(0, i - 4)] - 1, v: L.stdev(r.slice(Math.max(0, i - lb), i + 1)) })
  const idx = []; for (let i = lb; i < n - 1; i++) idx.push(i)
  const train = idx.filter(i => i < cut), test = idx.filter(i => i >= cut)
  const q = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.floor(p * (arr.length - 1))]
  const Ft = train.map(feat), m1 = q(Ft.map(f => f.m), 1 / 3), m2 = q(Ft.map(f => f.m), 2 / 3), v1 = q(Ft.map(f => f.v), 1 / 3), v2 = q(Ft.map(f => f.v), 2 / 3)
  const bucket = (x, a, b) => (x <= a ? 0 : x <= b ? 1 : 2)
  const state = (i, pos) => { const f = feat(i); return bucket(f.m, m1, m2) * 6 + bucket(f.v, v1, v2) * 2 + pos }
  const Q = Array.from({ length: 18 }, () => [0, 0]), g = L.rng(seed), cost = costBps / 1e4
  for (let e = 0; e < episodes; e++) {
    let pos = 0, eps = epsilon * (1 - e / episodes)
    for (let k = 0; k < train.length - 1; k++) {
      const i = train[k], s = state(i, pos), a = g.uniform() < eps ? (g.uniform() < 0.5 ? 0 : 1) : (Q[s][1] > Q[s][0] ? 1 : 0)
      const reward = a * r[i + 1] - cost * Math.abs(a - pos), s2 = state(train[k + 1], a)
      Q[s][a] += alpha * (reward + gamma * Math.max(...Q[s2]) - Q[s][a]); pos = a
    }
  }
  let pos = 0, trades = 0; const rets = []
  for (const i of test) { const a = Q[state(i, pos)][1] > Q[state(i, pos)][0] ? 1 : 0; rets.push(a * r[i + 1] - cost * Math.abs(a - pos)); if (a !== pos) trades++; pos = a }
  const bh = test.map(i => r[i + 1]), sh = x => { const s = L.stdev(x); return s > 0 ? L.mean(x) / s * Math.sqrt(252) : 0 }
  const labels = ['down', 'flat', 'up'], vl = ['calm', 'normal', 'volatile']
  const policy = []; for (let m = 0; m < 3; m++) for (let v = 0; v < 3; v++) { const s = m * 6 + v * 2; policy.push({ state: `${labels[m]} momentum, ${vl[v]}`, whenFlat: Q[s][1] > Q[s][0] ? 'go long' : 'stay out', whenLong: Q[s + 1][1] > Q[s + 1][0] ? 'hold' : 'exit' }) }
  return { train: train.length, test: test.length, sharpe: sh(rets), totalReturn: rets.reduce((a, x) => a * (1 + x), 1) - 1, buyHoldSharpe: sh(bh), buyHoldReturn: bh.reduce((a, x) => a * (1 + x), 1) - 1, trades, exposure: rets.filter(x => x !== 0).length / rets.length, policy, note: 'Reinforcement learning on one price series overfits easily; trust only the out-of-sample columns.' }
}

module.exports = { adam, mlp, mlpCore, cnn1d, cnnCore, lstm, lstmCore, qLearning }
