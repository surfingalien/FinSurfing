'use strict'
/**
 * lib/split-guard.js — keep a stock split from reading as a crash.
 *
 * Every chart provider in the cascade serves split-adjusted history except
 * Alpha Vantage's free TIME_SERIES_DAILY (the adjusted series is premium). On
 * that path NVDA's 10:1 split of 10 June 2024 is a 90% one-day fall, which
 * would wreck a backtest, a volatility forecast, a regime label and the
 * resolution of any pick spanning it. Two pure steps:
 *
 *   applySplits   divide every price before each known split by its ratio (and
 *                 multiply volume), given the splits from lib/income.js (Yahoo)
 *   suspectJumps  with no split list, find one-day moves whose size matches a
 *                 common split ratio within 1.5% — a real crash can match too,
 *                 so the caller REFUSES the series rather than "fixing" it
 *
 * Tests: tests/split-guard.test.js
 */

const RATIOS = [2, 3, 4, 5, 8, 10, 15, 20, 25, 30, 40, 50]
const TOL = 0.015

const dayOf = sec => new Date(sec * 1000).toISOString().slice(0, 10)

/** Arrays in, adjusted copies out. `timestamps` in unix seconds; `splits` [{date:'YYYY-MM-DD', ratio}] (ratio 10 = 10-for-1). */
function applySplits({ timestamps, opens, highs, lows, closes, volumes }, splits = []) {
  const days = timestamps.map(dayOf)
  const factor = days.map(() => 1)
  for (const s of splits || []) {
    if (!(s?.ratio > 0) || s.ratio === 1) continue
    for (let i = 0; i < days.length; i++) if (days[i] < s.date) factor[i] *= s.ratio
  }
  const px = arr => (arr ? arr.map((v, i) => (v == null ? v : v / factor[i])) : arr)
  return {
    timestamps, opens: px(opens), highs: px(highs), lows: px(lows), closes: px(closes),
    volumes: volumes ? volumes.map((v, i) => (v == null ? v : Math.round(v * factor[i]))) : volumes,
    applied: (splits || []).filter(s => s.ratio > 0 && s.ratio !== 1 && s.date > days[0] && s.date <= days[days.length - 1]).length,
  }
}

/** One-day moves the size of a split (down for a forward split, up for a reverse one). */
function suspectJumps(timestamps, closes) {
  const out = []
  for (let i = 1; i < closes.length; i++) {
    const a = closes[i - 1], b = closes[i]
    if (!(a > 0 && b > 0)) continue
    const r = a / b
    for (const k of RATIOS) {
      if (Math.abs(r / k - 1) <= TOL) { out.push({ date: dayOf(timestamps[i]), ratio: k }); break }
      if (Math.abs((1 / r) / k - 1) <= TOL) { out.push({ date: dayOf(timestamps[i]), ratio: 1 / k }); break }
    }
  }
  return out
}

module.exports = { RATIOS, TOL, applySplits, suspectJumps }
