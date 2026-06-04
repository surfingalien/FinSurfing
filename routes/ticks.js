'use strict'
/**
 * routes/ticks.js
 * Query stored tick data from QuestDB.
 *
 * GET /api/ticks/:symbol              — raw ticks
 * GET /api/ticks/:symbol/ohlcv        — OHLCV aggregated from ticks
 * GET /api/ticks/:symbol/latest       — latest stored price
 */

const express  = require('express')
const router   = express.Router()
const questdb  = require('../lib/questdb')

function notEnabled(res) {
  return res.status(503).json({
    error: 'Tick storage not configured — set QUESTDB_URL env var and redeploy',
    docs:  'https://questdb.io/docs/get-started/docker/',
  })
}

// GET /api/ticks/:symbol?from=<ms>&to=<ms>&limit=1000
router.get('/:symbol', async (req, res) => {
  if (!questdb.enabled) return notEnabled(res)

  const symbol = req.params.symbol.toUpperCase()
  const now    = Date.now()
  const from   = parseInt(req.query.from)  || now - 3_600_000   // default: 1h ago
  const to     = parseInt(req.query.to)    || now
  const limit  = Math.min(parseInt(req.query.limit) || 1000, 50_000)

  if (from >= to) return res.status(400).json({ error: 'from must be less than to' })

  const ticks = await questdb.queryTicks(symbol, from, to, limit)
  res.json({ symbol, from, to, count: ticks.length, ticks })
})

// GET /api/ticks/:symbol/ohlcv?interval=60&from=<ms>&to=<ms>
router.get('/:symbol/ohlcv', async (req, res) => {
  if (!questdb.enabled) return notEnabled(res)

  const symbol   = req.params.symbol.toUpperCase()
  const now      = Date.now()
  const from     = parseInt(req.query.from)     || now - 3_600_000
  const to       = parseInt(req.query.to)       || now
  const interval = Math.max(parseInt(req.query.interval) || 60, 1)   // seconds, min 1s

  const ohlcv = await questdb.queryOHLCV(symbol, interval, from, to)
  res.json({ symbol, interval, from, to, count: ohlcv.length, ohlcv })
})

// GET /api/ticks/:symbol/latest
router.get('/:symbol/latest', async (req, res) => {
  if (!questdb.enabled) return notEnabled(res)

  const symbol = req.params.symbol.toUpperCase()
  const prices = await questdb.queryLatestPrices([symbol])
  const price  = prices[symbol] ?? null

  if (price == null) return res.status(404).json({ error: `No tick data found for ${symbol}` })
  res.json({ symbol, price })
})

module.exports = router
