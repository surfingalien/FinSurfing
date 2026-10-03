'use strict'
/**
 * lib/strategy-library.js
 *
 * The AI Brain's evolving strategy memory — "survival of the fittest" for
 * rule-based strategies.
 *
 * Strategy Lab (lib/strategy-lab.js) proposes strategy configs and the real
 * backtest engine validates them, but until now that verdict was thrown away
 * after each user-triggered run. This module makes it PERSISTENT and
 * SELECTIVE: every strategy that survives a backtest is stored, then RE-tested
 * on fresh bars on later cycles. A strategy that keeps working accumulates
 * fitness and generations; one that stops working is retired automatically.
 *
 * Why this is genuine self-improvement rather than prompt theatre:
 *   - the LLM only ever PROPOSES (type + params from a fixed catalog)
 *   - the deterministic backtest engine is the sole judge — it cannot be
 *     argued with, and it runs on real historical bars
 *   - fitness is computed from measured metrics in code, never by a model
 *   - a strategy must SURVIVE REPEATED validation on new data to rank highly,
 *     so a single lucky backtest can't earn a permanent place
 *
 * Storage: data/strategy-library.jsonl (append-only writes, rewritten on
 * prune — same pattern as the prediction log). All ranking/fitness/retirement
 * logic is pure and unit-tested; file I/O is a thin, injectable layer.
 *
 * Tests: tests/strategy-library.test.js
 */

const fs     = require('fs')
const atomic = require('./atomic-write')
const path   = require('path')
const crypto = require('crypto')
const { canonicalJson } = require('./canonical-json')

const DATA_DIR    = require('./data-dir').DATA_DIR
const LIBRARY_LOG = path.join(DATA_DIR, 'strategy-library.jsonl')

// Keep the last N validations per strategy — enough to judge consistency
// without growing the file without bound.
const MAX_VALIDATIONS = 10
// A strategy is retired after this many consecutive failing validations.
const MAX_CONSECUTIVE_FAILURES = 2
// Or after going this long without surviving a validation.
const STALE_DAYS = 45
// Hard cap on stored strategies (lowest fitness pruned first).
const MAX_LIBRARY_SIZE = 200
// A validation at or above this score counts as a "survival".
const PASS_SCORE = 50

// ── Identity ──────────────────────────────────────────────────────────────────

/**
 * Stable key for a strategy config — same symbol+type+params ⇒ same key.
 *
 * Params are serialized with the SHARED canonical-JSON helper rather than
 * interpolated: composed-rule strategies carry a NESTED rule tree as a param,
 * and plain interpolation renders every distinct rule as "[object Object]",
 * collapsing them all into one identity so they silently overwrite each other.
 */
function strategyKey({ symbol, strategy, params }) {
  const sortedParams = Object.keys(params || {}).sort()
    .map(k => `${k}=${canonicalJson(params[k])}`).join(',')
  return `${String(symbol || '').toUpperCase()}|${strategy}|${sortedParams}`
}

/** 8-char content id derived from the key. */
function strategyId(config) {
  return crypto.createHash('sha256').update(strategyKey(config)).digest('hex').slice(0, 8)
}

// ── Fitness (pure math over MEASURED backtest metrics) ───────────────────────

const tanhUnit = x => Math.tanh(x)

/**
 * Score a single backtest result 0–100 from metrics the engine produced.
 * 50 = neutral. Alpha (vs buy & hold) and risk-adjusted return weigh equally —
 * a strategy that beats the market only by taking more risk shouldn't score
 * like one that does it efficiently.
 * Returns 0 for a result with too few trades to mean anything.
 */
function scoreValidation(metrics, { minTrades = 2 } = {}) {
  if (!metrics || (metrics.totalTrades ?? 0) < minTrades) return 0
  const alpha  = Number(metrics.alpha)
  const sharpe = Number(metrics.sharpeRatio)
  if (!Number.isFinite(alpha) || !Number.isFinite(sharpe)) return 0
  // alpha of ±20pp and sharpe of ±1.0 land near the ends of each 25-pt band
  const alphaComponent  = 25 * tanhUnit(alpha / 20)
  const sharpeComponent = 25 * tanhUnit(sharpe)
  const raw = 50 + alphaComponent + sharpeComponent
  return Math.max(0, Math.min(100, Math.round(raw * 10) / 10))
}

/**
 * Fitness 0–100 across a strategy's validation history.
 *
 * Two deliberate properties:
 *  1. ONLY FORWARD EVIDENCE BUILDS CONFIDENCE. The admission backtest is the
 *     window the strategy was SELECTED on, so it proves nothing about the
 *     future; re-running it on the "latest 2y" — ~99% the same bars — proved
 *     nothing more, however many times it was repeated. Confidence now counts
 *     only `forward` validations: bars AFTER discovery, which no selection
 *     step ever saw. Saturates at 3; with none, fitness is discounted by 40%.
 *  2. RECENCY WINS — the most recent validations are weighted more, so a
 *     strategy that has stopped working decays instead of coasting on history.
 */
function computeFitness(entry) {
  const vals = (entry?.validations || []).filter(v => typeof v?.score === 'number')
  if (!vals.length) return 0
  const recent = vals.slice(-MAX_VALIDATIONS)
  // Linear recency weights: oldest = 1, newest = n
  let weighted = 0, weightSum = 0
  recent.forEach((v, i) => {
    const w = i + 1
    weighted  += v.score * w
    weightSum += w
  })
  const base       = weighted / weightSum
  const confidence = Math.min(1, recent.filter(v => v.forward).length / 3)
  return Math.round(base * (0.6 + 0.4 * confidence) * 10) / 10
}

/** Forward validations (post-discovery bars) that passed. */
function forwardPasses(entry) {
  return (entry?.validations || []).filter(v => v?.forward && (v.score ?? 0) >= PASS_SCORE).length
}

/** Count of failing validations at the end of the history. */
function consecutiveFailures(entry) {
  const vals = entry?.validations || []
  let n = 0
  for (let i = vals.length - 1; i >= 0; i--) {
    if ((vals[i]?.score ?? 0) < PASS_SCORE) n++
    else break
  }
  return n
}

/**
 * Should this strategy be retired? Retirement is how the library stays honest:
 * strategies that stop beating the market are removed from the Brain's context
 * automatically, without anyone curating the list.
 */
function shouldRetire(entry, { now = Date.now(), staleDays = STALE_DAYS } = {}) {
  if (!entry) return true
  if (consecutiveFailures(entry) >= MAX_CONSECUTIVE_FAILURES) return true
  const lastPass = entry.lastPassedAt ? new Date(entry.lastPassedAt).getTime() : null
  if (lastPass == null) {
    // Never passed: retire once it's had its chances
    return (entry.validations?.length ?? 0) >= MAX_CONSECUTIVE_FAILURES
  }
  return (now - lastPass) > staleDays * 86400000
}

// ── Entry lifecycle (pure) ────────────────────────────────────────────────────

/** Create a fresh library entry from a validated Strategy Lab proposal. */
function buildEntry({ symbol, strategy, params, name, rationale, marketFit, description, metrics, verdict, at = null }) {
  const ts    = at || new Date().toISOString()
  const score = scoreValidation(metrics)
  const entry = {
    id:        strategyId({ symbol, strategy, params }),
    symbol:    String(symbol || '').toUpperCase(),
    strategy,
    params:    { ...params },
    // Human-readable rule text for composed strategies (null for catalog ones)
    description: description ? String(description).slice(0, 300) : null,
    name:      name      ? String(name).slice(0, 80)       : `${strategy} on ${symbol}`,
    rationale: rationale ? String(rationale).slice(0, 400) : '',
    marketFit: marketFit ? String(marketFit).slice(0, 200) : '',
    discoveredAt: ts,
    lastValidatedAt: ts,
    lastPassedAt: score >= PASS_SCORE ? ts : null,
    generation: 1,
    status: 'active',
    validations: [{ at: ts, score, verdict, alpha: metrics?.alpha ?? null, sharpe: metrics?.sharpeRatio ?? null, trades: metrics?.totalTrades ?? null }],
  }
  entry.fitness = computeFitness(entry)
  return entry
}

/**
 * Fold a NEW validation (a re-test on fresh bars) into an existing entry.
 * Pure — returns a new object. `generation` counts how many independent
 * backtest cycles this strategy has survived being re-examined by.
 */
function applyValidation(entry, { metrics, verdict, at = null, forward = false, forwardFrom = null }) {
  const ts    = at || new Date().toISOString()
  // A forward window is weeks, not years — one completed trade is evidence.
  const score = scoreValidation(metrics, { minTrades: forward ? 1 : 2 })
  const validations = [
    ...(entry.validations || []),
    {
      at: ts, score, verdict, alpha: metrics?.alpha ?? null, sharpe: metrics?.sharpeRatio ?? null, trades: metrics?.totalTrades ?? null,
      ...(forward ? { forward: true, forwardFrom } : {}),
    },
  ].slice(-MAX_VALIDATIONS)

  const next = {
    ...entry,
    validations,
    lastValidatedAt: ts,
    lastPassedAt: score >= PASS_SCORE ? ts : (entry.lastPassedAt ?? null),
    generation: (entry.generation ?? 1) + 1,
  }
  next.fitness = computeFitness(next)
  next.status  = shouldRetire(next, { now: new Date(ts).getTime() }) ? 'retired' : 'active'
  return next
}

/** Active strategies, best-fitness first. */
function rankStrategies(entries, limit = 10) {
  return (entries || [])
    .filter(e => e && e.status !== 'retired' && typeof e.fitness === 'number')
    .sort((a, b) =>
      (b.fitness - a.fitness) ||
      ((b.generation ?? 0) - (a.generation ?? 0)))
    .slice(0, limit)
}

/** Drop retired entries and cap the library at MAX_LIBRARY_SIZE by fitness. */
function pruneLibrary(entries, { maxSize = MAX_LIBRARY_SIZE } = {}) {
  const active = (entries || []).filter(e => e && e.status !== 'retired')
  if (active.length <= maxSize) return active
  return [...active].sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0)).slice(0, maxSize)
}

/**
 * Prompt-injection block for the AI Brain: the strategies that have actually
 * survived repeated backtests, with their MEASURED numbers. '' when the
 * library has nothing proven yet — never inject an empty ceremony.
 */
function buildStrategyBlock(entries, { limit = 8 } = {}) {
  // Injected only once a strategy has passed at least one FORWARD re-test —
  // the admission backtest is in-sample and cannot show "it still works".
  const top = rankStrategies(entries, 50)
    .filter(e => (e.fitness ?? 0) >= PASS_SCORE && forwardPasses(e) >= 1)
    .slice(0, limit)
  if (!top.length) return ''
  const lines = top.map(e => {
    const last = e.validations?.[e.validations.length - 1] || {}
    const alpha = last.alpha != null ? `${last.alpha > 0 ? '+' : ''}${last.alpha}%` : 'n/a'
    // Composed strategies carry a rule tree, not flat params — show the
    // human-readable rule so the Brain can reason about the actual logic.
    const shape = e.description
      ? `${e.strategy} [${e.description}]`
      : `${e.strategy}(${Object.entries(e.params || {}).map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`).join(',')})`
    return `  ${e.symbol}: ${shape} — fitness ${e.fitness}, passed ${forwardPasses(e)} forward re-test(s) on bars after discovery, last alpha vs buy&hold ${alpha}, Sharpe ${last.sharpe ?? 'n/a'}`
  })
  return [
    '\n\nEVOLVED STRATEGY LIBRARY (rule-based strategies that passed in two disjoint historical windows at discovery AND kept working on bars AFTER discovery — every number below was measured by the backtest engine with next-bar fills and trading costs, never estimated):',
    ...lines,
    'Use these as evidence about what actually works on these symbols right now: a symbol with a high-fitness trend-following strategy is behaving trendily; one whose only survivors are mean-reversion configs is range-bound. Cite a strategy when it supports your technicalScore.',
  ].join('\n')
}

// ── File I/O (thin layer over the pure logic above) ──────────────────────────

function ensureDir(file) {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readLibrary(file = LIBRARY_LOG) {
  try {
    if (!fs.existsSync(file)) return []
    // Later lines supersede earlier ones for the same id (append-only upsert).
    const byId = new Map()
    for (const entry of atomic.readJsonl(file)) {   // unreadable lines are reported, not silently skipped
      if (entry?.id) byId.set(entry.id, entry)
    }
    return [...byId.values()]
  } catch { return [] }
}

/** Append an entry (upsert by id on read). Never throws to the caller. */
function appendEntry(entry, file = LIBRARY_LOG) {
  try {
    ensureDir(file)
    fs.appendFileSync(file, JSON.stringify(entry) + '\n')
    return true
  } catch (e) {
    console.warn('[strategy-library] append failed:', e.message)
    return false
  }
}

/** Rewrite the file with exactly these entries (used after pruning). */
function writeLibrary(entries, file = LIBRARY_LOG) {
  try {
    atomic.rewriteJsonl(file, entries)
    return true
  } catch (e) {
    console.warn('[strategy-library] write failed:', e.message)
    return false
  }
}

/**
 * Record a backtest result for one strategy config: creates a new entry or
 * folds the result into the existing one. Returns the resulting entry.
 */
function recordValidation(config, { metrics, verdict, at = null, forward = false, forwardFrom = null }, file = LIBRARY_LOG) {
  const id       = strategyId(config)
  const existing = readLibrary(file).find(e => e.id === id)
  const entry    = existing
    ? applyValidation(existing, { metrics, verdict, at, forward, forwardFrom })
    : buildEntry({ ...config, metrics, verdict, at })
  appendEntry(entry, file)
  return entry
}

/** Convenience for prompt injection at scan time. */
function getStrategyBlock(opts = {}) {
  try { return buildStrategyBlock(readLibrary(), opts) } catch { return '' }
}

/** Library summary for the UI / evolution endpoint. */
function libraryStats(entries = null) {
  const all      = entries || readLibrary()
  const active   = all.filter(e => e.status !== 'retired')
  const retired  = all.length - active.length
  // "Proven" = passed on bars after discovery, the only evidence selection
  // never saw — not merely re-run many times on the same history.
  const proven   = active.filter(e => forwardPasses(e) >= 1 && (e.fitness ?? 0) >= PASS_SCORE)
  const fitnesses = active.map(e => e.fitness ?? 0)
  return {
    total:        all.length,
    active:       active.length,
    retired,
    proven:       proven.length,
    avgFitness:   fitnesses.length ? +(fitnesses.reduce((s, v) => s + v, 0) / fitnesses.length).toFixed(1) : null,
    bestFitness:  fitnesses.length ? Math.max(...fitnesses) : null,
    maxGeneration: active.length ? Math.max(...active.map(e => e.generation ?? 0)) : 0,
    symbols:      [...new Set(active.map(e => e.symbol))].length,
  }
}

module.exports = {
  LIBRARY_LOG, PASS_SCORE, MAX_VALIDATIONS, MAX_CONSECUTIVE_FAILURES, STALE_DAYS, MAX_LIBRARY_SIZE,
  // pure
  strategyKey, strategyId, scoreValidation, computeFitness, consecutiveFailures, forwardPasses,
  shouldRetire, buildEntry, applyValidation, rankStrategies, pruneLibrary, buildStrategyBlock,
  // io
  readLibrary, writeLibrary, appendEntry, recordValidation, getStrategyBlock, libraryStats,
}
