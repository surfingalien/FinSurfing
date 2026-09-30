'use strict'

/**
 * lib/kelly.js — Kelly Criterion position sizing (advisory).
 *
 * Asymmetric-payoff Kelly with fractional + hard-cap guardrails, for SUGGESTING
 * (never executing) a position size on a recommendation.
 *
 * Doing it properly (vs. the common mistake of feeding a raw confidence score in
 * as the win probability): the win-probability MUST come from EMPIRICAL
 * calibration — the historical win rate of resolved picks — via
 * `winProbFromStats(computeStats(...))`. The payoff asymmetry comes from the
 * pick's own target/stop. Because a tight stop makes full Kelly exceed 100%
 * (leverage), callers apply a fractional multiplier AND a hard cap — both
 * enforced here.
 *
 * Pure functions, unit-tested (tests/kelly.test.js).
 */

const { shrinkRate } = require('./calibration-stats')

// Full Kelly fraction of bankroll for a bet that returns +winFrac with prob p,
// or −lossFrac with prob (1−p):  f* = (p·W − q·L) / (W·L).
// Clamped to ≥0 (never size a non-positive-edge bet). May exceed 1 (leverage)
// when the stop is tight — callers MUST fraction + cap it.
function fullKelly(p, winFrac, lossFrac) {
  const W = winFrac, L = lossFrac, q = 1 - p
  if (!(p > 0 && p < 1) || !(W > 0) || !(L > 0)) return 0
  const f = (p * W - q * L) / (W * L)
  return f > 0 ? f : 0
}

// Expected value per $1 risked: p·W − q·L (the edge). ≤0 ⇒ no positive edge.
function edge(p, winFrac, lossFrac) {
  if (!(p >= 0 && p <= 1)) return 0
  return p * winFrac - (1 - p) * lossFrac
}

/**
 * Suggested position size as a fraction of the portfolio.
 * @param {object} o
 * @param {number} o.winProb      empirical win probability (0–1)
 * @param {number} o.winFrac      gain fraction if target hit (e.g. 0.25 for +25%)
 * @param {number} o.lossFrac     loss fraction if stopped (e.g. 0.12 for −12%)
 * @param {number} [o.fraction]   fractional-Kelly multiplier (default 0.5 = half)
 * @param {number} [o.maxFraction] hard cap as a fraction of portfolio (default 0.2)
 */
function suggestedSize({ winProb, winFrac, lossFrac, fraction = 0.5, maxFraction = 0.2 }) {
  const full       = fullKelly(winProb, winFrac, lossFrac)
  const fractioned = full * fraction
  const suggested  = Math.max(0, Math.min(fractioned, maxFraction))
  return {
    winProb:      +(+winProb).toFixed(3),
    fullKellyPct: +(full * 100).toFixed(1),
    suggestedPct: +(suggested * 100).toFixed(1),
    capped:       fractioned > maxFraction,
    edgePerUnit:  +edge(winProb, winFrac, lossFrac).toFixed(4),
    fraction,
    maxPct:       +(maxFraction * 100).toFixed(1),
  }
}

/**
 * Derive an empirical win probability from lib/brain-learnings `computeStats()`.
 *
 * Specificity order, most specific first:
 *   1. asset class (`byAssetType`) — stocks, ETFs and crypto have genuinely
 *      different hit rates, and a blended number sizes all three wrong. Checked
 *      first because it is the segment the pick actually belongs to.
 *   2. the stated-confidence calibration bucket
 *   3. the overall resolved win rate (the segments' horizon first)
 *   4. a conservative fallback
 * Every level is gated on `minN` so a thin segment falls through to a broader
 * one rather than sizing off noise.
 *
 * The measured rate is SHRUNK toward the fallback in proportion to how little
 * data backs it (`shrinkStrength` pseudo-observations, lib/calibration-stats
 * `shrinkRate`). Kelly is steep in p: a raw 70% off 15 picks — whose 95%
 * interval runs from ~42% to ~89% — sizes as if 70% were known, and the EV
 * gate passes on it. Shrinkage turns "15 picks said 70%" into ~59%, and 1,500
 * picks at 70% into ~70%. Returns { p, raw, n, source } so provenance and the
 * unshrunk rate stay visible.
 */
function winProbFromStats(stats, { confidence = null, assetType = null, fallback = 0.5, minN = 15, shrinkStrength = 20 } = {}) {
  const take = (seg, n, label) => {
    const wins = seg.wins ?? Math.round(seg.winRate * n)
    const p = shrinkRate(wins, n, { prior: fallback, strength: shrinkStrength })
    return { p: +p.toFixed(4), raw: seg.winRate, n, source: `${label} (n=${n}, raw ${Math.round(seg.winRate * 100)}% shrunk toward ${Math.round(fallback * 100)}%)` }
  }

  // computeStats folds the legacy 'equity' label into 'stock'; match that here
  // so a caller passing either lands on the same segment.
  const atKey = assetType ? String(assetType).toLowerCase().replace(/^equity$/, 'stock') : null
  const atSeg = atKey && stats?.byAssetType?.[atKey]
  if (atSeg && typeof atSeg.winRate === 'number' && atSeg.n >= minN) {
    return take(atSeg, atSeg.n, `assetType:${atKey}`)
  }

  const bucket = confidence && stats?.calibration?.[confidence]
  if (bucket && typeof bucket.winRate === 'number' && bucket.n >= minN) {
    return take(bucket, bucket.n, `calibration:${confidence}`)
  }
  // The segments' horizon first, then the other. A measured winRate of 0 is
  // real evidence (it drags p well below the fallback), never a reason to
  // substitute the more optimistic fallback outright.
  const order = stats?.segmentHorizon === 7
    ? [[stats?.h7, '7d'], [stats?.h30, '30d']]
    : [[stats?.h30, '30d'], [stats?.h7, '7d']]
  for (const [overall, label] of order) {
    if (overall && typeof overall.winRate === 'number' && overall.nTradeable >= minN) {
      return take(overall, overall.nTradeable, `overall ${label} win rate`)
    }
  }
  return { p: fallback, raw: null, n: 0, source: 'default (calibration pending)' }
}

module.exports = { fullKelly, edge, suggestedSize, winProbFromStats }
