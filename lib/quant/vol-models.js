'use strict'
/**
 * lib/quant/vol-models.js — the GARCH family, fitted by Gaussian maximum
 * likelihood, plus an out-of-sample contest between them.
 *
 *   arch     h_t = ω + α x²_{t−1}                                   (Engle 1982)
 *   garch    h_t = ω + α x²_{t−1} + β h_{t−1}                        (Bollerslev 1986)
 *   gjr      h_t = ω + (α + γ·1[x_{t−1}<0]) x²_{t−1} + β h_{t−1}     (Glosten–Jagannathan–Runkle 1993)
 *   egarch   ln h_t = ω + α(|z_{t−1}| − √(2/π)) + γ z_{t−1} + β ln h_{t−1}   (Nelson 1991)
 *   aparch   σ_t^δ = ω + α(|x_{t−1}| − γ x_{t−1})^δ + β σ_{t−1}^δ     (Ding–Granger–Engle 1993)
 *   ewma     h_t = λ h_{t−1} + (1−λ) x²_{t−1}, λ = 0.94             (RiskMetrics; nothing fitted)
 *
 * x = returns minus their mean. The recursion starts from the same backcast
 * the Python `arch` package uses (exponentially weighted first 75 squares,
 * weights 0.94^i), so the fits agree with it — tools/quant-validation checks
 * each model against `arch`. Parameters are searched by Nelder–Mead in a
 * transformed space that keeps every model positive and stationary.
 *
 * Multi-step forecasts: closed form for ARCH/GARCH/GJR (E[x²] = h, P(z<0) = ½),
 * seeded Monte Carlo for EGARCH and APARCH (no closed form), flat for EWMA.
 *
 * compareModels: a walk-forward contest — refit every `refitEvery` days on
 * data before the test day only, forecast the next day's variance, score by
 * QLIKE (ln h + x²/h, the loss that ranks variance forecasts consistently with
 * a noisy proxy — Patton 2011), and test each model against GARCH(1,1) with a
 * Diebold–Mariano t (Newey–West, 5 lags).
 *
 * Tests: tests/quant-vol-models.test.js
 */
const L = require('./linalg')

const ANN = 252
const MODELS = ['arch', 'garch', 'gjr', 'egarch', 'aparch', 'ewma']
const LABELS = { arch: 'ARCH(1)', garch: 'GARCH(1,1)', gjr: 'GJR-GARCH(1,1)', egarch: 'EGARCH(1,1)', aparch: 'APARCH(1,1)', ewma: 'EWMA (λ 0.94)' }
const SQRT2PI = Math.sqrt(2 / Math.PI)
const sig = u => 1 / (1 + Math.exp(-u))
const logit = p => Math.log(p / (1 - p))
const MAXP = 0.9999

/** `arch`'s backcast: Σ w_i x_i² over the first 75 returns, w_i ∝ 0.94^i. */
function backcast(x, power = 2) {
  const n = Math.min(75, x.length); let s = 0, w = 0
  for (let i = 0; i < n; i++) { const wi = 0.94 ** i; s += wi * Math.abs(x[i]) ** power; w += wi }
  return s / w
}

function lnGamma(z) {
  const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5]
  let y = z, t = z + 5.5; t -= (z + 0.5) * Math.log(t); let s = 1.000000000190015
  for (const cj of c) s += cj / ++y
  return -t + Math.log(2.5066282746310005 * s / z)
}
/** E[(|z| − γz)^δ] for z ~ N(0,1): APARCH's persistence term. */
function aparchKappa(gamma, delta) {
  const m = Math.exp((delta / 2) * Math.log(2) + lnGamma((delta + 1) / 2)) / Math.sqrt(Math.PI)
  return 0.5 * m * ((1 + gamma) ** delta + (1 - gamma) ** delta)
}

// ── Parameter maps: unconstrained vector u → model parameters ────────────────

const SPECS = {
  arch: {
    n: 2,
    from: (u, s2) => ({ omega: s2 * Math.exp(u[0]), alpha: MAXP * sig(u[1]) }),
    to: (p, s2) => [Math.log(p.omega / s2), logit(p.alpha / MAXP)],
    start: s2 => ({ omega: 0.5 * s2, alpha: 0.4 }),
    persistence: p => p.alpha,
  },
  garch: {
    n: 3,
    from: (u, s2) => { const per = MAXP * sig(u[1]), sh = sig(u[2]); return { omega: s2 * Math.exp(u[0]), alpha: per * sh, beta: per * (1 - sh) } },
    to: (p, s2) => [Math.log(p.omega / s2), logit((p.alpha + p.beta) / MAXP), logit(p.alpha / (p.alpha + p.beta))],
    start: s2 => ({ omega: 0.05 * s2, alpha: 0.08, beta: 0.88 }),
    persistence: p => p.alpha + p.beta,
  },
  gjr: {
    n: 4,
    from: (u, s2) => {
      const per = MAXP * sig(u[1]), e = [Math.exp(u[2]), Math.exp(u[3]), 1], s = e[0] + e[1] + e[2]
      return { omega: s2 * Math.exp(u[0]), alpha: per * e[0] / s, gamma: 2 * per * e[1] / s, beta: per * e[2] / s }
    },
    to: (p, s2) => { const per = p.alpha + p.gamma / 2 + p.beta; return [Math.log(p.omega / s2), logit(per / MAXP), Math.log(Math.max(p.alpha, 1e-6) / p.beta), Math.log(Math.max(p.gamma / 2, 1e-6) / p.beta)] },
    start: s2 => ({ omega: 0.05 * s2, alpha: 0.03, gamma: 0.1, beta: 0.88 }),
    persistence: p => p.alpha + p.gamma / 2 + p.beta,
  },
  egarch: {
    n: 4,
    from: u => ({ omega: u[0], alpha: u[1], gamma: u[2], beta: MAXP * Math.tanh(u[3]) }),
    to: p => [p.omega, p.alpha, p.gamma, Math.atanh(p.beta / MAXP)],
    start: s2 => ({ omega: Math.log(s2) * (1 - 0.97), alpha: 0.12, gamma: -0.08, beta: 0.97 }),
    persistence: p => p.beta,
  },
  aparch: {
    n: 5,
    from: (u, s2) => {
      const delta = 0.3 + 3.7 * sig(u[4]), gamma = 0.99 * Math.tanh(u[2]), k = aparchKappa(gamma, delta)
      const per = MAXP * sig(u[1]), sh = sig(u[3])     // persistence = α·κ + β
      return { omega: Math.pow(s2, delta / 2) * Math.exp(u[0]), alpha: per * sh / k, gamma, beta: per * (1 - sh), delta }
    },
    to: (p, s2) => {
      const k = aparchKappa(p.gamma, p.delta), per = p.alpha * k + p.beta
      return [Math.log(p.omega / Math.pow(s2, p.delta / 2)), logit(per / MAXP), Math.atanh(p.gamma / 0.99), logit(p.alpha * k / per), logit((p.delta - 0.3) / 3.7)]
    },
    start: s2 => ({ omega: 0.05 * Math.sqrt(s2), alpha: 0.06, gamma: 0.4, beta: 0.9, delta: 1.2 }),
    persistence: p => p.alpha * aparchKappa(p.gamma, p.delta) + p.beta,
  },
}

/**
 * Conditional variances h_0..h_n for model `m` with params `p` over x (h_n is
 * the one-step forecast after the last observation). Pure.
 */
function filter(m, p, x) {
  const n = x.length, h = new Array(n + 1)
  if (m === 'ewma') {
    let v = backcast(x)
    for (let t = 0; t <= n; t++) { if (t > 0) v = 0.94 * v + 0.06 * x[t - 1] ** 2; h[t] = v }
    return h
  }
  if (m === 'egarch') {
    let lh = Math.log(backcast(x))
    for (let t = 0; t <= n; t++) {
      if (t > 0) { const z = x[t - 1] / Math.sqrt(Math.exp(lh)); lh = p.omega + p.alpha * (Math.abs(z) - SQRT2PI) + p.gamma * z + p.beta * lh; if (lh > 50) lh = 50; if (lh < -50) lh = -50 }
      h[t] = Math.exp(lh)
    }
    return h
  }
  if (m === 'aparch') {
    const d = p.delta
    let s = backcast(x, d)                       // σ^δ
    for (let t = 0; t <= n; t++) {
      if (t > 0) { const e = x[t - 1]; s = p.omega + p.alpha * Math.pow(Math.abs(e) - p.gamma * e, d) + p.beta * s }
      h[t] = Math.pow(s, 2 / d)
    }
    return h
  }
  let v = backcast(x)
  for (let t = 0; t <= n; t++) {
    if (t > 0) {
      const e2 = x[t - 1] ** 2
      v = m === 'arch' ? p.omega + p.alpha * e2
        : m === 'garch' ? p.omega + p.alpha * e2 + p.beta * v
        : p.omega + (p.alpha + (x[t - 1] < 0 ? p.gamma : 0)) * e2 + p.beta * v   // gjr
    }
    h[t] = v
  }
  return h
}

function logLik(h, x) {
  let ll = 0
  for (let t = 0; t < x.length; t++) {
    const v = h[t]
    if (!(v > 1e-16) || !Number.isFinite(v)) return -Infinity
    ll += -0.5 * (Math.log(2 * Math.PI) + Math.log(v) + x[t] * x[t] / v)
  }
  return ll
}

/**
 * Fit one model to returns `r` (demeaned inside). `warm` = params to start
 * from (a refit in the walk-forward contest). Returns params, log-likelihood,
 * AIC/BIC, persistence, and the conditional variance path.
 */
function fit(m, r, { warm = null, maxIter = 2000 } = {}) {
  if (!MODELS.includes(m)) throw new Error(`unknown model ${m}`)
  if (r.length < 100) throw new Error(`${LABELS[m]} needs at least 100 returns`)
  const mu = L.mean(r), x = r.map(v => v - mu), s2 = L.variance(x, 0)
  if (m === 'ewma') {
    const h = filter('ewma', null, x)
    return { model: m, label: LABELS[m], params: { lambda: 0.94 }, nParams: 0, logLik: logLik(h, x), persistence: 0.94, mean: mu, h, x }
  }
  const S = SPECS[m]
  const obj = u => { const p = S.from(u, s2); const ll = logLik(filter(m, p, x), x); return Number.isFinite(ll) ? -ll : 1e300 }
  // A refit (warm start from the previous fit) needs only that start; a cold fit also tries the default.
  const warmU = warm ? S.to(warm, s2) : null
  const starts = (warmU && warmU.every(Number.isFinite) ? [warmU] : [S.to(S.start(s2), s2)]).filter(u => u.every(Number.isFinite))
  let best = null
  // Tolerances are relative to |log-likelihood| (thousands), so 1e-9 is ~1e-5 log-lik units — far below what moves a parameter.
  for (const u0 of starts) {
    const res = L.nelderMead(obj, u0, { step: 0.5, maxIter, tol: 1e-8 })
    const again = L.nelderMead(obj, res.x, { step: 0.1, maxIter: Math.min(maxIter, 600), tol: 1e-9 })   // restart: Nelder–Mead stalls on ridges; capped, since a flat ridge (no volatility clustering) never converges
    if (!best || again.f < best.f) best = again
  }
  const params = S.from(best.x, s2), h = filter(m, params, x), ll = -best.f, k = S.n
  return { model: m, label: LABELS[m], params, nParams: k, logLik: ll, aic: -2 * ll + 2 * k, bic: -2 * ll + k * Math.log(x.length), persistence: S.persistence(params), mean: mu, h, x }
}

/**
 * Daily variance forecasts h_{T+1..T+H} from a fitted model. Closed form where
 * one exists; seeded Monte Carlo (Gaussian shocks) for EGARCH and APARCH.
 */
function forecastPath(f, H = 21, { paths = 2000, seed = 7 } = {}) {
  const p = f.params, hNext = f.h[f.h.length - 1], out = [hNext]
  if (f.model === 'ewma') return new Array(H).fill(hNext)
  if (f.model === 'arch' || f.model === 'garch' || f.model === 'gjr') {
    const per = f.model === 'arch' ? p.alpha : f.model === 'garch' ? p.alpha + p.beta : p.alpha + p.gamma / 2 + p.beta
    for (let k = 1; k < H; k++) out.push(p.omega + per * out[k - 1])
    return out
  }
  const g = L.rng(seed), acc = new Array(H).fill(0)
  for (let s = 0; s < paths; s++) {
    let hv = hNext
    for (let k = 0; k < H; k++) {
      acc[k] += hv
      const z = g.normal(), e = Math.sqrt(hv) * z
      if (f.model === 'egarch') hv = Math.exp(p.omega + p.alpha * (Math.abs(z) - SQRT2PI) + p.gamma * z + p.beta * Math.log(hv))
      else { const sd = p.omega + p.alpha * Math.pow(Math.abs(e) - p.gamma * e, p.delta) + p.beta * Math.pow(hv, p.delta / 2); hv = Math.pow(sd, 2 / p.delta) }
    }
  }
  return acc.map(v => v / paths)
}

const annual = v => Math.sqrt(v * ANN)

/** The long-run (unconditional) variance where the model has one. */
function longRunVar(f) {
  const p = f.params
  if (f.persistence >= 1) return null
  if (f.model === 'arch' || f.model === 'garch' || f.model === 'gjr') return p.omega / (1 - f.persistence)
  if (f.model === 'egarch') return Math.exp(p.omega / (1 - p.beta))          // approximate (ignores Jensen)
  if (f.model === 'aparch') return Math.pow(p.omega / (1 - f.persistence), 2 / p.delta)
  return null
}

/** A readable summary of one fitted model (no series), with the 21-day forecast. */
function summarize(f, { horizon = 21, paths = 2000 } = {}) {
  const path = forecastPath(f, horizon, { paths }), lr = longRunVar(f)
  const half = f.persistence > 0 && f.persistence < 1 ? Math.log(0.5) / Math.log(f.persistence) : null
  return {
    model: f.model, label: f.label, params: f.params, nParams: f.nParams,
    logLik: f.logLik, aic: f.aic ?? null, bic: f.bic ?? null, persistence: f.persistence,
    halfLifeDays: half, longRunVol: lr != null ? annual(lr) : null,
    currentVol: annual(f.h[f.h.length - 2]), nextDayVol: annual(f.h[f.h.length - 1]),
    forecastVol21: annual(L.mean(path)), forecastPath: path.map(annual),
    leverage: f.params.gamma != null ? (f.model === 'egarch' ? f.params.gamma < 0 : f.params.gamma > 0) : null,
  }
}

/** Fit every model and summarise them; one failing never stops the rest. */
function fitAll(r, { models = MODELS, paths = 2000 } = {}) {
  const out = {}, errors = {}
  for (const m of models) { try { out[m] = summarize(fit(m, r), { paths }) } catch (e) { errors[m] = e.message } }
  return { models: out, errors }
}

/** Diebold–Mariano t on a loss-difference series with a Newey–West variance (Bartlett, `lags`). */
function dmTest(d, lags = 5) {
  const n = d.length, m = L.mean(d)
  let v = d.reduce((a, x) => a + (x - m) ** 2, 0) / n
  for (let k = 1; k <= lags; k++) {
    let c = 0; for (let t = k; t < n; t++) c += (d[t] - m) * (d[t - k] - m)
    v += 2 * (1 - k / (lags + 1)) * c / n
  }
  return { mean: m, t: v > 0 ? m / Math.sqrt(v / n) : 0, n }
}

/**
 * Walk-forward contest. Each model is refitted every `refitEvery` days on the
 * returns BEFORE the test day (expanding window), forecasts the next day's
 * variance, and is scored by QLIKE = ln h + x²/h. CPU-heavy (seconds), so it is async and
 * yields to the event loop after every refit.
 */
async function compareModels(r, { testShare = 0.3, refitEvery = 21, models = MODELS, yieldFn = () => new Promise(res => setImmediate(res)) } = {}) {
  const n = r.length, start = Math.floor(n * (1 - testShare))
  if (start < 250) throw new Error('need at least ~360 returns for an out-of-sample comparison')
  const losses = Object.fromEntries(models.map(m => [m, []]))
  const fails = {}
  for (const m of models) {
    let params = null
    for (let t0 = start; t0 < n; t0 += refitEvery) {
      const t1 = Math.min(n, t0 + refitEvery)
      try {
        const f = fit(m, r.slice(0, t0), { warm: params, maxIter: params ? 400 : 2000 })
        params = m === 'ewma' ? null : f.params
        // Filter through the test block with the fitted params: each h uses returns before its day only.
        const xs = r.slice(0, t1).map(v => v - f.mean), h = filter(m, f.params, xs)
        for (let t = t0; t < t1; t++) losses[m].push(Math.log(h[t]) + xs[t] * xs[t] / h[t])
      } catch (e) { fails[m] = e.message; break }
      await yieldFn()
    }
  }
  const ok = models.filter(m => losses[m].length === n - start)
  const ref = losses.garch?.length === n - start ? 'garch' : ok[0]
  const nTests = Math.max(1, ok.length - 1)
  const tBar = L.normInv(1 - 0.05 / nTests)        // one-sided, Bonferroni over the models compared with the reference
  const ranking = ok.map(m => {
    const qlike = L.mean(losses[m])
    const dm = m === ref ? null : dmTest(losses[m].map((v, i) => v - losses[ref][i]))
    return { model: m, label: LABELS[m], qlike, vsGarch: dm && { meanDiff: dm.mean, t: dm.t, better: dm.t < -tBar, worse: dm.t > tBar } }
  }).sort((a, b) => a.qlike - b.qlike)
  const best = ranking[0]
  return {
    testDays: n - start, refitEvery, reference: ref, tBar,
    ranking, best: best?.model ?? null, errors: fails,
    verdict: !best ? 'no model could be fitted'
      : best.model === ref ? `${LABELS[ref]} forecast best out of sample.`
      : best.vsGarch?.better ? `${best.label} beat ${LABELS[ref]} out of sample by more than chance (DM t ${best.vsGarch.t.toFixed(2)}, needs ≤ −${tBar.toFixed(2)}).`
      : `${best.label} had the lowest loss, but not by more than chance against ${LABELS[ref]} (DM t ${best.vsGarch?.t.toFixed(2)}).`,
  }
}

module.exports = { MODELS, LABELS, backcast, aparchKappa, filter, logLik, fit, forecastPath, longRunVar, summarize, fitAll, dmTest, compareModels }
