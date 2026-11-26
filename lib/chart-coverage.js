'use strict'
/**
 * lib/chart-coverage.js — is a provider's chart answer usable for the range asked?
 *
 * GET /api/chart takes the FIRST provider whose answer has the right shape and
 * caches it for 15 minutes. A provider could answer a range with no bars, with
 * bars whose close is missing (a fallback endpoint with other field names), or
 * with a few days for a five-year request — the page dropped every bar without
 * a close and drew an empty chart, with no error, until the cache expired; the
 * other ranges came from a different cache entry and looked fine. Now an answer
 * counts only with enough real closes for the range; otherwise the cascade
 * moves on, and the best short answer is used only when no provider had a full
 * one (a newly listed stock has short history everywhere). Pure.
 *
 * Tests: tests/chart-coverage.test.js
 */

// Trading sessions a daily range should hold (US equities; crypto has more).
const EXPECTED_DAILY = { '5d': 5, '1mo': 21, '3mo': 63, '6mo': 126, '1y': 252, '2y': 504, '5y': 1260 }
const MIN_SHARE = 0.5

/** { valid, expected, full } for a Yahoo-shaped chart answer. */
function coverage(data, range, interval = '1d') {
  const r = data?.chart?.result?.[0]
  const ts = r?.timestamp || []
  const close = r?.indicators?.quote?.[0]?.close || []
  let valid = 0
  for (let i = 0; i < ts.length; i++) if (Number.isFinite(ts[i]) && Number(close[i]) > 0) valid++
  const daily = interval === '1d'
  const expected = daily ? EXPECTED_DAILY[range] ?? null : null
  const full = valid >= 2 && (expected == null || valid >= Math.floor(expected * MIN_SHARE))
  return { valid, expected, full }
}

/**
 * Tracks the cascade: `accept(data, provider)` is true for a full answer;
 * a usable but short one is remembered as `best` in case nothing better comes.
 */
function cascade(range, interval) {
  let best = null
  const rejected = []
  return {
    accept(data, provider) {
      if (!data) return false
      const c = coverage(data, range, interval)
      if (c.full) return true
      rejected.push(`${provider}: ${c.valid} usable bar${c.valid === 1 ? '' : 's'}${c.expected ? ` of ~${c.expected}` : ''}`)
      if (c.valid >= 2 && (!best || c.valid > best.valid)) best = { data, provider, valid: c.valid }
      return false
    },
    get best() { return best },
    get rejected() { return rejected },
  }
}

module.exports = { EXPECTED_DAILY, MIN_SHARE, coverage, cascade }
