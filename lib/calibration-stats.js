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

// ── Independent windows, ranking, drift, skill (ideas from calibrain-harness, MIT) ──

const DAY_MS = 86_400_000

/**
 * Count a stock once per outcome window. Two picks of the same symbol whose
 * outcome windows overlap share most of their outcome — an hourly scan that
 * names NVDA ten times in a week has one 30-day result, not ten — so counting
 * them separately makes every interval too narrow and every test too easy.
 * Per key (symbol by default), in time order, a record is kept only if it
 * starts after the previous KEPT record's window ended. Records with no key
 * or no time cannot be thinned and are kept. Original order is preserved.
 *   windowDays  number, or (record) => days
 */
function independentPicks(records, windowDays, { keyOf = r => r?.symbol, timeOf = r => Date.parse(r?.generatedAt) } = {}) {
  const list = Array.isArray(records) ? records : []
  const win = typeof windowDays === 'function' ? windowDays : () => windowDays
  const rows = list.map((r, i) => ({ r, i, k: keyOf(r), t: timeOf(r) }))
  const keep = new Set()
  const next = new Map()
  for (const x of rows.filter(x => x.k != null && x.k !== '' && Number.isFinite(x.t)).sort((a, b) => a.t - b.t || a.i - b.i)) {
    if (x.t >= (next.get(x.k) ?? -Infinity)) {
      keep.add(x.i)
      next.set(x.k, x.t + Math.max(0, Number(win(x.r)) || 0) * DAY_MS)
    }
  }
  return rows.filter(x => keep.has(x.i) || x.k == null || x.k === '' || !Number.isFinite(x.t)).map(x => x.r)
}

/** Average ranks (ties share the mean rank). */
function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0])
  const out = new Array(xs.length)
  for (let i = 0; i < idx.length;) {
    let j = i
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++
    const r = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) out[idx[k][1]] = r
    i = j + 1
  }
  return out
}

/**
 * Spearman rank correlation with a 95% interval (Fisher z, standard error
 * 1.06/√(n−3) — Fieller et al.'s correction for ranks). Null below 10 pairs.
 */
function spearman(x, y) {
  const pairs = x.map((v, i) => [v, y[i]]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
  const n = pairs.length
  if (n < 10) return { n, rho: null, lo: null, hi: null }
  const rx = ranks(pairs.map(p => p[0])), ry = ranks(pairs.map(p => p[1]))
  const mx = rx.reduce((a, b) => a + b, 0) / n, my = ry.reduce((a, b) => a + b, 0) / n
  let sxy = 0, sxx = 0, syy = 0
  for (let i = 0; i < n; i++) { const a = rx[i] - mx, b = ry[i] - my; sxy += a * b; sxx += a * a; syy += b * b }
  if (!(sxx > 0 && syy > 0)) return { n, rho: null, lo: null, hi: null }
  const rho = sxy / Math.sqrt(sxx * syy)
  const z = Math.atanh(Math.max(-0.999999, Math.min(0.999999, rho))), se = 1.06 / Math.sqrt(n - 3)
  return { n, rho: +rho.toFixed(3), lo: +Math.tanh(z - Z95 * se).toFixed(3), hi: +Math.tanh(z + Z95 * se).toFixed(3) }
}

/**
 * Page–Hinkley test for a persistent INCREASE in the mean of xs (pass the
 * negated series to watch for a decrease). delta = the drift ignored per step,
 * lambda = the alarm threshold, both in the units of xs.
 */
function pageHinkley(xs, { delta = 0.005, lambda = 1.5 } = {}) {
  let mean = 0, m = 0, mn = 0, ph = 0, alarmAt = null
  xs.forEach((x, t) => {
    mean += (x - mean) / (t + 1)
    m += x - mean - delta
    mn = Math.min(mn, m)
    ph = m - mn
    if (ph > lambda && alarmAt == null) alarmAt = t + 1
  })
  return { n: xs.length, ph: +ph.toFixed(4), threshold: lambda, alarm: alarmAt != null, alarmAt }
}

/**
 * Brier skill of a forecast against a reference forecast on binary outcomes:
 * 1 − Brier(model)/Brier(reference). Positive = the model's probabilities are
 * better than the reference's. The 90% interval is a seeded bootstrap over
 * picks. Null below `minN`.
 */
function brierSkill(pModel, pRef, ys, { minN = 30, draws = 1000, seed = 7 } = {}) {
  const rows = ys.map((y, i) => [pModel[i], pRef[i], y]).filter(([a, b, y]) => Number.isFinite(a) && Number.isFinite(b) && (y === 0 || y === 1))
  const n = rows.length
  if (n < minN) return { n, minN, skill: null, lo: null, hi: null }
  const sk = sel => {
    let bm = 0, br = 0
    for (const [a, b, y] of sel) { bm += (a - y) ** 2; br += (b - y) ** 2 }
    return br > 0 ? 1 - bm / br : null
  }
  let s = seed >>> 0 || 1
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647 }
  const boot = []
  for (let d = 0; d < draws; d++) {
    const sel = []
    for (let i = 0; i < n; i++) sel.push(rows[Math.floor(rnd() * n)])
    const v = sk(sel); if (v != null) boot.push(v)
  }
  boot.sort((a, b) => a - b)
  const q = p => (boot.length ? boot[Math.min(boot.length - 1, Math.floor(p * boot.length))] : null)
  const point = sk(rows)
  return { n, skill: point == null ? null : +point.toFixed(4), lo: q(0.05) == null ? null : +q(0.05).toFixed(4), hi: q(0.95) == null ? null : +q(0.95).toFixed(4) }
}

module.exports = { wilson, shrinkRate, normCdf, binomialPValue, benjaminiHochberg, validateThreshold, Z95, independentPicks, ranks, spearman, pageHinkley, brierSkill }
