'use strict'
/**
 * lib/strategy-sweep.js — parameter sweeps: one strategy type, one symbol, a
 * whole grid of settings, judged in one batch.
 *
 * This is how the nightly run gets from a handful of ideas to thousands
 * without loosening anything. A sweep of 200 settings is 200 TRIALS, and the
 * batch is judged as one (strategy-lab.evaluateProposals): the deflated Sharpe
 * compares the best of them with the best of 200 skill-less tries, and PBO and
 * CPCV ask whether picking the best of the grid holds up on bars the choice
 * never saw. Trying more settings therefore RAISES the bar each one must clear.
 *
 * Neighbouring settings of one rule are near-copies, so at most KEEP_PER_SWEEP
 * of a sweep's survivors are admitted (best Sharpe first); the rest are
 * counted as duplicates, not as failures.
 *
 * The maths is CPU, so `runSweep` does it on a worker thread and the web
 * server keeps answering. A worker that cannot start, crashes or times out is
 * an error for that sweep — never a silent fall-back to blocking the server.
 *
 * Tests: tests/strategy-sweep.test.js
 */

const path = require('path')

const DEFAULT_SIZE   = 200
const MAX_SIZE       = 1000
const KEEP_PER_SWEEP = 2
const TIMEOUT_MS     = 120_000

/** How many settings a sweep tries. STRATEGY_BRAIN_SWEEP_SIZE, 20…1000. */
function sweepSize(env = process.env) {
  const n = Math.round(Number(env.STRATEGY_BRAIN_SWEEP_SIZE))
  return Number.isFinite(n) && n >= 20 ? Math.min(MAX_SIZE, n) : DEFAULT_SIZE
}

/** Orderings a setting must respect to mean anything (a "fast" average slower than the "slow" one is not a strategy). */
function validParams(p) {
  if (p.fastPeriod != null && p.slowPeriod != null && p.fastPeriod >= p.slowPeriod) return false
  if (p.fast != null && p.slow != null && p.fast >= p.slow) return false
  if (p.oversold != null && p.overbought != null && p.oversold >= p.overbought) return false
  return true
}

/**
 * An even grid over a catalog type's parameter ranges, at most `size` settings.
 * Deterministic: the same type and size always give the same grid.
 */
function gridFor(type, size = DEFAULT_SIZE, catalog = require('./strategy-lab').STRATEGY_CATALOG) {
  const spec = catalog[type]
  if (!spec) throw new Error(`unknown strategy type "${type}"`)
  const names = Object.keys(spec.params)
  const levels = Math.max(2, Math.floor(Math.pow(Math.max(2, size), 1 / names.length)))
  const axis = names.map(k => {
    const s = spec.params[k], out = new Set()
    for (let i = 0; i < levels; i++) {
      const v = s.min + (s.max - s.min) * (i / (levels - 1))
      out.add(s.int ? Math.round(v) : +v.toFixed(2))
    }
    return [...out]
  })
  let combos = [{}]
  names.forEach((k, i) => { combos = combos.flatMap(c => axis[i].map(v => ({ ...c, [k]: v }))) })
  return combos.filter(validParams).slice(0, size)
}

/**
 * Judge a grid. Synchronous and pure — this is what the worker runs.
 * Returns slim rows (no per-bar arrays): every setting with the reason it died, or `admit: true`.
 */
function evaluateGrid({ type, symbol, series, configs, costBps, exec = null }) {
  const SL = require('./strategy-lab'), SE = require('./strategy-evidence')
  const proposals = configs.map(params => ({
    strategy: type, params, name: `${type} (sweep)`, rationale: 'Strategy Brain: parameter sweep', marketFit: '',
    hypothesis: SE.parseHypothesis(null, SL.STRATEGY_CATALOG[type].expects),
  }))
  const out = SL.evaluateProposals(proposals, series.timestamps, series.closes, 10000, {
    costBps, opens: series.opens, highs: series.highs, lows: series.lows, ...(exec ? { volumes: series.volumes, ...exec } : {}),
  })
  const rows = out.map(p => {
    const reason = p.verdict !== 'validated' ? `not validated (${p.verdict})`
      : p.deflated && !p.deflated.pass ? 'deflated Sharpe below the luck benchmark'
      : SL.admissionProblem(p)
    return {
      params: p.params, verdict: p.verdict, reason: reason || null, admit: !reason,
      metrics: p.metrics, deflated: p.deflated || null, pbo: p.pbo || null, cpcv: p.cpcv || null,
      card: reason ? null : SL.cardFor(p), hypothesis: reason ? null : SE.storedHypothesis(p),
    }
  })
  // Near-copies: keep the best few survivors of the grid, by Sharpe.
  const winners = rows.filter(r => r.admit).sort((a, b) => (b.metrics?.sharpeRatio ?? 0) - (a.metrics?.sharpeRatio ?? 0))
  winners.slice(KEEP_PER_SWEEP).forEach(r => { r.admit = false; r.reason = 'a near-copy of a setting already kept from this sweep' })
  return { type, symbol, tried: rows.length, rows }
}

/** Run `evaluateGrid` on a worker thread. Rejects on a crash or after `timeoutMs`. */
function runSweep(payload, { timeoutMs = TIMEOUT_MS, Worker = require('worker_threads').Worker } = {}) {
  return new Promise((resolve, reject) => {
    let done = false
    const w = new Worker(path.join(__dirname, 'strategy-sweep-worker.js'), { workerData: payload })
    const finish = (fn, v) => { if (done) return; done = true; clearTimeout(timer); fn(v) }
    const timer = setTimeout(() => { w.terminate(); finish(reject, new Error(`the sweep did not finish in ${Math.round(timeoutMs / 1000)} s`)) }, timeoutMs)
    w.once('message', m => (m?.error ? finish(reject, new Error(m.error)) : finish(resolve, m)))
    w.once('error', e => finish(reject, e))
    w.once('exit', code => { if (code !== 0) finish(reject, new Error(`the sweep worker stopped (exit ${code})`)) })
  })
}

module.exports = { DEFAULT_SIZE, MAX_SIZE, KEEP_PER_SWEEP, sweepSize, validParams, gridFor, evaluateGrid, runSweep }
