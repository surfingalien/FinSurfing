'use strict'
/**
 * lib/ai-job-routes.js
 *
 * Mounts the standard background-job endpoints for one surface onto an
 * express Router. Every long AI surface needs the same five, and hand-writing
 * them per route is where the ordering bug lives: `/job/:id` declared before
 * `/job/latest` silently reads "latest" as a job id, and the failure is a 404
 * on a cold page load rather than anything that looks like a routing mistake.
 * Declaring them here means it is right once.
 *
 *   POST   <base>          → enqueue, 202 { jobId, position, status }
 *   GET    <base>/latest   → last completed run (cold page load)
 *   GET    <base>/:id      → status, and the result once done
 *   DELETE <base>/:id      → cancel a PENDING run
 *   GET    <base>s         → this user's recent runs   (opts.listPath)
 *
 * The synchronous endpoint each kind wraps is left untouched — the queue drives
 * it over loopback, and copilot/MCP/scheduled jobs still call it directly.
 *
 * Tests: tests/ai-job-routes.test.js
 */

const rateLimit = require('express-rate-limit')
const jobQueue  = require('./ai-job-queue')

/** Loopback requests are the background worker itself; the queue's per-user cap
 *  is the real limit. Without this, every user's queued run shares one budget. */
const skipLoopback = (req) => {
  const addr = req.socket?.remoteAddress || ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/**
 * @param {object}   router      express Router to mount on
 * @param {object}   opts
 * @param {string}   opts.kind        key in ai-job-queue's JOB_KINDS
 * @param {function} opts.requireAuth auth middleware
 * @param {string}  [opts.base]       path prefix for the job endpoints (default '/job')
 * @param {string}  [opts.listPath]   path for the list endpoint (default '/jobs')
 * @param {function}[opts.buildParams] (req) => params | { error } — validate and
 *                                     normalise the body. Returning an object with
 *                                     an `error` string rejects with 400.
 * @param {function}[opts.label]      (params) => string shown in job listings
 * @param {string}  [opts.disabledEnv] env var that, when 'true', 503s the enqueue
 * @param {string}  [opts.noun]       used in error messages
 */
function mountJobRoutes(router, {
  kind,
  requireAuth,
  base = '/job',
  listPath = '/jobs',
  buildParams = (req) => ({ ...(req.body || {}) }),
  label = () => null,
  disabledEnv = null,
  noun = 'run',
} = {}) {
  if (!jobQueue.JOB_KINDS[kind]) throw new Error(`mountJobRoutes: unknown kind "${kind}"`)

  const enqueueLimit = rateLimit({
    windowMs: 5 * 60 * 1000, max: 10,
    skip: skipLoopback,
    message: { error: `Too many ${noun} requests — wait a few minutes` },
  })

  router.post(base, requireAuth, enqueueLimit, (req, res) => {
    if (disabledEnv && process.env[disabledEnv] === 'true')
      return res.status(503).json({ error: `This feature is temporarily disabled (kill switch active)`, killSwitch: true })

    let params
    try {
      params = buildParams(req)
    } catch (e) {
      return res.status(400).json({ error: e.message })
    }
    if (params?.error) return res.status(400).json({ error: params.error })

    // Stamped here, not in buildParams, so no surface can forget it. The worker
    // calls the synchronous route over loopback where requireAuth is satisfied
    // by the internal secret and req.user is never set — a route that reads or
    // writes per-user history (rec journal, analysis memory) would silently do
    // it for nobody. See middleware/auth.js:effectiveUserId for the read side.
    params.userId = req.user?.userId

    try {
      const { id, position } = jobQueue.enqueue({
        userId: req.user?.userId,
        kind,
        params,
        label: label(params),
      })
      return res.status(202).json({ ok: true, jobId: id, position, status: position === 1 ? 'running' : 'queued' })
    } catch (e) {
      return res.status(503).json({ error: e.message })
    }
  })

  // Fixed path FIRST — after '/:id' it would be read as a job id.
  router.get(`${base}/latest`, requireAuth, (req, res) => {
    res.json({ job: jobQueue.getLatestResult(req.user?.userId, kind) })
  })

  router.get(`${base}/:id`, requireAuth, (req, res) => {
    const job = jobQueue.getJob(req.params.id, req.user?.userId)
    if (!job || job.kind !== kind) return res.status(404).json({ error: 'Not found' })
    res.json({ job })
  })

  router.delete(`${base}/:id`, requireAuth, (req, res) => {
    const existing = jobQueue.getJob(req.params.id, req.user?.userId)
    if (existing && existing.kind !== kind) return res.status(404).json({ error: 'Not found' })
    const ok = jobQueue.cancel(req.params.id, req.user?.userId)
    if (!ok) return res.status(404).json({ error: 'Not found, already running, or already finished' })
    res.json({ ok: true })
  })

  router.get(listPath, requireAuth, (req, res) => {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 10, 1), 50)
    res.json({ jobs: jobQueue.getUserJobs(req.user?.userId, limit, kind), queue: jobQueue.getQueue() })
  })

  return router
}

module.exports = { mountJobRoutes, skipLoopback }
