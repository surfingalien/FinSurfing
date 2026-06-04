'use strict'
/**
 * routes/quant.js
 * Proxy to the Python quant sidecar (python-sidecar/).
 *
 * GET /api/quant/health
 * GET /api/quant/indicators?symbol=AAPL
 * GET /api/quant/risk?symbols=AAPL,MSFT,GOOGL
 * GET /api/quant/greeks?symbol=AAPL&option_type=call&strike=200&expiry=2025-12-19
 * GET /api/quant/ratios?symbol=AAPL
 *
 * Set QUANT_SIDECAR_URL env var to point to the deployed sidecar.
 * Falls back gracefully with 503 when sidecar is not running.
 */

const express   = require('express')
const router    = express.Router()
const rateLimit = require('express-rate-limit')

const SIDECAR_URL = (process.env.QUANT_SIDECAR_URL || 'http://127.0.0.1:5001').replace(/\/$/, '')

const quantLimit = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { error: 'Quant rate limit — wait a minute' },
})

async function proxy(path, res) {
  try {
    const r = await fetch(`${SIDECAR_URL}${path}`, {
      headers: { Accept: 'application/json' },
      signal:  AbortSignal.timeout(45_000),
    })
    const data = await r.json()
    res.status(r.status).json(data)
  } catch (e) {
    if (e.name === 'AbortError' || e.message?.includes('timeout'))
      return res.status(504).json({ error: 'Quant sidecar timed out' })
    if (e.cause?.code === 'ECONNREFUSED' || e.message?.includes('ECONNREFUSED'))
      return res.status(503).json({
        error: 'Quant sidecar unavailable',
        hint:  'Set QUANT_SIDECAR_URL and ensure python-sidecar/ is deployed',
      })
    res.status(503).json({ error: `Sidecar error: ${e.message}` })
  }
}

router.get('/health',     (req, res) => proxy('/health', res))

router.get('/indicators', quantLimit, (req, res) =>
  proxy(`/indicators?${new URLSearchParams(req.query)}`, res))

router.get('/risk',       quantLimit, (req, res) =>
  proxy(`/risk?${new URLSearchParams(req.query)}`, res))

router.get('/greeks',     quantLimit, (req, res) =>
  proxy(`/greeks?${new URLSearchParams(req.query)}`, res))

router.get('/ratios',     quantLimit, (req, res) =>
  proxy(`/ratios?${new URLSearchParams(req.query)}`, res))

module.exports = router
