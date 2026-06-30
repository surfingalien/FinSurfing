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
 * Pure functions, no deps, unit-tested (tests/kelly.test.js).
 */

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
 * Prefers the per-confidence calibration bucket (when present with enough
 * samples), else the overall resolved win rate (30d preferred, then 7d), else a
 * conservative fallback. Returns { p, source } so callers can flag provenance.
 */
function winProbFromStats(stats, { confidence = null, fallback = 0.5, minN = 15 } = {}) {
  const bucket = confidence && stats?.calibration?.[confidence]
  if (bucket && typeof bucket.winRate === 'number' && bucket.n >= minN) {
    return { p: bucket.winRate, source: `calibration:${confidence} (n=${bucket.n})` }
  }
  const overall = stats?.h30 ?? stats?.h7
  if (overall && typeof overall.winRate === 'number' && overall.winRate > 0 && overall.nTradeable >= minN) {
    return { p: overall.winRate, source: `overall win rate (n=${overall.nTradeable})` }
  }
  return { p: fallback, source: 'default (calibration pending)' }
}

module.exports = { fullKelly, edge, suggestedSize, winProbFromStats }
