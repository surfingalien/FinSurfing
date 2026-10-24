'use strict'
/**
 * lib/ai-audit.js
 *
 * Audit log for all AI model calls: model, route, token counts (cached and
 * uncached), cost estimate, success/failure, duration.
 *
 * Persisted to data/ai-calls.jsonl (append-only, the newest MAX_ENTRIES kept;
 * mirrored by lib/durable-files.js) — it used to live in memory only, so every
 * deploy reset it and no cost or cache-hit trend could ever be measured.
 * Stats cover the stored window and say where it starts (`since`).
 */

const fs   = require('fs')
const path = require('path')
const { DATA_DIR } = require('./data-dir')
const { readJsonl, rewriteJsonl } = require('./atomic-write')

const LOG_FILE = path.join(DATA_DIR, 'ai-calls.jsonl')
const MAX_ENTRIES = 5000   // kept in memory and on disk; the file is compacted at 2×

// Approximate pricing per million tokens (input / output) in USD
const MODEL_PRICING = {
  'claude-opus-4-8':          { in: 15.00, out: 75.00 },
  'claude-sonnet-4-6':        { in:  3.00, out: 15.00 },
  'claude-haiku-4-5':         { in:  0.80, out:  4.00 },
  'openai/gpt-oss-120b':      { in:  0.15, out:  0.60 },  // Groq
  'llama-3.3-70b-versatile':  { in:  0.59, out:  0.79 },  // Groq — decommissioned 2026-09-21, kept for historic rows
}

let _idSeq    = 0
let _log      = []   // newest first
let _loaded   = false
let _persist  = true
let _fileRows = 0

// Lazy, so a test's data dir (tests/setup-env.js) is in place before the read.
function load() {
  if (_loaded) return
  _loaded = true
  let rows = []
  try { rows = readJsonl(LOG_FILE) } catch (e) {
    // The file exists but cannot be read: keep logging in memory, never compact over it.
    _persist = false
    console.error('[ai-audit] cannot read the call log, not persisting this process:', e.message)
  }
  _fileRows = rows.length
  _log = rows.slice(-MAX_ENTRIES).reverse()
  _idSeq = _log.reduce((m, e) => Math.max(m, Number(e.id) || 0), 0)
}

function persist(entry) {
  if (!_persist) return
  try {
    fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true })
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n')
    if (++_fileRows > 2 * MAX_ENTRIES) {
      rewriteJsonl(LOG_FILE, _log.slice().reverse())
      _fileRows = _log.length
    }
  } catch (e) {
    console.error('[ai-audit] could not write the call log:', e.message)
  }
}

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
  load()
  const cost = estimateCost(opts.model, opts.tokensIn, opts.tokensOut, { cacheRead: opts.cacheRead, cacheWrite: opts.cacheWrite })

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
  persist(entry)
}

function getLog(limit = 50) {
  load()
  return _log.slice(0, limit)
}

/** Calls, cost and cache-hit rate for a group of entries. */
function summarize(entries) {
  let costUsd = 0, cacheRead = 0, cacheWrite = 0, uncachedIn = 0
  for (const e of entries) {
    costUsd += e.costUsd || 0
    cacheRead += e.cacheRead || 0; cacheWrite += e.cacheWrite || 0; uncachedIn += e.tokensIn || 0
  }
  const promptTokens = cacheRead + cacheWrite + uncachedIn
  return {
    calls: entries.length,
    costUsd: +costUsd.toFixed(4),
    cacheHitRate: promptTokens ? +(cacheRead / promptTokens).toFixed(3) : null,
  }
}

function groupBy(entries, key) {
  const out = {}
  for (const e of entries) (out[key(e)] ||= []).push(e)
  return out
}

function getStats({ days = 30 } = {}) {
  load()
  const total   = _log.length
  const success = _log.filter(e => e.success).length
  const byRoute = {}
  const byModel = {}

  for (const e of _log) {
    byRoute[e.route] = (byRoute[e.route] || 0) + 1
    byModel[e.model] = (byModel[e.model] || 0) + 1
  }

  const all = summarize(_log)
  let cacheRead = 0, cacheWrite = 0
  for (const e of _log) { cacheRead += e.cacheRead || 0; cacheWrite += e.cacheWrite || 0 }

  // Per route and per day, so a cache hit rate that falls after a prompt
  // change (or a cost that climbs) shows up as a trend, not a single number.
  const routes = Object.fromEntries(Object.entries(groupBy(_log, e => e.route || 'unknown')).map(([r, es]) => [r, summarize(es)]))
  const cutoff = new Date(Date.now() - days * 86_400_000).toISOString().slice(0, 10)
  const byDay = Object.entries(groupBy(_log, e => String(e.ts).slice(0, 10)))
    .filter(([d]) => d >= cutoff)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, es]) => ({ date, ...summarize(es) }))

  const durations = _log.filter(e => e.durationMs).map(e => e.durationMs)
  const avgDurationMs = durations.length
    ? Math.round(durations.reduce((a, b) => a + b, 0) / durations.length)
    : null

  return {
    total,
    success,
    failures:       total - success,
    successRate:    total ? +(success / total * 100).toFixed(1) : null,
    totalCostUsd:   all.costUsd,
    since:          _log.length ? _log[_log.length - 1].ts : null,
    avgDurationMs,
    byRoute,
    byModel,
    // Share of prompt tokens served from the prompt cache over the log window.
    cache: { readTokens: cacheRead, writeTokens: cacheWrite, hitRate: all.cacheHitRate },
    routes,
    byDay,
  }
}

/** Tests only: forget the in-memory copy so the next call re-reads the file. */
function _reset() { _loaded = false; _persist = true; _log = []; _idSeq = 0; _fileRows = 0 }

module.exports = { LOG_FILE, MAX_ENTRIES, logCall, getLog, getStats, estimateCost, _reset }
