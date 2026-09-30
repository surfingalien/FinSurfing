'use strict'

/**
 * lib/calibration-stats.js
 *
 * The statistics the Brain's self-measurement was missing. Every rate it
 * reported was a bare point estimate — "62% win rate" off 13 picks reads the
 * same as off 1,300 — and every place that CHOSE something (a score cutoff, the
 * best segment) chose it on the same data it then reported, which manufactures
 * an edge out of noise. On pure coin-flip outcomes the old grid search over 11
 * score cutoffs reported a ~59% "alpha win rate" above its chosen line.
 *
 * Four tools, all pure:
 *   wilson()            — honest interval on a rate (well-behaved at small n and
 *                         at 0%/100%, unlike the normal approximation)
 *   shrinkRate()        — a rate pulled toward a prior in proportion to how
 *                         little data backs it; what sizing should consume
 *   benjaminiHochberg() — which of many tested segments survive the fact that
 *                         many were tested
 *   validateThreshold() — choose a cutoff on OLDER picks, keep it only if it
 *                         still beats no cutoff on NEWER picks it never saw
 *
 * Tests: tests/calibration-stats.test.js
 */

const Z95 = 1.959963984540054

/** Wilson score interval for k successes in n trials. */
function wilson(k, n, z = Z95) {
  if (!(n > 0)) return { lo: null, hi: null }
  const p = k / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const centre = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom
  return { lo: +Math.max(0, centre - half).toFixed(3), hi: +Math.min(1, centre + half).toFixed(3) }
}

/**
 * Posterior-mean rate under a Beta prior centred on `prior` with `strength`
 * pseudo-observations. At n=0 it IS the prior; as n grows it converges on the
 * measured rate. This is what a sizing rule should consume: it moves smoothly
 * from "no evidence" to "measured", instead of jumping from a 0.5 fallback to
 * whatever 15 picks happened to do.
 */
function shrinkRate(k, n, { prior = 0.5, strength = 20 } = {}) {
  if (!(n >= 0) || !(strength >= 0)) return prior
  return (k + prior * strength) / (n + strength)
}

// Standard normal CDF (Abramowitz & Stegun 26.2.17, |error| < 7.5e-8).
function normCdf(x) {
  const t = 1 / (1 + 0.2316419 * Math.abs(x))
  const d = 0.3989422804014327 * Math.exp(-x * x / 2)
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))))
  return x > 0 ? 1 - p : p
}

/**
 * Two-sided p-value that a segment's k/n differs from a reference rate p0.
 * Normal approximation to the binomial — adequate at the n floors used here,
 * and deliberately simple so the number can be checked by hand.
 */
function binomialPValue(k, n, p0) {
  if (!(n > 0) || !(p0 > 0 && p0 < 1)) return 1
  const z = (k / n - p0) / Math.sqrt((p0 * (1 - p0)) / n)
  return Math.min(1, 2 * (1 - normCdf(Math.abs(z))))
}

/**
 * Benjamini–Hochberg: given p-values for every segment TESTED (not just the
 * interesting ones — dropping the dull ones first defeats the correction),
 * return a parallel array of booleans for which survive at false-discovery
 * rate q.
 */
function benjaminiHochberg(pValues, q = 0.10) {
  const m = pValues.length
  const order = pValues.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0])
  let cutoff = -1
  order.forEach(([p], rank) => { if (p <= ((rank + 1) / m) * q) cutoff = rank })
  const keep = new Array(m).fill(false)
  for (let r = 0; r <= cutoff; r++) keep[order[r][1]] = true
  return keep
}

/**
 * Walk-forward validation of a "only keep picks scoring ≥ t" filter.
 *
 * rows: [{ t: timestamp, score, win: boolean }] — one per resolved pick.
 * The newest `holdoutFrac` (by time, never shuffled) is untouched while the
 * cutoff is chosen on the older rows; the chosen cutoff is then scored on the
 * holdout against the do-nothing alternative (keep every pick). It is adopted
 * only if its holdout rate's LOWER confidence bound clears the unfiltered
 * holdout rate — "better than no filter, beyond sampling noise".
 *
 * Returns { threshold|null, validated, reason, candidate, train, holdout }.
 * threshold is null whenever the filter is not proven; callers must then apply
 * NO filter, never fall back to some other number.
 */
function validateThreshold(rows, {
  grid = [35, 40, 45, 50, 55, 60, 65, 70, 75, 80, 85],
  holdoutFrac = 0.3,
  minTrain = 20,
  minHoldout = 15,
} = {}) {
  const clean = (rows || [])
    .filter(r => Number.isFinite(r?.score) && Number.isFinite(r?.t) && typeof r.win === 'boolean')
    .sort((a, b) => a.t - b.t)
  const rate = arr => (arr.length ? arr.filter(r => r.win).length / arr.length : null)
  const base = { threshold: null, validated: false, candidate: null, train: null, holdout: null }

  const nHold = Math.floor(clean.length * holdoutFrac)
  const train = clean.slice(0, clean.length - nHold)
  const hold  = clean.slice(clean.length - nHold)
  if (train.length < minTrain || hold.length < minHoldout) {
    return { ...base, reason: `insufficient data (${clean.length} resolved picks; need ≥${minTrain} to choose and ≥${minHoldout} to test)` }
  }

  let best = null
  for (const t of grid) {
    const above = train.filter(r => r.score >= t)
    if (above.length < minTrain) continue
    const r = rate(above)
    if (!best || r > best.rate) best = { t, rate: r, n: above.length }
  }
  if (!best) return { ...base, reason: `no cutoff leaves ≥${minTrain} training picks above it` }

  const holdAbove = hold.filter(r => r.score >= best.t)
  const holdAll   = rate(hold)
  const out = {
    ...base,
    candidate: best.t,
    train:   { n: best.n, rate: +best.rate.toFixed(3) },
    holdout: { n: holdAbove.length, rate: holdAbove.length ? +rate(holdAbove).toFixed(3) : null, baseRate: +holdAll.toFixed(3), baseN: hold.length },
  }
  if (holdAbove.length < minHoldout) {
    return { ...out, reason: `cutoff ${best.t} leaves only ${holdAbove.length} holdout picks (need ≥${minHoldout})` }
  }
  const wins = holdAbove.filter(r => r.win).length
  const { lo } = wilson(wins, holdAbove.length)
  if (!(lo > holdAll)) {
    return { ...out, reason: `cutoff ${best.t} did not beat no filter on unseen picks (holdout ${Math.round(out.holdout.rate * 100)}%, 95% lower bound ${Math.round(lo * 100)}% vs ${Math.round(holdAll * 100)}% unfiltered)` }
  }
  return { ...out, threshold: best.t, validated: true, reason: `cutoff ${best.t} beat no filter on ${holdAbove.length} unseen picks (lower bound ${Math.round(lo * 100)}% > ${Math.round(holdAll * 100)}%)` }
}

module.exports = { wilson, shrinkRate, normCdf, binomialPValue, benjaminiHochberg, validateThreshold, Z95 }
