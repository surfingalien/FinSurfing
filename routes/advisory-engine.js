'use strict'
/**
 * /api/advisory-engine — the measured half of the browser's AI Advisory
 * Engine (lib/advisory-engine.js). All signed-in: they serve or record
 * results about the user's own analyses.
 *
 *   GET  /backtest/:symbol   walk-forward test of the engine's price-only rule
 *                            on five years of bars (next-open entry, net of
 *                            costs, against the base rate). Heartbeated →
 *                            clients check `data.error` as well as `res.ok`.
 *   POST /record             records a signal the browser produced, anchored
 *                            on a SERVER price, so it is scored later.
 *   GET  /calibration        the engine's measured record, overall and per
 *                            signal type, with Wilson intervals.
 *   POST /persona-record     the Advisory page's rule-based persona calls
 *                            (Buy/Overweight/Sell/Underweight; Hold is not
 *                            scored), on a server price, once a day each.
 *   GET  /persona-calibration each persona's measured record.
 */
const express = require('express')
const { requireAuth } = require('../middleware/auth')
const { startJsonHeartbeat } = require('../lib/http-heartbeat')
const { fetchDailyBars } = require('../lib/internal-api')
const engine = require('../lib/advisory-engine')
const learningStore = require('../lib/learning-store')
const { costBpsForSymbol } = require('../utils/backtest')

const router = express.Router()
router.use(requireAuth)

const cleanSymbol = s => String(s || '').toUpperCase().replace(/[^A-Z0-9.^=-]/g, '').slice(0, 15)
const fwd = req => {
  const h = {}
  for (const k of ['x-aisa-key', 'x-finnhub-key', 'x-fmp-key', 'x-td-key', 'x-av-key']) if (req.headers[k]) h[k] = req.headers[k]
  return h
}
const isCrypto = sym => /-USD$|-USDT$/.test(sym)

// Backtests are deterministic per (symbol, day): cache for an hour so a page
// re-render or a second visitor does not refetch five years of bars.
const _cache = new Map()
const CACHE_MS = 60 * 60 * 1000

router.get('/backtest/:symbol', async (req, res) => {
  const sym = cleanSymbol(req.params.symbol)
  if (!sym) return res.status(400).json({ error: 'Invalid symbol' })
  const horizon = Math.min(60, Math.max(5, Number(req.query.horizon) || 20))
  const key = `${sym}:${horizon}`
  const hit = _cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.body)
  startJsonHeartbeat(res)
  try {
    const bars = await fetchDailyBars(sym, { range: '5y', headers: fwd(req), timeoutMs: 25_000 })
    if (!bars.length) return res.status(422).json({ error: `No price history for ${sym}: ${bars.reason || 'no data provider returned any'}` })
    const costBps = costBpsForSymbol(sym, isCrypto(sym) ? 'crypto' : null)
    const result = engine.walkForward(bars, { horizon, costBps })
    if (!result) return res.status(422).json({ error: `Not enough history for ${sym} to test the rule (${bars.length} daily bars)` })
    const body = { symbol: sym, ...result }
    _cache.set(key, { at: Date.now(), body })
    if (_cache.size > 500) _cache.delete(_cache.keys().next().value)
    res.json(body)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// One recorded signal per user + symbol + signal per day: re-analysing the same
// name ten times is one claim, not ten.
const _recent = new Map()
const DEDUPE_MS = 20 * 60 * 60 * 1000

router.post('/record', async (req, res) => {
  const { symbol, signal, ensembleScore, factors } = req.body || {}
  const sym = cleanSymbol(symbol)
  if (!sym || !engine.SIGNALS.includes(signal)) return res.status(400).json({ error: 'symbol and a known signal are required' })
  if (!engine.SIGNAL_ACTION[signal]) return res.json({ recorded: false, reason: `${signal} makes no directional claim to score` })
  const userId = req.user?.userId ?? null
  const key = `${userId}:${sym}:${signal}`
  const last = _recent.get(key)
  if (last && Date.now() - last < DEDUPE_MS) return res.json({ recorded: false, reason: 'already recorded today' })
  // The price is the server's last daily close, never the browser's number.
  const bars = await fetchDailyBars(sym, { range: '1mo', headers: fwd(req), timeoutMs: 10_000 })
  const lastBar = bars.at?.(-1)
  if (!(lastBar?.c > 0)) return res.json({ recorded: false, reason: `no server price for ${sym}` })
  const decision = engine.decisionFromSignal({ symbol: sym, signal, ensembleScore, factors },
    { price: lastBar.c, userId, priceAsOf: new Date(lastBar.t).toISOString().slice(0, 10) })
  if (!decision) return res.json({ recorded: false, reason: 'nothing to record' })
  try {
    learningStore.recordDecision(decision)
    _recent.set(key, Date.now())
    res.json({ recorded: true, price: decision.price, priceAsOf: decision.meta.priceAsOf, action: decision.action })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// The Advisory page's five rule-based personas: every directional call they make
// on a symbol, recorded once a day per user + symbol + persona on a SERVER price.
router.post('/persona-record', async (req, res) => {
  const { symbol, calls } = req.body || {}
  const sym = cleanSymbol(symbol)
  if (!sym || !Array.isArray(calls) || !calls.length) return res.status(400).json({ error: 'symbol and calls are required' })
  const userId = req.user?.userId ?? null
  const wanted = calls.slice(0, engine.PERSONA_IDS.length)
    .filter(c => engine.PERSONA_IDS.includes(c?.persona) && engine.PERSONA_ACTION[c?.action])
    .filter(c => { const last = _recent.get(`${userId}:${sym}:persona:${c.persona}`); return !(last && Date.now() - last < DEDUPE_MS) })
  if (!wanted.length) return res.json({ recorded: 0, reason: 'no new directional calls (Hold is not scored; each persona is recorded once a day)' })
  const bars = await fetchDailyBars(sym, { range: '1mo', headers: fwd(req), timeoutMs: 10_000 })
  const lastBar = bars.at?.(-1)
  if (!(lastBar?.c > 0)) return res.json({ recorded: 0, reason: `no server price for ${sym}` })
  const priceAsOf = new Date(lastBar.t).toISOString().slice(0, 10)
  const decisions = wanted.map(c => engine.decisionFromPersona({ symbol: sym, ...c }, { price: lastBar.c, userId, priceAsOf })).filter(Boolean)
  try {
    learningStore.recordDecisions(decisions)
    for (const d of decisions) _recent.set(`${userId}:${sym}:persona:${d.meta.ruleSet}`, Date.now())
    res.json({ recorded: decisions.length, personas: decisions.map(d => d.meta.ruleSet), price: lastBar.c, priceAsOf })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/persona-calibration', (req, res) => {
  try {
    res.json(engine.personaCalibration(learningStore.readDecisions(), learningStore.calibrate, { minSample: learningStore.MIN_SAMPLE }))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.get('/calibration', (req, res) => {
  try {
    res.json(engine.engineCalibration(learningStore.readDecisions(), learningStore.calibrate, { minSample: learningStore.MIN_SAMPLE }))
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
module.exports._internals = { _cache, _recent }
