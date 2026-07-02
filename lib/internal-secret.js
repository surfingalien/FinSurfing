'use strict'
const crypto = require('crypto')

// Per-process secret for loopback-only server-to-server calls (scheduled jobs,
// route-to-route proxying via /api/... over 127.0.0.1). Never persisted or
// exposed to clients — regenerated on every boot, which is fine since both
// the caller and the checker live in this same process.
const INTERNAL_SECRET = process.env.INTERNAL_SECRET || crypto.randomBytes(32).toString('hex')

function isInternalRequest(req) {
  const addr = req.socket?.remoteAddress || ''
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  if (!loopback) return false
  const header = req.headers['x-internal-secret'] || ''
  if (header.length !== INTERNAL_SECRET.length) return false
  return crypto.timingSafeEqual(Buffer.from(header), Buffer.from(INTERNAL_SECRET))
}

module.exports = { INTERNAL_SECRET, isInternalRequest }
