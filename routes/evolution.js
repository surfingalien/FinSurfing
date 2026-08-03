'use strict'
/**
 * routes/evolution.js
 *
 * Observability + control for the AI Brain's evolution loop.
 *
 *   GET  /api/evolution/status     — library stats, top strategies, calibration
 *   GET  /api/evolution/strategies — the ranked strategy library
 *   POST /api/evolution/run        — (admin) trigger a cycle now
 *   GET  /api/evolution/paper      — paper portfolio + performance
 *   GET  /api/evolution/paper/trades — paper trade audit trail
 *   POST /api/evolution/paper/reset  — (admin) flatten the paper book
 *
 * Read endpoints are open (same posture as /api/ai-brain/learnings — they
 * expose only server-side aggregates). Anything that MUTATES state or spends
 * API budget requires admin.
 */

const express = require('express')
const router  = express.Router()

const { requireAuth, requireAdmin } = require('../middleware/auth')
const library       = require('../lib/strategy-library')
const learningStore = require('../lib/learning-store')
const paperBroker   = require('../lib/paper-broker')
const { fetchDailyBars } = require('../lib/internal-api')

// ── Status ────────────────────────────────────────────────────────────────────

router.get('/status', (req, res) => {
  try {
    const entries = library.readLibrary()
    res.json({
      available:   true,
      library:     library.libraryStats(entries),
      topStrategies: library.rankStrategies(entries, 10).map(e => ({
        id: e.id, symbol: e.symbol, strategy: e.strategy, params: e.params,
        fitness: e.fitness, generation: e.generation, status: e.status,
        lastValidatedAt: e.lastValidatedAt,
        lastAlpha:  e.validations?.[e.validations.length - 1]?.alpha  ?? null,
        lastSharpe: e.validations?.[e.validations.length - 1]?.sharpe ?? null,
      })),
      calibration: learningStore.getCalibration(),
      paper:       paperBroker.snapshot(),
    })
  } catch (e) {
    console.error('[evolution/status]', e.message)
    res.status(500).json({ available: false, error: e.message })
  }
})

router.get('/strategies', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 25, 1), 100)
  const includeRetired = req.query.includeRetired === '1'
  const all = library.readLibrary()
  const entries = includeRetired ? all : all.filter(e => e.status !== 'retired')
  res.json({
    count: entries.length,
    strategies: library.rankStrategies(entries, limit),
    stats: library.libraryStats(all),
  })
})

// Trigger a cycle on demand. Admin-only: it spends LLM + market-data budget.
router.post('/run', requireAuth, requireAdmin, (req, res) => {
  const { runEvolutionCycle } = require('../lib/brain-evolution')
  const skipDiscovery = req.body?.skipDiscovery === true
  // Fire-and-forget — a full cycle runs for minutes; don't hold the connection.
  runEvolutionCycle({ skipDiscovery })
    .catch(e => console.error('[evolution/run]', e.stack || e.message))
  res.json({ ok: true, status: 'running', message: 'Evolution cycle started. Poll GET /api/evolution/status.' })
})

// ── Paper portfolio ───────────────────────────────────────────────────────────

// Mark positions to market using the internal chart feed so equity/P&L are
// real rather than held at cost.
async function currentPrices(symbols) {
  const map = {}
  await Promise.all(symbols.map(async sym => {
    const bars = await fetchDailyBars(sym, { range: '1mo', timeoutMs: 8_000 })
    const last = bars.length ? bars[bars.length - 1].c : null
    if (last != null) map[sym] = last
  }))
  return map
}

router.get('/paper', async (req, res) => {
  try {
    const portfolio = paperBroker.loadPortfolio()
    const symbols   = Object.keys(portfolio.positions || {})
    const priceMap  = symbols.length ? await currentPrices(symbols).catch(() => ({})) : {}
    res.json(paperBroker.snapshot(priceMap))
  } catch (e) {
    console.error('[evolution/paper]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.get('/paper/trades', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500)
  const trades = paperBroker.loadTrades()
  res.json({
    count: trades.length,
    // Newest first; rejections included on purpose — a refused order is as
    // much a part of the audit trail as an executed one.
    trades: trades.slice(-limit).reverse(),
  })
})

router.post('/paper/reset', requireAuth, requireAdmin, (req, res) => {
  const cash = Math.max(1000, Math.min(Number(req.body?.cash) || paperBroker.STARTING_CASH, 10_000_000))
  const portfolio = paperBroker.reset(cash)
  res.json({ ok: true, portfolio })
})

module.exports = router
