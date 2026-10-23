'use strict'

/**
 * lib/app-url.js — the public site address, for links that leave the server.
 *
 * Password-reset emails link to `${APP_URL}/reset-password?token=…`. APP_URL is
 * typed by hand on Railway, and a trailing slash is the natural way to write
 * it ("https://finsurfing-production.up.railway.app/") — which produced
 * "…app//reset-password", a path the app did not recognise, so the reset form
 * never opened. Trailing slashes are stripped here, once, for every caller.
 *
 * Pure. Tests: tests/app-url.test.js
 */
const DEFAULT_APP_URL = 'http://localhost:5173'

function appUrl(env = process.env) {
  const raw = String(env.APP_URL || '').trim()
  return (raw || DEFAULT_APP_URL).replace(/\/+$/, '')
}

function resetLink(token, env = process.env) {
  return `${appUrl(env)}/reset-password?token=${encodeURIComponent(token)}`
}

module.exports = { appUrl, resetLink, DEFAULT_APP_URL }
