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

router.post('/jobs/:id/trigger', async (req, res) => {
  const { id } = req.params
  try {
    const data = await scheduler.trigger(id)
    res.json({ ok: true, data })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

router.patch('/jobs/:id', (req, res) => {
  const { id } = req.params
  const { enabled } = req.body
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' })
  scheduler.setEnabled(id, enabled)
  res.json({ ok: true })
})

module.exports = router
