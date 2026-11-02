'use strict'
/**
 * /api/agent-desk — the supervised self-improvement loop (lib/agent-desk.js).
 *
 *   GET  /status                 signed in: switches, budget, ledger, last cycle,
 *                                proposals, strategy experiments, paper book, alerts
 *   GET  /log?limit=             signed in: the audit trail, newest first
 *   POST /run                    admin: run one cycle now (returns at once; the
 *                                page polls /status)
 *   POST /pause  {reason}        admin: stop at the next step
 *   POST /resume                 admin
 *   POST /proposals/:id/approve  admin {note}: apply exactly the stated effect
 *   POST /proposals/:id/reject   admin {note}
 *
 * The operator's env switches (AGENT_DESK_ENABLED, AGENT_MONTHLY_BUDGET_USD,
 * PAPER_TRADING_ENABLED and the paper limits) cannot be changed from here.
 */
const express = require('express')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const desk = require('../lib/agent-desk')
const opsAlerts = require('../lib/ops-alerts')

const router = express.Router()
router.use(requireAuth)

const who = req => req.user?.email || req.user?.userId || 'admin'

router.get('/status', (req, res) => {
  try {
    const st = desk.status()
    // Alerts computed live from the book and the desk; the data-feed alert
    // comes from the hourly job's probe (no network call on a page load).
    const pb = require('../lib/paper-broker')
    const live = opsAlerts.collectAlerts({ paper: pb.snapshot(), trades: pb.loadTrades(), desk: st })
    const feed = opsAlerts.currentAlerts().filter(a => a.key === 'data-feed')
    res.json({ ...st, alerts: [...feed, ...live] })
  } catch (e) { res.status(500).json({ error: e.message }) }
})

router.get('/log', (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100))
  res.json({ rows: desk.readLog().slice(-limit).reverse() })
})

router.post('/run', requireAdmin, (req, res) => {
  const blocked = desk.stopReason()
  if (blocked) return res.status(409).json({ error: `The desk will not run: ${blocked}` })
  if (desk.isRunning()) return res.status(409).json({ error: 'A cycle is already running' })
  desk.runCycle({ trigger: 'manual', by: who(req) }).catch(e => console.warn('[agent-desk] manual cycle failed:', e.message))
  res.status(202).json({ started: true })
})

router.post('/pause', requireAdmin, (req, res) => {
  res.json(desk.pause({ by: who(req), reason: req.body?.reason ?? null }))
})
router.post('/resume', requireAdmin, (req, res) => {
  res.json(desk.resume({ by: who(req) }))
})

for (const [path, decision] of [['approve', 'approved'], ['reject', 'rejected']]) {
  router.post(`/proposals/:id/${path}`, requireAdmin, (req, res) => {
    try { res.json(desk.decide(String(req.params.id), decision, { by: who(req), note: req.body?.note ?? null })) }
    catch (e) { res.status(e.status || 400).json({ error: e.message }) }
  })
}

module.exports = router
