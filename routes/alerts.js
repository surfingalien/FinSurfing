'use strict'
/**
 * routes/alerts.js
 *
 * Alert → AI trigger pipeline.
 *
 * GET  /api/alerts/stream
 *   SSE stream — client connects once; receives AI analysis events when alerts fire.
 *   Events: { type: 'analysis', symbol, signal, confidence, trend, entry, stopLoss,
 *             reasoning, triggeredBy: {type,threshold,price}, analyzedAt }
 *            { type: 'ping' }  — keepalive every 25s
 *
 * POST /api/alerts/trigger
 *   body: { symbol, alertType, threshold, price }
 *   Runs analyze_symbol in background, broadcasts result to all SSE clients.
 *   Returns immediately: { ok: true, queued: symbol }
 */

const express     = require('express')
const rateLimit   = require('express-rate-limit')
const broadcaster = require('../lib/alert-broadcaster')

const router = express.Router()

const triggerLimit = rateLimit({ windowMs: 60_000, max: 20 })

const BASE_URL = () => `http://127.0.0.1:${process.env.PORT || 3001}`

// ── SSE stream ────────────────────────────────────────────────────────────────

router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const clientId = broadcaster.subscribe(res)

  // Keepalive ping every 25s
  const hb = setInterval(() => {
    try { res.write('data: {"type":"ping"}\n\n') } catch { cleanup() }
  }, 25_000)

  function cleanup() {
    clearInterval(hb)
    broadcaster.unsubscribe(clientId)
  }

  req.on('close', cleanup)
})

// ── Trigger ───────────────────────────────────────────────────────────────────

router.post('/trigger', triggerLimit, async (req, res) => {
  const { symbol, alertType, threshold, price } = req.body || {}
  if (!symbol) return res.status(400).json({ error: 'symbol required' })

  res.json({ ok: true, queued: symbol.toUpperCase() })

  // Run analyze_symbol in background — don't block the HTTP response
  setImmediate(() => _runAnalysis({ symbol, alertType, threshold, price }, req))
})

async function _runAnalysis({ symbol, alertType, threshold, price }, req) {
  const sym = symbol.toUpperCase()
  try {
    // Forward user API keys if present
    const fwdHeaders = { 'Content-Type': 'application/json', 'x-internal': '1' }
    for (const k of ['x-aisa-key', 'x-finnhub-key', 'x-fmp-key', 'x-td-key', 'x-av-key']) {
      if (req?.headers?.[k]) fwdHeaders[k] = req.headers[k]
    }

    const r = await fetch(
      `${BASE_URL()}/api/trading-analysis/analyze`,
      { method: 'POST', headers: fwdHeaders, body: JSON.stringify({ symbol: sym, interval: 'D' }), signal: AbortSignal.timeout(30_000) }
    )
    const data = await r.json()
    const a = data.analysis

    broadcaster.broadcast({
      type:        'analysis',
      symbol:      sym,
      signal:      a?.signal,
      confidence:  a?.confidence,
      entry:       a?.entry,
      stopLoss:    a?.stopLoss,
      takeProfit:  a?.target,
      reasoning:   (a?.summary || '').slice(0, 300),
      risks:       a?.risks || [],
      triggeredBy: { type: alertType, threshold, price },
      analyzedAt:  new Date().toISOString(),
    })
  } catch (e) {
    broadcaster.broadcast({
      type:        'analysis_error',
      symbol:      sym,
      error:       e.message,
      triggeredBy: { type: alertType, threshold, price },
      analyzedAt:  new Date().toISOString(),
    })
  }
}

// POST /api/alerts/watchlist — sync client watchlist to server so hourly scan uses it
router.post('/watchlist', (req, res) => {
  const { symbols } = req.body || {}
  if (!Array.isArray(symbols)) return res.status(400).json({ error: 'symbols array required' })
  const clean = symbols
    .map(s => String(s).toUpperCase().replace(/[^A-Z0-9.-]/g, ''))
    .filter(Boolean)
    .slice(0, 50)
  try {
    const jobs = require('../lib/scheduled-jobs')
    jobs.setServerWatchlist(clean)
    res.json({ ok: true, synced: clean })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
