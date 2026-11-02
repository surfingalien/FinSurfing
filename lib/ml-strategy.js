'use strict'
/**
 * lib/ml-strategy.js — a machine-learning model as a trading strategy,
 * judged exactly like every other strategy in this app.
 *
 * The model answers one question each day: from what was known at today's
 * close, will the stock be higher `horizon` sessions from now? Its answer is
 * turned into a rule: be long while P(up) ≥ `enter`, step aside when it falls
 * below `exit`. The backtest engine (utils/backtest.js — next-day fills, costs)
 * is the only judge.
 *
 * No look-ahead, by construction:
 *   - features use bars ≤ t only (lib/quant/ml-compare.js:buildDataset);
 *   - predictions are WALK-FORWARD: the history is cut into `blocks`; the
 *     model that predicts block k is fitted only on rows whose labels were
 *     already known when block k began (training ends `horizon` rows before
 *     it — the purge). Block 0 is warm-up and never trades;
 *   - the newest bars (labels not known yet) are predicted by the last model,
 *     so the rule produces today's signal too — which is what lets the
 *     library re-test it forward on bars that arrive after it was admitted.
 *   - thresholds are FIXED in advance (`enter`/`exit` are parameters, never
 *     tuned on the result); trying two of them counts as two trials.
 *
 * Every model is seeded, so the same bars always give the same signals.
 * Tests: tests/ml-strategy.test.js
 */

const ML = require('./quant/ml')
const NN = require('./quant/neural')
const { buildDataset } = require('./quant/ml-compare')

const ML_TYPE = 'ml_model'

/** Models usable as strategies: seeded, and fast enough to refit a few times per symbol. */
const STRATEGY_MODELS = {
  logistic:          { label: 'Logistic regression',             make: () => ML.logistic() },
  naive_bayes:       { label: 'Gaussian naive Bayes',            make: () => ML.gaussianNB() },
  tree:              { label: 'Decision tree',                   make: () => ML.decisionTree() },
  random_forest:     { label: 'Random forest',                   make: () => ML.randomForest({ trees: 60 }) },
  gradient_boosting: { label: 'Gradient boosting',               make: () => ML.gradientBoosting({ rounds: 60 }) },
  linear_svm:        { label: 'Support vector machine (linear)', make: () => ML.linearSVM() },
  lda:               { label: 'Linear discriminant analysis',    make: () => ML.lda() },
  mlp:               { label: 'Neural network (MLP)',            make: () => NN.mlp({ epochs: 40 }) },
  // A model the Strategy Brain builds from others: the average of three different learners' probabilities.
  ensemble:          { label: 'Ensemble (logistic + forest + boosting)', make: () => ensemble([() => ML.logistic(), () => ML.randomForest({ trees: 60 }), () => ML.gradientBoosting({ rounds: 60 })]) },
}

/** Average of several models' P(up). Each member is seeded, so the ensemble is too. */
function ensemble(makers) {
  let members = []
  return {
    fit(X, y) { members = makers.map(m => m().fit(X, y)); return this },
    predictProba(X) { const ps = members.map(m => m.predictProba(X)); return X.map((_, i) => ps.reduce((a, p) => a + p[i], 0) / ps.length) },
  }
}
const DEFAULTS = { horizon: 5, enter: 0.55, exit: 0.5, blocks: 6 }
const MIN_TRAIN_ROWS = 250

/** Series ({timestamps s, opens, highs, lows, closes, volumes}) → bars ({t ms, o, h, l, c, v}). */
function barsOf(series) {
  return series.closes.map((c, i) => ({ t: series.timestamps[i] * 1000, o: series.opens?.[i] ?? c, h: series.highs?.[i] ?? c, l: series.lows?.[i] ?? c, c, v: series.volumes?.[i] ?? 0 }))
}

/**
 * Walk-forward P(up in `horizon` sessions) for every bar it can be known for.
 * @returns {{ prob: Map<number,number>, fits: number, firstPredicted: number|null }} keyed by bar time (ms)
 */
function walkForwardProbabilities(bars, { model, horizon = DEFAULTS.horizon, blocks = DEFAULTS.blocks } = {}) {
  const spec = STRATEGY_MODELS[model]
  if (!spec) throw new Error(`unknown model ${model}`)
  const D = buildDataset(bars, { horizon, withTail: true })
  const n = D.X.length, size = Math.floor(n / blocks)
  const prob = new Map()
  let fits = 0, last = null, firstPredicted = null
  for (let k = 1; k < blocks; k++) {
    const teStart = k * size, teEnd = k === blocks - 1 ? n : (k + 1) * size
    const trEnd = teStart - horizon                      // purge: those labels end inside the test block
    if (trEnd < MIN_TRAIN_ROWS) continue
    const m = spec.make().fit(D.X.slice(0, trEnd), D.y.slice(0, trEnd)); fits++; last = m
    const p = m.predictProba(D.X.slice(teStart, teEnd))
    for (let i = teStart; i < teEnd; i++) { prob.set(D.bars[D.idx[i]].t, p[i - teStart]); if (firstPredicted == null) firstPredicted = D.bars[D.idx[i]].t }
  }
  // Today's (and the last few days') prediction: the newest model, trained only on labels known before its block.
  if (last && D.tailX.length) {
    const p = last.predictProba(D.tailX)
    D.tailIdx.forEach((bi, j) => prob.set(D.bars[bi].t, p[j]))
  }
  return { prob, fits, firstPredicted }
}

/** Probabilities → +1 / −1 / 0 signals aligned to the series. Pure. */
function signalsFromProbabilities(series, prob, { enter = DEFAULTS.enter, exit = DEFAULTS.exit } = {}) {
  return series.timestamps.map(ts => {
    const p = prob.get(ts * 1000)
    if (p == null) return 0
    if (p >= enter) return 1
    if (p < exit) return -1
    return 0
  })
}

/** Signals for a library entry of type ml_model. Used by strategy-versions.signalsFor. */
function mlSignals(series, params = {}) {
  const { model, horizon = DEFAULTS.horizon, enter = DEFAULTS.enter, exit = DEFAULTS.exit, blocks = DEFAULTS.blocks } = params
  const { prob } = walkForwardProbabilities(barsOf(series), { model, horizon, blocks })
  return signalsFromProbabilities(series, prob, { enter, exit })
}

/** The variants one experiment tries for a model: two horizons × two entry thresholds — four trials. */
function variantsFor(model) {
  const out = []
  for (const horizon of [5, 10]) for (const enter of [0.52, 0.55]) out.push({ model, horizon, enter, exit: 0.5, blocks: DEFAULTS.blocks })
  return out
}

function describe(params) {
  const m = STRATEGY_MODELS[params.model]?.label || params.model
  return `${m}: long while P(up in ${params.horizon} sessions) ≥ ${params.enter}, out below ${params.exit} (walk-forward refits, ${params.blocks} blocks)`
}

/**
 * Evaluate a batch of ML variants on one symbol: every variant is a trial;
 * survivors must be 'validated' in both windows, clear the deflated Sharpe
 * for the batch and not come from an overfitting batch. Async: yields
 * between variants so a nightly run never freezes the server.
 */
async function evaluateMlBatch(series, variants, { costBps, yieldFn = () => new Promise(r => setImmediate(r)) } = {}) {
  const { evaluateSignals, attachPbo } = require('./strategy-lab')
  const { attachDeflated } = require('./overfitting')
  const batch = []
  for (const params of variants) {
    try {
      const signals = mlSignals(series, params)
      const trades = signals.filter(s => s === 1).length
      batch.push({ params, name: `${STRATEGY_MODELS[params.model].label} (${params.horizon}d, ≥${params.enter})`, description: describe(params), longDays: trades, ...evaluateSignals(series.timestamps, series.closes, signals, { costBps, opens: series.opens }) })
    } catch (e) {
      batch.push({ params, name: params.model, error: e.message, verdict: 'error', metrics: { totalTrades: 0, sharpeRatio: 0, alpha: 0 }, returns: [], returnStats: null })
    }
    await yieldFn()
  }
  const scored = attachDeflated(batch)
  attachPbo(scored)
  return scored.map(x => ({
    ...x,
    admit: x.verdict === 'validated' && !(x.deflated && !x.deflated.pass) && !x.pbo?.overfit,
    reason: x.error ? `error: ${x.error}`
      : x.verdict !== 'validated' ? `not validated (${x.verdict})`
      : x.deflated && !x.deflated.pass ? `deflated Sharpe ${x.deflated.dsr} over ${x.deflated.nTrials} trials`
      : x.pbo?.overfit ? `batch overfits (PBO ${x.pbo.pbo})`
      : 'admitted',
  }))
}

module.exports = { ML_TYPE, STRATEGY_MODELS, DEFAULTS, barsOf, walkForwardProbabilities, signalsFromProbabilities, mlSignals, variantsFor, describe, evaluateMlBatch }
