'use strict'
/**
 * lib/quant/dcc.js — DCC-GARCH (Engle 2002): correlations that move.
 *
 * Step 1: each asset gets its own GARCH(1,1) (lib/quant/vol-models.js); its
 *         returns divided by the fitted volatility are the standardised
 *         residuals z (unit variance by construction, correlated across assets).
 * Step 2: Q_t = (1 − a − b) Q̄ + a z_{t−1} z_{t−1}ᵀ + b Q_{t−1},
 *         R_t = diag(Q_t)^−½ Q_t diag(Q_t)^−½, Q̄ = the sample correlation of z.
 *         a and b are fitted by COMPOSITE likelihood over pairs of assets
 *         (Engle, Shephard & Sheppard 2008) — the full likelihood needs an
 *         N×N inverse per day and is biased toward b → 1 when N is large; each
 *         pair's correlation only needs three scalar recursions. All pairs up to
 *         MAX_PAIRS, a seeded sample of pairs beyond that.
 *
 * Forecasts: H_{T+k} = D_{T+k} R_{T+k} D_{T+k}, D from each asset's GARCH
 * variance path, and Q_{T+k} = Q̄ + (a+b)^{k−1}(Q_{T+1} − Q̄) (the standard
 * mean-reversion approximation). Portfolio VaR from H vs from the static
 * sample covariance shows what "correlations rise in a sell-off" does to risk.
 *
 * Pure; no I/O. Tests: tests/quant-dcc.test.js
 */
const L = require('./linalg')
const VM = require('./vol-models')

const MAX_PAIRS = 120
const Z95 = 1.6448536269514722

/** Pairs (i<j) to use in the composite likelihood. */
function pairsFor(N, { max = MAX_PAIRS, seed = 3 } = {}) {
  const all = []
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) all.push([i, j])
  if (all.length <= max) return all
  const g = L.rng(seed)
  for (let k = all.length - 1; k > 0; k--) { const m = Math.floor(g.uniform() * (k + 1)); [all[k], all[m]] = [all[m], all[k]] }
  return all.slice(0, max)
}

/** Sum over pairs of the bivariate Gaussian correlation log-likelihood (marginal terms dropped). */
function compositeLogLik(a, b, Z, Qbar, pairs) {
  const T = Z.length, c = 1 - a - b
  let ll = 0
  for (const [i, j] of pairs) {
    let qii = Qbar[i][i], qjj = Qbar[j][j], qij = Qbar[i][j]
    for (let t = 0; t < T; t++) {
      if (t > 0) {
        const zi = Z[t - 1][i], zj = Z[t - 1][j]
        qii = c * Qbar[i][i] + a * zi * zi + b * qii
        qjj = c * Qbar[j][j] + a * zj * zj + b * qjj
        qij = c * Qbar[i][j] + a * zi * zj + b * qij
      }
      let rho = qij / Math.sqrt(qii * qjj)
      if (rho > 0.9999) rho = 0.9999; else if (rho < -0.9999) rho = -0.9999
      const zi = Z[t][i], zj = Z[t][j], d = 1 - rho * rho
      ll += -0.5 * (Math.log(d) + (zi * zi + zj * zj - 2 * rho * zi * zj) / d - (zi * zi + zj * zj))
    }
  }
  return ll
}

/** The full Q/R path (R_0..R_T; R_T is the next-day correlation). */
function correlationPath(a, b, Z, Qbar) {
  const T = Z.length, N = Qbar.length, c = 1 - a - b
  let Q = Qbar.map(r => r.slice())
  const R = []
  for (let t = 0; t <= T; t++) {
    if (t > 0) {
      const z = Z[t - 1]
      const nq = Array.from({ length: N }, () => new Array(N))
      for (let i = 0; i < N; i++) for (let j = i; j < N; j++) nq[i][j] = nq[j][i] = c * Qbar[i][j] + a * z[i] * z[j] + b * Q[i][j]
      Q = nq
    }
    R.push(L.corrFromCov(Q))
  }
  return { R, Q }
}

/** Fit a, b to standardised residuals Z (T×N). */
function fitDcc(Z, { pairs = null } = {}) {
  const N = Z[0].length
  const Qbar = L.corrFromCov(L.covMatrix(Z))
  const P = pairs || pairsFor(N)
  const from = u => { const per = 0.999 * (1 / (1 + Math.exp(-u[0]))), sh = 1 / (1 + Math.exp(-u[1])); return { a: per * sh, b: per * (1 - sh) } }
  const obj = u => { const { a, b } = from(u); const ll = compositeLogLik(a, b, Z, Qbar, P); return Number.isFinite(ll) ? -ll : 1e300 }
  // start a = 0.03, b = 0.93 → per 0.96, share 0.03/0.96
  const u0 = [Math.log(0.96 / 0.999 / (1 - 0.96 / 0.999)), Math.log((0.03 / 0.96) / (1 - 0.03 / 0.96))]
  let res = L.nelderMead(obj, u0, { step: 0.3, maxIter: 400, tol: 1e-9 })
  res = L.nelderMead(obj, res.x, { step: 0.1, maxIter: 300, tol: 1e-10 })
  const { a, b } = from(res.x)
  // Constant-correlation benchmark (a = b = 0): does letting correlation move fit better?
  const llConst = compositeLogLik(0, 0, Z, Qbar, P)
  return { a, b, persistence: a + b, compositeLogLik: -res.f, constantLogLik: llConst, pairsUsed: P.length, Qbar }
}

const avgOffDiag = R => { const N = R.length; let s = 0, k = 0; for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { s += R[i][j]; k++ } return k ? s / k : null }

/**
 * DCC-GARCH on aligned returns. `rows` T×N (each row one day, all assets),
 * `symbols` names, optional `weights` (sum to 1) for portfolio risk.
 */
function dcc(rows, { symbols = null, weights = null, horizon = 21, historyDays = 252 } = {}) {
  const T = rows.length, N = rows[0]?.length || 0
  if (N < 2) throw new Error('DCC needs at least two assets')
  if (T < 250) throw new Error('DCC needs at least 250 aligned days')
  const names = symbols || Array.from({ length: N }, (_, i) => `A${i + 1}`)
  const cols = L.columns(rows)
  const fits = cols.map(c => VM.fit('garch', c))
  const Z = Array.from({ length: T }, (_, t) => fits.map(f => f.x[t] / Math.sqrt(f.h[t])))
  const d = fitDcc(Z)
  const { R } = correlationPath(d.a, d.b, Z, d.Qbar)
  const Rnext = R[T], Rbar = d.Qbar

  // Variance paths per asset, and the correlation path mean-reverting to Q̄.
  const vpaths = fits.map(f => VM.forecastPath(f, horizon))
  const per = d.a + d.b
  const corrAt = k => Rnext.map((r, i) => r.map((v, j) => (i === j ? 1 : Rbar[i][j] + per ** k * (v - Rbar[i][j]))))
  const cov = (k, Rk) => Rk.map((r, i) => r.map((v, j) => v * Math.sqrt(vpaths[i][k] * vpaths[j][k])))
  const Hnext = cov(0, Rnext)

  let portfolio = null
  if (weights && weights.length === N) {
    const S = L.covMatrix(rows)
    const sdDcc = Math.sqrt(L.quadForm(weights, Hnext)), sdStatic = Math.sqrt(L.quadForm(weights, S))
    let v21 = 0; for (let k = 0; k < horizon; k++) v21 += L.quadForm(weights, cov(k, corrAt(k)))
    portfolio = {
      var95_1d_dcc: Z95 * sdDcc, var95_1d_static: Z95 * sdStatic,
      vol_annual_dcc: sdDcc * Math.sqrt(252), vol_annual_static: sdStatic * Math.sqrt(252),
      var95_21d_dcc: Z95 * Math.sqrt(v21), var95_21d_static: Z95 * sdStatic * Math.sqrt(horizon),
      ratio: sdStatic > 0 ? sdDcc / sdStatic : null,
    }
  }

  const pairs = []
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) pairs.push({ a: names[i], b: names[j], now: Rnext[i][j], longRun: Rbar[i][j], change: Rnext[i][j] - Rbar[i][j] })
  pairs.sort((x, y) => y.change - x.change)
  const hist = R.slice(Math.max(1, R.length - historyDays))
  return {
    method: 'DCC(1,1)-GARCH(1,1), composite likelihood',
    symbols: names, days: T,
    a: d.a, b: d.b, persistence: per, halfLifeDays: per > 0 && per < 1 ? Math.log(0.5) / Math.log(per) : null,
    pairsUsed: d.pairsUsed, likelihoodGain: d.compositeLogLik - d.constantLogLik,
    avgCorrNow: avgOffDiag(Rnext), avgCorrLongRun: avgOffDiag(Rbar),
    avgCorrRange: (() => { const v = hist.map(avgOffDiag); return { min: Math.min(...v), max: Math.max(...v) } })(),
    avgCorrHistory: hist.map(avgOffDiag),
    corrNow: Rnext, corrLongRun: Rbar,
    rising: pairs.slice(0, 5), falling: pairs.slice(-5).reverse(),
    nextDayVol: fits.map((f, i) => ({ symbol: names[i], vol: Math.sqrt(f.h[T] * 252) })),
    portfolio,
  }
}

module.exports = { MAX_PAIRS, pairsFor, compositeLogLik, correlationPath, fitDcc, dcc, avgOffDiag }
