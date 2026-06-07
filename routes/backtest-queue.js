'use strict'
/**
 * routes/backtest-queue.js
 *
 * Overnight backtest queue API.
 *
 * POST /api/backtest/queue          — enqueue a job
 * GET  /api/backtest/queue          — queue state (pending + running + completed count)
 * GET  /api/backtest/queue/results  — last N completed results (?limit=20)
 * DELETE /api/backtest/queue/:id    — cancel a pending job
 */

const express = require('express')
const rateLimit = require('express-rate-limit')
const queue = require('../lib/backtest-queue')

const router = express.Router()
const enqueueLimit = rateLimit({ windowMs: 60_000, max: 10 })

const VALID_STRATEGIES = ['sma_crossover', 'rsi_threshold', 'macd_signal', 'bb_reversion']
const VALID_RANGES     = ['1y', '2y', '5y']

router.post('/', enqueueLimit, (req, res) => {
  const { symbol, strategy, params = {}, range = '1y', initialCapital = 10000, label } = req.body || {}

  if (!symbol)                           return res.status(400).json({ error: 'symbol required' })
  if (!VALID_STRATEGIES.includes(strategy))
    return res.status(400).json({ error: `strategy must be one of: ${VALID_STRATEGIES.join(', ')}` })
  if (!VALID_RANGES.includes(range))
    return res.status(400).json({ error: `range must be one of: ${VALID_RANGES.join(', ')}` })

  try {
    const job = {
      symbol:         symbol.toUpperCase(),
      strategy,
      params,
      range,
      initialCapital: Math.max(100, Math.min(Number(initialCapital) || 10000, 10_000_000)),
      label:          label || `${symbol.toUpperCase()} ${strategy} ${range}`,
      requestedAt:    new Date().toISOString(),
    }
    const info = queue.enqueue(job)
    res.json({ ok: true, id: info.id, position: info.position, job })
  } catch (e) {
    res.status(503).json({ error: e.message })
  }
})

router.get('/', (req, res) => {
  res.json(queue.getQueue())
})

router.get('/results', (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 20, 100)
  res.json({ results: queue.getResults(limit) })
})

router.delete('/:id', (req, res) => {
  const removed = queue.cancel(req.params.id)
  if (!removed) return res.status(404).json({ error: 'Job not found or already running' })
  res.json({ ok: true })
})

module.exports = router
