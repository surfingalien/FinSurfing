'use strict'
/**
 * lib/finnhub-keys.js
 *
 * Finnhub API key pool with round-robin rotation and per-key cooldown.
 *
 * Why: Finnhub's free tier rate-limits per key (~60 calls/min). A multi-holding
 * portfolio refreshing quotes can trip 429s on a single key, which blanks the
 * affected quotes until the next cycle. Spreading calls across several keys
 * keeps each one inside its budget; cooling a key that just returned 429/403
 * routes traffic away from it until it recovers.
 *
 * This is server-side and in-memory only — NO Railway redeploys (env changes
 * trigger one) and NO browser/UI involvement (those keys are per-user and
 * arrive as the x-finnhub-key header). Keys are read once from the environment:
 *   FINNHUB_API_KEYS  — comma-separated pool (preferred)
 *   FINNHUB_API_KEY   — single key (back-compat; folded into the pool)
 *
 * With one key configured this degrades to exactly the previous behaviour.
 */

const DEFAULT_COOLDOWN_MS = 60_000

let _keys = null
let _idx = 0
const _cooldownUntil = new Map() // key → epoch ms until which it is cooling

function parseKeys() {
  const multi  = (process.env.FINNHUB_API_KEYS || '').split(',').map(s => s.trim()).filter(Boolean)
  const single = (process.env.FINNHUB_API_KEY || '').trim()
  const out = []
  for (const k of [...multi, ...(single ? [single] : [])]) if (!out.includes(k)) out.push(k)
  return out
}

function keys() {
  if (_keys === null) _keys = parseKeys()
  return _keys
}

// Re-read env and reset state. Exposed for tests / hot config changes.
function reload() {
  _keys = parseKeys()
  _idx = 0
  _cooldownUntil.clear()
  return _keys
}

function has() {
  return keys().length > 0
}

/**
 * Next usable key, round-robin, skipping keys currently cooling down.
 * Returns null when no keys are configured. If every key is cooling, returns
 * the one whose cooldown expires soonest (least-bad choice) rather than nothing.
 */
function next() {
  const ks = keys()
  if (ks.length === 0) return null
  const now = Date.now()
  for (let i = 0; i < ks.length; i++) {
    const k = ks[_idx % ks.length]
    _idx = (_idx + 1) % ks.length
    const until = _cooldownUntil.get(k)
    if (!until || until <= now) return k
  }
  // All cooling — pick the soonest-to-recover.
  let best = ks[0], bestUntil = Infinity
  for (const k of ks) {
    const until = _cooldownUntil.get(k) ?? 0
    if (until < bestUntil) { bestUntil = until; best = k }
  }
  return best
}

/**
 * Mark a key as rate-limited so next() routes around it for `ms`. Keys that
 * aren't in the pool (e.g. a user's browser-supplied key) are ignored.
 */
function penalize(key, ms = DEFAULT_COOLDOWN_MS) {
  if (!key || !keys().includes(key)) return false
  _cooldownUntil.set(key, Date.now() + ms)
  return true
}

// True when an error from a Finnhub call indicates rate-limiting / auth block.
function isRateLimitError(err) {
  return /HTTP\s*(429|403)/.test(err?.message || '')
}

module.exports = { next, penalize, has, keys, reload, isRateLimitError, DEFAULT_COOLDOWN_MS }
