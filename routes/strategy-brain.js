'use strict'
/**
 * /api/strategy-brain — the autonomous strategy researcher (lib/strategy-brain.js).
 *   GET  /status   signed in: switch, arms with what each has earned, strategies it found, recent runs
 *   POST /run      admin: start a run now (returns at once; the page polls /status)
 *   POST /pause    admin: stop before the next experiment
 *   POST /resume   admin
 * STRATEGY_BRAIN_ENABLED and the shared AI budget are the operator's env vars; nothing here changes them.
 */
const express = require('express')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const brain = require('../lib/strategy-brain')

const router = express.Router()
router.use(requireAuth)
const who = req => req.user?.email || req.user?.userId || 'admin'

router.get('/status', (req, res) => {
  try { res.json(brain.status()) } catch (e) { res.status(500).json({ error: e.message }) }
})
router.post('/run', requireAdmin, (req, res) => {
  const blocked = brain.stopReason()
  if (blocked) return res.status(409).json({ error: `The Strategy Brain will not run: ${blocked}` })
  if (brain.isRunning()) return res.status(409).json({ error: 'A run is already in progress' })
  brain.run({ trigger: 'manual', by: who(req) }).catch(e => console.warn('[strategy-brain] manual run failed:', e.message))
  res.status(202).json({ started: true })
})
router.post('/pause', requireAdmin, (req, res) => { brain.pause({ by: who(req) }); res.json({ paused: true }) })
router.post('/resume', requireAdmin, (req, res) => { brain.resume(); res.json({ paused: false }) })

module.exports = router
