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
const { fetchDailyBars } = require('../lib/internal-api')
const router  = express.Router()
const { requireAuth } = require('../middleware/auth')

const TIMESFM_URL    = () => process.env.TIMESFM_URL || 'http://localhost:8000'
const CACHE_TTL_MS   = 15 * 60 * 1000   // 15-min — aligns with /api/chart cache
const TIMEOUT_MS     = 35_000            // model cold-start can take ~30s

const _cache = new Map()

// ── GET /api/forecast/:symbol ─────────────────────────────────────────────────
// Sign-in only: AI and scan results are not for anonymous visitors.
router.get('/:symbol', requireAuth, async (req, res) => {
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
    // ── Step 1: daily bars via the shared internal chart helper ───────────────
    // This used to fetch /api/chart/<SYM> (no such route — the chart takes
    // ?symbol=) and read a `candles` field the chart never returns, so every
    // forecast failed before reaching TimesFM.
    const bars = await fetchDailyBars(sym, { range: '2y', headers: { 'x-internal': '1' }, timeoutMs: 15_000 })
    if (bars.length < 30)
      return res.status(422).json({ error: `Insufficient price history for ${sym} (${bars.length} bars, need ≥30)` })

    const closes = bars.map(b => b.c).filter(v => v != null && !isNaN(v))

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

    // The bars helper never throws, so a network failure here is TimesFM itself.
    if (err.message === 'fetch failed')
      return res.status(503).json({ error: `TimesFM service unreachable at ${TIMESFM_URL()} — set TIMESFM_URL to a running instance` })
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
