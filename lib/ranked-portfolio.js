'use strict'
/**
 * lib/ranked-portfolio.js — many factors, one ranking, a portfolio you could
 * actually hold (ideas from Microsoft qlib, MIT; written from scratch).
 *
 * Factor mining (lib/factor-mining.js) tests each factor ALONE by its
 * information coefficient. The question an investor has is different: if a
 * model combined everything known at the close and held its top names, would
 * that portfolio beat simply owning the whole list, after costs? This module
 * answers it, walk-forward:
 *
 *   features  FEATURES — a broad price/volume set in the spirit of qlib's
 *             Alpha158 (returns, volatility, distance from moving averages and
 *             from highs/lows, range position, volume surge) plus the price
 *             factors of factor mining. Each reads bars ≤ the decision day.
 *             Ranked across the stocks of that day into [−0.5, 0.5].
 *   label     the cross-sectional percentile of the next HORIZON-session return.
 *   model     ridge regression refitted at every rebalance on all earlier
 *             rows whose label was already known (rebalances are HORIZON
 *             apart, so the newest training label ends on the decision day).
 *   portfolio top-K with a turnover limit (qlib's TopkDropout): keep the best
 *             K of {held} ∪ {the best N_DROP not held}, so at most N_DROP
 *             names change per rebalance; equal weight; each change pays half
 *             the round trip.
 *   benchmark the equal-weighted whole list on the same dates (no cost).
 *   baseline  the same portfolio rule ranked by 3-month momentum alone — does
 *             the model add anything over the simplest factor?
 *
 * Verdict on the per-rebalance excess return (rebalances do not overlap, so
 * they are independent units): `outperforms` needs t ≥ T_MIN AND both the
 * older and the newer half positive; `underperforms` t ≤ −T_MIN;
 * `insufficient` under MIN_TEST periods. The list is TODAY's large caps
 * (survivorship) and the returns are price-only on both sides — both stated
 * with every result.
 *
 * Store: data/ranked-portfolio.json (durable-files). Tests: tests/ranked-portfolio.test.js
 */

const fs = require('fs')
const path = require('path')
const { DATA_DIR } = require('./data-dir')
const { writeJsonAtomic } = require('./atomic-write')

const STORE_FILE = path.join(DATA_DIR, 'ranked-portfolio.json')
const HORIZON = 21
const TOP_K = 10
const N_DROP = 3
const MIN_TRAIN = 12          // rebalances of history before the first test
const MIN_TEST = 12
const T_MIN = 2
const RIDGE = 5
const MIN_NAMES = 15          // a cross-section thinner than this is skipped

const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length
const sdOf = xs => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1)) }

const ret = (c, i, w) => (i - w >= 0 && c[i - w] > 0 ? c[i] / c[i - w] - 1 : null)
function vol(c, i, w) {
  if (i - w < 1) return null
  const r = []
  for (let k = i - w + 1; k <= i; k++) if (c[k - 1] > 0) r.push(Math.log(c[k] / c[k - 1]))
  return r.length >= w * 0.8 ? sdOf(r) : null
}
function maGap(c, i, w) { if (i - w + 1 < 0) return null; let s = 0; for (let k = i - w + 1; k <= i; k++) s += c[k]; return c[i] / (s / w) - 1 }
function hiGap(p, i, w) { if (i - w + 1 < 0) return null; let m = -Infinity; for (let k = i - w + 1; k <= i; k++) m = Math.max(m, p.h[k]); return p.c[i] / m - 1 }
function loGap(p, i, w) { if (i - w + 1 < 0) return null; let m = Infinity; for (let k = i - w + 1; k <= i; k++) m = Math.min(m, p.l[k]); return p.c[i] / m - 1 }
function rsv(p, i, w) {
  if (i - w + 1 < 0) return null
  let hi = -Infinity, lo = Infinity
  for (let k = i - w + 1; k <= i; k++) { hi = Math.max(hi, p.h[k]); lo = Math.min(lo, p.l[k]) }
  return hi > lo ? (p.c[i] - lo) / (hi - lo) : null
}
function volSurge(p, i, w) { if (i - w < 0) return null; let s = 0; for (let k = i - w; k < i; k++) s += p.v[k]; const m = s / w; return m > 0 ? p.v[i] / m : null }

/** The feature set. Every function reads bars ≤ i only. */
const FEATURES = {
  roc5:  (p, i) => ret(p.c, i, 5),   roc10: (p, i) => ret(p.c, i, 10), roc20: (p, i) => ret(p.c, i, 20), roc60: (p, i) => ret(p.c, i, 60),
  roc120: (p, i) => ret(p.c, i, 120), roc250: (p, i) => ret(p.c, i, 250),
  vol5: (p, i) => vol(p.c, i, 5), vol20: (p, i) => vol(p.c, i, 20), vol60: (p, i) => vol(p.c, i, 60),
  ma5: (p, i) => maGap(p.c, i, 5), ma20: (p, i) => maGap(p.c, i, 20), ma60: (p, i) => maGap(p.c, i, 60), ma200: (p, i) => maGap(p.c, i, 200),
  hi20: (p, i) => hiGap(p, i, 20), hi60: (p, i) => hiGap(p, i, 60), hi250: (p, i) => hiGap(p, i, 250),
  lo20: (p, i) => loGap(p, i, 20), lo60: (p, i) => loGap(p, i, 60),
  rsv20: (p, i) => rsv(p, i, 20), rsv60: (p, i) => rsv(p, i, 60),
  vsurge20: (p, i) => volSurge(p, i, 20),
  volratio: (p, i) => { const a = vol(p.c, i, 5), b = vol(p.c, i, 60); return a != null && b > 0 ? a / b : null },
}

/** Rank values across a cross-section into [−0.5, 0.5]; missing → 0 (the middle). */
function rankScale(vals) {
  const idx = vals.map((v, i) => [v, i]).filter(([v]) => Number.isFinite(v)).sort((a, b) => a[0] - b[0])
  const out = vals.map(() => 0)
  const m = idx.length
  if (m < 2) return out
  for (let r = 0; r < m; r++) out[idx[r][1]] = r / (m - 1) - 0.5
  return out
}

/** One decision day: scaled features, and (when known) the label and the raw forward return. */
function crossSection(panel, date, features = FEATURES, horizon = HORIZON) {
  const names = [], raw = [], fwd = [], ends = []
  for (const [sym, p] of Object.entries(panel)) {
    const i = p.idx.get(date)
    if (i == null || i < 60) continue
    names.push(sym)
    raw.push(Object.values(features).map(f => { const v = f(p, i); return Number.isFinite(v) ? v : null }))
    const known = i + horizon < p.c.length && p.c[i] > 0
    fwd.push(known ? p.c[i + horizon] / p.c[i] - 1 : null)
    ends.push(known ? p.days[i + horizon] : null)     // the day this label became known
  }
  const k = Object.keys(features).length
  const cols = Array.from({ length: k }, (_, j) => rankScale(raw.map(r => r[j])))
  const X = names.map((_, r) => cols.map(col => col[r]))
  const y = rankScale(fwd).map((v, r) => (fwd[r] == null ? null : v))
  return { date, names, X, y, fwd, ends }
}

/** Ridge regression on rows {x, y}; returns weights (no intercept — features and labels are centred). */
function fitRidge(rows, lambda = RIDGE) {
  const { solve } = require('./quant/linalg')
  const k = rows[0].x.length
  const A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0)
  for (const { x, y } of rows) for (let a = 0; a < k; a++) { b[a] += x[a] * y; for (let c = 0; c < k; c++) A[a][c] += x[a] * x[c] }
  for (let a = 0; a < k; a++) A[a][a] += lambda
  return solve(A, b)
}
const score = (w, x) => x.reduce((s, v, j) => s + v * w[j], 0)

/** qlib's TopkDropout, equal weight: keep the best K of {held} ∪ {best nDrop not held}. */
function rebalance(held, ranked, { topK = TOP_K, nDrop = N_DROP } = {}) {
  const avail = new Set(ranked)
  const keepHeld = [...held].filter(s => avail.has(s))
  const notHeld = ranked.filter(s => !held.has(s))
  const pool = held.size === 0 ? ranked.slice(0, topK) : [...keepHeld, ...notHeld.slice(0, nDrop)]
  const order = new Map(ranked.map((s, i) => [s, i]))
  const next = new Set(pool.sort((a, b) => order.get(a) - order.get(b)).slice(0, topK))
  const sold = [...held].filter(s => !next.has(s)), bought = [...next].filter(s => !held.has(s))
  return { next, sold, bought }
}

/** Walk the decision days with a scorer; returns per-period portfolio / benchmark / excess returns. Pure. */
function walk(sections, scorer, { topK = TOP_K, nDrop = N_DROP, costBps = 10, startAt = MIN_TRAIN } = {}) {
  const half = costBps / 2 / 10_000
  let held = new Set()
  const periods = []
  for (let j = startAt; j < sections.length; j++) {
    const cs = sections[j]
    if (cs.names.length < MIN_NAMES) continue
    const scores = scorer(j, cs)
    if (!scores) continue
    const ranked = cs.names.map((s, r) => [s, scores[r]]).sort((a, b) => b[1] - a[1]).map(x => x[0])
    const { next, sold, bought } = rebalance(held, ranked, { topK, nDrop })
    held = next
    const rOf = new Map(cs.names.map((s, r) => [s, cs.fwd[r]]))
    const port = [...held].map(s => rOf.get(s)).filter(Number.isFinite)
    const all = cs.fwd.filter(Number.isFinite)
    if (!port.length || !all.length) continue      // the newest day has no outcome yet
    const cost = (sold.length + bought.length) / topK * half
    const p = mean(port) - cost, b = mean(all)
    const sc = cs.names.map((s, r) => [scores[r], cs.fwd[r]]).filter(([, f]) => Number.isFinite(f))
    periods.push({ date: cs.date, portfolio: +p.toFixed(5), benchmark: +b.toFixed(5), excess: +(p - b).toFixed(5), turnover: sold.length + bought.length, ic: icOf(sc.map(x => x[0]), sc.map(x => x[1])) })
  }
  return { periods, held: [...held] }
}

function icOf(a, b) {
  if (a.length < 5) return null
  const ra = rankScale(a), rb = rankScale(b)
  const ma = mean(ra), mb = mean(rb)
  let sab = 0, saa = 0, sbb = 0
  for (let i = 0; i < ra.length; i++) { sab += (ra[i] - ma) * (rb[i] - mb); saa += (ra[i] - ma) ** 2; sbb += (rb[i] - mb) ** 2 }
  return saa > 0 && sbb > 0 ? +(sab / Math.sqrt(saa * sbb)).toFixed(4) : null
}

/** Summary + verdict of a walk. Pure. */
function summarize(periods, horizon = HORIZON) {
  const n = periods.length
  const out = { periods: n, minPeriods: MIN_TEST, perYear: +(252 / horizon).toFixed(1) }
  if (!n) return { ...out, verdict: 'insufficient' }
  const ex = periods.map(p => p.excess)
  const m = mean(ex), s = sdOf(ex), t = s > 0 ? m / (s / Math.sqrt(n)) : null
  const half = Math.floor(n / 2)
  const older = half ? mean(ex.slice(0, half)) : null, newer = n - half ? mean(ex.slice(half)) : null
  const growth = key => periods.reduce((g, p) => g * (1 + p[key]), 1) - 1
  const ics = periods.map(p => p.ic).filter(Number.isFinite)
  const icM = ics.length ? mean(ics) : null, icS = ics.length > 1 ? sdOf(ics) : 0
  Object.assign(out, {
    meanExcessPct: +(m * 100).toFixed(3), t: t == null ? null : +t.toFixed(2),
    olderPct: older == null ? null : +(older * 100).toFixed(3), newerPct: newer == null ? null : +(newer * 100).toFixed(3),
    hitRate: +(ex.filter(x => x > 0).length / n).toFixed(3),
    portfolioTotalPct: +(growth('portfolio') * 100).toFixed(2), benchmarkTotalPct: +(growth('benchmark') * 100).toFixed(2),
    meanTurnover: +mean(periods.map(p => p.turnover)).toFixed(2),
    meanIc: icM == null ? null : +icM.toFixed(4), icT: icM != null && icS > 0 ? +(icM / (icS / Math.sqrt(ics.length))).toFixed(2) : null,
    curve: periods.map(p => ({ date: p.date, portfolio: p.portfolio, benchmark: p.benchmark })),
  })
  out.verdict = n < MIN_TEST ? 'insufficient'
    : t != null && t >= T_MIN && older > 0 && newer > 0 ? 'outperforms'
    : t != null && t <= -T_MIN ? 'underperforms'
    : 'no-difference'
  return out
}

/**
 * The whole study over a factor-mining panel (lib/factor-mining.js:toPanel). Pure.
 * Rebalance days come from factor-mining.rebalanceDates (HORIZON apart, after a year of warm-up),
 * plus the newest common day for today's ranking.
 */
function study(panel, { features = FEATURES, topK = TOP_K, nDrop = N_DROP, costBps = 10, lambda = RIDGE } = {}) {
  const fm = require('./factor-mining')
  const dates = fm.rebalanceDates(panel, HORIZON)
  const sections = dates.map(d => crossSection(panel, d, features))
  // The model: refit at each decision on every earlier row whose label is known.
  const model = (j, cs) => {
    const rows = []
    for (let q = 0; q < j; q++) {
      const s = sections[q]
      // Only labels already known at the close of the decision day (a gap in one stock's bars can push one past it).
      s.X.forEach((x, r) => { if (s.y[r] != null && s.ends[r] <= cs.date) rows.push({ x, y: s.y[r] }) })
    }
    if (rows.length < 50) return null
    const w = fitRidge(rows, lambda)
    return cs.X.map(x => score(w, x))
  }
  const momIdx = Object.keys(features).indexOf('roc60')
  const momentum = (j, cs) => cs.X.map(x => x[momIdx])
  const ridge = walk(sections, model, { topK, nDrop, costBps })
  const mom = walk(sections, momentum, { topK, nDrop, costBps })
  // Today's ranking: the newest day every name shares, scored by a model fitted on all known labels.
  const lastDate = latestCommonDay(panel)
  let today = null
  if (lastDate) {
    const cs = crossSection(panel, lastDate, features)
    const all = sections.flatMap(s => s.X.map((x, r) => (s.y[r] != null ? { x, y: s.y[r] } : null)).filter(Boolean))
    if (all.length >= 50 && cs.names.length >= MIN_NAMES) {
      const w = fitRidge(all, lambda)
      const ranked = cs.names.map((s, r) => ({ symbol: s, score: +score(w, cs.X[r]).toFixed(4) })).sort((a, b) => b.score - a.score)
      today = { date: lastDate, top: ranked.slice(0, topK), names: ranked.length,
        weights: Object.fromEntries(Object.keys(features).map((f, j) => [f, +w[j].toFixed(4)])) }
    }
  }
  return {
    params: { horizon: HORIZON, topK, nDrop, costBps, lambda, features: Object.keys(features), minTrain: MIN_TRAIN },
    universe: Object.keys(panel).length, decisionDays: dates.length,
    model: summarize(ridge.periods), momentum: summarize(mom.periods),
    holding: ridge.held, today,
    caveats: [
      'The list is today\'s large caps, so names that fell out of it are missing (survivorship) — this flatters every long strategy.',
      'Returns are price-only on both sides (no dividends for the list of names).',
    ],
  }
}

function latestCommonDay(panel) {
  const syms = Object.keys(panel)
  if (!syms.length) return null
  const count = new Map()
  for (const s of syms) for (const d of panel[s].days.slice(-10)) count.set(d, (count.get(d) || 0) + 1)
  const days = [...count.entries()].filter(([, n]) => n >= syms.length * 0.8).map(([d]) => d).sort()
  return days.at(-1) || null
}

function read(file = STORE_FILE) { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } }

/** Fetch the universe's bars, run the study, store it. A run reading too few names keeps the stored study. */
async function run({ fetchBars, universe = require('./factor-mining').defaultUniverse(), concurrency = 4, save = true, minUniverse = 20, file = STORE_FILE } = {}) {
  const barsBySymbol = {}
  const queue = [...universe]
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const s = queue.shift()
      try { barsBySymbol[s] = await fetchBars(s) } catch { /* one missing name is fine */ }
    }
  }))
  const panel = require('./factor-mining').toPanel(barsBySymbol)
  const n = Object.keys(panel).length
  if (n < minUniverse) throw new Error(`only ${n} of ${universe.length} names had enough history — keeping the stored study`)
  const out = { ranAt: new Date().toISOString(), ...study(panel) }
  if (save) writeJsonAtomic(file, out)
  return out
}

module.exports = {
  STORE_FILE, HORIZON, TOP_K, N_DROP, MIN_TRAIN, MIN_TEST, T_MIN, FEATURES,
  rankScale, crossSection, fitRidge, rebalance, walk, summarize, study, latestCommonDay, read, run, icOf,
}
