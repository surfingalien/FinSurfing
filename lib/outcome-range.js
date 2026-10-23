'use strict'

/**
 * lib/outcome-range.js — "picks like this landed between −8% and +14%, 80% of the time".
 *
 * A card states a target and a stop: the model's opinion of where price goes.
 * What it never said is how wide the real outcomes of picks like it have been.
 * This is that range, from this system's own resolved predictions, using the
 * split-conformal quantile: with n exchangeable past outcomes, the interval
 * between the ⌊(n+1)·α/2⌋-th and ⌈(n+1)·(1−α/2)⌉-th order statistics contains
 * a new outcome with probability ≥ 1−α. No model, no distributional
 * assumption — only the finite-sample correction that makes the coverage claim
 * honest for small n.
 *
 * "Exchangeable" is the assumption markets break (regimes change), so the
 * claim is CHECKED rather than asserted: `walkForwardCoverage` builds every
 * range from strictly earlier picks only and counts how often the next pick
 * actually landed inside. When that measured coverage falls well short of the
 * nominal 80%, the range is reported with that warning rather than as a
 * guarantee.
 *
 * Specificity: the pick's asset class first (stocks, ETFs and crypto move
 * very differently), all picks as the fallback; both gated on MIN_N.
 * Pure. Tests: tests/outcome-range.test.js
 */

const MIN_N = 30
const ALPHA = 0.2           // 80% range
const DAY = 86_400_000
const MAX_TESTS = 200

const assetOf = r => (r.assetType === 'equity' ? 'stock' : r.assetType || 'stock')

function realized(r, horizon) {
  const base = r.basePrice ?? r.priceAtPrediction ?? r.entryZoneMid
  const px = r[`price${horizon}d`]
  return base > 0 && px != null ? ((px - base) / base) * 100 : null
}

/** Conformal interval from a list of outcomes (percent). null below MIN_N. Pure. */
function conformalInterval(values, { alpha = ALPHA, minN = MIN_N } = {}) {
  const x = values.filter(Number.isFinite).sort((a, b) => a - b)
  const n = x.length
  if (n < minN) return null
  const lo = Math.max(1, Math.floor((n + 1) * (alpha / 2)))
  const hi = Math.min(n, Math.ceil((n + 1) * (1 - alpha / 2)))
  const median = n % 2 ? x[(n - 1) / 2] : (x[n / 2 - 1] + x[n / 2]) / 2
  return { low: +x[lo - 1].toFixed(1), high: +x[hi - 1].toFixed(1), median: +median.toFixed(1), n }
}

/**
 * Fraction of picks whose outcome landed inside the range built from strictly
 * EARLIER picks (time order). null until there are minN + 20 to test. Pure.
 */
function walkForwardCoverage(records, horizon, { alpha = ALPHA, minN = MIN_N } = {}) {
  const rows = records
    .map(r => ({ t: new Date(r.generatedAt).getTime(), v: realized(r, horizon) }))
    .filter(r => Number.isFinite(r.t) && Number.isFinite(r.v))
    .sort((a, b) => a.t - b.t)
  if (rows.length < minN + 20) return null
  let tested = 0, inside = 0
  // The most recent MAX_TESTS picks: recent coverage is the question, and it
  // keeps a scan's cost bounded however long the record grows.
  const start = Math.max(minN, rows.length - MAX_TESTS)
  let known = 0   // rows are time-sorted, so "outcome known by t" is a prefix
  for (let i = start; i < rows.length; i++) {
    // Only picks whose outcome was already KNOWN when pick i was made.
    while (known < i && rows[known].t + horizon * DAY <= rows[i].t) known++
    const iv = conformalInterval(rows.slice(0, known).map(r => r.v), { alpha, minN })
    if (!iv) continue
    tested++
    if (rows[i].v >= iv.low && rows[i].v <= iv.high) inside++
  }
  return tested >= 20 ? { tested, coverage: +(inside / tested).toFixed(3) } : null
}

/**
 * The range for one pick. `records` are resolved predictions. Horizon 30 when
 * the segment has MIN_N 30-day outcomes, else 7. Pure.
 */
function outcomeRange(records, { assetType = null, alpha = ALPHA, minN = MIN_N } = {}) {
  const all = records || []
  const segs = [
    ...(assetType ? [{ basis: `${assetType} picks`, rows: all.filter(r => assetOf(r) === assetType) }] : []),
    { basis: 'all picks', rows: all },
  ]
  for (const horizon of [30, 7]) {
    for (const seg of segs) {
      const iv = conformalInterval(seg.rows.map(r => realized(r, horizon)), { alpha, minN })
      if (!iv) continue
      const check = walkForwardCoverage(seg.rows, horizon, { alpha, minN })
      const nominal = 1 - alpha
      return {
        ...iv, horizon, basis: seg.basis, nominal,
        measuredCoverage: check?.coverage ?? null,
        // Exchangeability is an assumption; a range that has not held is said to.
        reliable: check ? check.coverage >= nominal - 0.1 : null,
        text: `past ${seg.basis} at ${horizon}d: ${iv.low > 0 ? '+' : ''}${iv.low}% to ${iv.high > 0 ? '+' : ''}${iv.high}% (${Math.round(nominal * 100)}% of n=${iv.n}${check ? `; held ${Math.round(check.coverage * 100)}% walk-forward` : ''})`,
      }
    }
  }
  return null
}

module.exports = { MIN_N, ALPHA, conformalInterval, walkForwardCoverage, outcomeRange, realized }
