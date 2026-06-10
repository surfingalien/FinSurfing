'use strict'
/**
 * routes/symbols.js
 *
 * Symbol metadata backed by lib/symbol-db.js (FinanceDatabase snapshot).
 *
 * GET  /api/symbols/stats              — snapshot freshness + per-class counts
 * GET  /api/symbols/classify/:symbol   — asset class + sector/category metadata
 * GET  /api/symbols/search?q=&limit=   — symbol/name search across classes
 * GET  /api/symbols/sectors            — equity sectors with counts
 * GET  /api/symbols/universe?sector=&size=&minCap= — top-cap equities per sector
 * POST /api/symbols/refresh            — re-download the snapshot (requireAuth)
 */

const express = require('express')
const router  = express.Router()
const { requireAuth } = require('../middleware/auth')
const symbolDb = require('../lib/symbol-db')

router.get('/stats', (req, res) => {
  res.json(symbolDb.stats())
})

router.get('/classify/:symbol', (req, res) => {
  const rec = symbolDb.classify(req.params.symbol)
  if (!rec) return res.status(404).json({ error: 'symbol not found', symbol: req.params.symbol })
  res.json(rec)
})

router.get('/search', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 50)
  res.json(symbolDb.search(req.query.q || '', limit))
})

router.get('/sectors', (req, res) => {
  res.json(symbolDb.listSectors())
})

router.get('/universe', (req, res) => {
  const { sector, minCap } = req.query
  if (!sector) return res.status(400).json({ error: 'sector query param required' })
  const size = Math.min(parseInt(req.query.size) || 25, 100)
  res.json({ sector, symbols: symbolDb.sectorUniverse(sector, { size, minCap }) })
})

router.post('/refresh', requireAuth, async (req, res) => {
  try {
    const result = await symbolDb.refresh()
    res.json(result)
  } catch (err) {
    console.error('[symbols] refresh error:', err.message)
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
