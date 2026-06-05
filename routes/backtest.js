'use strict'
/**
 * routes/backtest.js
 *
 * POST /api/backtest
 * body: { symbol, strategy, params, range, initialCapital }
 *   symbol        — e.g. "AAPL"
 *   strategy      — 'sma_crossover' | 'rsi_threshold' | 'macd_signal' | 'bb_reversion'
 *   params        — strategy-specific params (see utils/backtest.js)
 *   range         — '1y' | '2y' | '5y' (default '1y')
 *   initialCapital — number (default 10000)
 */

const express = require('express')
const { simulate, optimizeStrategy } = require('../utils/backtest')

const router = express.Router()

const VALID_STRATEGIES = ['sma_crossover', 'rsi_threshold', 'macd_signal', 'bb_reversion']
const VALID_RANGES     = ['1y', '2y', '5y']

router.post('/', async (req, res) => {
  const { symbol, strategy, params = {}, range = '1y', initialCapital = 10000 } = req.body

  if (!symbol || typeof symbol !== 'string')
    return res.status(400).json({ error: 'symbol is required' })
  if (!VALID_STRATEGIES.includes(strategy))
    return res.status(400).json({ error: `strategy must be one of: ${VALID_STRATEGIES.join(', ')}` })
  if (!VALID_RANGES.includes(range))
    return res.status(400).json({ error: `range must be one of: ${VALID_RANGES.join(', ')}` })

  const capital = Math.max(100, Math.min(Number(initialCapital) || 10000, 10_000_000))
  const sym     = symbol.toUpperCase().replace(/[^A-Z0-9.-]/g, '')
  const rangeMap = { '1y': '1y', '2y': '2y', '5y': '5y' }

  // Fetch OHLCV via internal /api/chart proxy (AISA → Finnhub → FMP cascade)
  // Forward any API-key headers the browser sent so user keys are respected.
  try {
    const port    = process.env.PORT || 3001
    const fwdHeaders = {}
    for (const h of ['x-aisa-key','x-finnhub-key','x-fmp-key','x-td-key','x-av-key']) {
      if (req.headers[h]) fwdHeaders[h] = req.headers[h]
    }
    const r       = await fetch(
      `http://127.0.0.1:${port}/api/chart?symbol=${encodeURIComponent(sym)}&interval=1d&range=${rangeMap[range]}`,
      { headers: fwdHeaders, signal: AbortSignal.timeout(30_000) }
    )
    const yahooData = await r.json()
    const result    = yahooData?.chart?.result?.[0]
    const timestamps = result?.timestamp
    const ohlcv      = result?.indicators?.quote?.[0]

    if (!timestamps || !ohlcv?.close || timestamps.length < 30)
      return res.status(422).json({ error: `Insufficient price history for ${sym}` })

    // Strip null closes
    const pairs = timestamps
      .map((t, i) => ({ t, c: ohlcv.close[i] }))
      .filter(p => p.c != null && !isNaN(p.c))

    if (pairs.length < 30)
      return res.status(422).json({ error: `Not enough valid closes for ${sym}` })

    const ts     = pairs.map(p => p.t)
    const closes = pairs.map(p => p.c)

    const backtestResult = simulate(ts, closes, strategy, params, capital)

    return res.json({
      symbol:    sym,
      strategy,
      range,
      initialCapital: capital,
      dataPoints: pairs.length,
      ...backtestResult,
    })
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError')
      return res.status(504).json({ error: 'Market data request timed out' })
    console.error('[backtest]', err.message)
    return res.status(500).json({ error: 'Backtest failed: ' + err.message })
  }
})

// ── Strategy optimizer ────────────────────────────────────────────────────────
// POST /api/backtest/optimize
// body: { symbol, strategy, paramRanges, range, initialCapital, sortBy }
// paramRanges: { fastPeriod: { min:5, max:30, step:5 }, ... }
// Max ~2000 combinations per call to avoid runaway CPU.
router.post('/optimize', async (req, res) => {
  const { symbol, strategy, paramRanges = {}, range = '1y', initialCapital = 10000, sortBy = 'sharpeRatio' } = req.body

  if (!symbol || typeof symbol !== 'string')
    return res.status(400).json({ error: 'symbol is required' })
  if (!VALID_STRATEGIES.includes(strategy))
    return res.status(400).json({ error: `strategy must be one of: ${VALID_STRATEGIES.join(', ')}` })

  // Guard against combinatorial explosion
  const combos = Object.values(paramRanges).reduce((acc, { min, max, step }) => {
    const n = Math.max(1, Math.ceil((max - min) / step) + 1)
    return acc * n
  }, 1)
  if (combos > 3000)
    return res.status(400).json({ error: `Too many combinations (${combos}). Reduce ranges or increase step.` })

  const capital = Math.max(100, Math.min(Number(initialCapital) || 10000, 10_000_000))
  const sym     = symbol.toUpperCase().replace(/[^A-Z0-9.-]/g, '')

  try {
    const port       = process.env.PORT || 3001
    const fwdHeaders = {}
    for (const h of ['x-aisa-key','x-finnhub-key','x-fmp-key','x-td-key','x-av-key']) {
      if (req.headers[h]) fwdHeaders[h] = req.headers[h]
    }
    const r        = await fetch(
      `http://127.0.0.1:${port}/api/chart?symbol=${encodeURIComponent(sym)}&interval=1d&range=${range}`,
      { headers: fwdHeaders, signal: AbortSignal.timeout(30_000) }
    )
    const yahooData = await r.json()
    const result    = yahooData?.chart?.result?.[0]
    const timestamps = result?.timestamp
    const ohlcv      = result?.indicators?.quote?.[0]

    if (!timestamps || !ohlcv?.close || timestamps.length < 30)
      return res.status(422).json({ error: `Insufficient price history for ${sym}` })

    const pairs  = timestamps.map((t, i) => ({ t, c: ohlcv.close[i] })).filter(p => p.c != null && !isNaN(p.c))
    const ts     = pairs.map(p => p.t)
    const closes = pairs.map(p => p.c)

    const results = optimizeStrategy(ts, closes, strategy, paramRanges, capital, sortBy)
    return res.json({ symbol: sym, strategy, range, combinations: combos, results })
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError')
      return res.status(504).json({ error: 'Market data request timed out' })
    console.error('[backtest/optimize]', err.message)
    return res.status(500).json({ error: 'Optimization failed: ' + err.message })
  }
})

module.exports = router
