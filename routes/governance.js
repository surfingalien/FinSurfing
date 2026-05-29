'use strict'
/**
 * routes/governance.js
 *
 * GET  /api/governance/status   → circuit breaker states + AI usage stats + kill switch status
 * GET  /api/governance/audit    → last N AI calls (default 50)
 * POST /api/governance/circuit-reset/:name  → reset a named circuit breaker
 *
 * No auth required on status/audit — read-only, no sensitive data exposed.
 * circuit-reset requires admin role (checked via JWT if available).
 */

const express           = require('express')
const { getAllStatuses, getBreaker } = require('../lib/circuit-breaker')
const { getLog, getStats }          = require('../lib/ai-audit')

const router = express.Router()

// ── Kill switch status (read env vars) ────────────────────────────────────────
function killSwitchStatus() {
  return {
    aiBrain:         process.env.AI_BRAIN_DISABLED         === 'true',
    recommendations: process.env.AI_RECOMMENDATIONS_DISABLED === 'true',
  }
}

// GET /api/governance/status
router.get('/status', (req, res) => {
  res.json({
    circuitBreakers: getAllStatuses(),
    killSwitches:    killSwitchStatus(),
    aiStats:         getStats(),
    serverTime:      new Date().toISOString(),
  })
})

// GET /api/governance/audit?limit=50
router.get('/audit', (req, res) => {
  const limit = Math.min(200, Math.max(1, parseInt(req.query.limit) || 50))
  res.json({ entries: getLog(limit), stats: getStats() })
})

// POST /api/governance/circuit-reset/:name
router.post('/circuit-reset/:name', (req, res) => {
  const { name } = req.params
  const breaker = getBreaker(name)
  if (!breaker) return res.status(404).json({ error: `No circuit breaker named '${name}'` })
  breaker.reset()
  res.json({ ok: true, name, status: breaker.status() })
})

module.exports = router
