'use strict'

/**
 * routes/scheduler.js
 *
 * REST API for the in-process task scheduler.
 *
 * GET  /api/scheduler/jobs          — list all jobs + last results
 * POST /api/scheduler/jobs/:id/trigger — manually trigger a job
 * PATCH /api/scheduler/jobs/:id     — { enabled: bool }
 */

const express   = require('express')
const router    = express.Router()
const scheduler = require('../lib/scheduler')
const { requireAuth, requireAdmin } = require('../middleware/auth')
let scheduledJobs = null
function getJobs() {
  if (!scheduledJobs) scheduledJobs = require('../lib/scheduled-jobs')
  return scheduledJobs
}

router.get('/jobs', (req, res) => {
  res.json(scheduler.getStatus())
})

router.post('/jobs/:id/trigger', requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params
  const jobs = scheduler.getStatus()
  if (!jobs.find(j => j.id === id)) return res.status(404).json({ error: `Unknown job: ${id}` })
  // Fire-and-forget — long jobs (AI Brain) take 2–4 min; don't block the HTTP connection
  scheduler.trigger(id).catch(e => console.error(`[scheduler] manual trigger ${id}:`, e.message))
  res.json({ ok: true, status: 'running', message: `Job "${id}" started. Poll GET /api/scheduler/jobs for result.` })
})

router.patch('/jobs/:id', requireAuth, requireAdmin, (req, res) => {
  const { id } = req.params
  const { enabled } = req.body
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' })
  scheduler.setEnabled(id, enabled)
  res.json({ ok: true })
})

// Test email — sends a plain diagnostic email to MORNING_BRIEF_EMAIL/ADMIN_EMAIL
router.post('/test-email', requireAuth, requireAdmin, async (req, res) => {
  const recipient = process.env.MORNING_BRIEF_EMAIL || process.env.ADMIN_EMAIL
  if (!recipient) return res.status(400).json({ error: 'MORNING_BRIEF_EMAIL or ADMIN_EMAIL not set' })
  const { sendEmail } = require('../lib/email')
  try {
    const delivered = await sendEmail({
      to:      recipient,
      subject: 'FinSurf — email delivery test',
      html:    `<p>Test email sent at ${new Date().toISOString()}. If you see this, email delivery is working.</p>`,
    })
    res.json({ ok: true, delivered, recipient, emailService: delivered ? 'ok' : 'none-configured (console only)' })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Cached result endpoints — read-only, no auth needed for internal UI use
router.get('/cache/scan',    (req, res) => res.json(getJobs().getCachedScan()    || { data: null }))
router.get('/cache/digest',  (req, res) => res.json(getJobs().getCachedDigest()  || { results: [] }))
router.get('/cache/alt/:symbol', (req, res) => {
  const snippet = getJobs().getCachedAltData(req.params.symbol?.toUpperCase())
  res.json({ symbol: req.params.symbol, snippet: snippet || null })
})

module.exports = router
