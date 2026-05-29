'use strict'
/**
 * lib/ai-audit.js
 *
 * Rolling in-memory audit log for all AI model calls.
 * Tracks model, route, cost estimate, success/failure, duration.
 * Survives server restarts only via in-process memory — resets on deploy.
 */

const MAX_ENTRIES = 200

// Approximate pricing per million tokens (input / output) in USD
const MODEL_PRICING = {
  'claude-opus-4-8':          { in: 15.00, out: 75.00 },
  'claude-sonnet-4-6':        { in:  3.00, out: 15.00 },
  'claude-haiku-4-5':         { in:  0.80, out:  4.00 },
  'llama-3.3-70b-versatile':  { in:  0.59, out:  0.79 },  // Groq
}

let _idSeq    = 0
const _log    = []   // newest first
let _totalCostUsd = 0

function estimateCost(model, tokensIn, tokensOut) {
  const p = MODEL_PRICING[model]
  if (!p || tokensIn == null || tokensOut == null) return null
  return +((tokensIn / 1_000_000) * p.in + (tokensOut / 1_000_000) * p.out).toFixed(6)
}

/**
 * Log one AI model call.
 * @param {object} opts
 * @param {string} opts.route        - e.g. 'ai-brain' | 'recommendations'
 * @param {string} opts.model        - model ID used
 * @param {string[]} [opts.symbols]  - symbols passed in
 * @param {boolean} opts.success
 * @param {string}  [opts.error]     - error message if failed
 * @param {number}  [opts.tokensIn]
 * @param {number}  [opts.tokensOut]
 * @param {number}  opts.durationMs
 * @param {string}  [opts.llm]       - 'claude' | 'groq' | 'unknown'
 */
function logCall(opts) {
  const cost = estimateCost(opts.model, opts.tokensIn, opts.tokensOut)
  if (cost) _totalCostUsd += cost

  const entry = {
    id:         ++_idSeq,
    ts:         new Date().toISOString(),
    route:      opts.route,
    model:      opts.model,
    llm:        opts.llm || 'unknown',
    symbolCount: (opts.symbols || []).length,
    symbols:    (opts.symbols || []).slice(0, 5),
    success:    opts.success,
    error:      opts.error || null,
    tokensIn:   opts.tokensIn  || null,
    tokensOut:  opts.tokensOut || null,
    costUsd:    cost,
    durationMs: opts.durationMs,
  }

  _log.unshift(entry)
  if (_log.length > MAX_ENTRIES) _log.pop()
}

function getLog(limit = 50) {
  return _log.slice(0, limit)
}

function getStats() {
  const total   = _log.length
  const success = _log.filter(e => e.success).length
  const byRoute = {}
  const byModel = {}

  for (const e of _log) {
    byRoute[e.route] = (byRoute[e.route] || 0) + 1
    byModel[e.model] = (byModel[e.model] || 0) + 1
  }

  const durations = _log.filter(e => e.durationMs).map(e => e.durationMs)
  const avgDurationMs = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null

  return {
    total,
    success,
    failures:       total - success,
    successRate:    total ? +(success / total * 100).toFixed(1) : null,
    totalCostUsd:   +_totalCostUsd.toFixed(4),
    avgDurationMs,
    byRoute,
    byModel,
  }
}

module.exports = { logCall, getLog, getStats, estimateCost }
