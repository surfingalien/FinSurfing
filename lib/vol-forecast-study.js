'use strict'
/**
 * lib/vol-forecast-study.js — should a GARCH-family model replace the 21-day
 * volatility forecast every surface uses?
 *
 * lib/quant-snapshot.js forecasts the next 21 sessions' volatility as the
 * median of GARCH(1,1), EWMA, Yang–Zhang and trailing realised volatility. That
 * forecast sizes stops (plan-odds, stop noise), the Brain's QUANT CONTEXT and
 * the Research Desk's volatility item. A better model should replace it only
 * when it has forecast better on data it never saw — so this study measures it:
 *
 *   - for each symbol, every 21 sessions (non-overlapping), take the ~year of
 *     bars the snapshot would have had at that date;
 *   - forecast the next 21 sessions' volatility with the CURRENT method and
 *     with each model in lib/quant/vol-models.js fitted on those returns only;
 *   - score each against the realised variance of the next 21 sessions with
 *     QLIKE (RV/F − ln(RV/F) − 1: zero when exact, robust to a noisy proxy);
 *   - average the loss difference (model − current) per DATE across symbols —
 *     one market day moves every stock together, so dates are the independent
 *     units — and t-test the dates.
 *
 * A model is ADOPTED only when its mean difference is negative with t below
 * −Φ⁻¹(1 − 0.05/k), k = models tried (one-sided, Bonferroni), over at least
 * MIN_DATES dates; among several, the lowest loss wins. Otherwise nothing
 * changes. The store is rewritten weekly, so an adoption that stops holding
 * is dropped on the next run.
 *
 * Store: data/vol-forecast-study.json (durable-files). Tests: tests/vol-forecast-study.test.js
 */
const fs = require('fs')
const path = require('path')
const L = require('./quant/linalg')
const VM = require('./quant/vol-models')
const { DATA_DIR } = require('./data-dir')

const FILE = path.join(DATA_DIR, 'vol-forecast-study.json')
const HORIZON = 21
const WINDOW = 252          // bars the snapshot normally has (1 year)
const MIN_DATES = 20
const ANN = 252

const logReturns = c => { const r = []; for (let i = 1; i < c.length; i++) if (c[i - 1] > 0 && c[i] > 0) r.push(Math.log(c[i] / c[i - 1])); return r }
const qlike = (rv, f) => rv / f - Math.log(rv / f) - 1

/** The snapshot's current method, on bars ≤ the origin (must match quant-snapshot.symbolSnapshot). */
function currentForecast(bars) {
  return require('./quant-snapshot').volForecasts(bars).forecast21
}

/** Every model's 21-day forecast (annualised vol) from returns r. */
function modelForecasts(r, models) {
  const out = {}
  for (const m of models) {
    try { out[m] = VM.summarize(VM.fit(m, r, { maxIter: 800 }), { horizon: HORIZON, paths: 400 }).forecastVol21 } catch { out[m] = null }
  }
  return out
}

/**
 * Losses for one symbol: one row per origin {date, rv, current, models:{m:loss}}.
 * Origins every HORIZON bars, each with WINDOW bars before it and HORIZON after.
 */
async function symbolLosses(bars, { models = VM.MODELS, yieldFn = () => new Promise(r => setImmediate(r)) } = {}) {
  const b = (bars || []).filter(x => x && x.c > 0)
  const rows = []
  for (let o = WINDOW; o + HORIZON < b.length; o += HORIZON) {
    const past = b.slice(o - WINDOW, o + 1)                       // bars ≤ origin
    const fut = logReturns(b.slice(o, o + HORIZON + 1).map(x => x.c))
    if (fut.length < HORIZON) continue
    const rv = fut.reduce((a, x) => a + x * x, 0) * ANN / HORIZON
    if (!(rv > 0)) continue
    const cur = currentForecast(past)
    if (!(cur > 0)) continue
    const fc = modelForecasts(logReturns(past.map(x => x.c)), models)
    const row = { date: new Date(b[o].t).toISOString().slice(0, 10), rv, current: qlike(rv, cur * cur), models: {} }
    for (const m of models) if (fc[m] > 0) row.models[m] = qlike(rv, fc[m] * fc[m])
    rows.push(row)
    await yieldFn()
  }
  return rows
}

/** Pure: per-symbol rows → verdict. `rowsBySymbol`: {SYM: rows}. */
function evaluate(rowsBySymbol, { models = VM.MODELS, minDates = MIN_DATES } = {}) {
  const byDate = new Map()
  for (const rows of Object.values(rowsBySymbol)) for (const r of rows) {
    if (!byDate.has(r.date)) byDate.set(r.date, [])
    byDate.get(r.date).push(r)
  }
  const dates = [...byDate.keys()].sort()
  // One-sided Bonferroni bar; the Student-t correction (Cornish–Fisher, df = dates − 1) because dates are few.
  const z = L.normInv(1 - 0.05 / models.length), df = Math.max(1, dates.length - 1)
  const tBar = z + (z ** 3 + z) / (4 * df)
  const currentLoss = L.mean(dates.map(d => L.mean(byDate.get(d).map(r => r.current))))
  const results = models.map(m => {
    const diffs = [], losses = []
    for (const d of dates) {
      const rs = byDate.get(d).filter(r => r.models[m] != null)
      if (!rs.length) continue
      diffs.push(L.mean(rs.map(r => r.models[m] - r.current)))
      losses.push(L.mean(rs.map(r => r.models[m])))
    }
    const n = diffs.length, mean = n ? L.mean(diffs) : null
    const sd = n > 1 ? Math.sqrt(L.variance(diffs)) : null
    const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : null
    return { model: m, label: VM.LABELS[m], dates: n, meanLoss: n ? L.mean(losses) : null, meanDiff: mean, t, beats: n >= minDates && t != null && t < -tBar }
  })
  const winners = results.filter(r => r.beats).sort((a, b) => a.meanLoss - b.meanLoss)
  const adopted = winners[0]?.model ?? null
  return {
    dates: dates.length, symbols: Object.keys(rowsBySymbol).filter(s => rowsBySymbol[s].length).length,
    observations: Object.values(rowsBySymbol).reduce((a, r) => a + r.length, 0),
    currentLoss, tBar, results: results.sort((a, b) => (a.meanLoss ?? Infinity) - (b.meanLoss ?? Infinity)),
    adopted, adoptedLabel: adopted ? VM.LABELS[adopted] : null,
    reason: dates.length < minDates ? `only ${dates.length} dates (needs ${minDates}) — nothing adopted`
      : adopted ? `${VM.LABELS[adopted]} forecast 21-day volatility better than the current median across ${winners[0].dates} dates (t ${winners[0].t.toFixed(2)}, needs ≤ −${tBar.toFixed(2)}) — adopted`
      : 'no model beat the current median forecast by more than chance — nothing changes',
  }
}

/** Fetch, measure, persist. A run that reads too few symbols keeps the stored study. */
async function runStudy({ universe, fetchBars, save = true, minUniverse = 10, models = VM.MODELS, concurrency = 3 } = {}) {
  const rowsBySymbol = {}
  let i = 0
  const worker = async () => {
    while (i < universe.length) {
      const s = universe[i++]
      try { const b = await fetchBars(s); if (b && b.length > WINDOW + HORIZON * 3) rowsBySymbol[s] = await symbolLosses(b, { models }) } catch { /* one missing name is fine */ }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker))
  const ok = Object.keys(rowsBySymbol).length
  if (ok < minUniverse) throw new Error(`only ${ok} of ${universe.length} symbols had history — stored study kept`)
  const result = { at: new Date().toISOString(), horizon: HORIZON, window: WINDOW, requested: universe.length, ...evaluate(rowsBySymbol, { models }) }
  if (save) { fs.mkdirSync(path.dirname(FILE), { recursive: true }); require('./atomic-write').writeJsonAtomic(FILE, result); cache = { at: 0, v: null } }
  return result
}

let cache = { at: 0, v: null }
function load() {
  if (Date.now() - cache.at < 10 * 60_000) return cache.v
  let v = null
  try { v = JSON.parse(fs.readFileSync(FILE, 'utf8')) } catch { /* not run yet */ }
  cache = { at: Date.now(), v }
  return v
}

/** The model the snapshot should use, or null (keep the median). */
function adoptedModel() { const s = load(); return s?.adopted && VM.MODELS.includes(s.adopted) ? s.adopted : null }

/** Compact view for the UI. */
function summary() {
  const s = load()
  if (!s) return { ran: false, note: 'The weekly volatility-forecast study has not run yet.' }
  return { ran: true, at: s.at, dates: s.dates, symbols: s.symbols, adopted: s.adopted, adoptedLabel: s.adoptedLabel, reason: s.reason, tBar: s.tBar, currentLoss: s.currentLoss, results: s.results }
}

module.exports = { FILE, HORIZON, WINDOW, MIN_DATES, qlike, symbolLosses, evaluate, runStudy, adoptedModel, summary, _resetCache: () => { cache = { at: 0, v: null } } }
