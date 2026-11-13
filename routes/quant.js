'use strict'
/**
 * routes/quant.js — Quant Lab API. Thin HTTP wrappers over lib/quant/* (all the maths lives there, tested
 * without a server). Two groups:
 *
 *   pure maths, public   POST /options/*, /calc/:name, /risk/stress|impact|montecarlo|bayes
 *                        — no market data, no AI, no cost: inputs in, numbers out (size-capped)
 *   market-data, sign-in POST /optimize, /volatility, /timeseries, /pairs, /pairs/screen, /statarb, /reversal,
 *                        /risk/capm, /risk/factors, /risk/copula, /risk/pca, /risk/dcc, /ml/compare, /ml/cluster, /ml/rl,
 *                        /holdings-scan (every tool above across the user's holdings at once), /event-study
 *                        — fetch daily bars over loopback, so they need a user and a tighter rate limit;
 *                        the slow ones are heartbeated (clients must check `data.error` as well as `res.ok`)
 * Nothing here calls a language model. Tests: tests/quant-route.test.js
 */
const express   = require('express')
const rateLimit = require('express-rate-limit')
const { requireAuth } = require('../middleware/auth')
const { guardAsync }  = require('../lib/async-route')
const { startJsonHeartbeat } = require('../lib/http-heartbeat')
const { fetchDailyBars } = require('../lib/internal-api')

const opt   = require('../lib/quant/options')
const vol   = require('../lib/quant/volatility')
const volModels = require('../lib/quant/vol-models')
const dccLib = require('../lib/quant/dcc')
const optim = require('../lib/quant/optimize')
const ts    = require('../lib/quant/timeseries')
const risk  = require('../lib/quant/risk')
const strat = require('../lib/quant/strategies')
const calc  = require('../lib/quant/calculators')
const mlc   = require('../lib/quant/ml-compare')
const nn    = require('../lib/quant/neural')
const L     = require('../lib/quant/linalg')
const hedge = require('../lib/quant/hedging')
const exo   = require('../lib/quant/exotics')
const vrpQ  = require('../lib/quant/vrp')
const varB  = require('../lib/quant/var-backtest')
const evs   = require('../lib/event-study')
const { isCryptoSymbol } = require('../lib/crypto-classify')
const { costBpsForSymbol } = require('../utils/backtest')

const router = express.Router()
const light = rateLimit({ windowMs: 60_000, max: 60, message: { error: 'Too many requests — wait a minute' } })
const heavy = rateLimit({ windowMs: 60_000, max: 10, message: { error: 'Too many requests — wait a minute' } })
const SYMBOL = /^[A-Za-z0-9.\-^=]{1,12}$/

class BadInput extends Error {}
const bad = msg => { throw new BadInput(msg) }
const num = (v, name, { min = -Infinity, max = Infinity, def } = {}) => {
  if (v == null || v === '') { if (def !== undefined) return def; bad(`${name} is required`) }
  const x = Number(v); if (!Number.isFinite(x) || x < min || x > max) bad(`${name} must be a number between ${min} and ${max}`)
  return x
}
const sym = (s, name = 'symbol') => { if (typeof s !== 'string' || !SYMBOL.test(s.trim())) bad(`${name}: a valid symbol is required`); return s.trim().toUpperCase() }
const syms = (arr, { min = 1, max = 12 } = {}) => { if (!Array.isArray(arr)) bad('symbols must be an array'); const u = [...new Set(arr.map(s => sym(s)))]; if (u.length < min || u.length > max) bad(`between ${min} and ${max} distinct symbols are required`); return u }
const keysFrom = req => ({ ...(req.headers['x-finnhub-key'] ? { 'x-finnhub-key': req.headers['x-finnhub-key'] } : {}), ...(req.headers['x-fmp-key'] ? { 'x-fmp-key': req.headers['x-fmp-key'] } : {}) })

// Short-lived bar cache: flipping between Quant Lab tabs re-asks for the same history, and the upstream data
// providers rate-limit. Only successes are cached; five minutes is far inside what a daily bar can change.
const BAR_TTL_MS = 5 * 60_000, BAR_CACHE_MAX = 300
const barCache = new Map()
async function bars(symbol, range, req) {
  const key = `${symbol}|${range}`, hit = barCache.get(key)
  if (hit && Date.now() - hit.t < BAR_TTL_MS) return hit.bars
  const b = await fetchDailyBars(symbol, { range, headers: keysFrom(req), timeoutMs: 20_000 })
  if (!b.length) bad(`no price history for ${symbol}${b.reason ? ` (${b.reason})` : ''}`)
  barCache.set(key, { t: Date.now(), bars: b })
  if (barCache.size > BAR_CACHE_MAX) barCache.delete(barCache.keys().next().value)
  return b
}
async function barsMap(list, range, req, min = 1) {
  const out = {}; const got = await Promise.all(list.map(s => bars(s, range, req).then(b => [s, b], e => [s, e])))
  const failed = []
  for (const [s, b] of got) { if (b instanceof Error) failed.push(`${s}: ${b.message}`); else out[s] = b }
  const n = Object.keys(out).length
  if (n < min) bad(`only ${n} of ${list.length} symbols loaded (need ${min})${failed.length ? ` — ${failed.join('; ')}` : ''}`)
  return { map: out, failed }
}
const RANGES = new Set(['1y', '2y', '5y'])
const rangeOf = (r, def = '2y') => (RANGES.has(r) ? r : def)

// route(): wraps a handler. Deliberate input / not-enough-data errors from lib/quant (plain Errors) and BadInput
// answer 400 with the reason; programming errors (TypeError, RangeError, ReferenceError, SyntaxError) are bugs and
// still go to guardAsync as 500s so they are never mistaken for bad input.
const isBug = e => e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError
const route = (name, fn) => guardAsync(name, async (req, res) => {
  // Await first, THEN look up res.json: `res.json(await fn())` reads res.json before fn runs, i.e. before
  // startJsonHeartbeat replaces it, so any request that heartbeated (> 15 s) failed with "Cannot set headers".
  try { const out = await fn(req, res); res.json(out) } catch (e) {
    if (isBug(e)) throw e
    return res.status(res.headersSent ? 200 : 400).json({ error: e.message })
  }
})

/* ── pure maths (public) ───────────────────────────────────────────────────── */
const optionArgs = b => ({
  S: num(b.S, 'S', { min: 0.0001, max: 1e7 }), K: num(b.K, 'K', { min: 0.0001, max: 1e7 }), r: num(b.r, 'r', { min: -0.2, max: 1, def: 0.04 }),
  sigma: num(b.sigma, 'sigma', { min: 0.001, max: 5 }), T: num(b.T, 'T (years)', { min: 1 / 365, max: 30 }), q: num(b.q, 'q', { min: 0, max: 1, def: 0 }),
  type: b.type === 'call' ? 'call' : 'put',
})
router.post('/options/price', light, route('quant/options/price', req => {
  const a = optionArgs(req.body || {})
  return opt.priceAll({ ...a, american: req.body.american !== false, n: Math.round(num(req.body.n, 'n', { min: 20, max: 2000, def: 500 })), grid: Math.round(num(req.body.grid, 'grid', { min: 50, max: 800, def: 300 })), paths: Math.round(num(req.body.paths, 'paths', { min: 1000, max: 60000, def: 20000 })), seed: 1 })
}))
router.post('/options/iv', light, route('quant/options/iv', req => {
  const a = optionArgs({ ...req.body, sigma: 0.2 }), price = num(req.body.price, 'price', { min: 0 })
  const iv = opt.impliedVol({ price, S: a.S, K: a.K, r: a.r, T: a.T, type: a.type, q: a.q })
  return { impliedVol: iv, note: iv == null ? 'No volatility reproduces that price (it is outside the no-arbitrage bounds).' : undefined, greeks: iv != null ? opt.greeks({ ...a, sigma: iv }) : null }
}))
router.post('/options/gamma-scalp', light, route('quant/options/gamma-scalp', req => {
  const b = req.body || {}
  return opt.simulateGammaScalp({ S: num(b.S, 'S', { min: 0.01, max: 1e6, def: 100 }), K: num(b.K, 'K', { min: 0.01, max: 1e6, def: 100 }), r: 0, sigmaImplied: num(b.sigmaImplied, 'sigmaImplied', { min: 0.01, max: 3, def: 0.2 }), sigmaRealized: num(b.sigmaRealized, 'sigmaRealized', { min: 0.01, max: 3, def: 0.25 }), days: Math.round(num(b.days, 'days', { min: 5, max: 250, def: 60 })), T: num(b.T, 'T', { min: 0.05, max: 3, def: 0.5 }), rehedgesPerDay: Math.round(num(b.rehedgesPerDay, 'rehedgesPerDay', { min: 1, max: 8, def: 1 })), seed: Math.round(num(b.seed, 'seed', { min: 1, max: 1e6, def: 3 })), costBps: num(b.costBps, 'costBps', { min: 0, max: 100, def: 0 }) })
}))

const quoteList = (arr, { needT = false } = {}) => {
  if (!Array.isArray(arr) || arr.length < 3 || arr.length > 60) bad('quotes: 3–60 rows of {strike, iv' + (needT ? ', T' : '') + '}')
  return arr.map(x => ({ strike: num(x.strike, 'strike', { min: 0.0001 }), iv: num(x.iv, 'iv (decimal)', { min: 0.001, max: 5 }), ...(needT ? { T: num(x.T, 'T', { min: 1 / 365, max: 10 }) } : {}) }))
}
router.post('/options/hedging', heavy, route('quant/options/hedging', req => {
  const b = req.body || {}
  const args = { S: num(b.S, 'S', { min: 0.01, max: 1e6, def: 100 }), K: num(b.K, 'K', { min: 0.01, max: 1e6, def: 100 }), T: num(b.T, 'T', { min: 0.02, max: 1, def: 0.25 }), sigmaImplied: num(b.sigmaImplied, 'sigmaImplied', { min: 0.01, max: 3, def: 0.2 }), sigmaRealized: num(b.sigmaRealized, 'sigmaRealized', { min: 0.01, max: 3, def: 0.25 }), costBps: num(b.costBps, 'costBps', { min: 0, max: 100, def: 5 }), riskAversion: num(b.riskAversion, 'riskAversion', { min: 0.01, max: 100, def: 1 }), type: b.type === 'put' ? 'put' : 'call', paths: Math.round(num(b.paths, 'paths', { min: 100, max: 3000, def: 1000 })), seed: Math.round(num(b.seed, 'seed', { min: 1, max: 1e6, def: 1 })) }
  return { ...hedge.compareHedging(args), discrete: hedge.discreteHedgingError({ S: args.S, K: args.K, T: args.T, sigma: args.sigmaImplied, type: args.type, counts: [8, 32, 128], paths: Math.min(args.paths, 1000) }) }
}))
router.post('/options/calibrate-sabr', light, route('quant/options/calibrate-sabr', req => {
  const b = req.body || {}
  return opt.calibrateSabr({ F: num(b.F, 'F (forward)', { min: 1e-6 }), T: num(b.T, 'T', { min: 1 / 365, max: 30 }), beta: num(b.beta, 'beta', { min: 0, max: 1, def: 1 }), quotes: quoteList(b.quotes) })
}))
router.post('/options/calibrate-heston', heavy, route('quant/options/calibrate-heston', (req, res) => {
  startJsonHeartbeat(res); const b = req.body || {}
  return opt.calibrateHeston({ S: num(b.S, 'S', { min: 0.0001 }), r: num(b.r, 'r', { min: -0.2, max: 1, def: 0.03 }), q: num(b.q, 'q', { min: 0, max: 1, def: 0 }), quotes: quoteList(b.quotes, { needT: true }), maxIter: 300 })
}))
router.post('/options/exotic', heavy, route('quant/options/exotic', req => {
  const b = req.body || {}, kind = b.kind
  const a = { S: num(b.S, 'S', { min: 0.01, max: 1e6, def: 100 }), r: num(b.r, 'r', { min: -0.2, max: 1, def: 0.04 }), q: num(b.q, 'q', { min: 0, max: 1, def: 0 }), sigma: num(b.sigma, 'sigma', { min: 0.01, max: 3, def: 0.25 }), T: num(b.T, 'T', { min: 1 / 365, max: 10, def: 1 }), type: b.type === 'put' ? 'put' : 'call', paths: Math.round(num(b.paths, 'paths', { min: 1000, max: 40000, def: 20000 })), seed: 1 }
  if (kind === 'asian') return { kind, ...exo.asian({ ...a, K: num(b.K, 'K', { min: 0.01, def: a.S }), fixings: Math.round(num(b.fixings, 'fixings', { min: 2, max: 365, def: 52 })) }) }
  if (kind === 'barrier') return { kind, ...exo.barrier({ ...a, K: num(b.K, 'K', { min: 0.01, def: a.S }), H: num(b.H, 'H (barrier)', { min: 0.01 }), barrier: ['up-and-out', 'down-and-out', 'up-and-in', 'down-and-in'].includes(b.barrier) ? b.barrier : bad('barrier must be up-and-out, down-and-out, up-and-in or down-and-in'), steps: Math.round(num(b.steps, 'steps', { min: 10, max: 365, def: 100 })) }) }
  if (kind === 'lookback') return { kind, ...exo.lookback({ ...a, steps: Math.round(num(b.steps, 'steps', { min: 10, max: 365, def: 100 })) }) }
  bad('kind must be asian, barrier or lookback')
}))

const CALCS = {
  carry: calc.carryTrade, basis: calc.basisTrade, 'roll-yield': calc.rollYield, 'merger-arb': calc.mergerArb, convertible: calc.convertibleArb,
  merton: calc.merton, vasicek: calc.vasicek, 'yield-curve': a => calc.yieldCurve(a.rates || {}, { history: a.history }), dispersion: calc.dispersion,
  'vol-term-structure': a => calc.volTermStructure(a.points || []), skew: calc.skewMetrics, 'skew-delta': calc.skewAwareDelta,
  heston: a => { const o = { ...a, type: a.type === 'put' ? 'put' : 'call' }; const price = opt.heston(o); return { price, impliedVol: opt.hestonImpliedVol(o), note: 'Fourier-inversion Heston price. v0 and theta are variances (σ²).' } },
  sabr: a => ({ smile: opt.sabrSmile({ ...a, strikes: a.strikes || [0.8, 0.9, 1, 1.1, 1.2].map(m => m * a.F) }), note: 'Hagan et al. (2002) lognormal SABR implied volatility; alpha is on the scale of F^(1−β).' }),
  parity: calc.parityArbitrage, 'theta-gamma': calc.thetaGamma, capacity: calc.capacity, leverage: calc.leverageMargin, 'short-sale': calc.shortSale,
  'order-book': calc.orderBookWalk, latency: calc.latencyCost, ito: a => calc.itoDemo({ ...a, paths: Math.min(Number(a.paths) || 20000, 50000) }), turnover: calc.turnover,
  'market-making': calc.avellanedaStoikov, execution: calc.executionSchedule, shortfall: calc.implementationShortfall,
}
router.get('/calc', (_req, res) => res.json({ calculators: Object.keys(CALCS) }))
router.post('/calc/:name', light, route('quant/calc', req => {
  const f = CALCS[req.params.name]; if (!f) bad(`unknown calculator "${req.params.name}"`)
  const body = req.body || {}; if (JSON.stringify(body).length > 20_000) bad('input too large')
  return f(body)
}))
router.post('/risk/stress', light, route('quant/risk/stress', req => {
  const p = req.body?.positions; if (!Array.isArray(p) || !p.length || p.length > 100) bad('positions: 1–100 rows of {symbol, value, beta?}')
  return risk.stressTest(p.map(x => ({ symbol: String(x.symbol || '?').slice(0, 12), value: num(x.value, 'value', { min: 0 }), beta: x.beta == null || x.beta === '' ? undefined : num(x.beta, 'beta', { min: -5, max: 5 }), shock: x.shock == null || x.shock === '' ? undefined : num(x.shock, 'shock', { min: -1, max: 5 }) })))
}))
router.post('/risk/impact', light, route('quant/risk/impact', req => { const b = req.body || {}; return risk.marketImpact({ shares: num(b.shares, 'shares', { min: 1 }), price: num(b.price, 'price', { min: 0.0001 }), adv: num(b.adv, 'adv', { min: 1 }), dailyVol: num(b.dailyVol, 'dailyVol', { min: 0.0001, max: 1 }), spreadBps: num(b.spreadBps, 'spreadBps', { min: 0, max: 500, def: 5 }) }) }))
router.post('/risk/bayes', light, route('quant/risk/bayes', req => { const b = req.body || {}; const n = Math.round(num(b.n, 'n', { min: 1, max: 1e6 })); return risk.bayesBinomial(Math.round(num(b.wins, 'wins', { min: 0, max: n })), n, { threshold: num(b.threshold, 'threshold', { min: 0, max: 1, def: 0.5 }) }) }))
router.post('/risk/montecarlo', light, route('quant/risk/montecarlo', req => {
  const b = req.body || {}, w = b.weights, mu = b.mu, vols = b.vols, corr = b.corr
  if (![w, mu, vols].every(a => Array.isArray(a) && a.length >= 1 && a.length <= 20 && a.length === w.length)) bad('weights, mu and vols must be equal-length arrays (1–20)')
  const n = w.length, C = corr || L.identity(n)
  if (!Array.isArray(C) || C.length !== n) bad('corr must be an n×n matrix')
  const sd = vols.map(v => num(v, 'vol', { min: 0.0001, max: 1 })), cov = C.map((r, i) => r.map((c, j) => num(c, 'corr', { min: -1, max: 1 }) * sd[i] * sd[j]))
  return risk.monteCarloVaR({ weights: w.map(x => num(x, 'weight', { min: -2, max: 2 })), mu: mu.map(x => num(x, 'mu', { min: -1, max: 1 })), cov, horizon: num(b.horizon, 'horizon', { min: 1, max: 252, def: 1 }), paths: 20000, level: num(b.level, 'level', { min: 0.8, max: 0.999, def: 0.95 }), value: num(b.value, 'value', { min: 0, def: 1 }) })
}))

/* ── market-data endpoints (sign-in) ───────────────────────────────────────── */
router.use(requireAuth)

router.post('/optimize', heavy, route('quant/optimize', async (req, res) => {
  startJsonHeartbeat(res)
  const list = syms(req.body?.symbols, { min: 2, max: 12 }), { map, failed } = await barsMap(list, rangeOf(req.body?.range, '5y'), req, 2)
  const r = optim.compareMethods(map, { cap: num(req.body?.cap, 'cap', { min: 0.1, max: 1, def: 0.6 }) })
  const f = Object.keys(map).length >= 2 ? (() => { const hrp = require('../lib/hrp'), al = hrp.alignReturns(map), lw = optim.ledoitWolf(al.returns), mu = L.columns(al.returns).map(c => L.mean(c) * 252), S = lw.cov.map(rw => rw.map(v => v * 252)); const ef = optim.efficientFrontier(mu, S, { points: 20 }); return { symbols: al.symbols, points: ef.points, minVariance: { ...ef.minVariance, w: undefined, weights: Object.fromEntries(al.symbols.map((s, i) => [s, +ef.minVariance.w[i].toFixed(4)])) }, maxSharpe: { ret: ef.maxSharpe.ret, vol: ef.maxSharpe.vol, sharpe: ef.maxSharpe.sharpe, weights: Object.fromEntries(al.symbols.map((s, i) => [s, +ef.maxSharpe.w[i].toFixed(4)])) }, note: 'Frontier uses unshrunk historical returns — it shows the shape of the trade-off, not a forecast.' } })() : null
  return { ...r, frontier: f, skipped: failed }
}))

// The whole Quant Lab across the user's holdings (lib/holdings-scan.js): per-holding quant snapshot,
// catalog strategies judged on two disjoint windows, opt-in walk-forward ML, and portfolio-level risk.
// Positions come from the page's active portfolio (shares only — prices are the server's last closes).
const _holdingsCache = new Map()
router.post('/holdings-scan', heavy, route('quant/holdings-scan', async (req, res) => {
  const raw = Array.isArray(req.body?.positions) ? req.body.positions : bad('positions must be an array of { symbol, shares }')
  const merged = new Map()
  for (const p of raw) {
    const s = sym(p?.symbol), sh = num(p?.shares, `shares of ${s}`, { min: 0, max: 1e12 })
    if (sh > 0) merged.set(s, (merged.get(s) || 0) + sh)
  }
  const hs = require('../lib/holdings-scan')
  const positions = [...merged].map(([symbol, shares]) => ({ symbol, shares })).slice(0, hs.MAX_HOLDINGS)
  if (!positions.length) bad('no holdings with shares to scan')
  const includeMl = req.body?.includeMl === true
  const key = `${req.user?.userId}|${includeMl}|${positions.map(p => `${p.symbol}:${p.shares}`).sort().join(',')}`
  const hit = _holdingsCache.get(key)
  if (hit && Date.now() - hit.t < 30 * 60_000) return { ...hit.body, cached: true }
  startJsonHeartbeat(res)
  // Five downloads at a time: a 30-holding portfolio fetched all at once trips the providers' rate limits.
  const map = {}, failed = []
  const queue = positions.map(p => p.symbol)
  await Promise.all(Array.from({ length: 5 }, async () => {
    for (let s = queue.shift(); s; s = queue.shift()) {
      try { map[s] = await bars(s, '5y', req) } catch (e) { failed.push(`${s}: ${e.message}`) }
    }
  }))
  if (!Object.keys(map).length) bad(`no holding had price history — ${failed.join('; ')}`)
  let bench = null
  try { bench = await bars('SPY', '5y', req) } catch { /* beta and stress fall back to beta 1 */ }
  let library = []
  try { library = require('../lib/strategy-library').readLibrary() } catch { /* empty library */ }
  // Earnings quality (SEC filings) and dated catalysts per holding — best-effort, three at a time (SEC asks for ≤10 requests/s).
  const filings = {}
  const today = new Date().toISOString().slice(0, 10)
  const fq = positions.map(p => p.symbol).filter(s => map[s] && !require('../lib/crypto-classify').isCryptoSymbol(s))
  await Promise.all(Array.from({ length: 3 }, async () => {
    for (let s = fq.shift(); s; s = fq.shift()) {
      try {
        const facts = await require('../lib/sec-facts').getCompanyFacts(s).catch(() => null)
        const quality = facts ? require('../lib/earnings-quality').qualityAt(facts, today) : null
        const CAT = require('../lib/catalysts')
        const inputs = await CAT.gatherInputs(s, { headers: keysFrom(req), lastFiled: quality?.lastFiled ?? null })
        filings[s] = { quality, events: CAT.buildCatalysts({ today, ...inputs }) }
      } catch { /* this holding just shows no quality / calendar */ }
    }
  }))
  const body = { ...(await hs.scanHoldings(positions, map, { benchBars: bench, library, includeMl, filings })), skipped: failed, truncated: merged.size > hs.MAX_HOLDINGS ? merged.size - hs.MAX_HOLDINGS : 0 }
  _holdingsCache.set(key, { t: Date.now(), body })
  if (_holdingsCache.size > 200) _holdingsCache.delete(_holdingsCache.keys().next().value)
  return body
}))

router.post('/volatility', heavy, route('quant/volatility', async (req, res) => {
  const s = sym(req.body?.symbol), b = await bars(s, rangeOf(req.body?.range, '2y'), req)
  const out = { symbol: s, ...vol.volatilityReport(b, { window: Math.round(num(req.body?.window, 'window', { min: 5, max: 120, def: 21 })) }) }
  // The GARCH family on 5 years of daily log returns, then the walk-forward contest between them (seconds of CPU → heartbeat).
  startJsonHeartbeat(res)
  try {
    const b5 = await bars(s, '5y', req), c = b5.map(x => x.c), r = []
    for (let i = 1; i < c.length; i++) if (c[i - 1] > 0 && c[i] > 0) r.push(Math.log(c[i] / c[i - 1]))
    out.family = { observations: r.length, ...volModels.fitAll(r) }
    if (req.body?.compare !== false) {
      try { out.comparison = await volModels.compareModels(r, { refitEvery: 63 }) } catch (e) { out.comparisonError = e.message }
    }
    try { out.forecastStudy = require('../lib/vol-forecast-study').summary() } catch { /* study not run yet */ }
  } catch (e) { out.familyError = e.message }
  return out
}))

router.post('/timeseries', heavy, route('quant/timeseries', async req => {
  const s = sym(req.body?.symbol), b = await bars(s, rangeOf(req.body?.range, '5y'), req), c = b.map(x => x.c), lr = L.logReturnsOf(c), out = { symbol: s, observations: c.length }
  const tryit = (k, f) => { try { out[k] = f() } catch (e) { out[k + 'Error'] = e.message } }
  tryit('adfPrice', () => ts.adf(c.map(Math.log))); tryit('adfReturns', () => ts.adf(lr)); tryit('hurst', () => ts.hurst(c.map(Math.log)))
  tryit('autocorrelation', () => ({ acf: ts.acf(lr, 10), ljungBox: ts.ljungBox(lr, 10) })); tryit('cycles', () => ts.dominantCycles(lr.slice(-512)))
  tryit('arima', () => { const m = ts.arima(c.slice(-500).map(Math.log), { horizon: 10 }); return { ...m, forecast: m.forecast.map(f => ({ step: f.step, mean: Math.exp(f.mean), lo: Math.exp(f.lo), hi: Math.exp(f.hi) })) } })
  tryit('regimes', () => ts.hmm2(lr))
  tryit('varianceRatio', () => [2, 5, 10, 20].map(q => ts.varianceRatio(c.map(Math.log), q)))
  tryit('kalmanLevel', () => { const lp = c.slice(-250).map(Math.log), k = ts.kalmanLocalLevel(lp); return { gain: k.gain, series: lp.map((v, i) => ({ i, price: Math.exp(v), level: Math.exp(k.level[i]) })) } })
  return out
}))

router.post('/pairs', heavy, route('quant/pairs', async req => { const y = sym(req.body?.y, 'y'), x = sym(req.body?.x, 'x'); if (y === x) bad('choose two different symbols'); const { map, failed } = await barsMap([y, x], rangeOf(req.body?.range, '5y'), req, 2); if (!map[y] || !map[x]) bad(`could not load both symbols — ${failed.join('; ')}`); return { y, x, ...strat.testPair(map[y], map[x], { kalman: req.body?.kalman === true, entryZ: num(req.body?.entryZ, 'entryZ', { min: 0.5, max: 4, def: 2 }), costBps: num(req.body?.costBps, 'costBps', { min: 0, max: 100, def: 10 }) }) } }))
router.post('/pairs/screen', heavy, route('quant/pairs/screen', async (req, res) => { startJsonHeartbeat(res); const list = syms(req.body?.symbols, { min: 3, max: 10 }), { map, failed } = await barsMap(list, rangeOf(req.body?.range, '5y'), req, 2); return { ...strat.screenPairs(map), skipped: failed } }))
router.post('/statarb', heavy, route('quant/statarb', async req => { const list = syms(req.body?.symbols, { min: 4, max: 20 }), { map, failed } = await barsMap(list, '2y', req, 4); return { ...strat.statArbPca(map, { k: Math.round(num(req.body?.k, 'k', { min: 1, max: 5, def: 3 })) }), skipped: failed } }))
router.post('/reversal', heavy, route('quant/reversal', async req => { const s = sym(req.body?.symbol), b = await bars(s, '5y', req); return { symbol: s, ...strat.shortTermReversal(b, { k: num(req.body?.k, 'k', { min: 0.5, max: 4, def: 1.5 }), hold: Math.round(num(req.body?.hold, 'hold', { min: 1, max: 10, def: 1 })) }) } }))

router.post('/risk/capm', heavy, route('quant/risk/capm', async req => {
  const s = sym(req.body?.symbol), bm = sym(req.body?.benchmark || 'SPY', 'benchmark'), { map, failed } = await barsMap([s, bm], rangeOf(req.body?.range, '2y'), req, 2)
  if (!map[s] || !map[bm]) bad(`could not load both series — ${failed.join('; ')}`); const hrp = require('../lib/hrp'), al = hrp.alignReturns({ [s]: map[s], [bm]: map[bm] })
  return { symbol: s, benchmark: bm, ...risk.capm(al.returns.map(r => r[al.symbols.indexOf(s)]), al.returns.map(r => r[al.symbols.indexOf(bm)]), { rf: num(req.body?.rf, 'rf', { min: 0, max: 0.3, def: 0.04 }) }), bootstrapSharpe: risk.bootstrapSharpe(al.returns.map(r => r[al.symbols.indexOf(s)]), { B: 400 }) }
}))
// Fama–French five factors + momentum (Ken French's daily files), Newey–West errors (lib/factor-regression.js).
router.post('/risk/factors', heavy, route('quant/risk/factors', async req => {
  const s = sym(req.body?.symbol), years = Math.round(num(req.body?.years, 'years', { min: 1, max: 5, def: 3 }))
  const FR = require('../lib/factor-regression')
  const [b, factors] = await Promise.all([bars(s, '5y', req), FR.fetchFactors()])
  const res = FR.regress(b, factors, { years })
  return { symbol: s, years, ...res, summary: FR.describe(res, s) }
}))
router.post('/risk/copula', heavy, route('quant/risk/copula', async req => { const a = sym(req.body?.a, 'a'), b = sym(req.body?.b, 'b'); const { map } = await barsMap([a, b], '5y', req, 2); const hrp = require('../lib/hrp'), al = hrp.alignReturns(map); return { a, b, ...risk.gaussianCopula(al.returns.map(r => r[0]), al.returns.map(r => r[1])) } }))
router.post('/risk/pca', heavy, route('quant/risk/pca', async req => { const list = syms(req.body?.symbols, { min: 3, max: 20 }), { map } = await barsMap(list, '2y', req, 3), al = require('../lib/hrp').alignReturns(map), p = risk.pca(al.returns, { components: 3 }); return { symbols: al.symbols, explained: p.explained, cumulative: p.cumulative, loadings: p.loadings.map(v => Object.fromEntries(al.symbols.map((s, i) => [s, +v[i].toFixed(4)]))) } }))
router.post('/risk/dcc', heavy, route('quant/risk/dcc', async (req, res) => {
  const list = syms(req.body?.symbols, { min: 2, max: 20 }), { map } = await barsMap(list, '5y', req, 2), al = require('../lib/hrp').alignReturns(map)
  startJsonHeartbeat(res)
  const w = al.symbols.map(() => 1 / al.symbols.length)
  return { ...dccLib.dcc(al.returns, { symbols: al.symbols, weights: w }), weighting: 'equal weights' }
}))

router.post('/ml/compare', heavy, route('quant/ml/compare', async (req, res) => { startJsonHeartbeat(res); const s = sym(req.body?.symbol), b = await bars(s, '5y', req); return { symbol: s, ...mlc.compareModels(b, { horizon: Math.round(num(req.body?.horizon, 'horizon', { min: 1, max: 20, def: 5 })) }) } }))
router.post('/ml/cluster', heavy, route('quant/ml/cluster', async req => { const list = syms(req.body?.symbols, { min: 4, max: 30 }), { map, failed } = await barsMap(list, '2y', req, 4); return { ...mlc.clusterSymbols(map, { k: Math.round(num(req.body?.k, 'k', { min: 2, max: 6, def: 3 })) }), skipped: failed } }))
router.post('/ml/rl', heavy, route('quant/ml/rl', async (req, res) => { startJsonHeartbeat(res); const s = sym(req.body?.symbol), b = await bars(s, '5y', req); return { symbol: s, ...nn.qLearning(b) } }))

router.post('/vrp', heavy, route('quant/vrp', async req => {
  const s = sym(req.body?.symbol || 'SPY'), b = await bars(s, '5y', req), horizon = Math.round(num(req.body?.horizon, 'horizon', { min: 5, max: 63, def: 21 }))
  let vix = null, vixError = null
  if (s === 'SPY' || s === 'VOO' || s === 'IVV') { try { vix = await vrpQ.fetchVix({ start: '2019-01-01' }) } catch (e) { vixError = e.message } }
  const iv = req.body?.impliedVol != null && req.body.impliedVol !== '' ? num(req.body.impliedVol, 'impliedVol (decimal)', { min: 0.01, max: 5 }) : vix ? vix[vix.length - 1].value / 100 : bad(vixError ? `VIX history is unavailable right now (${vixError}) — enter the implied volatility (decimal) instead` : 'enter the implied volatility (decimal) — only S&P 500 trackers (SPY, VOO, IVV) get it automatically from VIX')
  const out = { symbol: s, impliedSource: req.body?.impliedVol != null && req.body.impliedVol !== '' ? 'entered' : `VIX ${vix[vix.length - 1].date} (FRED)`, snapshot: vrpQ.vrpSnapshot(b, { impliedVol: iv, horizon }) }
  if (vix) { try { out.history = vrpQ.vrpHistory(b, vix, { horizon }) } catch (e) { out.historyError = e.message } } else if (vixError) out.historyError = vixError
  return out
}))
router.post('/optimize/walk-forward', heavy, route('quant/optimize/walk-forward', async (req, res) => {
  startJsonHeartbeat(res)
  const list = syms(req.body?.symbols, { min: 2, max: 10 }), { map, failed } = await barsMap(list, '5y', req, 2)
  return { ...optim.walkForward(map, { lookback: Math.round(num(req.body?.lookback, 'lookback', { min: 60, max: 756, def: 252 })), rebalance: Math.round(num(req.body?.rebalance, 'rebalance', { min: 5, max: 126, def: 21 })), costBps: num(req.body?.costBps, 'costBps', { min: 0, max: 200, def: 10 }), cap: num(req.body?.cap, 'cap', { min: 0.1, max: 1, def: 0.6 }) }), skipped: failed }
}))
router.post('/risk/var-backtest', heavy, route('quant/risk/var-backtest', async req => {
  const s = sym(req.body?.symbol), b = await bars(s, '5y', req)
  return { symbol: s, ...varB.backtestVar(L.logReturnsOf(b.map(x => x.c)), { level: num(req.body?.level, 'level', { min: 0.9, max: 0.999, def: 0.99 }), window: Math.round(num(req.body?.window, 'window', { min: 100, max: 750, def: 250 })) }) }
}))
router.post('/risk/premium', heavy, route('quant/risk/premium', async req => {
  const s = sym(req.body?.symbol), b = await bars(s, '5y', req)
  return { symbol: s, ...risk.riskPremium(L.returnsOf(b.map(x => x.c)), { rf: num(req.body?.rf, 'rf', { min: 0, max: 0.3, def: 0.04 }), B: 800 }) }
}))
router.post('/ml/walk-forward', heavy, route('quant/ml/walk-forward', async (req, res) => {
  startJsonHeartbeat(res); const s = sym(req.body?.symbol), b = await bars(s, '5y', req)
  return { symbol: s, ...mlc.walkForwardModels(b, { horizon: Math.round(num(req.body?.horizon, 'horizon', { min: 1, max: 20, def: 5 })), folds: Math.round(num(req.body?.folds, 'folds', { min: 3, max: 8, def: 5 })) }) }
}))

// Event study: what this stock did after its own past earnings releases, periodic filings or entered dates.
// Dates from the SEC filing index (keyless); returns vs SPY (BTC for a crypto pair), after costs. lib/event-study.js
router.post('/event-study', heavy, route('quant/event-study', async req => {
  const s = sym(req.body?.symbol), kind = evs.KINDS.includes(req.body?.kind) ? req.body.kind : 'earnings'
  const notes = []
  let events, name = null
  if (kind === 'custom') {
    const p = evs.parseCustomDates(req.body?.dates)
    if (!p.events.length) bad('enter at least one date as YYYY-MM-DD')
    events = p.events
    if (p.invalid.length) notes.push(`Not dates, ignored: ${p.invalid.join(', ')}.`)
    if (p.dropped) notes.push(`Only the newest ${evs.MAX_DATES} dates are used; ${p.dropped} older ones were left out.`)
  } else {
    let index
    try { index = await evs.fetchFilingIndex(s) } catch (e) { bad(`could not read the SEC filing index for ${s}: ${e.message}`) }
    if (!index) bad(`${s} has no SEC filings under that ticker (an ETF, a fund, a crypto pair or a foreign listing) — use "My own dates" instead`)
    name = index.name
    events = evs.eventDates(index.recent, kind)
    if (!events.length) bad(kind === 'earnings' ? `${s} has no 8-K earnings releases (Item 2.02) in its recent filings — foreign issuers report on a 6-K; try "Periodic filings" or your own dates` : `${s} has no periodic reports in its recent filings`)
  }
  const benchmark = isCryptoSymbol(s) ? 'BTC-USD' : 'SPY'
  if (s === benchmark) bad(`${s} is the benchmark itself — the return against it is zero by construction`)
  const [b, bb] = await Promise.all([bars(s, '5y', req), bars(benchmark, '5y', req)])
  const costBps = costBpsForSymbol(s)
  const result = evs.study({ bars: b, benchBars: bb, events, costBps })
  if (result.skipped.beforeHistory) notes.push(`${result.skipped.beforeHistory} older ${result.skipped.beforeHistory === 1 ? 'event is' : 'events are'} before the five years of price history and ${result.skipped.beforeHistory === 1 ? 'was' : 'were'} not used.`)
  if (result.skipped.tooRecent) notes.push(`${result.skipped.tooRecent} ${result.skipped.tooRecent === 1 ? 'event has' : 'events have'} no trading session after ${result.skipped.tooRecent === 1 ? 'it' : 'them'} yet.`)
  return { symbol: s, name, kind, benchmark, ...result, summary: evs.describe(result, { symbol: s, kind, benchmark }), notes,
    method: `Entry at the open of the first session after the event date, exit at the close h sessions later, net of a ${costBps} bps round trip, minus ${benchmark} over the same sessions. Windows of one horizon never overlap. The t-statistic is across calendar months; the bar is two-sided 5% shared across the three horizons.` }
}))

module.exports = router
