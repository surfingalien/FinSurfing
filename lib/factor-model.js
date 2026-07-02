'use strict'
/**
 * lib/factor-model.js
 *
 * Deterministic multi-factor scores (0–100 each) computed from real daily
 * bars plus an optional trailing P/E: momentum, trend, low-volatility,
 * value, and their equal-weight composite. Injected into AI Brain scans
 * alongside COMPUTED TECHNICALS so factor exposure is math the model can
 * cite but never invents. 50 = neutral on every scale.
 *
 * Pure — tests in tests/factor-model.test.js.
 */

const { computeEMA, computeADX } = require('./technical-indicators')

const clampScore = v => Math.max(0, Math.min(100, Math.round(v)))

// tanh squash: return in % mapped to 0–100, 50 = flat, `scale` = the move
// (in %) that lands at ~88 (tanh(1) ≈ 0.76 → 88)
const squash = (rPct, scale) => clampScore(50 + 50 * Math.tanh(rPct / scale))

function trailingReturn(closes, bars) {
  const n = closes.length
  if (n <= bars || !(closes[n - 1 - bars] > 0)) return null
  return (closes[n - 1] - closes[n - 1 - bars]) / closes[n - 1 - bars] * 100
}

/** Momentum: blend of 20/60/120-bar returns, each tanh-squashed. */
function momentumScore(closes) {
  if (!closes || closes.length < 21) return null
  const parts = [[20, 8], [60, 15], [120, 25]]
    .map(([bars, scale]) => {
      const r = trailingReturn(closes, bars)
      return r == null ? null : squash(r, scale)
    })
    .filter(v => v != null)
  return parts.length ? clampScore(parts.reduce((a, b) => a + b, 0) / parts.length) : null
}

/** Trend: EMA stack (price>EMA50, price>EMA200, EMA50>EMA200) + ADX≥25, scaled to available checks. */
function trendScore(closes, highs, lows) {
  if (!closes || closes.length < 60) return null
  const price = closes[closes.length - 1]
  const e50   = computeEMA(closes, 50)
  const e200  = closes.length >= 200 ? computeEMA(closes, 200) : null
  const adx   = highs?.length && lows?.length ? computeADX(highs, lows, closes) : null

  let pts = 0, max = 0
  if (e50 != null)                 { max += 30; if (price > e50)  pts += 30 }
  if (e200 != null)                { max += 30; if (price > e200) pts += 30 }
  if (e50 != null && e200 != null) { max += 20; if (e50 > e200)   pts += 20 }
  if (adx != null)                 { max += 20; if (adx >= 25)    pts += 20 }
  return max >= 50 ? clampScore(pts / max * 100) : null
}

/** Low-volatility factor: annualized vol of the last ~120 daily returns, inverted (5%→100, 75%→0). */
function lowVolScore(closes) {
  if (!closes || closes.length < 30) return null
  const c = closes.slice(-121)
  const rets = []
  for (let i = 1; i < c.length; i++) {
    if (c[i - 1] > 0) rets.push((c[i] - c[i - 1]) / c[i - 1])
  }
  if (rets.length < 20) return null
  const mean = rets.reduce((a, b) => a + b, 0) / rets.length
  const vol  = Math.sqrt(rets.reduce((s, v) => s + (v - mean) ** 2, 0) / rets.length) * Math.sqrt(252) * 100
  return clampScore(100 - (vol - 5) * (100 / 70))
}

/** Value: trailing P/E mapped log-linearly (P/E 5→100, P/E 60→0); null when missing or negative earnings. */
function valueScore(pe) {
  if (pe == null || !Number.isFinite(pe) || pe <= 0) return null
  const lo = Math.log(5), hi = Math.log(60)
  return clampScore(100 - (Math.log(pe) - lo) / (hi - lo) * 100)
}

/**
 * @param {object} args
 * @param {number[]} args.closes  — daily closes, ascending
 * @param {number[]} [args.highs]
 * @param {number[]} [args.lows]
 * @param {number}   [args.pe]    — trailing P/E when known (equities)
 */
function factorScores({ closes, highs, lows, pe } = {}) {
  const momentum = closes ? momentumScore(closes) : null
  const trend    = closes ? trendScore(closes, highs, lows) : null
  const lowVol   = closes ? lowVolScore(closes) : null
  const value    = valueScore(pe)
  const present  = [momentum, trend, lowVol, value].filter(v => v != null)
  const composite = present.length
    ? clampScore(present.reduce((a, b) => a + b, 0) / present.length)
    : null
  return { momentum, trend, lowVol, value, composite }
}

/** Compact injection fragment, e.g. "FACTORS mom=72 trend=75 lowvol=31 comp=59"; null when nothing computed. */
function factorLine(scores) {
  if (!scores || scores.composite == null) return null
  const bits = []
  if (scores.momentum != null) bits.push(`mom=${scores.momentum}`)
  if (scores.trend    != null) bits.push(`trend=${scores.trend}`)
  if (scores.lowVol   != null) bits.push(`lowvol=${scores.lowVol}`)
  if (scores.value    != null) bits.push(`val=${scores.value}`)
  bits.push(`comp=${scores.composite}`)
  return 'FACTORS ' + bits.join(' ')
}

module.exports = { factorScores, factorLine, momentumScore, trendScore, lowVolScore, valueScore }
