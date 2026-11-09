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
const { simulate, optimizeStrategy, costBpsForSymbol } = require('../utils/backtest')
const { runPortfolioBacktest } = require('../utils/portfolio-backtest')

const router = express.Router()

const VALID_STRATEGIES = ['sma_crossover', 'rsi_threshold', 'macd_signal', 'bb_reversion', 'donchian_breakout', 'range_breakout_atr', 'adx_trend']
const VALID_RANGES     = ['1y', '2y', '5y']

// Execution model for a request: next-bar fills and the asset class's
// round-trip cost unless the caller asks otherwise (costBps clamped 0-200;
// fill 'close' reproduces the legacy same-bar fills for comparison).
// Optional execution model (lib/execution-model.js): body.slippage {model:'range'|'impact', rangeK, coef,
// maxParticipation} and body.exits {stopPct|stopAtr, t1Pct|t1Atr, targetPct|targetAtr, trailPct, maxHoldBars}.
// Every number is clamped to a sane range; anything else is ignored.
const clampNum = (v, lo, hi) => { const x = Number(v); return Number.isFinite(x) && x > 0 ? Math.max(lo, Math.min(hi, x)) : undefined }
function slippageFrom(b) {
  if (!b || typeof b !== 'object') return undefined
  const model = ['range', 'impact'].includes(b.model) ? b.model : null
  const maxParticipation = clampNum(b.maxParticipation, 0.001, 1)
  if (!model && !maxParticipation) return undefined
  return { model: model || 'none', rangeK: clampNum(b.rangeK, 0.001, 1), coef: clampNum(b.coef, 0.01, 5), maxParticipation }
}
function exitsFrom(b) {
  if (!b || typeof b !== 'object') return undefined
  const e = {
    stopPct: clampNum(b.stopPct, 0.1, 50), t1Pct: clampNum(b.t1Pct, 0.1, 500), targetPct: clampNum(b.targetPct, 0.1, 500),
    stopAtr: clampNum(b.stopAtr, 0.1, 20), t1Atr: clampNum(b.t1Atr, 0.1, 50), targetAtr: clampNum(b.targetAtr, 0.1, 50),
    trailPct: clampNum(b.trailPct, 0.1, 50), maxHoldBars: clampNum(b.maxHoldBars, 1, 1000),
  }
  for (const k of Object.keys(e)) if (e[k] === undefined) delete e[k]
  return Object.keys(e).length ? e : undefined
}
const barsOf = pairs => ({ opens: pairs.map(p => p.o), highs: pairs.map(p => p.h), lows: pairs.map(p => p.l), volumes: pairs.map(p => p.v) })
function executionFor(body, sym, bars) {
  const c = Number(body?.costBps)
  const out = {
    costBps: Number.isFinite(c) ? Math.max(0, Math.min(200, c)) : costBpsForSymbol(sym),
    fill:    body?.fill === 'close' ? 'close' : 'next',
    opens:   bars.opens,
    // highs/lows feed the breakout/ADX signals; on their own they change nothing in the simulation
    highs:   bars.highs,
    lows:    bars.lows,
  }
  const slippage = slippageFrom(body?.slippage), exits = exitsFrom(body?.exits)
  if (slippage || exits) Object.assign(out, { volumes: bars.volumes }, slippage ? { slippage } : {}, exits ? { exits } : {})
  return out
}

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
      .map((t, i) => ({ t, c: ohlcv.close[i], o: ohlcv.open?.[i], h: ohlcv.high?.[i], l: ohlcv.low?.[i], v: ohlcv.volume?.[i] }))
      .filter(p => p.c != null && !isNaN(p.c))

    if (pairs.length < 30)
      return res.status(422).json({ error: `Not enough valid closes for ${sym}` })

    const ts     = pairs.map(p => p.t)
    const closes = pairs.map(p => p.c)

    const backtestResult = simulate(ts, closes, strategy, params, capital, executionFor(req.body, sym, barsOf(pairs)))

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

    const pairs  = timestamps.map((t, i) => ({ t, c: ohlcv.close[i], o: ohlcv.open?.[i], h: ohlcv.high?.[i], l: ohlcv.low?.[i], v: ohlcv.volume?.[i] })).filter(p => p.c != null && !isNaN(p.c))
    const ts     = pairs.map(p => p.t)
    const closes = pairs.map(p => p.c)

    // NOTE: the optimizer ranks many configs on one history — its top result
    // is in-sample by construction. Strategy Lab's two-window verdict is the
    // honest check for a config picked here.
    const results = optimizeStrategy(ts, closes, strategy, paramRanges, capital, sortBy, 50, executionFor(req.body, sym, barsOf(pairs)))
    return res.json({ symbol: sym, strategy, range, combinations: combos, results })
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError')
      return res.status(504).json({ error: 'Market data request timed out' })
    console.error('[backtest/optimize]', err.message)
    return res.status(500).json({ error: 'Optimization failed: ' + err.message })
  }
})

// ── Portfolio backtest ────────────────────────────────────────────────────────
// POST /api/backtest/portfolio
// body: { symbols: ['AAPL','MSFT'] | [{symbol,weight}], range, initialCapital,
//         rebalance: 'none'|'monthly'|'quarterly'|'threshold', thresholdPct,
//         stopLossPct, takeProfitPct, commissionPct }
router.post('/portfolio', async (req, res) => {
  const {
    symbols, range = '1y', initialCapital = 10000,
    rebalance = 'monthly', thresholdPct, stopLossPct, takeProfitPct, commissionPct,
  } = req.body

  const list = Array.isArray(symbols) ? symbols.slice(0, 15) : []
  const parsed = list.map(x => typeof x === 'string'
    ? { symbol: x, weight: null }
    : { symbol: x?.symbol, weight: x?.weight ?? null })
    .map(x => ({ ...x, symbol: String(x.symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '') }))
    .filter(x => x.symbol)
  if (parsed.length < 2)
    return res.status(400).json({ error: 'symbols: at least 2 required (max 15)' })
  if (!VALID_RANGES.includes(range))
    return res.status(400).json({ error: `range must be one of: ${VALID_RANGES.join(', ')}` })
  if (!['none', 'monthly', 'quarterly', 'threshold'].includes(rebalance))
    return res.status(400).json({ error: 'rebalance must be none|monthly|quarterly|threshold' })

  const capital = Math.max(100, Math.min(Number(initialCapital) || 10000, 10_000_000))

  try {
    const port = process.env.PORT || 3001
    const fwdHeaders = {}
    for (const h of ['x-aisa-key','x-finnhub-key','x-fmp-key','x-td-key','x-av-key']) {
      if (req.headers[h]) fwdHeaders[h] = req.headers[h]
    }

    const seriesBySymbol = {}
    await Promise.all(parsed.map(async ({ symbol }) => {
      const r = await fetch(
        `http://127.0.0.1:${port}/api/chart?symbol=${encodeURIComponent(symbol)}&interval=1d&range=${range}`,
        { headers: fwdHeaders, signal: AbortSignal.timeout(30_000) }
      )
      const data   = await r.json()
      const result = data?.chart?.result?.[0]
      const ts     = result?.timestamp || []
      const cl     = result?.indicators?.quote?.[0]?.close || []
      seriesBySymbol[symbol] = ts.map((t, i) => ({
        date: new Date(t * 1000).toISOString().slice(0, 10), close: cl[i],
      })).filter(p => p.close != null && !isNaN(p.close))
    }))

    const missing = parsed.filter(p => (seriesBySymbol[p.symbol] || []).length < 30).map(p => p.symbol)
    if (missing.length)
      return res.status(422).json({ error: `Insufficient price history for: ${missing.join(', ')}` })

    const weights = parsed.some(p => p.weight != null)
      ? Object.fromEntries(parsed.map(p => [p.symbol, p.weight ?? 0]))
      : null

    const result = runPortfolioBacktest({
      seriesBySymbol, weights, initialCapital: capital,
      rebalance, thresholdPct, stopLossPct, takeProfitPct, commissionPct,
    })
    if (result.error) return res.status(422).json(result)
    return res.json({ range, initialCapital: capital, ...result })
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError')
      return res.status(504).json({ error: 'Market data request timed out' })
    console.error('[backtest/portfolio]', err.message)
    return res.status(500).json({ error: 'Portfolio backtest failed: ' + err.message })
  }
})

module.exports = router
