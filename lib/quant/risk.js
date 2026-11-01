'use strict'
/**
 * lib/quant/risk.js — risk and performance statistics beyond what analytics already reports.
 *
 *   capm                beta, Jensen's alpha, Treynor ratio, information ratio, tracking error, capture ratios
 *   stressTest          scenario shocks through each position's beta, plus the worst k-day windows actually seen
 *   bootstrap           stationary block bootstrap confidence intervals for any statistic (Sharpe, mean, …)
 *   bayesBinomial       Beta–Binomial posterior for a win rate (credible interval, P(p > threshold))
 *   monteCarloVaR       multivariate-normal Monte Carlo VaR/ES via Cholesky correlated draws
 *   gaussianCopula      rank-correlation fit, dependent simulation, and an empirical tail-dependence check
 *   pca                 principal components of a returns matrix
 *   marketImpact        square-root-law impact + half-spread cost of trading a size
 * Tests: tests/quant-risk.test.js
 */
const L = require('./linalg')

const ANN = 252

function maxDrawdown(r) { let eq = 1, peak = 1, dd = 0; for (const x of r) { eq *= 1 + x; peak = Math.max(peak, eq); dd = Math.min(dd, eq / peak - 1) } return dd }

/** CAPM-style statistics of a return series against a benchmark (aligned, daily simple returns, annual rf). */
function capm(port, bench, { rf = 0 } = {}) {
  const n = Math.min(port.length, bench.length)
  if (n < 30) throw new Error('need at least 30 aligned returns')
  const p = port.slice(-n), b = bench.slice(-n), rfd = rf / ANN
  const ex = p.map(x => x - rfd), bx = b.map(x => x - rfd)
  const f = L.ols(bx.map(x => [x]), ex)
  const beta = f.beta[1], alphaDaily = f.beta[0], mp = L.mean(ex) * ANN
  const active = p.map((x, i) => x - b[i]), te = L.stdev(active) * Math.sqrt(ANN)
  const up = [], dn = []; b.forEach((x, i) => (x > 0 ? up : dn).push(i))
  const capture = idx => (idx.length ? L.mean(idx.map(i => p[i])) / L.mean(idx.map(i => b[i])) : null)
  return {
    beta, jensenAlpha: alphaDaily * ANN, alphaTStat: f.tstat[0], r2: f.r2,
    treynor: Math.abs(beta) > 1e-9 ? mp / beta : null,
    trackingError: te, informationRatio: te > 0 ? L.mean(active) * ANN / te : null,
    upCapture: capture(up), downCapture: capture(dn),
    sharpe: L.stdev(ex) > 0 ? mp / (L.stdev(ex) * Math.sqrt(ANN)) : null, observations: n,
  }
}

const SCENARIOS = [
  { id: 'mkt-10', name: 'Market −10% (correction)', market: -0.10 },
  { id: 'mkt-20', name: 'Market −20% (bear market)', market: -0.20 },
  { id: 'gfc-2008', name: '2008-style crash (market −37%)', market: -0.37 },
  { id: 'covid-2020', name: 'March-2020 crash (market −34%)', market: -0.34 },
  { id: 'black-monday', name: 'Black Monday (market −20% in a day)', market: -0.20 },
  { id: 'rally-10', name: 'Market +10% (relief rally)', market: 0.10 },
]
/**
 * positions: [{ symbol, value, beta? , shock? }] — `shock` overrides the market scenario for that name
 * (e.g. -0.6 for a stock you expect to fall on its own). Unknown beta defaults to 1 and is listed in `assumed`.
 */
function stressTest(positions, { scenarios = SCENARIOS, history = null } = {}) {
  const total = L.sum(positions.map(p => p.value))
  if (!(total > 0)) throw new Error('portfolio value must be positive')
  const assumed = positions.filter(p => p.beta == null).map(p => p.symbol)
  const rows = scenarios.map(s => {
    const per = positions.map(p => { const shock = p.shock != null ? p.shock : (p.beta ?? 1) * s.market; return { symbol: p.symbol, shock, pnl: p.value * shock } })
    const pnl = L.sum(per.map(x => x.pnl))
    return { id: s.id, name: s.name, marketShock: s.market, pnl, pnlPct: pnl / total, worstPosition: per.reduce((a, b) => (b.pnl < a.pnl ? b : a)) }
  })
  const out = { portfolioValue: total, scenarios: rows, assumedBeta1: assumed }
  if (history && history.length >= 60) {
    out.worstWindows = [1, 5, 21].map(k => {
      let worst = Infinity, at = -1
      for (let i = k; i <= history.length; i++) { let g = 1; for (let j = i - k; j < i; j++) g *= 1 + history[j]; if (g - 1 < worst) { worst = g - 1; at = i - 1 } }
      return { days: k, worstReturn: worst, endIndex: at, dollarLoss: worst * total }
    })
    out.maxDrawdown = maxDrawdown(history)
  }
  return out
}

/** Stationary block bootstrap (Politis–Romano), mean block length `block`. Returns the point estimate and a (1−α) percentile interval. */
function bootstrap(x, stat, { B = 1000, block = 10, alpha = 0.05, seed = 1 } = {}) {
  const n = x.length; if (n < 20) throw new Error('need at least 20 observations')
  const g = L.rng(seed), draws = [], pNew = 1 / Math.max(1, block)
  for (let b = 0; b < B; b++) {
    const s = new Array(n); let i = Math.floor(g.uniform() * n)
    for (let t = 0; t < n; t++) { s[t] = x[i]; i = g.uniform() < pNew ? Math.floor(g.uniform() * n) : (i + 1) % n }
    const v = stat(s); if (Number.isFinite(v)) draws.push(v)
  }
  draws.sort((a, c) => a - c)
  const q = p => draws[Math.min(draws.length - 1, Math.max(0, Math.floor(p * draws.length)))]
  return { estimate: stat(x), lo: q(alpha / 2), hi: q(1 - alpha / 2), draws: draws.length, block }
}
const sharpeOf = r => { const s = L.stdev(r); return s > 0 ? L.mean(r) / s * Math.sqrt(ANN) : 0 }
const bootstrapSharpe = (r, o) => bootstrap(r, sharpeOf, { block: 10, ...o })

/* regularised incomplete beta I_x(a,b) (continued fraction) for the Beta posterior */
function lnGamma(z) { const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]; let y = z, x = z, t = x + 5.5; t -= (x + 0.5) * Math.log(t); let s = 1.000000000190015; for (const cj of c) s += cj / ++y; return -t + Math.log(2.5066282746310005 * s / x) }
function betacf(a, b, x) {
  let qab = a + b, qap = a + 1, qam = a - 1, c = 1, d = 1 - qab * x / qap; if (Math.abs(d) < 1e-300) d = 1e-300; d = 1 / d; let h = d
  for (let m = 1; m <= 300; m++) {
    const m2 = 2 * m; let aa = m * (b - m) * x / ((qam + m2) * (a + m2)); d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300; c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; h *= d * c
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2)); d = 1 + aa * d; if (Math.abs(d) < 1e-300) d = 1e-300; c = 1 + aa / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del
    if (Math.abs(del - 1) < 1e-14) break
  }
  return h
}
function betaCdf(x, a, b) {
  if (x <= 0) return 0; if (x >= 1) return 1
  const bt = Math.exp(lnGamma(a + b) - lnGamma(a) - lnGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? bt * betacf(a, b, x) / a : 1 - bt * betacf(b, a, 1 - x) / b
}
const betaInv = (p, a, b) => { let lo = 0, hi = 1; for (let i = 0; i < 80; i++) { const m = (lo + hi) / 2; if (betaCdf(m, a, b) < p) lo = m; else hi = m } return (lo + hi) / 2 }

/** Update a Beta(a0,b0) prior on a hit rate with `wins` of `n`. Default prior is flat. */
function bayesBinomial(wins, n, { a0 = 1, b0 = 1, threshold = 0.5, level = 0.95 } = {}) {
  if (wins < 0 || wins > n) throw new Error('wins must be between 0 and n')
  const a = a0 + wins, b = b0 + n - wins, tail = (1 - level) / 2
  return { posteriorMean: a / (a + b), lo: betaInv(tail, a, b), hi: betaInv(1 - tail, a, b), probAbove: 1 - betaCdf(threshold, a, b), threshold, a, b, n }
}

/** Correlated normal draws: rows of z·Lᵀ. `corr` is N×N; returns paths×N matrix of standard normals with that correlation. */
function correlatedNormals(corr, paths, seed = 1) {
  const Lc = L.cholesky(corr), g = L.rng(seed), N = corr.length, out = []
  for (let p = 0; p < paths; p++) { const z = Array.from({ length: N }, () => g.normal()); out.push(Lc.map(row => { let s = 0; for (let k = 0; k < N; k++) s += row[k] * z[k]; return s })) }
  return out
}
/** Monte Carlo VaR/ES of a weighted portfolio over `horizon` days from per-asset daily mean and covariance. */
function monteCarloVaR({ weights, mu, cov, horizon = 1, paths = 20000, level = 0.95, seed = 1, value = 1 }) {
  const N = weights.length, sd = cov.map((r, i) => Math.sqrt(r[i])), corr = cov.map((r, i) => r.map((v, j) => v / (sd[i] * sd[j])))
  const z = correlatedNormals(corr, paths, seed), h = Math.sqrt(horizon), pnl = []
  for (const row of z) { let r = 0; for (let i = 0; i < N; i++) r += weights[i] * (mu[i] * horizon + sd[i] * h * row[i]); pnl.push(r) }
  pnl.sort((a, b) => a - b)
  const k = Math.max(1, Math.floor((1 - level) * paths)), var_ = -pnl[k - 1], es = -L.mean(pnl.slice(0, k))
  return { var: var_, expectedShortfall: es, varValue: var_ * value, esValue: es * value, level, horizon, paths }
}

const ranks = x => { const idx = x.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]), r = new Array(x.length); idx.forEach(([, i], k) => { r[i] = (k + 1) / (x.length + 1) }); return r }
/**
 * Gaussian copula between two return series: rank correlation → Gaussian parameter ρ = 2 sin(π·ρ_s/6), then
 * compare the observed joint lower-tail frequency (both below their q-quantile) with what the Gaussian copula
 * implies. A Gaussian copula has no tail dependence, so observed ≫ implied means crashes cluster more than it assumes.
 */
function gaussianCopula(a, b, { q = 0.05, sims = 40000, seed = 1 } = {}) {
  const n = Math.min(a.length, b.length); if (n < 100) throw new Error('need at least 100 paired observations')
  const ua = ranks(a.slice(-n)), ub = ranks(b.slice(-n))
  const rhoS = L.correlation(ua, ub), rho = 2 * Math.sin(Math.PI * rhoS / 6)
  const obs = ua.filter((u, i) => u <= q && ub[i] <= q).length / n
  const z = correlatedNormals([[1, rho], [rho, 1]], sims, seed), thr = L.normInv(q)
  const implied = z.filter(r => r[0] <= thr && r[1] <= thr).length / sims
  return { rankCorrelation: rhoS, gaussianRho: rho, jointTailObserved: obs, jointTailGaussian: implied, tailRatio: implied > 0 ? obs / implied : null, independentTail: q * q, verdict: implied > 0 && obs > 1.5 * implied ? 'crashes cluster more than a Gaussian copula implies' : 'tail co-movement is in line with the Gaussian assumption' }
}

/** PCA of a T×N returns matrix on the correlation matrix (assets on different vol scales stay comparable). */
function pca(returns, { components = 3 } = {}) {
  const C = L.corrFromCov(L.covMatrix(returns)), { values, vectors } = L.jacobiEigen(C), total = L.sum(values)
  const k = Math.min(components, values.length), cols = L.columns(returns), mu = cols.map(L.mean), sd = cols.map(c => L.stdev(c))
  return {
    explained: values.slice(0, k).map(v => v / total), cumulative: values.slice(0, k).reduce((a, v, i) => (a.push((a[i - 1] || 0) + v / total), a), []),
    loadings: vectors.slice(0, k), eigenvalues: values,
    scores: returns.map(r => vectors.slice(0, k).map(v => L.dot(v, r.map((x, i) => (x - mu[i]) / sd[i])))),
  }
}

/**
 * Cost of trading `shares`: half-spread plus square-root impact  I = Y·σ_daily·√(Q/ADV)  (Y≈1 for liquid US
 * stocks). Returns cost in bps and dollars, participation, and a warning when the order is large vs volume.
 */
function marketImpact({ shares, price, adv, dailyVol, spreadBps = 5, y = 1 }) {
  if (!(shares > 0 && price > 0 && adv > 0 && dailyVol > 0)) throw new Error('shares, price, adv and dailyVol must be positive')
  const participation = shares / adv, impactBps = y * dailyVol * Math.sqrt(participation) * 1e4, totalBps = spreadBps / 2 + impactBps
  return { participation, halfSpreadBps: spreadBps / 2, impactBps, totalBps, dollarCost: shares * price * totalBps / 1e4, notional: shares * price, warning: participation > 0.1 ? 'order above 10% of daily volume: expect the square-root law to understate cost; slice it over several days' : null }
}

module.exports = { capm, stressTest, SCENARIOS, bootstrap, bootstrapSharpe, bayesBinomial, betaCdf, correlatedNormals, monteCarloVaR, gaussianCopula, pca, marketImpact, maxDrawdown }
