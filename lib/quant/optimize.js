'use strict'
/**
 * lib/quant/optimize.js — portfolio construction: mean–variance (max Sharpe, min variance,
 * efficient frontier), equal-risk-contribution risk parity, inverse volatility, with
 * Ledoit–Wolf covariance shrinkage and weight caps — and a comparison against HRP that
 * scores every method OUT of sample, because in-sample Sharpe ranks the optimisers by how
 * well they overfit, not by how well they work (estimated μ is the weak link).
 *
 * Long-only, fully invested, per-asset cap. Solvers are projected gradient on the capped
 * simplex (bisection projection) — slow but dependency-free and robust for ≤ ~50 assets.
 * Tests: tests/quant-optimize.test.js
 */
const L = require('./linalg')
const hrp = require('../hrp')

const ANN = 252

/** Ledoit–Wolf (2004) shrinkage of the sample covariance toward a scaled identity. Rows = observations. */
function ledoitWolf(rows) {
  const T = rows.length, N = rows[0].length
  const means = L.columns(rows).map(L.mean), X = rows.map(r => r.map((v, j) => v - means[j]))
  const S = L.identity(N).map(() => new Array(N).fill(0))
  for (const x of X) for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) S[i][j] += x[i] * x[j] / T
  const mu = S.reduce((a, r, i) => a + r[i], 0) / N
  let d2 = 0
  for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) d2 += (S[i][j] - (i === j ? mu : 0)) ** 2
  d2 /= N
  let b2 = 0
  for (const x of X) { let f = 0; for (let i = 0; i < N; i++) for (let j = 0; j < N; j++) f += (x[i] * x[j] - S[i][j]) ** 2; b2 += f / N }
  b2 = Math.min(b2 / (T * T), d2)
  const shrinkage = d2 > 0 ? b2 / d2 : 1
  const cov = S.map((r, i) => r.map((v, j) => shrinkage * (i === j ? mu : 0) + (1 - shrinkage) * v))
  return { cov, shrinkage, sample: S }
}

/** Euclidean projection onto { Σw = 1, lo ≤ w ≤ hi } by bisection on the shift τ. */
function projectCapped(v, lo = 0, hi = 1) {
  const n = v.length
  if (lo * n > 1 + 1e-12 || hi * n < 1 - 1e-12) throw new Error(`infeasible weight bounds for ${n} assets (min ${lo}, max ${hi})`)
  const f = tau => v.reduce((a, x) => a + Math.min(hi, Math.max(lo, x - tau)), 0) - 1
  let a = Math.min(...v) - hi - 1, b = Math.max(...v) - lo + 1
  for (let i = 0; i < 100; i++) { const m = (a + b) / 2; if (f(m) > 0) a = m; else b = m }
  const tau = (a + b) / 2
  return v.map(x => Math.min(hi, Math.max(lo, x - tau)))
}

/** Maximise μᵀw − (λ/2) wᵀΣw on the capped simplex (λ → ∞ is minimum variance). */
function meanVarianceUtility(mu, S, lambda, { cap = 1, minW = 0, iters = 4000 } = {}) {
  const n = mu.length
  const norm = Math.sqrt(S.reduce((a, r) => a + r.reduce((b, x) => b + x * x, 0), 0))
  const step = 1 / (lambda * norm + 1e-12)
  let w = projectCapped(new Array(n).fill(1 / n), minW, cap)
  for (let it = 0; it < iters; it++) {
    const g = L.matVec(S, w).map((s, i) => mu[i] - lambda * s)
    const next = projectCapped(w.map((x, i) => x + step * g[i]), minW, cap)
    let d = 0; for (let i = 0; i < n; i++) d = Math.max(d, Math.abs(next[i] - w[i]))
    w = next; if (d < 1e-10) break
  }
  return w
}

const stats = (w, mu, S, rf = 0) => {
  const ret = L.dot(w, mu), vol = Math.sqrt(Math.max(0, L.quadForm(w, S)))
  return { ret, vol, sharpe: vol > 0 ? (ret - rf) / vol : 0 }
}

/** Minimum-variance portfolio. */
function minVariance(S, opts = {}) { return meanVarianceUtility(new Array(S.length).fill(0), S, 1, opts) }

/** Efficient frontier: sweep risk aversion; return points, the minimum-variance point and the maximum-Sharpe point. */
function efficientFrontier(mu, S, { points = 25, rf = 0, cap = 1, minW = 0 } = {}) {
  const lambdas = Array.from({ length: points }, (_, i) => Math.exp(Math.log(0.3) + (Math.log(300) - Math.log(0.3)) * (1 - i / (points - 1)) ** 1))
  const scale = 1
  const pts = lambdas.map(l => { const w = meanVarianceUtility(mu, S, l * scale, { cap, minW }); return { lambda: l, w, ...stats(w, mu, S, rf) } })
  // refine the max-Sharpe point by golden section on log λ around the best sweep point
  let best = pts.reduce((a, b) => (b.sharpe > a.sharpe ? b : a))
  let lo = Math.log(best.lambda / 2), hi = Math.log(best.lambda * 2)
  const sharpeAt = ll => { const w = meanVarianceUtility(mu, S, Math.exp(ll), { cap, minW }); return { w, ...stats(w, mu, S, rf) } }
  const gr = (Math.sqrt(5) - 1) / 2; let c = hi - gr * (hi - lo), d = lo + gr * (hi - lo), fc = sharpeAt(c), fd = sharpeAt(d)
  for (let i = 0; i < 18; i++) { if (fc.sharpe > fd.sharpe) { hi = d; d = c; fd = fc; c = hi - gr * (hi - lo); fc = sharpeAt(c) } else { lo = c; c = d; fc = fd; d = lo + gr * (hi - lo); fd = sharpeAt(d) } }
  const refined = fc.sharpe > fd.sharpe ? fc : fd
  if (refined.sharpe >= best.sharpe) best = { lambda: Math.exp((lo + hi) / 2), ...refined }
  const mv = minVariance(S, { cap, minW })
  return { points: pts.map(({ w, lambda, ...s }) => s).sort((a, b) => a.vol - b.vol), minVariance: { w: mv, ...stats(mv, mu, S, rf) }, maxSharpe: best }
}

/** Maximum-Sharpe long-only portfolio (tangency) with an optional per-asset cap. */
const maxSharpe = (mu, S, opts = {}) => efficientFrontier(mu, S, { points: 15, ...opts }).maxSharpe.w

/** Equal risk contribution (risk parity) by cyclical coordinate descent; weights sum to 1, long-only, uncapped. */
function riskParity(S, { budget = null, iters = 2000 } = {}) {
  const n = S.length, b = budget || new Array(n).fill(1 / n)
  let w = S.map((r, i) => 1 / Math.sqrt(r[i])); const s0 = L.sum(w); w = w.map(x => x / s0)
  for (let it = 0; it < iters; it++) {
    let moved = 0
    for (let i = 0; i < n; i++) {
      let off = 0; for (let j = 0; j < n; j++) if (j !== i) off += S[i][j] * w[j]
      const nw = (-off + Math.sqrt(off * off + 4 * S[i][i] * b[i])) / (2 * S[i][i])
      moved = Math.max(moved, Math.abs(nw - w[i])); w[i] = nw
    }
    if (moved < 1e-12) break
  }
  const s = L.sum(w); return w.map(x => x / s)
}
/** Each asset's share of total portfolio risk: wᵢ(Σw)ᵢ / wᵀΣw. */
function riskContributions(w, S) { const m = L.matVec(S, w), t = L.dot(w, m); return w.map((x, i) => (t > 0 ? x * m[i] / t : 0)) }
const inverseVol = S => { const v = S.map((r, i) => 1 / Math.sqrt(r[i])), s = L.sum(v); return v.map(x => x / s) }
const equalWeight = n => new Array(n).fill(1 / n)

/**
 * Build every portfolio from the first `trainShare` of the history and score each on the rest.
 * barsBySymbol: { SYM: [{t, c}] }. Expected returns are shrunk halfway to the cross-sectional mean
 * (an unshrunk historical μ is the single biggest cause of optimiser failure).
 */
function compareMethods(barsBySymbol, { trainShare = 0.7, cap = 0.6, rf = 0, muShrink = 0.5 } = {}) {
  const al = hrp.alignReturns(barsBySymbol)
  const { symbols, returns } = al
  if (symbols.length < 2) throw new Error('need at least 2 symbols with overlapping history')
  if (returns.length < 120) throw new Error(`only ${returns.length} overlapping daily returns; need at least 120`)
  const cut = Math.floor(returns.length * trainShare), train = returns.slice(0, cut), test = returns.slice(cut)
  const lw = ledoitWolf(train), S = lw.cov.map(r => r.map(v => v * ANN))
  const raw = L.columns(train).map(c => L.mean(c) * ANN), grand = L.mean(raw)
  const mu = raw.map(m => muShrink * grand + (1 - muShrink) * m)
  const capEff = Math.max(cap, 1 / symbols.length + 1e-6)
  const methods = {
    'Equal weight': equalWeight(symbols.length),
    'Inverse volatility': inverseVol(S),
    'Minimum variance': minVariance(S, { cap: capEff }),
    'Max Sharpe (mean–variance)': maxSharpe(mu, S, { cap: capEff, rf }),
    'Risk parity (ERC)': riskParity(S),
  }
  const h = hrp.hrpWeights({ symbols, returns: train })
  if (h) methods['Hierarchical risk parity'] = symbols.map(s => h.weights[s] ?? 0)
  const evalRet = (w, rows) => rows.map(r => L.dot(w, r))
  const perf = (w, rows) => { const x = evalRet(w, rows), m = L.mean(x) * ANN, v = L.stdev(x) * Math.sqrt(ANN); return { ret: m, vol: v, sharpe: v > 0 ? (m - rf) / v : 0, maxDrawdown: maxDD(x) } }
  const out = Object.entries(methods).map(([name, w]) => ({
    method: name,
    weights: Object.fromEntries(symbols.map((s, i) => [s, +w[i].toFixed(4)])),
    riskShare: Object.fromEntries(symbols.map((s, i) => [s, +riskContributions(w, S)[i].toFixed(4)])),
    inSample: perf(w, train), outOfSample: perf(w, test),
  }))
  return {
    symbols, trainObs: train.length, testObs: test.length, shrinkage: lw.shrinkage, muShrink, cap: capEff,
    methods: out,
    bestOutOfSample: out.reduce((a, b) => (b.outOfSample.sharpe > a.outOfSample.sharpe ? b : a)).method,
    note: 'In-sample Sharpe ranks the optimisers by how well they overfit. Judge them on the out-of-sample columns, and expect the order to change from period to period.',
  }
}
function maxDD(rets) { let eq = 1, peak = 1, dd = 0; for (const r of rets) { eq *= 1 + r; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1) } return dd }

module.exports = { ledoitWolf, projectCapped, meanVarianceUtility, minVariance, maxSharpe, efficientFrontier, riskParity, riskContributions, inverseVol, equalWeight, compareMethods }
