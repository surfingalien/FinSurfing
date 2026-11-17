'use strict'
/**
 * routes/inbound-alerts.js — alerts sent in by the user's own TradingView
 * (lib/inbound-alerts.js).
 *
 *   hook    POST /api/hooks/tradingview/:key   public — the key IS the credential
 *   manage  GET    /api/inbound-alerts         the user's address status + alerts
 *           POST   /api/inbound-alerts/key     create or rotate (key shown once)
 *           DELETE /api/inbound-alerts/key     switch the address off
 *           DELETE /api/inbound-alerts/:id     delete one alert
 *
 * The hook only records. It places no order, calls no model and runs nothing.
 * Tests: tests/inbound-alerts.test.js
 */
const express   = require('express')
const rateLimit = require('express-rate-limit')
const { requireAuth } = require('../middleware/auth')
const { appUrl } = require('../lib/app-url')
const IA = require('../lib/inbound-alerts')

// ── The hook ────────────────────────────────────────────────────────────────
const hook = express.Router()

// Per address, not per IP: TradingView posts from a handful of shared addresses,
// and one runaway alert must not be able to fill the store.
const perKey = rateLimit({
  windowMs: 60_000, max: 30, standardHeaders: true, legacyHeaders: false,
  keyGenerator: req => IA.hashKey(req.params.key || ''),
  message: { error: 'Too many alerts — wait a minute' },
})

hook.post('/:key', perKey, express.text({ type: () => true, limit: IA.MAX_BODY }), (req, res) => {
  const userId = IA.userForKey(req.params.key)
  // An unknown, rotated or malformed key: one plain answer, no detail.
  if (!userId) return res.status(404).json({ error: 'Not found' })
  // express.json (global) has already parsed a JSON body; a text body arrives as a string.
  const size = typeof req.body === 'string' ? Buffer.byteLength(req.body) : Buffer.byteLength(JSON.stringify(req.body ?? ''))
  if (size > IA.MAX_BODY) return res.status(413).json({ error: 'Alert too large' })
  const parsed = IA.parseAlert(req.body)
  if (parsed.error) return res.status(400).json({ error: parsed.error })
  const row = IA.record(userId, parsed)
  res.json({ ok: true, id: row.id, symbol: row.symbol })
})

// ── Management (signed in) ──────────────────────────────────────────────────
const manage = express.Router()
manage.use(requireAuth)
const keyLimit = rateLimit({ windowMs: 15 * 60_000, max: 10, message: { error: 'Too many key changes — wait a few minutes' } })

/** Where TradingView should post. APP_URL when the operator set it, else the address this request came in on. */
function baseUrl(req) {
  if (process.env.APP_URL) return appUrl()
  return `${req.protocol}://${req.get('host')}`
}

manage.get('/', (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 100, 1), IA.MAX_PER_USER)
  const symbol = req.query.symbol ? IA.normSymbol(String(req.query.symbol)) : null
  res.json({
    status: IA.keyStatus(req.user.userId),
    hookBase: `${baseUrl(req)}/api/hooks/tradingview/`,
    alerts: IA.list(req.user.userId, { limit, symbol }),
    recentDays: IA.RECENT_DAYS,
  })
})

manage.post('/key', keyLimit, (req, res) => {
  const { key, createdAt } = IA.rotateKey(req.user.userId)
  // The only time the key leaves the server. It cannot be read back later.
  res.json({ url: `${baseUrl(req)}/api/hooks/tradingview/${key}`, createdAt })
})

manage.delete('/key', (req, res) => res.json({ ok: IA.revokeKey(req.user.userId) }))

manage.delete('/:id', (req, res) => {
  if (!/^[a-f0-9]{12}$/.test(req.params.id)) return res.status(400).json({ error: 'Invalid id' })
  const ok = IA.remove(req.user.userId, req.params.id)
  res.status(ok ? 200 : 404).json(ok ? { ok: true } : { error: 'Not found' })
})

module.exports = { hook, manage }
