'use strict'
/**
 * routes/forecast.js
 *
 * GET /api/forecast/:symbol
 *   Calls the TimesFM Python microservice with the last 512 daily closes
 *   and returns 7d / 30d / 90d price forecasts with quantile uncertainty bands.
 *
 * Requires env var TIMESFM_URL (default http://localhost:8000).
 * If the microservice is unavailable the route returns 503 gracefully —
 * the UI treats forecast as optional and hides the panel on error.
 */

const express = require('express')
const router  = express.Router()

const TIMESFM_URL    = () => process.env.TIMESFM_URL || 'http://localhost:8000'
const CACHE_TTL_MS   = 15 * 60 * 1000   // 15-min — aligns with /api/chart cache
const TIMEOUT_MS     = 35_000            // model cold-start can take ~30s

const _cache = new Map()

// ── GET /api/forecast/:symbol ─────────────────────────────────────────────────
router.get('/:symbol', async (req, res) => {
  const sym = (req.params.symbol || '').trim().toUpperCase()
  if (!sym || !/^[A-Z0-9.\-^]{1,20}$/.test(sym))
    return res.status(400).json({ error: 'Valid symbol required' })

  // Serve stale cache immediately while fresh data is available
  const hit = _cache.get(sym)
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS)
    return res.json({ ...hit.data, cached: true })

  // Check that the microservice is even configured
  const svcUrl = TIMESFM_URL()
  if (!svcUrl)
    return res.status(503).json({ error: 'TimesFM service not configured (set TIMESFM_URL)' })

  try {
    // ── Step 1: fetch daily bars from internal chart endpoint ─────────────────
    const port     = process.env.PORT || 3001
    const chartRes = await fetch(
      `http://127.0.0.1:${port}/api/chart/${encodeURIComponent(sym)}?interval=1d&range=2y`,
      { signal: AbortSignal.timeout(15_000) }
    )
    if (!chartRes.ok) {
      const e = await chartRes.json().catch(() => ({}))
      return res.status(422).json({ error: e.error || 'Failed to fetch price history' })
    }

    const chartJson = await chartRes.json()
    const candles   = chartJson?.candles ?? []

    if (candles.length < 30)
      return res.status(422).json({ error: `Insufficient price history for ${sym} (${candles.length} bars, need ≥30)` })

    const closes = candles.map(c => c.close).filter(v => v != null && !isNaN(v))

    // ── Step 2: call TimesFM Python microservice ──────────────────────────────
    const tfRes = await fetch(`${svcUrl}/predict`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ symbol: sym, closes }),
      signal:  AbortSignal.timeout(TIMEOUT_MS),
    })

    if (!tfRes.ok) {
      const e = await tfRes.json().catch(() => ({}))
      return res.status(503).json({ error: e.detail || 'TimesFM inference failed' })
    }

    const tf = await tfRes.json()

    // ── Step 3: build response ────────────────────────────────────────────────
    const data = {
      symbol:       sym,
      currentPrice: tf.current_price,
      model:        tf.model,
      generatedAt:  new Date().toISOString(),
      forecasts:    tf.forecasts,   // { '7d': { point, p10, p50, p90, upside, range }, ... }
      series:       tf.series,      // 90 daily points for chart overlay
      inputBars:    closes.length,
    }

    _cache.set(sym, { ts: Date.now(), data })
    return res.json({ ...data, cached: false })

  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError')
      return res.status(504).json({ error: 'TimesFM request timed out — model may be warming up, retry in 30s' })

    console.error('[forecast]', sym, err.message)
    return res.status(503).json({ error: err.message })
  }
})

// ── GET /api/forecast/health — proxy microservice health ──────────────────────
router.get('/health/status', async (req, res) => {
  const svcUrl = TIMESFM_URL()
  if (!svcUrl) return res.json({ available: false, reason: 'TIMESFM_URL not set' })
  try {
    const r = await fetch(`${svcUrl}/health`, { signal: AbortSignal.timeout(5_000) })
    const d = await r.json()
    return res.json({ available: r.ok, ...d })
  } catch (e) {
    return res.json({ available: false, reason: e.message })
  }
})

module.exports = router
