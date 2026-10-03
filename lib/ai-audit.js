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
  'openai/gpt-oss-120b':      { in:  0.15, out:  0.60 },  // Groq
  'llama-3.3-70b-versatile':  { in:  0.59, out:  0.79 },  // Groq — decommissioned 2026-09-21, kept for historic rows
}

let _idSeq    = 0
const _log    = []   // newest first
let _totalCostUsd = 0

// Anthropic reports cached input separately: input_tokens is only the
// UNCACHED part, cache writes bill at 1.25x input (5-minute TTL) and cache
// reads at 0.1x. Ignoring the two cache fields under-counts a cold call and
// hides what caching saves.
const CACHE_WRITE_MULT = 1.25
const CACHE_READ_MULT  = 0.10

function estimateCost(model, tokensIn, tokensOut, { cacheRead = 0, cacheWrite = 0 } = {}) {
  const p = MODEL_PRICING[model]
  if (!p || tokensIn == null || tokensOut == null) return null
  const inputEquiv = tokensIn + (cacheWrite || 0) * CACHE_WRITE_MULT + (cacheRead || 0) * CACHE_READ_MULT
  return +((inputEquiv / 1_000_000) * p.in + (tokensOut / 1_000_000) * p.out).toFixed(6)
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
 * @param {number}  [opts.cacheRead]   - cache_read_input_tokens
 * @param {number}  [opts.cacheWrite]  - cache_creation_input_tokens
 * @param {number}  opts.durationMs
 * @param {string}  [opts.llm]       - 'claude' | 'groq' | 'unknown'
 */
function logCall(opts) {
  const cost = estimateCost(opts.model, opts.tokensIn, opts.tokensOut, { cacheRead: opts.cacheRead, cacheWrite: opts.cacheWrite })
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
    cacheRead:  opts.cacheRead  || null,
    cacheWrite: opts.cacheWrite || null,
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

  let cacheRead = 0, cacheWrite = 0, uncachedIn = 0
  for (const e of _log) { cacheRead += e.cacheRead || 0; cacheWrite += e.cacheWrite || 0; uncachedIn += e.tokensIn || 0 }
  const promptTokens = cacheRead + cacheWrite + uncachedIn

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
    // Share of prompt tokens served from the prompt cache over the log window.
    cache: { readTokens: cacheRead, writeTokens: cacheWrite, hitRate: promptTokens ? +(cacheRead / promptTokens).toFixed(3) : null },
  }
}

module.exports = { logCall, getLog, getStats, estimateCost }
