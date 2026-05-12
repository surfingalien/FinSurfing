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
const { simulate } = require('../utils/backtest')

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

  // Fetch OHLCV from Yahoo Finance (reusing internal proxy logic)
  try {
    const yahooUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=${rangeMap[range]}&interval=1d&events=div,splits`
    const ctrl     = new AbortController()
    const timer    = setTimeout(() => ctrl.abort(), 15_000)

    let yahooData
    try {
      const r = await fetch(yahooUrl, {
        signal: ctrl.signal,
        headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' },
      })
      yahooData = await r.json()
    } finally {
      clearTimeout(timer)
    }

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
    if (err.name === 'AbortError')
      return res.status(504).json({ error: 'Yahoo Finance request timed out' })
    console.error('[backtest]', err.message)
    return res.status(500).json({ error: 'Backtest failed: ' + err.message })
  }
})

module.exports = router
