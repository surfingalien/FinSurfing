'use strict'
/**
 * routes/quant.js — Quant Lab API. Thin HTTP wrappers over lib/quant/* (all the maths lives there, tested
 * without a server). Two groups:
 *
 *   pure maths, public   POST /options/*, /calc/:name, /risk/stress|impact|montecarlo|bayes
 *                        — no market data, no AI, no cost: inputs in, numbers out (size-capped)
 *   market-data, sign-in POST /optimize, /volatility, /timeseries, /pairs, /pairs/screen, /statarb, /reversal,
 *                        /risk/capm, /risk/copula, /risk/pca, /ml/compare, /ml/cluster, /ml/rl
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
const optim = require('../lib/quant/optimize')
const ts    = require('../lib/quant/timeseries')
const risk  = require('../lib/quant/risk')
const strat = require('../lib/quant/strategies')
const calc  = require('../lib/quant/calculators')
const mlc   = require('../lib/quant/ml-compare')
const nn    = require('../lib/quant/neural')
const L     = require('../lib/quant/linalg')

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

async function bars(symbol, range, req) {
  const b = await fetchDailyBars(symbol, { range, headers: keysFrom(req), timeoutMs: 20_000 })
  if (!b.length) bad(`no price history for ${symbol}${b.reason ? ` (${b.reason})` : ''}`)
  return b
}
async function barsMap(list, range, req) {
  const out = {}; const got = await Promise.all(list.map(s => bars(s, range, req).then(b => [s, b], e => [s, e])))
  const failed = []
  for (const [s, b] of got) { if (b instanceof Error) failed.push(`${s}: ${b.message}`); else out[s] = b }
  if (Object.keys(out).length < 1) bad(failed.join('; ') || 'no data')
  return { map: out, failed }
}
const RANGES = new Set(['1y', '2y', '5y'])
const rangeOf = (r, def = '2y') => (RANGES.has(r) ? r : def)

// route(): wraps a handler. Deliberate input / not-enough-data errors from lib/quant (plain Errors) and BadInput
// answer 400 with the reason; programming errors (TypeError, RangeError, ReferenceError, SyntaxError) are bugs and
// still go to guardAsync as 500s so they are never mistaken for bad input.
const isBug = e => e instanceof TypeError || e instanceof RangeError || e instanceof ReferenceError || e instanceof SyntaxError
const route = (name, fn) => guardAsync(name, async (req, res) => {
  try { res.json(await fn(req, res)) } catch (e) {
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

const CALCS = {
  carry: calc.carryTrade, basis: calc.basisTrade, 'roll-yield': calc.rollYield, 'merger-arb': calc.mergerArb, convertible: calc.convertibleArb,
  merton: calc.merton, vasicek: calc.vasicek, 'yield-curve': a => calc.yieldCurve(a.rates || {}, { history: a.history }), dispersion: calc.dispersion,
  'vol-term-structure': a => calc.volTermStructure(a.points || []), skew: calc.skewMetrics, 'skew-delta': calc.skewAwareDelta,
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
  const list = syms(req.body?.symbols, { min: 2, max: 12 }), { map, failed } = await barsMap(list, rangeOf(req.body?.range, '5y'), req)
  const r = optim.compareMethods(map, { cap: num(req.body?.cap, 'cap', { min: 0.1, max: 1, def: 0.6 }) })
  const f = Object.keys(map).length >= 2 ? (() => { const hrp = require('../lib/hrp'), al = hrp.alignReturns(map), lw = optim.ledoitWolf(al.returns), mu = L.columns(al.returns).map(c => L.mean(c) * 252), S = lw.cov.map(rw => rw.map(v => v * 252)); const ef = optim.efficientFrontier(mu, S, { points: 20 }); return { symbols: al.symbols, points: ef.points, minVariance: { ...ef.minVariance, w: undefined, weights: Object.fromEntries(al.symbols.map((s, i) => [s, +ef.minVariance.w[i].toFixed(4)])) }, maxSharpe: { ret: ef.maxSharpe.ret, vol: ef.maxSharpe.vol, sharpe: ef.maxSharpe.sharpe, weights: Object.fromEntries(al.symbols.map((s, i) => [s, +ef.maxSharpe.w[i].toFixed(4)])) }, note: 'Frontier uses unshrunk historical returns — it shows the shape of the trade-off, not a forecast.' } })() : null
  return { ...r, frontier: f, skipped: failed }
}))

router.post('/volatility', heavy, route('quant/volatility', async req => { const s = sym(req.body?.symbol), b = await bars(s, rangeOf(req.body?.range, '2y'), req); return { symbol: s, ...vol.volatilityReport(b, { window: Math.round(num(req.body?.window, 'window', { min: 5, max: 120, def: 21 })) }) } }))

router.post('/timeseries', heavy, route('quant/timeseries', async req => {
  const s = sym(req.body?.symbol), b = await bars(s, rangeOf(req.body?.range, '5y'), req), c = b.map(x => x.c), lr = L.logReturnsOf(c), out = { symbol: s, observations: c.length }
  const tryit = (k, f) => { try { out[k] = f() } catch (e) { out[k + 'Error'] = e.message } }
  tryit('adfPrice', () => ts.adf(c.map(Math.log))); tryit('adfReturns', () => ts.adf(lr)); tryit('hurst', () => ts.hurst(c.map(Math.log)))
  tryit('autocorrelation', () => ({ acf: ts.acf(lr, 10), ljungBox: ts.ljungBox(lr, 10) })); tryit('cycles', () => ts.dominantCycles(lr.slice(-512)))
  tryit('arima', () => { const m = ts.arima(c.slice(-500).map(Math.log), { horizon: 10 }); return { ...m, forecast: m.forecast.map(f => ({ step: f.step, mean: Math.exp(f.mean), lo: Math.exp(f.lo), hi: Math.exp(f.hi) })) } })
  tryit('regimes', () => ts.hmm2(lr))
  return out
}))

router.post('/pairs', heavy, route('quant/pairs', async req => { const y = sym(req.body?.y, 'y'), x = sym(req.body?.x, 'x'); if (y === x) bad('choose two different symbols'); const { map } = await barsMap([y, x], rangeOf(req.body?.range, '5y'), req); if (!map[y] || !map[x]) bad('could not load both symbols'); return { y, x, ...strat.testPair(map[y], map[x], { kalman: req.body?.kalman === true, entryZ: num(req.body?.entryZ, 'entryZ', { min: 0.5, max: 4, def: 2 }), costBps: num(req.body?.costBps, 'costBps', { min: 0, max: 100, def: 10 }) }) } }))
router.post('/pairs/screen', heavy, route('quant/pairs/screen', async (req, res) => { startJsonHeartbeat(res); const list = syms(req.body?.symbols, { min: 3, max: 10 }), { map, failed } = await barsMap(list, rangeOf(req.body?.range, '5y'), req); return { ...strat.screenPairs(map), skipped: failed } }))
router.post('/statarb', heavy, route('quant/statarb', async req => { const list = syms(req.body?.symbols, { min: 4, max: 20 }), { map, failed } = await barsMap(list, '2y', req); return { ...strat.statArbPca(map, { k: Math.round(num(req.body?.k, 'k', { min: 1, max: 5, def: 3 })) }), skipped: failed } }))
router.post('/reversal', heavy, route('quant/reversal', async req => { const s = sym(req.body?.symbol), b = await bars(s, '5y', req); return { symbol: s, ...strat.shortTermReversal(b, { k: num(req.body?.k, 'k', { min: 0.5, max: 4, def: 1.5 }), hold: Math.round(num(req.body?.hold, 'hold', { min: 1, max: 10, def: 1 })) }) } }))

router.post('/risk/capm', heavy, route('quant/risk/capm', async req => {
  const s = sym(req.body?.symbol), bm = sym(req.body?.benchmark || 'SPY', 'benchmark'), { map } = await barsMap([s, bm], rangeOf(req.body?.range, '2y'), req)
  if (!map[s] || !map[bm]) bad('could not load both series'); const hrp = require('../lib/hrp'), al = hrp.alignReturns({ [s]: map[s], [bm]: map[bm] })
  return { symbol: s, benchmark: bm, ...risk.capm(al.returns.map(r => r[al.symbols.indexOf(s)]), al.returns.map(r => r[al.symbols.indexOf(bm)]), { rf: num(req.body?.rf, 'rf', { min: 0, max: 0.3, def: 0.04 }) }), bootstrapSharpe: risk.bootstrapSharpe(al.returns.map(r => r[al.symbols.indexOf(s)]), { B: 400 }) }
}))
router.post('/risk/copula', heavy, route('quant/risk/copula', async req => { const a = sym(req.body?.a, 'a'), b = sym(req.body?.b, 'b'); const { map } = await barsMap([a, b], '5y', req); const hrp = require('../lib/hrp'), al = hrp.alignReturns(map); return { a, b, ...risk.gaussianCopula(al.returns.map(r => r[0]), al.returns.map(r => r[1])) } }))
router.post('/risk/pca', heavy, route('quant/risk/pca', async req => { const list = syms(req.body?.symbols, { min: 3, max: 20 }), { map } = await barsMap(list, '2y', req), al = require('../lib/hrp').alignReturns(map), p = risk.pca(al.returns, { components: 3 }); return { symbols: al.symbols, explained: p.explained, cumulative: p.cumulative, loadings: p.loadings.map(v => Object.fromEntries(al.symbols.map((s, i) => [s, +v[i].toFixed(4)]))) } }))

router.post('/ml/compare', heavy, route('quant/ml/compare', async (req, res) => { startJsonHeartbeat(res); const s = sym(req.body?.symbol), b = await bars(s, '5y', req); return { symbol: s, ...mlc.compareModels(b, { horizon: Math.round(num(req.body?.horizon, 'horizon', { min: 1, max: 20, def: 5 })) }) } }))
router.post('/ml/cluster', heavy, route('quant/ml/cluster', async req => { const list = syms(req.body?.symbols, { min: 4, max: 30 }), { map, failed } = await barsMap(list, '2y', req); return { ...mlc.clusterSymbols(map, { k: Math.round(num(req.body?.k, 'k', { min: 2, max: 6, def: 3 })) }), skipped: failed } }))
router.post('/ml/rl', heavy, route('quant/ml/rl', async (req, res) => { startJsonHeartbeat(res); const s = sym(req.body?.symbol), b = await bars(s, '5y', req); return { symbol: s, ...nn.qLearning(b) } }))

module.exports = router
