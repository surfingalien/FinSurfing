'use strict'
/**
 * lib/strategy-versions.js — diagnose why a strategy fails, propose ONE
 * targeted change, and keep it only if it beats its parent on data neither
 * the diagnosis nor the selection saw.
 *
 * The library (lib/strategy-library.js) could only admit or retire a
 * strategy. This adds the step in between that the self-improvement loop
 * needs: v1.0 loses in high volatility → hypothesis "skip entries when ATR is
 * in its top third" → v1.1 = v1.0 with that entry filter → tested against
 * v1.0 → kept or reverted, with the lineage written down.
 *
 * Division of labour, as everywhere in this repo:
 *   - DIAGNOSIS is code: every closed trade of the parent on the DEVELOPMENT
 *     window is tagged with the market state at its entry (volatility tercile,
 *     trend vs the 200-day average, 20-day z-score, variance ratio), and the
 *     state where it lost most is named, with counts.
 *   - CANDIDATES are filters that skip entries in that state. Thresholds come
 *     from the development window only. A model may add up to two
 *     single-condition filters (feature, comparison, value) — validated by the
 *     strategy DSL's allow-list like any composed rule; no code is executed.
 *   - THE JUDGE is the backtest engine (next-bar fills, costs) over three
 *     DISJOINT windows: development 60% (diagnosis + thresholds), validation
 *     20% (choose among candidates), final test 20% (one look, never used to
 *     choose). A candidate is kept only when, against its parent:
 *       1. validation: it improves return net of costs, with the paired daily
 *          t-stat above a bar that rises with the number of candidates tried
 *          (one-sided, family-wise 10% — trying more filters needs more proof);
 *       2. final test: it still improves return (one look);
 *       3. regimes: on validation + test it is not worse in BOTH the up-trend
 *          and the down-trend halves of the symbol's own history;
 *       4. it still trades (≥ MIN_TRADES on validation + test) — a filter that
 *          removes every trade "improves" a losing strategy to zero.
 *   Anything else is REVERTED and the record says which check failed.
 *
 * The filter only removes entries; exits are untouched, so a version can
 * never hold a position its parent would have closed.
 *
 * Store: data/strategy-versions.jsonl (append-only lineage; durable-files).
 * Pure except loadVersions/appendVersion. Tests: tests/strategy-versions.test.js
 */

const fs = require('fs')
const path = require('path')
const { simulateWithSignals, generateSignals } = require('../utils/backtest')
const dsl = require('./strategy-dsl')
const { normInv } = require('./quant/linalg')

const COMPOSED_TYPE = 'composed_rule'
const SPLITS = { dev: 0.6, val: 0.2 }       // test = the rest
const MIN_BARS = 400                        // ~1.6y of daily bars; 5y is what callers fetch
const MIN_DIAG_TRADES = 4                   // a state with fewer losing trades names nothing
const MIN_TRADES = 3                        // a version must still trade on validation + test
const FAMILY_ALPHA = 0.10
const LLM_FILTER_FEATURES = ['atrPct', 'rsi14', 'zscore20', 'vr5', 'hurst', 'volRatio', 'roc20', 'volFcst', 'bbPctB']

// ── Signals ──────────────────────────────────────────────────────────────────

/** Entry filter as a DSL boolean node; null = no filter. */
function filteredSignals(base, filterBool) {
  if (!filterBool) return base.slice()
  return base.map((s, i) => (s === 1 && filterBool[i] !== true ? 0 : s))
}

/** The parent's raw signals: a catalog strategy or a composed rule. */
function baseSignals(entry, series) {
  if (entry.strategy === COMPOSED_TYPE) return dsl.generateRuleSignals(entry.params.rule, series)
  // A machine-learning model as a rule (lib/ml-strategy.js): walk-forward refits, never look-ahead.
  if (entry.strategy === 'ml_model') return require('./ml-strategy').mlSignals(series, entry.params)
  return generateSignals(series.closes, entry.strategy, entry.params)
}

/**
 * Signals for any library entry, honouring a version's entry filter
 * (params.filter). Used by the library's forward re-validation too, so a
 * promoted version is re-tested as the version, not as its parent.
 */
function signalsFor(entry, series) {
  const base = baseSignals(entry, series)
  const f = entry.params?.filter
  if (!f) return base
  const v = dsl.validateNode(f)   // throws RuleError on anything off the allow-list
  if (v !== 'boolean') throw new dsl.RuleError('a filter must be a condition')
  return filteredSignals(base, dsl.evalBoolean(f, dsl.featureContext(series)))
}

// ── Windows ──────────────────────────────────────────────────────────────────

function windows(n) {
  const a = Math.floor(n * SPLITS.dev), b = Math.floor(n * (SPLITS.dev + SPLITS.val))
  return { dev: [0, a], val: [a, b], test: [b, n] }
}

function runWindow(series, signals, [from, to], costBps) {
  const r = simulateWithSignals(series.timestamps.slice(from, to), series.closes.slice(from, to), signals.slice(from, to), 10_000,
    { costBps, opens: series.opens ? series.opens.slice(from, to) : undefined })
  const eq = r.equity.map(e => e.value)
  const daily = eq.slice(1).map((v, i) => (v - eq[i]) / eq[i])
  return { metrics: r.metrics, trades: r.trades, daily }
}

const pickMetrics = m => ({ totalReturn: m.totalReturn, alpha: m.alpha, sharpe: m.sharpeRatio, maxDrawdown: m.maxDrawdown, trades: m.totalTrades, winRate: m.winRate, costBps: m.costBps })

// ── Diagnosis ────────────────────────────────────────────────────────────────

function tercile(values, q) {
  const v = values.filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  return v[Math.min(v.length - 1, Math.floor(q * v.length))]
}

/**
 * The market states a trade can be entered in, each with the filter that
 * would skip it. Thresholds are computed from the development window only.
 */
function stateDefinitions(ctx, [from, to]) {
  const slice = name => ctx.get(name).slice(from, to)
  const atrHi = tercile(slice('atrPct'), 2 / 3), atrLo = tercile(slice('atrPct'), 1 / 3)
  const f = (feature, op, value) => ({ op, left: { feature }, right: typeof value === 'string' ? { feature: value } : { const: +Number(value).toFixed(4) } })
  return [
    atrHi != null && { key: 'high-volatility', label: `high volatility (ATR above ${atrHi.toFixed(2)}% — top third)`, inState: i => ctx.get('atrPct')[i] > atrHi, filter: f('atrPct', '<=', atrHi), change: `skip entries when ATR% > ${atrHi.toFixed(2)}` },
    atrLo != null && { key: 'low-volatility', label: `low volatility (ATR below ${atrLo.toFixed(2)}% — bottom third)`, inState: i => ctx.get('atrPct')[i] < atrLo, filter: f('atrPct', '>=', atrLo), change: `skip entries when ATR% < ${atrLo.toFixed(2)}` },
    { key: 'downtrend', label: 'below the 200-day average', inState: i => ctx.get('close')[i] < ctx.get('sma200')[i], filter: f('close', '>=', 'sma200'), change: 'skip entries below the 200-day average' },
    { key: 'uptrend', label: 'above the 200-day average', inState: i => ctx.get('close')[i] > ctx.get('sma200')[i], filter: f('close', '<=', 'sma200'), change: 'skip entries above the 200-day average' },
    { key: 'stretched-up', label: 'stretched up (20-day z-score > 1)', inState: i => ctx.get('zscore20')[i] > 1, filter: f('zscore20', '<=', 1), change: 'skip entries when the 20-day z-score is above 1' },
    { key: 'stretched-down', label: 'stretched down (20-day z-score < −1)', inState: i => ctx.get('zscore20')[i] < -1, filter: f('zscore20', '>=', -1), change: 'skip entries when the 20-day z-score is below −1' },
    { key: 'trending', label: 'trending tape (variance ratio > 1)', inState: i => ctx.get('vr5')[i] > 1, filter: f('vr5', '<=', 1), change: 'skip entries when the 5-day variance ratio is above 1' },
    { key: 'reverting', label: 'mean-reverting tape (variance ratio < 1)', inState: i => ctx.get('vr5')[i] < 1, filter: f('vr5', '>=', 1), change: 'skip entries when the 5-day variance ratio is below 1' },
  ].filter(Boolean)
}

/**
 * Where the parent loses on the development window. Each closed trade is
 * tagged by the state at its ENTRY bar (the signal bar, the day before the
 * fill). Returns the states ranked by how much worse trades in them did than
 * trades outside them. Pure.
 */
function diagnose(series, signals, devRange, costBps) {
  const [from, to] = devRange
  const ctx = dsl.featureContext(series)
  const run = runWindow(series, signals, devRange, costBps)
  const dates = series.timestamps.map(t => new Date(t * 1000).toISOString().slice(0, 10))
  // Pair each sell with its buy; the signal bar is the bar before the fill.
  const closed = []
  let open = null
  for (const t of run.trades) {
    if (t.type === 'buy') open = t
    else if (t.type === 'sell' && open && !t.open) {
      const fillIdx = dates.indexOf(open.date, from)
      if (fillIdx > from) closed.push({ entryIdx: fillIdx - 1, pnl: t.pnl })
      open = null
    }
  }
  const states = stateDefinitions(ctx, devRange)
  const findings = []
  for (const s of states) {
    const inS = closed.filter(t => s.inState(t.entryIdx)), outS = closed.filter(t => !s.inState(t.entryIdx))
    if (inS.length < MIN_DIAG_TRADES || outS.length < 2) continue
    const avg = a => a.reduce((x, t) => x + t.pnl, 0) / a.length
    const inAvg = avg(inS), outAvg = avg(outS)
    if (!(inAvg < 0 && inAvg < outAvg)) continue
    findings.push({
      key: s.key, state: s.label, trades: inS.length, avgPnlPct: +inAvg.toFixed(2),
      winRate: +(inS.filter(t => t.pnl > 0).length / inS.length).toFixed(2),
      othersTrades: outS.length, othersAvgPnlPct: +outAvg.toFixed(2),
      lostPct: +(inS.reduce((x, t) => x + t.pnl, 0)).toFixed(2),
      filter: s.filter, change: s.change,
    })
  }
  findings.sort((a, b) => a.lostPct - b.lostPct)
  return { trades: closed.length, metrics: pickMetrics(run.metrics), findings }
}

// ── Model-proposed filters ───────────────────────────────────────────────────

/** Normalise a model's single-condition filter proposals into DSL nodes; invalid ones are dropped with a reason. Pure. */
function parseFilterProposals(proposals = []) {
  const ok = [], rejected = []
  for (const p of (Array.isArray(proposals) ? proposals : []).slice(0, 2)) {
    const node = { op: p?.op, left: { feature: p?.feature }, right: { const: Number(p?.value) } }
    try {
      if (!LLM_FILTER_FEATURES.includes(p?.feature)) throw new Error(`feature ${p?.feature} is not offered`)
      if (!['<', '>', '<=', '>='].includes(p?.op)) throw new Error(`op ${p?.op} is not a comparison`)
      if (!Number.isFinite(node.right.const)) throw new Error('value is not a number')
      if (dsl.validateNode(node) !== 'boolean') throw new Error('not a condition')
      ok.push({ key: `model:${p.feature}${p.op}${node.right.const}`, filter: node, change: `only enter when ${p.feature} ${p.op} ${node.right.const}`, hypothesis: String(p?.hypothesis || '').slice(0, 300), source: 'model' })
    } catch (e) { rejected.push({ proposal: p, reason: e.message }) }
  }
  return { ok, rejected }
}

function filterPrompt({ entry, diagnosis }) {
  return `A trading strategy is losing money in some market states. Propose at most TWO single-condition ENTRY filters (the strategy only enters when the condition holds) that could fix it. Every filter you propose will be backtested on data you have not seen and kept only if it beats the current version there.

Strategy: ${entry.name || entry.strategy} on ${entry.symbol}${entry.description ? ` — ${entry.description}` : ''}
Development-window result: ${JSON.stringify(diagnosis.metrics)}
Where it lost (trades tagged by the state at entry):
${diagnosis.findings.map(f => `- ${f.state}: ${f.trades} trades, avg ${f.avgPnlPct}% (others ${f.othersAvgPnlPct}%), win rate ${Math.round(f.winRate * 100)}%`).join('\n') || '- no single state stands out'}

Features you may use: ${LLM_FILTER_FEATURES.map(n => `${n} (${dsl.FEATURES[n].desc})`).join('; ')}.
State no performance numbers; give each filter a one-sentence hypothesis.`
}

// ── Evaluation ───────────────────────────────────────────────────────────────

function pairedT(a, b) {
  const n = Math.min(a.length, b.length)
  if (n < 20) return { t: 0, n, mean: 0 }
  const d = Array.from({ length: n }, (_, i) => a[i] - b[i])
  const mean = d.reduce((x, y) => x + y, 0) / n
  const sd = Math.sqrt(d.reduce((x, y) => x + (y - mean) ** 2, 0) / (n - 1))
  return { t: sd > 0 ? mean / (sd / Math.sqrt(n)) : (mean > 0 ? Infinity : 0), n, mean }
}

/** The bar a validation t-stat must clear when `k` candidates were tried: one-sided Bonferroni at FAMILY_ALPHA. */
function tThreshold(k) {
  return normInv(1 - FAMILY_ALPHA / Math.max(1, k))
}

/**
 * Daily return differences of candidate vs parent on validation + test,
 * split by the symbol's own trend state (close vs 200-day average). Pure.
 */
function regimeCheck(series, candDaily, parentDaily, from) {
  const ctx = dsl.featureContext(series)
  const close = ctx.get('close'), sma = ctx.get('sma200')
  const sum = { up: { diff: 0, days: 0 }, down: { diff: 0, days: 0 } }
  for (let i = 0; i < Math.min(candDaily.length, parentDaily.length); i++) {
    const bar = from + i + 1
    if (!Number.isFinite(sma[bar])) continue
    const k = close[bar] >= sma[bar] ? 'up' : 'down'
    sum[k].diff += candDaily[i] - parentDaily[i]
    sum[k].days++
  }
  const r = k => ({ days: sum[k].days, excessPct: +(sum[k].diff * 100).toFixed(2) })
  const out = { up: r('up'), down: r('down') }
  // Not worse in either regime with enough days in it (a regime with < 20 days says nothing).
  out.pass = ['up', 'down'].every(k => out[k].days < 20 || out[k].excessPct >= -0.25)
  return out
}

/**
 * Improve one strategy: diagnose, build candidates, judge them. Pure given
 * the series and the (optional) model proposals.
 * @returns {{ status: 'promoted'|'reverted'|'no-diagnosis'|'insufficient-data', ... }}
 */
function improve(entry, series, { costBps = 10, modelProposals = [], parentVersion = null } = {}) {
  const n = series.closes.length
  if (n < MIN_BARS) return { status: 'insufficient-data', reason: `${n} daily bars (need ${MIN_BARS})` }
  const W = windows(n)
  const parentSig = signalsFor(entry, series)
  const diagnosis = diagnose(series, parentSig, W.dev, costBps)

  const fromDiag = diagnosis.findings.slice(0, 3).map(f => ({ key: f.key, filter: f.filter, change: f.change, hypothesis: `it lost in ${f.state}: ${f.trades} trades averaging ${f.avgPnlPct}% vs ${f.othersAvgPnlPct}% elsewhere`, source: 'diagnosis' }))
  const model = parseFilterProposals(modelProposals)
  const candidates = [...fromDiag, ...model.ok]
  const base = { diagnosis, rejectedProposals: model.rejected, windows: Object.fromEntries(Object.entries(W).map(([k, [a, b]]) => [k, { from: dateOf(series, a), to: dateOf(series, b - 1), bars: b - a }])) }
  if (!candidates.length) return { status: 'no-diagnosis', reason: diagnosis.trades < MIN_DIAG_TRADES ? `only ${diagnosis.trades} closed trades on the development window` : 'no market state where it clearly lost', ...base }

  const ctx = dsl.featureContext(series)
  // An existing filter is kept: a v1.2 adds to v1.1, it does not replace it.
  const combine = f => (entry.params?.filter ? { op: 'and', left: entry.params.filter, right: f } : f)
  const parent = { val: runWindow(series, parentSig, W.val, costBps), test: runWindow(series, parentSig, W.test, costBps) }
  const tBar = tThreshold(candidates.length)

  const scored = candidates.map(c => {
    const filter = combine(c.filter)
    const sig = filteredSignals(parentSig, dsl.evalBoolean(c.filter, ctx))
    const val = runWindow(series, sig, W.val, costBps)
    const t = pairedT(val.daily, parent.val.daily)
    return { ...c, filter, sig, val, t }
  }).sort((a, b) => b.val.metrics.totalReturn - a.val.metrics.totalReturn)

  const best = scored[0]
  const checks = []
  const valGain = +(best.val.metrics.totalReturn - parent.val.metrics.totalReturn).toFixed(2)
  checks.push({ check: 'validation', pass: valGain > 0 && best.t.t >= tBar, detail: `return ${best.val.metrics.totalReturn}% vs parent ${parent.val.metrics.totalReturn}% (paired t ${Number.isFinite(best.t.t) ? best.t.t.toFixed(2) : '∞'}, needs ≥ ${tBar.toFixed(2)} for ${candidates.length} candidate${candidates.length > 1 ? 's' : ''})` })

  const test = runWindow(series, best.sig, W.test, costBps)
  const testGain = +(test.metrics.totalReturn - parent.test.metrics.totalReturn).toFixed(2)
  checks.push({ check: 'final test', pass: testGain > 0, detail: `return ${test.metrics.totalReturn}% vs parent ${parent.test.metrics.totalReturn}% — looked at once` })

  const regimes = regimeCheck(series, [...best.val.daily, ...test.daily], [...parent.val.daily, ...parent.test.daily], W.val[0])
  checks.push({ check: 'regimes', pass: regimes.pass, detail: `excess vs parent: up-trend ${regimes.up.excessPct}% over ${regimes.up.days} days, down-trend ${regimes.down.excessPct}% over ${regimes.down.days} days` })

  const trades = best.val.metrics.totalTrades + test.metrics.totalTrades
  checks.push({ check: 'still trades', pass: trades >= MIN_TRADES, detail: `${trades} closed trades on validation + test (needs ≥ ${MIN_TRADES})` })

  const passed = checks.every(c => c.pass)
  const fromVersion = parentVersion || entry.version || 'v1.0'
  return {
    status: passed ? 'promoted' : 'reverted',
    reason: passed ? 'beat its parent on validation, the final test and in both trend regimes' : `failed: ${checks.filter(c => !c.pass).map(c => c.check).join(', ')}`,
    ...base,
    parentVersion: fromVersion,
    version: passed ? bumpVersion(fromVersion) : null,
    change: best.change, hypothesis: best.hypothesis, source: best.source,
    filter: best.filter,
    candidatesTried: candidates.length,
    candidates: scored.map(c => ({ key: c.key, change: c.change, source: c.source, valReturn: c.val.metrics.totalReturn, t: Number.isFinite(c.t.t) ? +c.t.t.toFixed(2) : null })),
    checks,
    parent: { val: pickMetrics(parent.val.metrics), test: pickMetrics(parent.test.metrics) },
    candidate: { val: pickMetrics(best.val.metrics), test: pickMetrics(test.metrics) },
    regimes,
  }
}

function dateOf(series, i) {
  const t = series.timestamps[Math.max(0, Math.min(series.timestamps.length - 1, i))]
  return new Date(t * 1000).toISOString().slice(0, 10)
}

/** v1.0 → v1.1 → … → v1.9 → v2.0. */
function bumpVersion(v) {
  const m = /^v(\d+)\.(\d+)$/.exec(String(v || 'v1.0'))
  if (!m) return 'v1.1'
  let major = +m[1], minor = +m[2] + 1
  if (minor >= 10) { major++; minor = 0 }
  return `v${major}.${minor}`
}

/** The library entry a promoted version becomes. Pure. */
function versionEntry(parent, result, { at = new Date().toISOString() } = {}) {
  return {
    symbol: parent.symbol,
    strategy: parent.strategy,
    params: { ...parent.params, filter: result.filter },
    name: `${String(parent.name || parent.strategy).replace(/\s+v\d+\.\d+$/, '')} ${result.version}`,
    rationale: `${result.version} of ${parent.id}: ${result.change} (${result.hypothesis})`.slice(0, 400),
    description: `${parent.description ? `${parent.description}; ` : ''}${result.change}`.slice(0, 300),
    marketFit: parent.marketFit || '',
    lineage: { parentId: parent.id, rootId: parent.lineage?.rootId || parent.id, version: result.version, parentVersion: result.parentVersion, at },
  }
}

// ── Store ────────────────────────────────────────────────────────────────────

const VERSIONS_LOG = process.env.STRATEGY_VERSIONS_LOG || path.join(require('./data-dir').DATA_DIR, 'strategy-versions.jsonl')

function loadVersions(file = VERSIONS_LOG) {
  try { return require('./atomic-write').readJsonl(file) } catch { return [] }
}
function appendVersion(rec, file = VERSIONS_LOG) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.appendFileSync(file, JSON.stringify(rec) + '\n')
  return rec
}

/** The latest record per experiment id (status changes append a new row). Pure. */
function latestById(rows) {
  const m = new Map()
  for (const r of rows || []) if (r?.id) m.set(r.id, { ...(m.get(r.id) || {}), ...r })
  return [...m.values()].sort((a, b) => String(b.at).localeCompare(String(a.at)))
}

module.exports = {
  SPLITS, MIN_BARS, MIN_TRADES, LLM_FILTER_FEATURES, VERSIONS_LOG,
  filteredSignals, signalsFor, windows, diagnose, stateDefinitions, parseFilterProposals, filterPrompt,
  pairedT, tThreshold, regimeCheck, improve, bumpVersion, versionEntry,
  loadVersions, appendVersion, latestById,
}
