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

router.get('/jobs', (req, res) => {
  res.json(scheduler.getStatus())
})

router.post('/jobs/:id/trigger', (req, res) => {
  const { id } = req.params
  const jobs = scheduler.getStatus()
  if (!jobs.find(j => j.id === id)) return res.status(404).json({ error: `Unknown job: ${id}` })
  // Fire-and-forget — long jobs (AI Brain) take 2–4 min; don't block the HTTP connection
  scheduler.trigger(id).catch(e => console.error(`[scheduler] manual trigger ${id}:`, e.message))
  res.json({ ok: true, status: 'running', message: `Job "${id}" started. Poll GET /api/scheduler/jobs for result.` })
})

router.patch('/jobs/:id', (req, res) => {
  const { id } = req.params
  const { enabled } = req.body
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' })
  scheduler.setEnabled(id, enabled)
  res.json({ ok: true })
})

module.exports = router
