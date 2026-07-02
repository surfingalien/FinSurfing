'use strict'
/**
 * routes/strategy-lab.js
 *
 * POST /api/strategy-lab/propose  (requireAuth)
 * body: { symbol, range = '2y', initialCapital = 10000, count = 3 }
 *   symbol         — e.g. "AAPL", "BTC-USD"
 *   range          — '1y' | '2y' | '5y'
 *   initialCapital — number (default 10000)
 *   count          — proposals to request (1–5, default 3)
 *
 * Strategy Lab: the LLM proposes rule-based strategy configs (type + exact
 * params from the fixed catalog in lib/strategy-lab.js), grounded in the
 * symbol's COMPUTED TECHNICALS — then every proposal is validated by the
 * deterministic backtest engine (utils/backtest.js) over real historical
 * bars. All metrics in the response come from simulate(), never the model.
 * Re-run any proposal with full equity curve via POST /api/backtest.
 */

const express = require('express')
const { requireAuth } = require('../middleware/auth')
const { getRouter } = require('../lib/ai-router')
const { CircuitOpenError } = require('../lib/circuit-breaker')
const { fetchDailyBars } = require('../lib/internal-api')
const { compactTaLine } = require('../lib/technical-indicators')
const { buildProposalPrompt, parseProposals, evaluateProposals, MAX_PROPOSALS } = require('../lib/strategy-lab')

const router = express.Router()
const aiRouter = getRouter('strategy-lab')

const VALID_RANGES = ['1y', '2y', '5y']

router.post('/propose', requireAuth, async (req, res) => {
  const { symbol, range = '2y', initialCapital = 10000, count = 3 } = req.body || {}

  if (!symbol || typeof symbol !== 'string')
    return res.status(400).json({ error: 'symbol is required' })
  if (!VALID_RANGES.includes(range))
    return res.status(400).json({ error: `range must be one of: ${VALID_RANGES.join(', ')}` })

  const sym     = symbol.toUpperCase().replace(/[^A-Z0-9.-]/g, '')
  const capital = Math.max(100, Math.min(Number(initialCapital) || 10000, 10_000_000))
  const n       = Math.max(1, Math.min(Number(count) || 3, MAX_PROPOSALS))

  // Forward browser API keys so the internal chart fetch respects user keys
  const fwdHeaders = {}
  for (const h of ['x-aisa-key', 'x-finnhub-key', 'x-fmp-key', 'x-td-key', 'x-av-key']) {
    if (req.headers[h]) fwdHeaders[h] = req.headers[h]
  }

  const bars = await fetchDailyBars(sym, { range, headers: fwdHeaders, timeoutMs: 30_000 })
  if (bars.length < 60)
    return res.status(422).json({ error: `Insufficient price history for ${sym} (${bars.length} bars, need 60+)` })

  const timestamps = bars.map(b => Math.floor(b.t / 1000)) // simulate() expects unix seconds
  const closes     = bars.map(b => b.c)
  const taLine     = compactTaLine(
    sym,
    bars.map(b => b.o), bars.map(b => b.h), bars.map(b => b.l),
    closes, bars.map(b => b.v)
  )

  const prompt = buildProposalPrompt({ symbol: sym, range, taLine, count: n })

  let raw = '', llmUsed = 'claude'
  try {
    const result = await aiRouter.call({ prompt, maxTokens: 2048, symbols: [sym] })
    raw     = result.text
    llmUsed = result.llmUsed
  } catch (err) {
    if (err instanceof CircuitOpenError) return res.status(503).json({ error: err.message, circuitOpen: true })
    if (err.status === 503)             return res.status(503).json({ error: err.message })
    console.error('[strategy-lab]', err.message)
    return res.status(500).json({ error: 'Strategy proposal failed: ' + err.message })
  }

  const proposals = parseProposals(raw, n)
  if (!proposals.length) {
    console.error('[strategy-lab] No valid proposals in AI response:', raw.slice(0, 200))
    return res.status(502).json({ error: 'AI returned no valid strategy proposals — please try again' })
  }

  const evaluated = evaluateProposals(proposals, timestamps, closes, capital)

  return res.json({
    symbol: sym,
    range,
    initialCapital: capital,
    dataPoints: bars.length,
    taLine,
    llmUsed,
    proposals: evaluated,
  })
})

module.exports = router
