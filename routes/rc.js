'use strict'
/**
 * routes/rc.js
 *
 * POST /api/rc  — remote control queue for Claude Code session
 *
 * Accepts a signed command and appends it to /tmp/claude-rc-queue.
 * The Claude Code session monitors this file via `tail -f` and processes
 * each line as an instruction.
 *
 * Auth: RC_SECRET env var (shared secret). If unset, endpoint is disabled.
 *
 * Body: { "cmd": "string instruction", "secret": "..." }
 * OR:  Authorization: Bearer <RC_SECRET>  with body { "cmd": "..." }
 */

const express = require('express')
const fs = require('fs')
const rateLimit = require('express-rate-limit')

const router = express.Router()
const QUEUE_FILE = '/tmp/claude-rc-queue'

const limit = rateLimit({ windowMs: 60_000, max: 20 })

router.post('/', limit, (req, res) => {
  const secret = process.env.RC_SECRET
  if (!secret) {
    return res.status(503).json({ error: 'Remote control not configured (RC_SECRET not set)' })
  }

  const authHeader = req.headers.authorization || ''
  const bodySecret = req.body?.secret
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : bodySecret

  if (provided !== secret) {
    return res.status(401).json({ error: 'Unauthorized' })
  }

  const cmd = (req.body?.cmd || '').trim()
  if (!cmd) {
    return res.status(400).json({ error: 'cmd is required' })
  }
  if (cmd.length > 2000) {
    return res.status(400).json({ error: 'cmd too long (max 2000 chars)' })
  }

  const line = JSON.stringify({ ts: new Date().toISOString(), cmd }) + '\n'
  try {
    fs.appendFileSync(QUEUE_FILE, line)
    console.log('[rc] command queued:', cmd.slice(0, 80))
    res.json({ ok: true, queued: cmd })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/rc/status — simple health check (no auth needed)
router.get('/status', (req, res) => {
  res.json({
    enabled: !!process.env.RC_SECRET,
    queueFile: QUEUE_FILE,
    queueExists: fs.existsSync(QUEUE_FILE),
  })
})

module.exports = router
