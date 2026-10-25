'use strict'

/**
 * lib/factor-mining.js — which price-based factors actually RANK stocks by
 * their next month's return, measured across a whole list.
 *
 * The strategy library (lib/strategy-library.js) asks a per-symbol question:
 * does this rule beat holding THIS stock? A factor asks a cross-sectional one:
 * on a given day, do the names scoring highest go on to beat the names
 * scoring lowest? lib/factor-model.js gives every scan momentum / trend /
 * low-vol scores, but nothing ever checked that those factors rank anything
 * on this universe.
 *
 * Method (all computed from daily bars, no model involved):
 *   1. Every CANDIDATE factor is a function of one stock's bars up to day i.
 *   2. Every `horizon` (21) trading days — non-overlapping, so one month's
 *      move is counted once — rank the universe on the factor and on its
 *      return over the NEXT `horizon` days; the Spearman correlation of the
 *      two ranks is that period's information coefficient (IC).
 *   3. Walk-forward: the older 70% of periods choose the factor's direction
 *      (momentum might work as momentum, or as reversal); the newest 30%,
 *      never looked at while choosing, must confirm it.
 *   4. Overfitting correction: testing a dozen factors and keeping the best
 *      selects for luck, exactly like keeping the best of many strategies.
 *      The train IC series of every candidate is a trial; a factor is
 *      admitted only if its Deflated Sharpe (lib/overfitting.js) against the
 *      best of that many skill-less trials clears DSR_MIN — every candidate
 *      counts, rejected ones included.
 *
 * Verdicts: `admitted` / `failed-holdout` / `luck` (DSR) / `insufficient`.
 * An admitted factor also stores the universe's latest values, so any
 * symbol's percentile on it can be read from its own bars later.
 *
 * Known bias, stated with every result: the universe is TODAY's large caps, so
 * names that fell out of it over five years are missing (survivorship). It
 * flatters factors that buy past winners; the holdout guards against luck,
 * not against this.
 *
 * Pure except where a caller passes `fetchBars`. Tests: tests/factor-mining.test.js
 */

const { returnStats, probabilisticSharpe, expectedMaxSharpe } = require('./overfitting')

const HORIZON    = 21
const WARMUP     = 252
const MIN_CROSS  = 12      // names with a value AND a forward return on a date
const TRAIN_FRAC = 0.7
// Stricter than the strategy library's DSR_MIN (0.5). That one sits behind a
// forward-only re-validation that keeps retiring luck; a factor is admitted
// once per run and read straight into the dossier, so the gate must do the
// work alone. Tuned on pure-noise universes (tests pin the false-admission
// rate) — at 0.5 the best noise factor passed about half the time by
// construction, since 0.5 means "as good as the expected luckiest".
const FACTOR_DSR_MIN = 0.9
const HOLDOUT_T      = 1

// ── Candidate factors (each reads bars ≤ i only) ─────────────────────────────
const ret = (c, i, k) => (i - k >= 0 && c[i - k] > 0 ? c[i] / c[i - k] - 1 : null)
function dailyRets(c, i, n) {
  if (i - n < 0) return null
  const r = []
  for (let k = i - n + 1; k <= i; k++) if (c[k - 1] > 0) r.push(c[k] / c[k - 1] - 1)
  return r.length >= n * 0.8 ? r : null
}
const mean = xs => xs.reduce((a, b) => a + b, 0) / xs.length
const sd = xs => { const m = mean(xs); return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1)) }

const FACTORS = {
  mom_12_1:   { label: '12-1 month momentum',        fn: ({ c }, i) => (i >= 252 && c[i - 252] > 0 ? c[i - 21] / c[i - 252] - 1 : null) },
  mom_6_1:    { label: '6-1 month momentum',         fn: ({ c }, i) => (i >= 126 && c[i - 126] > 0 ? c[i - 21] / c[i - 126] - 1 : null) },
  mom_3m:     { label: '3-month return',             fn: ({ c }, i) => ret(c, i, 63) },
  rev_1m:     { label: '1-month reversal',           fn: ({ c }, i) => { const r = ret(c, i, 21); return r == null ? null : -r } },
  rev_1w:     { label: '1-week reversal',            fn: ({ c }, i) => { const r = ret(c, i, 5); return r == null ? null : -r } },
  low_vol:    { label: 'low 60-day volatility',      fn: ({ c }, i) => { const r = dailyRets(c, i, 60); return r ? -sd(r) : null } },
  trend_200:  { label: 'distance above 200-day avg', fn: ({ c }, i) => (i >= 199 ? c[i] / mean(c.slice(i - 199, i + 1)) - 1 : null) },
  near_high:  { label: 'nearness to 52-week high',   fn: ({ c, h }, i) => (i >= 251 ? c[i] / Math.max(...h.slice(i - 251, i + 1)) : null) },
  vol_surge:  { label: 'volume surge (20d vs 120d)', fn: ({ v }, i) => {
    if (i < 120) return null
    const a = mean(v.slice(i - 19, i + 1)), b = mean(v.slice(i - 119, i + 1))
    return a > 0 && b > 0 ? Math.log(a / b) : null
  } },
  low_lottery: { label: 'no lottery days (low max 1-month daily gain)', fn: ({ c }, i) => { const r = dailyRets(c, i, 21); return r ? -Math.max(...r) : null } },
  low_skew:   { label: 'low 60-day return skew',     fn: ({ c }, i) => {
    const r = dailyRets(c, i, 60); if (!r) return null
    const m = mean(r), s = sd(r); if (!(s > 0)) return null
    return -mean(r.map(x => ((x - m) / s) ** 3))
  } },
  range_pos:  { label: 'position in 1-month range',  fn: ({ c, h, l }, i) => {
    if (i < 20) return null
    const hi = Math.max(...h.slice(i - 20, i + 1)), lo = Math.min(...l.slice(i - 20, i + 1))
    return hi > lo ? (c[i] - lo) / (hi - lo) : null
  } },
  // Fundamental factors from SEC filings (lib/sec-facts.js), each reading only
  // what had been FILED by day i — a quarter is unknown until its 10-Q lands.
  earnings_yield: { label: 'earnings yield (SEC-reported EPS / price)', fn: (p, i) => fund(p, i)?.earningsYield ?? null },
  sales_growth:   { label: 'revenue growth year over year (SEC)',       fn: (p, i) => fund(p, i)?.revenueGrowthYoY ?? null },
  roe:            { label: 'return on equity (SEC)',                    fn: (p, i) => fund(p, i)?.roe ?? null },
  low_accruals:   { label: 'low accruals — earnings backed by cash (SEC)', fn: (p, i) => { const a = fund(p, i)?.accruals; return a == null ? null : -a } },
  fcf_yield:      { label: 'free-cash-flow yield (SEC)',                fn: (p, i) => fund(p, i)?.fcfYield ?? null },
  // Lazy Prices: share of the latest 10-K's text carried over from the previous
  // 10-K, FILED before day i (lib/filing-change.js).
  filing_sim:     { label: '10-K text carried over from the previous 10-K (Lazy Prices, SEC)', fn: (p, i) => (p.filings ? require('./filing-change').simAsOf(p.filings, p.days[i]) : null) },
}

/** Point-in-time SEC snapshot for panel row p at bar i (memoised per row). */
function fund(p, i) {
  if (!p.fund || !p.days) return null
  p._snap ||= new Map()
  if (!p._snap.has(i)) p._snap.set(i, require('./sec-facts').snapshotAt(p.fund, p.days[i], { price: p.c[i] }))
  return p._snap.get(i)
}

// ── Statistics ───────────────────────────────────────────────────────────────
function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0])
  const r = new Array(xs.length)
  for (let k = 0; k < idx.length;) {
    let j = k
    while (j + 1 < idx.length && idx[j + 1][0] === idx[k][0]) j++
    const avg = (k + j) / 2 + 1
    for (let m = k; m <= j; m++) r[idx[m][1]] = avg
    k = j + 1
  }
  return r
}

/** Spearman rank correlation. null for <3 pairs or a constant side. Pure. */
function spearman(a, b) {
  if (a.length < 3 || a.length !== b.length) return null
  const ra = ranks(a), rb = ranks(b)
  const ma = mean(ra), mb = mean(rb)
  let num = 0, da = 0, db = 0
  for (let i = 0; i < ra.length; i++) { num += (ra[i] - ma) * (rb[i] - mb); da += (ra[i] - ma) ** 2; db += (rb[i] - mb) ** 2 }
  return da > 0 && db > 0 ? num / Math.sqrt(da * db) : null
}

/** Mean of the top-fifth's forward return minus the bottom fifth's. */
function quintileSpread(vals, fwd) {
  const order = vals.map((v, i) => [v, fwd[i]]).sort((a, b) => a[0] - b[0])
  const q = Math.max(1, Math.floor(order.length / 5))
  return mean(order.slice(-q).map(x => x[1])) - mean(order.slice(0, q).map(x => x[1]))
}

function seriesSummary(xs) {
  if (!xs.length) return { n: 0, meanIc: null, t: null, hit: null }
  const m = mean(xs), s = xs.length > 1 ? sd(xs) : 0
  return {
    n: xs.length,
    meanIc: +m.toFixed(4),
    t: s > 0 ? +(m / (s / Math.sqrt(xs.length))).toFixed(2) : null,
    hit: +(xs.filter(x => x > 0).length / xs.length).toFixed(2),
  }
}

// ── Panel ────────────────────────────────────────────────────────────────────
const dayKey = t => new Date(t).toISOString().slice(0, 10)

function toPanel(barsBySymbol, fundamentals = {}, filings = {}) {
  const panel = {}
  for (const [sym, bars] of Object.entries(barsBySymbol || {})) {
    const b = (bars || []).filter(x => x && x.c > 0)
    if (b.length < WARMUP + HORIZON + 1) continue
    panel[sym] = {
      c: b.map(x => x.c), h: b.map(x => x.h ?? x.c), l: b.map(x => x.l ?? x.c), v: b.map(x => x.v ?? 0),
      idx: new Map(b.map((x, i) => [dayKey(x.t), i])), days: b.map(x => dayKey(x.t)),
      fund: fundamentals?.[sym] || null,
      filings: filings?.[sym] || null,
    }
  }
  return panel
}

/**
 * Rebalance dates: every `horizon`th day of the calendar shared by most of the
 * universe, after the warm-up, leaving room for the forward window.
 */
function rebalanceDates(panel, horizon = HORIZON) {
  const syms = Object.keys(panel)
  if (!syms.length) return []
  const count = new Map()
  for (const s of syms) for (const d of panel[s].days) count.set(d, (count.get(d) || 0) + 1)
  const cal = [...count.entries()].filter(([, n]) => n >= syms.length * 0.6).map(([d]) => d).sort()
  const out = []
  for (let k = WARMUP; k + horizon < cal.length; k += horizon) out.push(cal[k])
  return out
}

/** Per-date factor values and forward returns for every candidate. */
function crossSections(panel, dates, { horizon = HORIZON, factors = FACTORS } = {}) {
  const out = Object.fromEntries(Object.keys(factors).map(f => [f, []]))
  for (const date of dates) {
    const fwd = {}
    for (const [sym, p] of Object.entries(panel)) {
      const i = p.idx.get(date)
      if (i == null || i < WARMUP || i + horizon >= p.c.length) continue
      fwd[sym] = { i, r: p.c[i + horizon] / p.c[i] - 1 }
    }
    for (const [name, f] of Object.entries(factors)) {
      const vals = [], rets = []
      for (const [sym, { i, r }] of Object.entries(fwd)) {
        const v = f.fn(panel[sym], i)
        if (Number.isFinite(v)) { vals.push(v); rets.push(r) }
      }
      if (vals.length < MIN_CROSS) continue
      const ic = spearman(vals, rets)
      if (ic != null) out[name].push({ date, ic, n: vals.length, spread: quintileSpread(vals, rets) })
    }
  }
  return out
}

// ── Decay and turnover (alphalens-style diagnostics) ─────────────────────────
// Neither changes a verdict. Decay says how fast the information is used up
// (an IC that is gone by 21 days cannot be traded monthly); turnover says how
// much of the top fifth changes each rebalance, which is what costs money.
const DECAY_HORIZONS = [5, 10, 21, 63]

function decayProfile(panel, factorName, f, dir) {
  const out = {}
  for (const h of DECAY_HORIZONS) {
    const xs = crossSections(panel, rebalanceDates(panel, h), { horizon: h, factors: { [factorName]: f } })[factorName]
    out[h] = xs.length >= 5 ? +(mean(xs.map(x => x.ic)) * dir).toFixed(4) : null
  }
  return out
}

/** Mean share of the top quintile replaced between consecutive rebalances. */
function topTurnover(panel, dates, f, dir) {
  let prev = null
  const shares = []
  for (const date of dates) {
    const vals = []
    for (const [sym, p] of Object.entries(panel)) {
      const i = p.idx.get(date)
      if (i == null || i < WARMUP) continue
      const v = f.fn(p, i)
      if (Number.isFinite(v)) vals.push([sym, v * dir])
    }
    if (vals.length < MIN_CROSS) { prev = null; continue }
    vals.sort((a, b) => b[1] - a[1])
    const top = new Set(vals.slice(0, Math.max(1, Math.floor(vals.length / 5))).map(x => x[0]))
    if (prev) shares.push([...top].filter(sym => !prev.has(sym)).length / top.size)
    prev = top
  }
  return shares.length ? +mean(shares).toFixed(2) : null
}

/**
 * Mine every candidate. @returns {{ factors: object[], admitted: string[], periods, universe, horizon, caveats }}
 */
function mineFactors(barsBySymbol, { horizon = HORIZON, factors = FACTORS, trainFrac = TRAIN_FRAC, asOf = null, dsrMin = FACTOR_DSR_MIN, holdoutT = HOLDOUT_T, fundamentals = {}, filings = {}, diagnostics = true } = {}) {
  const panel = toPanel(barsBySymbol, fundamentals, filings)
  const dates = rebalanceDates(panel, horizon)
  const xs = crossSections(panel, dates, { horizon, factors })

  const evaluated = Object.entries(factors).map(([name, f]) => {
    const series = xs[name]
    const cut = Math.floor(series.length * trainFrac)
    const train = series.slice(0, cut), hold = series.slice(cut)
    const dir = train.length && mean(train.map(p => p.ic)) < 0 ? -1 : 1
    const oriented = arr => arr.map(p => p.ic * dir)
    return {
      name, label: f.label, direction: dir === 1 ? 'as-is' : 'inverted',
      periods: series.length,
      train: { ...seriesSummary(oriented(train)), spreadPct: train.length ? +(mean(train.map(p => p.spread * dir)) * 100).toFixed(2) : null },
      holdout: { ...seriesSummary(oriented(hold)), spreadPct: hold.length ? +(mean(hold.map(p => p.spread * dir)) * 100).toFixed(2) : null },
      stats: returnStats(oriented(train)),
    }
  })

  // The luck benchmark: the Sharpe the luckiest of `trials` SKILL-LESS
  // candidates would show. Every candidate counts, computable or not, and in
  // BOTH directions — choosing the sign on the training periods is itself a
  // selection. The spread of a skill-less Sharpe estimate over n periods is
  // 1/(n−1); the observed spread across THESE candidates is not used, because
  // when several factors genuinely work it is wide for that reason, which
  // would raise the bar above the real ones (a planted momentum factor with a
  // t-stat of 10 failed that way).
  const trials = 2 * evaluated.length
  const results = evaluated.map(({ stats, ...e }) => {
    let deflated = null
    if (stats) {
      const srStar = expectedMaxSharpe(trials, 1 / (stats.n - 1))
      const dsr = probabilisticSharpe(stats, srStar)
      if (dsr != null) deflated = { dsr: +dsr.toFixed(3), sr: +stats.sr.toFixed(4), srStar: +srStar.toFixed(4), nTrials: trials, n: stats.n, pass: dsr >= dsrMin }
    }
    const verdict = !stats || e.holdout.n < 5 ? 'insufficient'
      : !deflated?.pass ? 'luck'
      : !(e.holdout.meanIc > 0 && e.holdout.t >= holdoutT) ? 'failed-holdout'
      : 'admitted'
    // Diagnostics for every factor that produced a series at all.
    const f = factors[e.name], dir = e.direction === 'inverted' ? -1 : 1
    const diag = diagnostics && stats ? { decay: decayProfile(panel, e.name, f, dir), turnover: topTurnover(panel, dates, f, dir) } : null
    return { ...e, deflated, verdict, ...(diag || {}) }
  }).sort((a, b) => (b.verdict === 'admitted') - (a.verdict === 'admitted') || (b.deflated?.dsr ?? 0) - (a.deflated?.dsr ?? 0))

  // Latest cross-section of each admitted factor, so a symbol's percentile on
  // it can be read later from its own bars.
  const lastDate = Object.values(panel).map(p => p.days.at(-1)).sort().at(-1) ?? null
  for (const r of results.filter(x => x.verdict === 'admitted')) {
    const vals = Object.values(panel).map(p => factors[r.name].fn(p, p.c.length - 1)).filter(Number.isFinite)
    r.latest = { asOf: lastDate, values: vals.sort((a, b) => a - b).map(v => +v.toPrecision(5)) }
  }

  return {
    ranAt: asOf || new Date().toISOString(),
    horizon, universe: Object.keys(panel).length, periods: dates.length,
    tested: results.length, admitted: results.filter(r => r.verdict === 'admitted').map(r => r.name),
    dsrMin, holdoutT, factors: results,
    caveats: ["The list is today's large caps, so stocks that dropped out over the period are missing (survivorship). That flatters factors that buy past winners."],
  }
}

/**
 * A symbol's percentile (0-100, oriented so high = what the factor favours)
 * on every admitted factor, from its own bars. Pure.
 */
/** The built-in factors plus every model-proposed one stored in a library. */
function factorsOf(library) {
  const out = { ...FACTORS }
  const dsl = require('./factor-dsl')
  for (const r of library?.factors || []) if (r.source === 'llm' && r.expression && dsl.parseExpr(r.expression).ok) out[r.name] = dsl.toFactor(r.name, r.expression, r.label)
  return out
}

function percentilesFor(bars, library, { factors = factorsOf(library), fund = null, filings = null } = {}) {
  const b = (bars || []).filter(x => x && x.c > 0)
  if (!b.length) return []
  const p = { c: b.map(x => x.c), h: b.map(x => x.h ?? x.c), l: b.map(x => x.l ?? x.c), v: b.map(x => x.v ?? 0), days: b.map(x => dayKey(x.t)), fund, filings }
  return (library?.factors || []).filter(r => r.verdict === 'admitted' && r.latest?.values?.length && factors[r.name]).map(r => {
    const v = factors[r.name].fn(p, p.c.length - 1)
    if (!Number.isFinite(v)) return null
    const below = r.latest.values.filter(x => x <= v).length / r.latest.values.length
    const pct = Math.round((r.direction === 'inverted' ? 1 - below : below) * 100)
    return { name: r.name, label: r.label, percentile: pct, holdoutIc: r.holdout.meanIc, holdoutPeriods: r.holdout.n, universe: r.latest.values.length }
  }).filter(Boolean)
}

// ── Storage + job ────────────────────────────────────────────────────────────
const path = require('path')
const LIBRARY_FILE = path.join(require('./data-dir').DATA_DIR, 'factor-library.json')

function readLibrary(file = LIBRARY_FILE) {
  try { return JSON.parse(require('fs').readFileSync(file, 'utf8')) } catch { return null }
}

function saveLibrary(lib, file = LIBRARY_FILE) {
  require('fs').mkdirSync(path.dirname(file), { recursive: true })
  require('./atomic-write').writeJsonAtomic(file, lib)
}

// Fallback list when the symbol index is not loaded: liquid US large caps
// across sectors (the survivorship caveat applies either way).
const FALLBACK_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'AVGO', 'ORCL', 'CRM', 'ADBE', 'CSCO', 'AMD', 'INTC', 'QCOM', 'TXN',
  'AMZN', 'TSLA', 'HD', 'MCD', 'NKE', 'SBUX', 'LOW', 'BKNG', 'GOOGL', 'META', 'NFLX', 'DIS', 'T', 'VZ',
  'JPM', 'BAC', 'WFC', 'GS', 'MS', 'BLK', 'AXP', 'C', 'LLY', 'UNH', 'JNJ', 'MRK', 'ABBV', 'PFE', 'TMO', 'ABT',
  'XOM', 'CVX', 'COP', 'SLB', 'EOG', 'PG', 'KO', 'PEP', 'WMT', 'COST', 'CAT', 'GE', 'HON', 'UNP', 'RTX', 'DE',
  'LIN', 'APD', 'NEE', 'DUK', 'SO', 'PLD', 'AMT', 'EQIX',
]

function defaultUniverse() {
  try {
    const db = require('./symbol-db')
    const sectors = ['Information Technology', 'Health Care', 'Financials', 'Consumer Discretionary', 'Communication Services',
      'Industrials', 'Consumer Staples', 'Energy', 'Utilities', 'Real Estate', 'Materials']
    const syms = [...new Set(sectors.flatMap(s => { try { return db.sectorUniverse(s, { size: 7, minCap: 'Large Cap' }) } catch { return [] } }))]
    if (syms.length >= 40) return syms
  } catch { /* index optional */ }
  return FALLBACK_UNIVERSE
}

/** Fetch 5y bars for the universe (bounded concurrency), mine, persist. */
/**
 * Model-proposed factors for this run: last run's admitted ones carried
 * forward, plus new proposals that are valid and not a near-copy of an
 * existing factor (lib/factor-dsl.js). Returns { factors, proposals }.
 */
async function proposedFactors({ propose, previous, panel, base }) {
  const dsl = require('./factor-dsl')
  const out = {}, proposals = []
  for (const f of (previous?.factors || []).filter(f => f.source === 'llm' && f.verdict === 'admitted' && f.expression)) {
    if (dsl.parseExpr(f.expression).ok) out[f.name] = dsl.toFactor(f.name, f.expression, f.label)
  }
  if (!propose) return { factors: out, proposals }
  let raw = []
  try { raw = await propose({ existing: [...Object.values(base), ...Object.values(out)].map(f => f.label) }) } catch (e) {
    return { factors: out, proposals: [{ status: 'error', reason: e.message }] }
  }
  const dates = rebalanceDates(panel).slice(-6)
  for (const p of raw) {
    if (p.status !== 'ok') { proposals.push(p); continue }
    if (base[p.name] || out[p.name]) { proposals.push({ ...p, status: 'invalid', reason: 'name already used' }); continue }
    const cand = dsl.toFactor(p.name, p.expression)
    const dup = dsl.originality(cand, { ...base, ...out }, panel, dates, spearman)
    if (dup && dup.rho >= dsl.ORIGINALITY_MAX) { proposals.push({ ...p, status: 'duplicate', reason: `ranks stocks like ${dup.duplicateOf} (mean |ρ| ${dup.rho})` }); continue }
    out[p.name] = { ...cand, hypothesis: p.hypothesis }
    proposals.push({ ...p, status: 'tested', closestExisting: dup })
  }
  return { factors: out, proposals }
}

async function runMining({ fetchBars, fetchFacts = null, filingSims = {}, propose = null, universe = defaultUniverse(), concurrency = 4, save = true, minUniverse = 20 } = {}) {
  const barsBySymbol = {}, fundamentals = {}
  const queue = [...universe]
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const s = queue.shift()
      try { barsBySymbol[s] = await fetchBars(s) } catch { /* one missing name is fine */ }
      if (fetchFacts) { try { fundamentals[s] = await fetchFacts(s) } catch { /* price factors still run */ } }
    }
  }))
  const llm = await proposedFactors({ propose, previous: readLibrary(), panel: toPanel(barsBySymbol, fundamentals, filingSims), base: FACTORS })
  const factors = { ...FACTORS, ...llm.factors }
  const lib = {
    ...mineFactors(barsBySymbol, { fundamentals, filings: filingSims, factors }), requested: universe.length,
    withFundamentals: Object.values(fundamentals).filter(Boolean).length,
    withFilingChange: universe.filter(s => filingSims?.[s]?.length).length,
    proposals: llm.proposals,
  }
  // Keep each model-proposed factor's expression and hypothesis on its row, so
  // percentilesFor and next week's run can rebuild it.
  for (const r of lib.factors) {
    const f = factors[r.name]
    if (f?.source === 'llm') Object.assign(r, { source: 'llm', expression: f.expression, hypothesis: f.hypothesis ?? null })
  }
  // A data outage must not overwrite last week's library with a run over a
  // handful of names: refuse, and keep the stored one.
  if (lib.universe < minUniverse) throw new Error(`only ${lib.universe} of ${universe.length} names had 5 years of bars — too few to rank; the stored library is kept`)
  if (save) saveLibrary(lib)
  return lib
}

module.exports = {
  HORIZON, MIN_CROSS, FACTOR_DSR_MIN, HOLDOUT_T, FACTORS, DECAY_HORIZONS, LIBRARY_FILE, FALLBACK_UNIVERSE,
  spearman, ranks, quintileSpread, toPanel, rebalanceDates, crossSections, mineFactors, percentilesFor, factorsOf, proposedFactors,
  readLibrary, saveLibrary, defaultUniverse, runMining,
}
