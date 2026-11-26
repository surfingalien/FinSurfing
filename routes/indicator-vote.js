'use strict'
/**
 * /api/indicator-vote — the measured half of the Analyze page's indicator vote
 * (lib/indicator-vote.js). Signed in.
 *
 *   GET /backtest/:symbol   the page's BUY rule with its own 2-ATR stop /
 *                           3-ATR target replayed over five years of daily
 *                           bars, next-open entry, net of costs, against the
 *                           same number of trades on random days
 *                           (lib/indicator-vote-backtest.js). Heartbeated →
 *                           clients check `data.error` as well as `res.ok`.
 */
const express = require('express')
const { requireAuth } = require('../middleware/auth')
const { startJsonHeartbeat } = require('../lib/http-heartbeat')
const { fetchDailyBars } = require('../lib/internal-api')
const { backtestVote } = require('../lib/indicator-vote-backtest')
const { costBpsForSymbol } = require('../utils/backtest')

const router = express.Router()
router.use(requireAuth)

const cleanSymbol = s => String(s || '').toUpperCase().replace(/[^A-Z0-9.^=-]/g, '').slice(0, 15)
const fwd = req => {
  const h = {}
  for (const k of ['x-aisa-key', 'x-finnhub-key', 'x-fmp-key', 'x-td-key', 'x-av-key']) if (req.headers[k]) h[k] = req.headers[k]
  return h
}
const _cache = new Map()
const CACHE_MS = 60 * 60 * 1000

router.get('/backtest/:symbol', async (req, res) => {
  const sym = cleanSymbol(req.params.symbol)
  if (!sym) return res.status(400).json({ error: 'Invalid symbol' })
  const maxHold = Math.min(60, Math.max(5, Number(req.query.maxHold) || 20))
  const key = `${sym}:${maxHold}`
  const hit = _cache.get(key)
  if (hit && Date.now() - hit.at < CACHE_MS) return res.json(hit.body)
  startJsonHeartbeat(res)
  try {
    const bars = await fetchDailyBars(sym, { range: '5y', headers: fwd(req), timeoutMs: 25_000 })
    if (!bars.length) return res.status(422).json({ error: `No price history for ${sym}: ${bars.reason || 'no data provider returned any'}` })
    const costBps = costBpsForSymbol(sym, /-USD$|-USDT$/.test(sym) ? 'crypto' : null)
    const result = backtestVote(bars, { costBps, maxHold })
    if (!result) return res.status(422).json({ error: `Not enough history for ${sym} to test the rule (${bars.length} daily bars)` })
    const body = { symbol: sym, ...result }
    _cache.set(key, { at: Date.now(), body })
    if (_cache.size > 500) _cache.delete(_cache.keys().next().value)
    res.json(body)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
