'use strict'
/**
 * lib/persona-rule-study.js — has each Advisory persona's rule worked over the
 * last five years?
 *
 * The page records every persona call from today on, so a persona's own hit
 * rate takes months to mean anything. This answers the question now, on past
 * data, with nothing the persona could not have known: every 21 sessions,
 * each stock in the universe (~70 large caps) is scored with the page's own
 * function (lib/persona-rules.js) from
 *   - revenue growth, EPS growth (TTM vs a year earlier), P/E — SEC figures as
 *     FIRST FILED by that date (sec-facts.snapshotAt), never later restatements
 *   - beta to SPY over the past 252 sessions, RSI and the 50-day average from
 *     closes up to that date
 *   - dividend yield: not known point-in-time here, so left out (the page's
 *     +5 stability bonus never applies in the test — stated with the result)
 * The persona's TOP FIFTH is held for the next 21 sessions and compared with
 * the equal-weighted universe, after the cost of the names that changed (half
 * the stock round trip per change). Rebalances never overlap.
 *
 * Verdict per persona: `outperforms` mean excess > 0 with t ≥ 2 and both
 * halves positive; `underperforms` t ≤ −2; else `no-difference`; fewer than
 * MIN_PERIODS rebalances `insufficient`. Also the mean rank correlation (IC)
 * between score and next-month return. Survivorship (today's large caps) is
 * stated. A run reading fewer than `minUniverse` names keeps the stored study.
 *
 * Tests: tests/persona-rule-study.test.js
 */

const path = require('path')
const atomic = require('./atomic-write')
const rules = require('./persona-rules')
const fm = require('./factor-mining')

const FILE = path.join(require('./data-dir').DATA_DIR, 'persona-rule-study.json')
const HORIZON = 21
const MIN_PERIODS = 24
const COST_BPS = 10          // stock round trip (expected-value.ROUND_TRIP_BPS.stock)
const DAY = 86_400_000

const mean = a => a.reduce((x, y) => x + y, 0) / (a.length || 1)
/** Deterministic pseudo-random order for (date, symbol). */
function tieKey(d, s) {
  let h = 2166136261
  for (const ch of `${d}|${s}`) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0 }
  return h
}
function tStat(xs) {
  if (xs.length < 3) return null
  const m = mean(xs), sd = Math.sqrt(xs.reduce((a, x) => a + (x - m) ** 2, 0) / (xs.length - 1))
  return sd > 0 ? m / (sd / Math.sqrt(xs.length)) : null
}

/** Beta of a stock's daily returns to SPY's over the `n` sessions ending at date d. */
function betaAt(stock, spy, d, n = 252) {
  const i = stock.idx.get(d), j = spy.idx.get(d)
  if (i == null || j == null || i < n || j < n) return null
  const xs = [], ys = []
  for (let k = i - n + 1; k <= i; k++) {
    const day = stock.days[k], jj = spy.idx.get(day), prevDay = stock.days[k - 1], jp = spy.idx.get(prevDay)
    if (jj == null || jp == null) continue
    ys.push(stock.c[k] / stock.c[k - 1] - 1); xs.push(spy.c[jj] / spy.c[jp] - 1)
  }
  if (xs.length < n * 0.8) return null
  const mx = mean(xs), my = mean(ys)
  let cov = 0, vx = 0
  for (let k = 0; k < xs.length; k++) { cov += (xs[k] - mx) * (ys[k] - my); vx += (xs[k] - mx) ** 2 }
  return vx > 0 ? cov / vx : null
}

/** The page's inputs for one stock on date d, from data known by d. */
function inputsAt(stock, spy, d, snapAt) {
  const i = stock.idx.get(d)
  const price = stock.c[i]
  const snap = snapAt ? snapAt(d, price) : null
  const prior = snapAt ? snapAt(new Date(Date.parse(d) - 365 * DAY).toISOString().slice(0, 10), null) : null
  const eg = snap?.epsTtm != null && prior?.epsTtm > 0 ? (snap.epsTtm / prior.epsTtm - 1) * 100 : null
  return {
    revenueGrowthPct: snap?.revenueGrowthYoY ?? null,
    earningsGrowthPct: eg,
    pe: snap?.pe ?? null,
    beta: betaAt(stock, spy, d),
    dividendYield: null,
  }
}

/**
 * Pure core. panel: factor-mining toPanel output (must include SPY);
 * snapshots: { SYM: (dateISO, price) => sec snapshot | null }.
 */
function study(panel, snapshots = {}, { horizon = HORIZON, costBps = COST_BPS, personas = Object.keys(rules.PERSONA_WEIGHTS) } = {}) {
  const spy = panel.SPY
  if (!spy) throw new Error('SPY bars are needed for beta')
  const names = Object.keys(panel).filter(s => s !== 'SPY')
  const stockPanel = Object.fromEntries(names.map(s => [s, panel[s]]))
  const dates = fm.rebalanceDates(stockPanel, horizon)
  const out = {}
  const prevTop = {}
  for (const id of personas) out[id] = { periods: [], ics: [] }
  for (const d of dates) {
    const rows = []
    for (const s of names) {
      const p = panel[s], i = p.idx.get(d)
      if (i == null || i + horizon >= p.c.length) continue
      rows.push({ s, f: inputsAt(p, spy, d, snapshots[s]), closes: p.c.slice(0, i + 1), fwd: p.c[i + horizon] / p.c[i] - 1 })
    }
    if (rows.length < 10) continue
    const all = mean(rows.map(r => r.fwd))
    for (const id of personas) {
      const scored = rows.map(r => ({ s: r.s, score: rules.scoreFor(id, r.f, r.closes), fwd: r.fwd }))
      // Equal scores (the page clamps at 0 and 100) are drawn in a seeded
      // random order per date — an alphabetical tie-break put the same
      // A-names in every top fifth.
      scored.sort((a, b) => b.score - a.score || tieKey(d, a.s) - tieKey(d, b.s))
      const cutScore = scored[Math.max(2, Math.floor(scored.length / 5)) - 1]?.score
      out[id].ties = (out[id].ties || 0) + (scored.filter(x => x.score === cutScore).length > 1 ? 1 : 0)
      const top = scored.slice(0, Math.max(2, Math.floor(scored.length / 5)))
      const set = new Set(top.map(x => x.s))
      const changed = prevTop[id] ? top.filter(x => !prevTop[id].has(x.s)).length / top.length : 1
      prevTop[id] = set
      const excess = mean(top.map(x => x.fwd)) - all - changed * (costBps / 10_000)
      out[id].periods.push({ date: d, excess, top: top.map(x => x.s).slice(0, 5) })
      const ic = fm.spearman(scored.map(x => x.score), scored.map(x => x.fwd))
      if (ic != null) out[id].ics.push(ic)
    }
  }
  const result = {}
  for (const [id, r] of Object.entries(out)) {
    const ex = r.periods.map(p => p.excess)
    const half = Math.floor(ex.length / 2)
    const t = tStat(ex)
    const res = {
      periods: ex.length,
      meanExcessPct: ex.length ? +(mean(ex) * 100).toFixed(2) : null,
      t: t == null ? null : +t.toFixed(2),
      olderHalfPct: half ? +(mean(ex.slice(0, half)) * 100).toFixed(2) : null,
      newerHalfPct: half ? +(mean(ex.slice(half)) * 100).toFixed(2) : null,
      hitRate: ex.length ? +(ex.filter(x => x > 0).length / ex.length).toFixed(2) : null,
      icMean: r.ics.length ? +mean(r.ics).toFixed(3) : null,
      latestTop: r.periods.length ? r.periods[r.periods.length - 1].top : [],
      // Months where the top fifth's cut fell inside a group of equal scores.
      tiedCutMonths: r.ties || 0,
    }
    res.verdict = ex.length < MIN_PERIODS ? 'insufficient'
      : t != null && t >= 2 && res.olderHalfPct > 0 && res.newerHalfPct > 0 ? 'outperforms'
        : t != null && t <= -2 ? 'underperforms' : 'no-difference'
    result[id] = res
  }
  return { horizon, costBps, universe: names.length, dates: dates.length, personas: result }
}

function readStudy(file = FILE) {
  try { return JSON.parse(require('fs').readFileSync(file, 'utf8')) } catch { return null }
}

/** Live run: bars + SEC facts for the universe and SPY; saves unless too few names. */
async function run({ fetchBars, fetchFacts, universe = fm.defaultUniverse(), concurrency = 4, save = true, minUniverse = 20, file = FILE } = {}) {
  const secFacts = require('./sec-facts')
  const syms = [...new Set(universe)].filter(s => s !== 'SPY')
  const bars = {}, facts = {}
  const queue = [...syms]
  async function worker() {
    while (queue.length) {
      const s = queue.shift()
      const b = await fetchBars(s).catch(() => null)
      if (b?.length) bars[s] = b
      const c = fetchFacts ? await fetchFacts(s).catch(() => null) : null
      if (c) facts[s] = c
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  bars.SPY = await fetchBars('SPY').catch(() => null)
  const panel = fm.toPanel(bars)
  const priced = Object.keys(panel).filter(s => s !== 'SPY').length
  if (!panel.SPY || priced < minUniverse) throw new Error(`only ${priced} names had five years of prices${panel.SPY ? '' : ' and SPY had none'} — the stored study is kept`)
  const snapshots = Object.fromEntries(Object.entries(facts).map(([s, c]) => [s, (d, price) => secFacts.snapshotAt(c, d, { price })]))
  const res = study(panel, snapshots)
  const body = {
    ranAt: new Date().toISOString(), ...res, withFundamentals: Object.keys(facts).length,
    caveats: [
      "Universe is today's large caps (survivorship): names that fell out of it over five years are missing, which flatters every rule alike.",
      'Fundamentals are SEC figures as first filed by each date; dividend yield is not known point-in-time here, so the page\'s +5 stability bonus never applies in the test.',
      'Each rebalance holds the persona\'s top fifth for 21 sessions against all names equally weighted, after half the round trip on each name that changed.',
    ],
  }
  if (save) atomic.writeJsonAtomic(file, body)
  return body
}

module.exports = { FILE, HORIZON, MIN_PERIODS, betaAt, inputsAt, study, readStudy, run }
