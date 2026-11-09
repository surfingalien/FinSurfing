'use strict'
/**
 * lib/holdings-scan.js — the Quant Lab run across the user's whole portfolio
 * instead of one symbol at a time. Pure: callers fetch the bars.
 *
 * Per holding:
 *   quant     — lib/quant-snapshot.js (21-session volatility forecast,
 *               trend/mean-reversion character, filtered-HS VaR/ES, beta to
 *               SPY, calm/stressed state)
 *   strategies — the four catalog strategies at their default parameters,
 *               each judged by strategy-lab.evaluateSignals on two DISJOINT
 *               windows net of the asset's costs (the library's own bar), plus
 *               any library strategy already proven on the symbol
 *   ml        — opt-in: eight seeded classifiers in purged walk-forward folds
 *               against the do-nothing baseline (lib/quant/ml-compare.js).
 *               With many holdings some pass by luck; the expected number is
 *               reported next to the count that passed.
 *
 * Portfolio (positions valued at the last close × shares):
 *   weights, annualised volatility (Ledoit–Wolf covariance), each holding's
 *   share of the RISK (Euler contributions — a 10% weight can be 30% of the
 *   risk), historical 1-day VaR95/ES95 and the worst 1/5/21-day windows of
 *   today's weights over the past, beta to SPY, stress scenarios, the first
 *   principal component's share of the variance (how much of the book is one
 *   bet), effective number of independent bets, pairs that move together
 *   (ρ ≥ 0.8), and what risk-parity weights would be. Nothing here is a trade
 *   instruction; risk parity is shown for comparison.
 *
 * Tests: tests/holdings-scan.test.js
 */

const L = require('./quant/linalg')
const optim = require('./quant/optimize')
const risk = require('./quant/risk')
const qs = require('./quant-snapshot')
const { alignReturns } = require('./hrp')
const sl = require('./strategy-lab')
const { generateSignals, costBpsForSymbol } = require('../utils/backtest')
const { isCryptoSymbol } = require('./crypto-classify')

const MAX_HOLDINGS = 40
const MIN_PORTFOLIO_OBS = 120
// Every model that is seeded and fast enough to refit five times per holding (k-NN, kernel SVM, QDA and the
// sequence networks are left to the one-symbol ML bench).
const ML_MODELS = ['Logistic regression', 'Gaussian naive Bayes', 'Decision tree', 'Random forest', 'Gradient boosting', 'Support vector machine (linear)', 'Linear discriminant analysis', 'Neural network (MLP)']
const LABEL_TO_ID = { 'Logistic regression': 'logistic', 'Gaussian naive Bayes': 'naive_bayes', 'Decision tree': 'tree', 'Random forest': 'random_forest', 'Gradient boosting': 'gradient_boosting', 'Support vector machine (linear)': 'linear_svm', 'Linear discriminant analysis': 'lda', 'Neural network (MLP)': 'mlp' }
const ML_FOLDS = 5
const RHO_FLAG = 0.8

const lastClose = bars => { for (let i = bars.length - 1; i >= 0; i--) if (bars[i]?.c > 0) return bars[i].c; return null }

/** Catalog strategies at default parameters, judged like the library judges them. Pure. */
function strategyCheck(symbol, bars, libraryEntries = []) {
  const ts = bars.map(b => Math.floor(b.t / 1000)), closes = bars.map(b => b.c), opens = bars.map(b => b.o ?? b.c), ohlc = { highs: bars.map(b => b.h ?? b.c), lows: bars.map(b => b.l ?? b.c) }
  const costBps = costBpsForSymbol(symbol, isCryptoSymbol(symbol) ? 'crypto' : null)
  const rows = []
  for (const [name, spec] of Object.entries(sl.STRATEGY_CATALOG)) {
    const params = Object.fromEntries(Object.entries(spec.params).map(([k, v]) => [k, v.default]))
    try {
      const e = sl.evaluateSignals(ts, closes, generateSignals(closes, name, params, ohlc), { costBps, opens })
      rows.push({ strategy: name, params, verdict: e.verdict, alpha: e.metrics.alpha, sharpe: e.metrics.sharpeRatio, trades: e.metrics.totalTrades, older: e.early && { alpha: e.early.alpha, trades: e.early.totalTrades }, recent: e.recent && { alpha: e.recent.alpha, trades: e.recent.totalTrades } })
    } catch (err) { rows.push({ strategy: name, params, verdict: 'error', error: err.message }) }
  }
  const library = (libraryEntries || []).filter(e => e.symbol === symbol && e.status !== 'retired').map(e => ({
    id: e.id, name: e.name, version: e.version || 'v1.0', fitness: e.fitness ?? null,
    forwardPasses: (e.validations || []).filter(v => v.forward && v.score >= 50).length,
  }))
  const validated = rows.filter(r => r.verdict === 'validated')
  return { costBps, rows, library, validated: validated.map(r => r.strategy), summary: validated.length ? `${validated.length} of 4 catalog rules held up in both windows` : 'no catalog rule held up in both the older and the recent window' }
}

/** Fast ML models in purged walk-forward folds. Pure (CPU-heavy: ~0.3 s per holding). */
function mlCheck(bars, { horizon = 5 } = {}) {
  const mlc = require('./quant/ml-compare')
  try {
    const r = mlc.walkForwardModels(bars, { horizon, folds: ML_FOLDS, only: ML_MODELS })
    const consistent = r.results.filter(x => x.foldsBeatingBaseline === x.folds && x.meanEdgeVsBaseline > 0)
    return { horizonDays: horizon, models: r.results.map(x => ({ model: x.model, meanAccuracy: x.meanAccuracy, meanAuc: x.meanAuc, foldsBeatingBaseline: x.foldsBeatingBaseline, folds: x.folds })), baselineAccuracy: r.meanBaselineAccuracy, passed: consistent.map(x => x.model) }
  } catch (e) { return { error: e.message } }
}

/** One ML model as a trading rule on one holding (lib/ml-strategy.js), judged like the library judges strategies. */
async function mlStrategyCheck(symbol, bars, label, { yieldFn } = {}) {
  const ms = require('./ml-strategy'), id = LABEL_TO_ID[label]
  if (!id) return null
  const series = { timestamps: bars.map(b => Math.floor(b.t / 1000)), opens: bars.map(b => b.o ?? b.c), highs: bars.map(b => b.h ?? b.c), lows: bars.map(b => b.l ?? b.c), closes: bars.map(b => b.c), volumes: bars.map(b => b.v ?? 0) }
  const [r] = await ms.evaluateMlBatch(series, [{ model: id, horizon: 5, enter: 0.55, exit: 0.5, blocks: 6 }], { costBps: costBpsForSymbol(symbol, isCryptoSymbol(symbol) ? 'crypto' : null), yieldFn })
  return r && { model: label, rule: r.description, verdict: r.verdict, alpha: r.metrics?.alpha ?? null, trades: r.metrics?.totalTrades ?? null, older: r.early && { alpha: r.early.alpha }, recent: r.recent && { alpha: r.recent.alpha } }
}

/**
 * The portfolio as a whole. `positions` [{symbol, shares}], `barsBySymbol`
 * 1y+ of daily bars each, `benchBars` SPY. Pure.
 */
function portfolioRisk(positions, barsBySymbol, { benchBars = null } = {}) {
  const valued = positions.map(p => ({ ...p, price: lastClose(barsBySymbol[p.symbol] || []) })).filter(p => p.price > 0 && p.shares > 0)
  const total = valued.reduce((a, p) => a + p.shares * p.price, 0)
  if (!(total > 0)) return { error: 'no holding could be valued from its price history' }
  const usable = valued.filter(p => (barsBySymbol[p.symbol] || []).length > MIN_PORTFOLIO_OBS)
  const excluded = valued.filter(p => !usable.includes(p)).map(p => p.symbol)
  const out = {
    totalValue: +total.toFixed(2),
    weights: valued.map(p => ({ symbol: p.symbol, shares: p.shares, price: p.price, value: +(p.shares * p.price).toFixed(2), weight: (p.shares * p.price) / total })).sort((a, b) => b.value - a.value),
    excluded,
  }
  if (usable.length < 1) return { ...out, note: 'no holding has enough price history for portfolio risk' }

  const map = Object.fromEntries(usable.map(p => [p.symbol, barsBySymbol[p.symbol]]))
  const al = alignReturns(map)
  if (al.returns.length < 60) return { ...out, note: `only ${al.returns.length} common trading days across the holdings — too few for portfolio risk` }
  const uv = usable.reduce((a, p) => a + p.shares * p.price, 0)
  const w = al.symbols.map(s => { const p = usable.find(x => x.symbol === s); return (p.shares * p.price) / uv })
  const port = al.returns.map(r => r.reduce((a, x, i) => a + x * w[i], 0))
  const n = al.symbols.length
  out.observations = al.returns.length
  out.from = null

  // Volatility and each holding's share of it (Euler contributions on a shrunk covariance).
  if (n >= 2) {
    const lw = optim.ledoitWolf(al.returns), S = lw.cov.map(r => r.map(v => v * 252))
    const variance = L.dot(w, L.matVec(S, w))
    const rc = optim.riskContributions(w, S)
    out.annualVol = Math.sqrt(Math.max(variance, 0))
    out.riskContributions = al.symbols.map((s, i) => ({ symbol: s, weight: w[i], riskShare: rc[i] })).sort((a, b) => b.riskShare - a.riskShare)
    out.concentration = out.riskContributions.filter(r => r.riskShare > r.weight * 1.5 && r.riskShare > 0.1).map(r => r.symbol)
    try { const rp = optim.riskParity(S); out.riskParity = al.symbols.map((s, i) => ({ symbol: s, current: w[i], riskParity: rp.w ? rp.w[i] : rp[i] })) } catch { /* no solution */ }
    // Correlation: pairs that are really one position, and how many independent bets the book holds.
    const sd = S.map((r, i) => Math.sqrt(r[i]))
    const pairs = []
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) { const rho = S[i][j] / (sd[i] * sd[j]); if (rho >= RHO_FLAG) pairs.push({ a: al.symbols[i], b: al.symbols[j], rho: +rho.toFixed(2) }) }
    out.movesTogether = pairs.sort((x, y) => y.rho - x.rho)
    const p = risk.pca(al.returns, { components: Math.min(3, n) })
    out.pca = { firstComponentShare: p.explained[0], explained: p.explained }
    // Effective number of bets: 1 / Σ(risk share²) — 1 means a single bet.
    out.effectiveBets = +(1 / rc.reduce((a, x) => a + x * x, 0)).toFixed(1)
  } else {
    out.annualVol = L.stdev(port) * Math.sqrt(252)
  }

  // Historical VaR/ES of today's weights, worst windows, drawdown.
  const sorted = [...port].sort((a, b) => a - b), k = Math.max(1, Math.floor(0.05 * sorted.length))
  out.var95 = -sorted[k - 1]
  out.es95 = -L.mean(sorted.slice(0, k))
  out.var95Usd = out.var95 * total
  // DCC-GARCH: correlations as they are NOW, not averaged over five years — and the VaR they imply.
  if (n >= 2 && al.returns.length >= 250) {
    try {
      const d = require('./quant/dcc').dcc(al.returns, { symbols: al.symbols, weights: w })
      out.dcc = { a: d.a, b: d.b, persistence: d.persistence, halfLifeDays: d.halfLifeDays, likelihoodGain: d.likelihoodGain, pairsUsed: d.pairsUsed,
        avgCorrNow: d.avgCorrNow, avgCorrLongRun: d.avgCorrLongRun, avgCorrRange: d.avgCorrRange, avgCorrHistory: d.avgCorrHistory.filter((_, i, a) => (a.length - 1 - i) % 5 === 0),
        rising: d.rising, falling: d.falling, portfolio: d.portfolio, portfolioUsd: d.portfolio && { var95_1d_dcc: d.portfolio.var95_1d_dcc * uv, var95_1d_static: d.portfolio.var95_1d_static * uv } }
    } catch (e) { out.dccError = e.message }
  } else out.dccError = n < 2 ? 'needs at least two holdings with history' : `only ${al.returns.length} common days (needs 250)`
  const st = risk.stressTest(usable.map(p => ({ symbol: p.symbol, value: p.shares * p.price, beta: null })), { history: port })
  out.worstWindows = st.worstWindows
  out.maxDrawdown = st.maxDrawdown

  // Beta to SPY, then the stress scenarios with each holding's own beta.
  const betas = {}
  if (benchBars?.length) {
    const day = t => new Date(t).toISOString().slice(0, 10)
    const bm = new Map(benchBars.filter(b => b.c > 0).map(b => [day(b.t), b.c]))
    for (const s of al.symbols) {
      const b = map[s], xs = []
      for (let i = 1; i < b.length; i++) { const d0 = day(b[i - 1].t), d1 = day(b[i].t); if (bm.has(d0) && bm.has(d1) && b[i - 1].c > 0) xs.push([b[i].c / b[i - 1].c - 1, bm.get(d1) / bm.get(d0) - 1]) }
      if (xs.length >= 60) betas[s] = L.ols(xs.map(x => [x[1]]), xs.map(x => x[0])).beta[1]
    }
    out.beta = al.symbols.reduce((a, s, i) => a + w[i] * (betas[s] ?? 1), 0)
  }
  out.stress = risk.stressTest(usable.map(p => ({ symbol: p.symbol, value: p.shares * p.price, beta: betas[p.symbol] ?? null })), {}).scenarios
  return out
}

/**
 * The whole scan. Yields to the event loop between holdings so a 30-holding
 * scan never freezes the server for other requests.
 */
async function scanHoldings(positions, barsBySymbol, { benchBars = null, library = [], includeMl = false, filings = {}, yieldFn = () => new Promise(r => setImmediate(r)) } = {}) {
  const holdings = []
  const xs = qs.crossSection(Object.fromEntries(positions.map(p => [p.symbol, barsBySymbol[p.symbol]]).filter(([, b]) => b?.length > 150)))
  for (const p of positions) {
    const bars = barsBySymbol[p.symbol]
    if (!bars?.length) { holdings.push({ symbol: p.symbol, shares: p.shares, error: 'no price history' }); continue }
    const snap = qs.symbolSnapshot(bars.slice(-260), { benchBars: benchBars ? benchBars.slice(-260) : null })
    const row = { symbol: p.symbol, shares: p.shares, price: lastClose(bars), bars: bars.length, quant: snap, vsHoldings: xs.get(p.symbol) || null }
    // Earnings quality and upcoming catalysts (lib/earnings-quality.js, lib/catalysts.js), when the route found them.
    const f = filings[p.symbol]
    if (f?.quality) row.quality = { periodEnd: f.quality.periodEnd, cashConversion: f.quality.cashConversion, accruals: f.quality.accruals, receivablesGap: f.quality.receivablesGap, inventoryGap: f.quality.inventoryGap, checked: f.quality.checked, flags: f.quality.flags }
    if (f?.events) row.catalysts = f.events.filter(e => !['options-expiry', 'index-rebalance'].includes(e.kind))
    row.strategies = bars.length >= 300 ? strategyCheck(p.symbol, bars, library) : { summary: `only ${bars.length} days of history — strategies need ~300`, rows: [], library: [], validated: [] }
    if (includeMl) {
      row.ml = bars.length >= 600 ? mlCheck(bars) : { error: `only ${bars.length} days of history — the walk-forward test needs ~600` }
      // The best model (by out-of-sample AUC) as a TRADING RULE: does acting on its predictions beat buy & hold
      // after costs, in both the older and the recent window? Accuracy alone is not money.
      if (!row.ml.error && row.ml.models?.length) {
        await yieldFn()
        row.ml.asStrategy = await mlStrategyCheck(p.symbol, bars, row.ml.models[0].model, { yieldFn })
      }
    }
    holdings.push(row)
    await yieldFn()
  }
  const portfolio = portfolioRisk(positions, barsBySymbol, { benchBars })
  const mlRan = holdings.filter(h => h.ml && !h.ml.error)
  const ml = includeMl ? {
    holdingsTested: mlRan.length, modelsPerHolding: ML_MODELS.length, folds: ML_FOLDS,
    passed: mlRan.filter(h => h.ml.passed.length).map(h => ({ symbol: h.symbol, models: h.ml.passed })),
    // Accuracy is not money: the best model on each holding, run as a rule through the backtester.
    asStrategyValidated: mlRan.filter(h => h.ml.asStrategy?.verdict === 'validated').map(h => ({ symbol: h.symbol, model: h.ml.asStrategy.model })),
    // P(beat the baseline in all 5 folds | no skill) ≈ 0.5^5 per model, if folds were independent.
    expectedByLuck: +(mlRan.length * ML_MODELS.length * 0.5 ** ML_FOLDS).toFixed(1),
  } : null
  const strategies = {
    withValidatedRule: holdings.filter(h => h.strategies?.validated?.length).map(h => ({ symbol: h.symbol, rules: h.strategies.validated })),
    tested: holdings.filter(h => h.strategies?.rows?.length).length,
  }
  return { asOf: new Date().toISOString(), holdings, portfolio, strategies, ml, calendar: calendarSummary(holdings, filings), quality: qualitySummary(holdings) }
}

/** Every holding's dated events in the next 45 days, nearest first, plus the market-wide ones once. Pure. */
function calendarSummary(holdings, filings = {}, { days = 45 } = {}) {
  const own = holdings.flatMap(h => (h.catalysts || []).filter(e => e.daysAway <= days).map(e => ({ symbol: h.symbol, ...e })))
  const anyEvents = Object.values(filings).find(f => f?.events)?.events || []
  const market = anyEvents.filter(e => (e.kind === 'index-rebalance' || e.kind === 'options-expiry') && e.daysAway <= days)
  const checked = holdings.filter(h => h.catalysts).length
  return checked || market.length ? { days, checked, events: [...own, ...market].sort((a, b) => a.date.localeCompare(b.date)) } : null
}

/** Holdings whose earnings-quality read raised flags. Pure. */
function qualitySummary(holdings) {
  const read = holdings.filter(h => h.quality?.checked)
  return read.length ? { checked: read.length, flagged: read.filter(h => h.quality.flags.length).map(h => ({ symbol: h.symbol, flags: h.quality.flags })) } : null
}

module.exports = { MAX_HOLDINGS, ML_MODELS, ML_FOLDS, RHO_FLAG, strategyCheck, mlCheck, mlStrategyCheck, portfolioRisk, scanHoldings, calendarSummary, qualitySummary }
