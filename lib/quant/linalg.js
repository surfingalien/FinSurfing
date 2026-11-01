'use strict'
/**
 * lib/quant/linalg.js — the small dense linear algebra and statistics every other
 * quant module shares. Pure, dependency-free; sized for ≤ ~100 assets / few thousand
 * observations, which is what a portfolio screen needs. Tests: tests/quant-linalg.test.js
 */

const sum = xs => { let s = 0; for (const x of xs) s += x; return s }
const mean = xs => (xs.length ? sum(xs) / xs.length : NaN)
function variance(xs, ddof = 1) {
  const n = xs.length; if (n - ddof <= 0) return NaN
  const m = mean(xs); let s = 0
  for (const x of xs) s += (x - m) ** 2
  return s / (n - ddof)
}
const stdev = (xs, ddof = 1) => Math.sqrt(variance(xs, ddof))
function covariance(a, b, ddof = 1) {
  const n = Math.min(a.length, b.length); if (n - ddof <= 0) return NaN
  const ma = mean(a.slice(0, n)), mb = mean(b.slice(0, n)); let s = 0
  for (let i = 0; i < n; i++) s += (a[i] - ma) * (b[i] - mb)
  return s / (n - ddof)
}
const correlation = (a, b) => { const c = covariance(a, b), d = stdev(a) * stdev(b); return d > 0 ? c / d : 0 }
const columns = rows => (rows[0] || []).map((_, j) => rows.map(r => r[j]))

/** Sample covariance of a T×N returns matrix → N×N. */
function covMatrix(rows) {
  const cols = columns(rows), N = cols.length
  const S = Array.from({ length: N }, () => new Array(N).fill(0))
  for (let i = 0; i < N; i++) for (let j = i; j < N; j++) { S[i][j] = S[j][i] = covariance(cols[i], cols[j]) }
  return S
}
function corrFromCov(S) {
  const N = S.length
  return S.map((r, i) => r.map((v, j) => { const d = Math.sqrt(S[i][i] * S[j][j]); return d > 0 ? v / d : (i === j ? 1 : 0) }))
}

const identity = n => Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)))
const transpose = A => (A[0] || []).map((_, j) => A.map(r => r[j]))
const matVec = (A, v) => A.map(r => { let s = 0; for (let j = 0; j < r.length; j++) s += r[j] * v[j]; return s })
function matMul(A, B) {
  const Bt = transpose(B)
  return A.map(r => Bt.map(c => { let s = 0; for (let k = 0; k < r.length; k++) s += r[k] * c[k]; return s }))
}
const dot = (a, b) => { let s = 0; for (let i = 0; i < a.length; i++) s += a[i] * b[i]; return s }
const quadForm = (w, S) => dot(w, matVec(S, w))

/** Solve A x = b by Gaussian elimination with partial pivoting. Throws if singular. */
function solve(A, b) {
  const n = A.length, M = A.map((r, i) => [...r, b[i]])
  for (let c = 0; c < n; c++) {
    let p = c
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r
    if (Math.abs(M[p][c]) < 1e-14) throw new Error('singular matrix')
    ;[M[c], M[p]] = [M[p], M[c]]
    for (let r = c + 1; r < n; r++) {
      const f = M[r][c] / M[c][c]
      for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]
    }
  }
  const x = new Array(n).fill(0)
  for (let i = n - 1; i >= 0; i--) {
    let s = M[i][n]
    for (let k = i + 1; k < n; k++) s -= M[i][k] * x[k]
    x[i] = s / M[i][i]
  }
  return x
}
function inverse(A) {
  const n = A.length, cols = identity(n).map(e => solve(A, e))
  return transpose(cols)
}

/** Lower-triangular L with L Lᵀ = A. Throws when A is not positive definite. */
function cholesky(A) {
  const n = A.length, L = Array.from({ length: n }, () => new Array(n).fill(0))
  for (let i = 0; i < n; i++) {
    for (let j = 0; j <= i; j++) {
      let s = A[i][j]
      for (let k = 0; k < j; k++) s -= L[i][k] * L[j][k]
      if (i === j) { if (s <= 1e-14) throw new Error('matrix is not positive definite'); L[i][j] = Math.sqrt(s) }
      else L[i][j] = s / L[j][j]
    }
  }
  return L
}

/** Symmetric eigen-decomposition by cyclic Jacobi. values desc; vectors[k] is the k-th eigenvector. */
function jacobiEigen(A0, maxSweeps = 60) {
  const n = A0.length, A = A0.map(r => [...r]), V = identity(n)
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) off += A[i][j] ** 2
    if (off < 1e-22) break
    for (let p = 0; p < n - 1; p++) for (let q = p + 1; q < n; q++) {
      if (Math.abs(A[p][q]) < 1e-18) continue
      const th = (A[q][q] - A[p][p]) / (2 * A[p][q])
      const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1))
      const c = 1 / Math.sqrt(t * t + 1), s = t * c
      for (let k = 0; k < n; k++) {
        const akp = A[k][p], akq = A[k][q]
        A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq
      }
      for (let k = 0; k < n; k++) {
        const apk = A[p][k], aqk = A[q][k]
        A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk
      }
      for (let k = 0; k < n; k++) {
        const vkp = V[k][p], vkq = V[k][q]
        V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq
      }
    }
  }
  const idx = A.map((_, i) => i).sort((a, b) => A[b][b] - A[a][a])
  return { values: idx.map(i => A[i][i]), vectors: idx.map(i => V.map(r => r[i])) }
}

/**
 * Ordinary least squares y = Xβ (+ intercept first when `intercept`). Normal equations
 * — fine for the few regressors used here. Returns beta, resid, r2, se, tstat, n.
 */
function ols(X, y, { intercept = true } = {}) {
  const n = y.length
  const Xd = X.map(r => (intercept ? [1, ...r] : r))
  const p = Xd[0].length
  if (n <= p) throw new Error('not enough observations')
  const Xt = transpose(Xd), XtX = matMul(Xt, Xd)
  const beta = solve(XtX, matVec(Xt, y))
  const fitted = matVec(Xd, beta), resid = y.map((v, i) => v - fitted[i])
  const sse = sum(resid.map(r => r * r)), my = mean(y), sst = sum(y.map(v => (v - my) ** 2))
  const s2 = sse / (n - p)
  let se = new Array(p).fill(NaN)
  try { const inv = inverse(XtX); se = inv.map((r, i) => Math.sqrt(Math.max(0, s2 * r[i]))) } catch { /* collinear */ }
  return { beta, resid, fitted, r2: sst > 0 ? 1 - sse / sst : 0, se, tstat: beta.map((b, i) => (se[i] > 0 ? b / se[i] : NaN)), n, sigma2: s2 }
}

/** Thomas algorithm for a tridiagonal system (a: sub, b: diag, c: super, d: rhs). */
function thomas(a, b, c, d) {
  const n = b.length, cp = new Array(n), dp = new Array(n), x = new Array(n)
  cp[0] = c[0] / b[0]; dp[0] = d[0] / b[0]
  for (let i = 1; i < n; i++) {
    const m = b[i] - a[i] * cp[i - 1]
    cp[i] = i < n - 1 ? c[i] / m : 0
    dp[i] = (d[i] - a[i] * dp[i - 1]) / m
  }
  x[n - 1] = dp[n - 1]
  for (let i = n - 2; i >= 0; i--) x[i] = dp[i] - cp[i] * x[i + 1]
  return x
}

/** Deterministic PRNG (mulberry32) + Gaussian draws (Box–Muller, both outputs used). */
function rng(seed = 1) {
  let a = seed >>> 0, spare = null
  const u = () => { a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296 }
  const normal = () => {
    if (spare != null) { const s = spare; spare = null; return s }
    let x, y; do { x = u() } while (x <= 1e-12); y = u()
    const r = Math.sqrt(-2 * Math.log(x)); spare = r * Math.sin(2 * Math.PI * y)
    return r * Math.cos(2 * Math.PI * y)
  }
  return { uniform: u, normal }
}

/** Standard normal pdf / cdf (Hart/West double-precision approximation, |err| < 1e-15). */
const normPdf = x => Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI)
function normCdf(x) {
  const z = Math.abs(x); let c
  if (z > 37) c = 0
  else {
    const e = Math.exp(-z * z / 2)
    if (z < 7.07106781186547) {
      let n = 0.0352624965998911 * z + 0.700383064443688
      n = n * z + 6.37396220353165; n = n * z + 33.912866078383; n = n * z + 112.079291497871
      n = n * z + 221.213596169931; n = n * z + 220.206867912376
      let d = 0.0883883476483184 * z + 1.75566716318264
      d = d * z + 16.064177579207; d = d * z + 86.7807322029461; d = d * z + 296.564248779674
      d = d * z + 637.333633378831; d = d * z + 793.826512519948; d = d * z + 440.413735824752
      c = e * n / d
    } else {
      let b = z + 0.65; b = z + 4 / b; b = z + 3 / b; b = z + 2 / b; b = z + 1 / b
      c = e / b / 2.506628274631
    }
  }
  return x > 0 ? 1 - c : c
}

/** Quantile of the standard normal (Acklam), |rel err| < 1.2e-9. */
function normInv(p) {
  if (p <= 0 || p >= 1) return p <= 0 ? -Infinity : Infinity
  const a = [-3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.383577518672690e2, -3.066479806614716e1, 2.506628277459239]
  const b = [-5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1, -1.328068155288572e1]
  const c = [-7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pl = 0.02425
  let q, r
  if (p < pl) { q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1) }
  if (p > 1 - pl) { q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1) }
  q = p - 0.5; r = q * q
  return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1)
}

/** Simple returns from a closes array. */
const returnsOf = closes => { const r = []; for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0) r.push(closes[i] / closes[i - 1] - 1); return r }
const logReturnsOf = closes => { const r = []; for (let i = 1; i < closes.length; i++) if (closes[i - 1] > 0 && closes[i] > 0) r.push(Math.log(closes[i] / closes[i - 1])); return r }


/**
 * Nelder–Mead simplex minimiser (unconstrained; callers map bounded parameters through transforms). Standard
 * reflection/expansion/contraction/shrink coefficients. Returns { x, f, iterations, converged }.
 */
function nelderMead(f, x0, { step = 0.1, maxIter = 2000, tol = 1e-10 } = {}) {
  const n = x0.length
  let simplex = [x0.slice()]
  for (let i = 0; i < n; i++) { const x = x0.slice(); x[i] = x[i] !== 0 ? x[i] * (1 + step) : step; simplex.push(x) }
  let vals = simplex.map(f), it = 0
  for (; it < maxIter; it++) {
    const order = vals.map((v, i) => i).sort((a, b) => vals[a] - vals[b]); simplex = order.map(i => simplex[i]); vals = order.map(i => vals[i])
    if (Math.abs(vals[n] - vals[0]) <= tol * (Math.abs(vals[0]) + tol)) break
    const c = new Array(n).fill(0); for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) c[j] += simplex[i][j] / n
    const pt = (a, t) => c.map((cj, j) => cj + t * (a[j] - cj))
    const xr = pt(simplex[n], -1), fr = f(xr)
    if (fr < vals[0]) { const xe = pt(simplex[n], -2), fe = f(xe); if (fe < fr) { simplex[n] = xe; vals[n] = fe } else { simplex[n] = xr; vals[n] = fr } continue }
    if (fr < vals[n - 1]) { simplex[n] = xr; vals[n] = fr; continue }
    const outside = fr < vals[n], xc = outside ? pt(simplex[n], -0.5) : pt(simplex[n], 0.5), fc = f(xc)
    if (fc < (outside ? fr : vals[n])) { simplex[n] = xc; vals[n] = fc; continue }
    for (let i = 1; i <= n; i++) { simplex[i] = simplex[i].map((v, j) => simplex[0][j] + 0.5 * (v - simplex[0][j])); vals[i] = f(simplex[i]) }
  }
  const best = vals.indexOf(Math.min(...vals))
  return { x: simplex[best], f: vals[best], iterations: it, converged: it < maxIter }
}

module.exports = {
  nelderMead, sum, mean, variance, stdev, covariance, correlation, columns, covMatrix, corrFromCov,
  identity, transpose, matVec, matMul, dot, quadForm, solve, inverse, cholesky, jacobiEigen, ols, thomas,
  rng, normPdf, normCdf, normInv, returnsOf, logReturnsOf,
}
