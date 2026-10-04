'use strict'

/**
 * lib/async-route.js — an async Express handler must never take the server down.
 *
 * Express 4 does not catch a rejected promise from an async handler. The
 * rejection is unhandled, and Node exits on an unhandled rejection: one bad
 * scan request restarted the whole server — every user's in-flight request
 * and queued job with it. On 2026-10-03 a TypeError in the AI Brain scan did
 * exactly that, and the job queue's resume-after-restart re-ran the scan into
 * the same crash until its attempt cap stopped it.
 *
 * guardAsync answers the request with an error instead. A heartbeated route
 * (lib/http-heartbeat.js) may already have flushed its 200 headers; its
 * patched res.json still delivers the `error` body, which is what clients and
 * the job queue check.
 *
 * Tests: tests/async-route.test.js
 */
function guardAsync(name, handler) {
  return function guarded(req, res, next) {
    Promise.resolve()
      .then(() => handler(req, res, next))
      .catch(err => {
        console.error(`[${name}] unhandled error:`, err?.stack || err)
        if (res.writableEnded) return
        try {
          if (!res.headersSent) res.status(500)
          res.json({ error: `${name} failed unexpectedly: ${err?.message || err}` })
        } catch { /* connection already gone */ }
      })
  }
}

module.exports = { guardAsync }
