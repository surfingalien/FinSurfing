'use strict'
/**
 * lib/http-heartbeat.js
 *
 * Keeps a long-running JSON request alive on mobile networks.
 *
 * THE PROBLEM: an AI Brain scan holds the connection for 2–4 minutes while
 * writing ZERO bytes. iOS Safari and edge proxies drop an idle connection, and
 * the browser surfaces that as a bare `TypeError: Load failed` — a fetch
 * rejection with no HTTP response at all, so the client can't tell it apart
 * from the server being down. This is the same failure #214 fixed for the
 * copilot SSE stream ("Load failed" on mobile during long tool calls); that
 * fix isn't reusable here because this endpoint returns plain JSON, not SSE.
 *
 * THE FIX: trickle a space character every `intervalMs` until the real payload
 * is ready. Leading whitespace before a JSON value is valid per the JSON spec,
 * so `await res.json()` on the client parses the result unchanged and the
 * heartbeat is invisible to it.
 *
 * IMPORTANT CONSEQUENCE — read before using: once the first heartbeat byte is
 * written the HTTP headers are flushed, so the status code is locked at 200 and
 * a later failure CANNOT be signalled as 4xx/5xx. The failure is carried in the
 * body instead, so **clients of a heartbeat route must treat a body containing
 * `error` as a failure even on a 200**. Routes keep using `res.json()` normally;
 * this module patches it so none of their call sites change.
 *
 * Compression note: the app gzips responses, which buffers small writes. Each
 * heartbeat calls `res.flush()` (added by the `compression` middleware) so the
 * byte actually reaches the client rather than sitting in the gzip buffer —
 * without that, the heartbeat would be silently useless.
 */

const DEFAULT_INTERVAL_MS = 15_000

/**
 * Begin heartbeating a JSON response. Returns a stop() function; callers
 * normally don't need it because res.json()/close/finish all stop the timer.
 *
 * @param {import('http').ServerResponse} res
 * @param {object} [opts]
 * @param {number} [opts.intervalMs=15000] — well under the ~30–60s idle
 *        timeouts used by mobile browsers and CDN edges.
 */
function startJsonHeartbeat(res, { intervalMs = DEFAULT_INTERVAL_MS } = {}) {
  if (!res || typeof res.write !== 'function' || res._jsonHeartbeat) return () => {}

  let flushed = false          // true once a heartbeat byte has gone out
  let timer   = null
  const origJson = res.json.bind(res)

  const stop = () => { if (timer) { clearInterval(timer); timer = null } }

  timer = setInterval(() => {
    if (res.writableEnded || res.destroyed) return stop()
    try {
      if (!flushed) {
        // Set the type before the first byte — after this, headers are sent.
        if (!res.headersSent) res.setHeader('Content-Type', 'application/json; charset=utf-8')
        flushed = true
      }
      res.write(' ')
      res.flush?.()   // push past the gzip buffer, else the byte never lands
    } catch {
      stop()
    }
  }, intervalMs)
  timer.unref?.()

  res.json = (payload) => {
    stop()
    if (res.writableEnded) return res
    // Nothing written yet — normal path, status codes still work.
    if (!flushed) return origJson(payload)
    // Headers already flushed as 200: write the body by hand. A failure
    // payload still carries `error`, which is what the client checks.
    try {
      res.write(JSON.stringify(payload))
      res.end()
    } catch { /* connection already gone */ }
    return res
  }

  res.on('close',  stop)
  res.on('finish', stop)
  res._jsonHeartbeat = true

  return stop
}

module.exports = { startJsonHeartbeat, DEFAULT_INTERVAL_MS }
