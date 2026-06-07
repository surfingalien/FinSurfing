'use strict'
/**
 * lib/backtest-queue.js
 *
 * Sequential overnight backtest queue.
 *
 * Jobs are enqueued via enqueue() and run one-at-a-time in the background.
 * Results are appended to RESULTS_FILE (JSONL) and kept in memory for fast reads.
 *
 * API surface (consumed by routes/backtest-queue.js):
 *   enqueue(job)     → { id, position }
 *   getQueue()       → { pending, running, done }
 *   getResults(n)    → last n completed results
 *   cancel(id)       → bool
 */

const fs   = require('fs')
const path = require('path')

const RESULTS_FILE = path.join(__dirname, '..', 'backtest-results.jsonl')
const MAX_RESULTS  = 500   // keep in memory
const MAX_QUEUE    = 100   // reject if queue is full

// ── State ─────────────────────────────────────────────────────────────────────

const _pending  = []          // [{id, job, enqueuedAt}]
const _results  = []          // [{id, job, result|error, startedAt, finishedAt}]
let   _running  = null        // current {id, job, startedAt}
let   _workerRunning = false

// ── Enqueue ───────────────────────────────────────────────────────────────────

function enqueue(job) {
  if (_pending.length >= MAX_QUEUE)
    throw new Error(`Queue full (${MAX_QUEUE} pending). Try again later.`)

  const id = `bt-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  _pending.push({ id, job, enqueuedAt: new Date().toISOString() })
  _kickWorker()
  return { id, position: _pending.length }
}

function cancel(id) {
  const idx = _pending.findIndex(p => p.id === id)
  if (idx === -1) return false
  _pending.splice(idx, 1)
  return true
}

// ── Worker ────────────────────────────────────────────────────────────────────

function _kickWorker() {
  if (_workerRunning) return
  _workerRunning = true
  setImmediate(_runNext)
}

async function _runNext() {
  if (!_pending.length) { _workerRunning = false; _running = null; return }

  const item     = _pending.shift()
  _running       = { id: item.id, job: item.job, startedAt: new Date().toISOString() }

  const entry = { id: item.id, job: item.job, enqueuedAt: item.enqueuedAt, startedAt: _running.startedAt }

  try {
    const result  = await _runBacktest(item.job)
    entry.result  = result
    entry.status  = 'done'
  } catch (e) {
    entry.error   = e.message
    entry.status  = 'failed'
  }

  entry.finishedAt = new Date().toISOString()
  _running         = null

  // Persist to JSONL
  try { fs.appendFileSync(RESULTS_FILE, JSON.stringify(entry) + '\n') } catch {}

  // Keep in-memory ring buffer
  _results.push(entry)
  if (_results.length > MAX_RESULTS) _results.shift()

  // Process next
  setImmediate(_runNext)
}

// ── Backtest runner (calls internal API) ─────────────────────────────────────

async function _runBacktest(job) {
  const port = process.env.PORT || 3001
  const r    = await fetch(`http://127.0.0.1:${port}/api/backtest`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal': '1' },
    body:    JSON.stringify(job),
    signal:  AbortSignal.timeout(120_000),
  })
  const data = await r.json()
  if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`)
  return data
}

// ── Read ──────────────────────────────────────────────────────────────────────

function getQueue() {
  return {
    pending: _pending.map(p => ({ id: p.id, job: p.job, enqueuedAt: p.enqueuedAt })),
    running: _running ? { id: _running.id, job: _running.job, startedAt: _running.startedAt } : null,
    completedCount: _results.length,
  }
}

function getResults(n = 20) {
  return _results.slice(-Math.min(n, MAX_RESULTS)).reverse()
}

// ── Load persisted results on startup ────────────────────────────────────────

function loadPersistedResults() {
  try {
    if (!fs.existsSync(RESULTS_FILE)) return
    const lines = fs.readFileSync(RESULTS_FILE, 'utf8').trim().split('\n').filter(Boolean)
    const recent = lines.slice(-MAX_RESULTS)
    for (const line of recent) {
      try { _results.push(JSON.parse(line)) } catch {}
    }
    console.log(`[backtest-queue] loaded ${_results.length} persisted results`)
  } catch (e) {
    console.warn('[backtest-queue] could not load persisted results:', e.message)
  }
}

loadPersistedResults()

module.exports = { enqueue, cancel, getQueue, getResults }
