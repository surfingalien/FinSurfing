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
 * Every endpoint requires sign-in: the paper book, its trade trail and the
 * strategy library are the system's own record, not public data. Anything
 * that MUTATES state or spends API budget also requires admin.
 */

const express = require('express')
const router  = express.Router()

const { requireAuth, requireAdmin } = require('../middleware/auth')
const library       = require('../lib/strategy-library')
const learningStore = require('../lib/learning-store')
const paperBroker   = require('../lib/paper-broker')
const { fetchDailyBars } = require('../lib/internal-api')
const durableFiles  = require('../lib/durable-files')

// ── Status ────────────────────────────────────────────────────────────────────

router.get('/status', requireAuth, (req, res) => {
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
      // Whether the stores above survive a deploy. enabled:false in production
      // means every number on this page resets at the next deploy.
      persistence: durableFiles.status(),
    })
  } catch (e) {
    console.error('[evolution/status]', e.message)
    res.status(500).json({ available: false, error: e.message })
  }
})

router.get('/strategies', requireAuth, (req, res) => {
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

// ── Factor library (lib/factor-mining.js) ────────────────────────────────────

/** The last mining run without the stored cross-sections (they are for lookups). */
function factorSummary(lib) {
  if (!lib) return null
  const { factors = [], ...rest } = lib
  return { ...rest, factors: factors.map(({ latest, ...f }) => ({ ...f, latestAsOf: latest?.asOf ?? null })) }
}

router.get('/factors', requireAuth, (req, res) => {
  res.json({ library: factorSummary(require('../lib/factor-mining').readLibrary()) })
})

// Admin-only: fetches five years of bars for ~70 names.
router.post('/factors/run', requireAuth, requireAdmin, (req, res) => {
  const fm = require('../lib/factor-mining')
  fm.runMining({
    // Uses the stored filing-change fingerprints; the weekly job refreshes them.
    filingSims: require('../lib/filing-change').simsBySymbol(),
    fetchBars:  s => fetchDailyBars(s, { range: '5y', headers: { 'x-internal': '1' }, timeoutMs: 25_000 }),
    fetchFacts: s => require('../lib/sec-facts').getCompanyFacts(s),
    propose: process.env.ANTHROPIC_API_KEY || process.env.GROQ_API_KEY
      ? ({ existing }) => require('../lib/factor-dsl').proposeFactors({ router: require('../lib/ai-router').getRouter('factor-mining'), existing })
      : null,
  })
    .then(lib => console.log(`[evolution/factors] mined ${lib.tested} factors over ${lib.universe} names: admitted ${lib.admitted.join(', ') || 'none'}`))
    .catch(e => console.error('[evolution/factors]', e.stack || e.message))
  res.json({ ok: true, status: 'running', message: 'Factor mining started. Poll GET /api/evolution/factors.' })
})

// ── Post-earnings drift study (lib/pead.js) ─────────────────────────────────

router.get('/pead', requireAuth, (req, res) => {
  res.json({ study: require('../lib/pead').readStudy() })
})

// Admin-only: five years of bars + earnings history (+ recent transcripts) for ~70 names.
router.post('/pead/run', requireAuth, requireAdmin, (req, res) => {
  const fmp = require('../lib/fmp')
  const secFacts = require('../lib/sec-facts')
  const hasFmp = !!process.env.FMP_API_KEY
  require('../lib/pead').runStudy({
    universe:         require('../lib/factor-mining').defaultUniverse(),
    fetchBars:        s => fetchDailyBars(s, { range: '5y', headers: { 'x-internal': '1' }, timeoutMs: 25_000 }),
    fetchSurprises:   hasFmp ? s => fmp.earningsSurprises(s, { limit: 20 }) : null,
    fetchEps:         s => secFacts.getCompanyFacts(s).then(secFacts.epsQuarters),
    fetchTranscripts: hasFmp ? (s, n) => fmp.transcripts(s, { limit: n, timeoutMs: 15_000 }) : null,
  })
    .then(st => console.log(`[evolution/pead] ${st.events} events — long-beats ${st.strategy.verdict}`))
    .catch(e => console.error('[evolution/pead]', e.stack || e.message))
  res.json({ ok: true, status: 'running', message: 'Drift study started. Poll GET /api/evolution/pead.' })
})

// ── 13F holdings changes (lib/thirteenf.js) ─────────────────────────────────

router.get('/13f', requireAuth, (req, res) => {
  const t = require('../lib/thirteenf')
  const store = t.readStore()
  const sym = String(req.query.symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '')
  if (!store) return res.json({ store: null })
  const { cusipMap, bySymbol, ...meta } = store
  res.json(sym ? { ...meta, symbol: sym, rows: bySymbol[sym] || [], summary: t.describeFor(sym, store) } : { ...meta, symbols: Object.keys(bySymbol).length })
})

router.post('/13f/run', requireAuth, requireAdmin, (req, res) => {
  require('../lib/thirteenf').refresh()
    .then(s => console.log(`[evolution/13f] ${s.managers.length} managers, ${Object.keys(s.bySymbol).length} symbols`))
    .catch(e => console.error('[evolution/13f]', e.message))
  res.json({ ok: true, status: 'running', message: '13F refresh started (a few minutes). Poll GET /api/evolution/13f.' })
})

// ── Insider buying study (lib/insider-buys.js) ──────────────────────────────

router.get('/insiders', requireAuth, (req, res) => {
  const ib = require('../lib/insider-buys')
  const sym = String(req.query.symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '')
  res.json(sym ? { symbol: sym, recent: ib.recentFor(sym, { days: 365 }) } : { study: ib.readStudy() })
})

router.post('/insiders/run', requireAuth, requireAdmin, (req, res) => {
  const { fetchDailyBars } = require('../lib/internal-api')
  require('../lib/insider-buys').runStudy({ fetchBars: sym => fetchDailyBars(sym, { range: '5y', headers: { 'x-internal': '1' }, timeoutMs: 25_000 }) })
    .then(s => console.log(`[evolution/insiders] ${s.purchases} purchases, opportunistic ${s.strategies.opportunistic.verdict}, cluster ${s.strategies.cluster.verdict}`))
    .catch(e => console.error('[evolution/insiders]', e.message))
  res.json({ ok: true, status: 'running', message: 'Insider study started (the first run downloads ~24 quarters of SEC data). Poll GET /api/evolution/insiders.' })
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

router.get('/paper', requireAuth, async (req, res) => {
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

router.get('/paper/trades', requireAuth, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 500)
  const trades = paperBroker.loadTrades()
  res.json({
    count: trades.length,
    // Newest first; rejections included on purpose — a refused order is as
    // much a part of the audit trail as an executed one.
    trades: trades.slice(-limit).reverse(),
  })
})

// Positions opened before brackets existed can never exit. Give each one
// technical reference levels from its own bars (lib/trade-levels.js: stop
// below support/ATR, booking at 1.5R and 3R) instead of resetting the book.
router.post('/paper/adopt-brackets', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { levelInputs, tradeLevels } = require('../lib/trade-levels')
    const symbols = paperBroker.unmanagedPositions(paperBroker.loadPortfolio())
    const proposals = {}
    await Promise.all(symbols.map(async sym => {
      const li = levelInputs(await fetchDailyBars(sym, { range: '6mo', timeoutMs: 10_000 }))
      const plan = li && tradeLevels(li)
      if (plan) proposals[sym] = { price: li.price, bracket: { stop: plan.stop.price, t1: plan.booking[0].price, t2: plan.booking[1].price } }
    }))
    res.json({ ok: true, ...paperBroker.adoptUnmanaged(proposals) })
  } catch (e) {
    console.error('[evolution/paper/adopt-brackets]', e.message)
    res.status(500).json({ error: e.message })
  }
})

router.post('/paper/reset', requireAuth, requireAdmin, (req, res) => {
  const cash = Math.max(1000, Math.min(Number(req.body?.cash) || paperBroker.STARTING_CASH, 10_000_000))
  const portfolio = paperBroker.reset(cash)
  res.json({ ok: true, portfolio })
})

module.exports = router
