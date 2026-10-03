'use strict'

/**
 * lib/bar-session.js — has the last bar actually closed?
 *
 * During the US session the final daily bar from every provider is TODAY'S
 * bar, still forming: its volume is the volume so far. "Volume vs 20-day
 * average" computed on it reads every morning as weak volume (0.3x at 11:00
 * is a normal day, not a dry one), and a spike can never be seen until the
 * close. The AI Brain read that as "no volume confirmation" on every intraday
 * scan. Volume measures must use the last COMPLETED bar while one is forming.
 *
 * Rules:
 *   - US equity, daily: the bar's trading date is the UTC date of its
 *     timestamp (providers stamp 00:00 UTC or 13:30 UTC — same date either
 *     way). It is forming when that date is today in New York and New York
 *     time is before 16:00.
 *   - Crypto, daily: bars run 00:00–24:00 UTC; today's UTC bar is forming.
 *   - Intraday (intervalMs given): forming while t + intervalMs is in the
 *     future (t is the bar's start).
 *
 * Pure apart from the `now` default. Tests: tests/bar-session.test.js
 */

const DAY_MS = 86_400_000

const nyParts = (ms) => {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms))
  const get = t => parts.find(p => p.type === t)?.value
  return { date: `${get('year')}-${get('month')}-${get('day')}`, minutes: Number(get('hour')) * 60 + Number(get('minute')) }
}

const utcDate = ms => new Date(ms).toISOString().slice(0, 10)

/** Normalise a bar time (ms, seconds, or ISO/date string) to ms; null if unknown. */
function barTimeMs(t) {
  if (t == null) return null
  if (typeof t === 'number') return t < 1e11 ? t * 1000 : t
  const ms = Date.parse(t)
  return Number.isFinite(ms) ? ms : null
}

/**
 * @param {number|string} lastBarTime  the final bar's timestamp
 * @param {object} [o]
 * @param {boolean} [o.isCrypto]
 * @param {number}  [o.intervalMs]  set for intraday bars; omit for daily
 * @param {number}  [o.now]
 */
function isBarForming(lastBarTime, { isCrypto = false, intervalMs = null, now = Date.now() } = {}) {
  const t = barTimeMs(lastBarTime)
  if (t == null) return false                 // unknown time: assume complete (the old behaviour)
  if (intervalMs && intervalMs < DAY_MS) return t + intervalMs > now
  if (isCrypto) return utcDate(t) === utcDate(now)
  const ny = nyParts(now)
  return utcDate(t) === ny.date && ny.minutes < 16 * 60
}

const INTERVAL_MS = {
  '1m': 60e3, '2m': 120e3, '5m': 300e3, '15m': 900e3, '30m': 1800e3,
  '60m': 3600e3, '1h': 3600e3, '90m': 5400e3, '4h': 14400e3,
  '1wk': 7 * DAY_MS, 'W': 7 * DAY_MS,
}

/**
 * Is the final bar of this series still forming? `interval` uses the chart
 * API's names ('1d', '1h', '15m', '1wk'…); anything daily-like gets the
 * session rule.
 */
function isLastBarForming(bars, { interval = '1d', isCrypto = false, now = Date.now() } = {}) {
  if (!Array.isArray(bars) || !bars.length) return false
  const last = bars[bars.length - 1]
  const ivl = INTERVAL_MS[interval]
  if (ivl && ivl >= DAY_MS) {                       // weekly: open until a week after it started
    const t = barTimeMs(last.t)
    return t != null && t + ivl > now
  }
  return isBarForming(last.t, { isCrypto, intervalMs: ivl || null, now })
}

/** Fraction of the regular US session (09:30–16:00 ET) elapsed now, 0..1. */
function usSessionElapsed(now = Date.now()) {
  const { minutes } = nyParts(now)
  return Math.min(1, Math.max(0, (minutes - 570) / 390))
}

/** Is the regular US session (Mon–Fri 09:30–16:00 ET) open now? Holidays are not modelled. */
function usSessionOpen(now = Date.now()) {
  const wd = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short' }).format(new Date(now))
  if (wd === 'Sat' || wd === 'Sun') return false
  const { minutes } = nyParts(now)
  return minutes >= 570 && minutes < 960
}

module.exports = { isBarForming, isLastBarForming, usSessionElapsed, usSessionOpen, barTimeMs }
