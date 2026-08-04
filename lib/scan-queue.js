'use strict'
/**
 * lib/scan-queue.js
 *
 * Background AI Brain scans — start one, close the browser, come back to it.
 *
 * A scan takes 2–4 minutes. Holding an HTTP connection open for that long ties
 * the result to a live browser tab: close it, lose the scan, pay for the LLM
 * call anyway. (It also made the request fragile on mobile — see
 * lib/http-heartbeat.js.) Here the request only ENQUEUES; the scan runs on the
 * server and the result is persisted, so the tab is irrelevant to whether the
 * work completes.
 *
 * Follows the same shape as lib/backtest-queue.js (sequential worker, JSONL
 * persistence, in-memory ring buffer) rather than inventing a second job model.
 *
 * Scans run ONE AT A TIME on purpose: each one is an expensive multi-model LLM
 * call plus ~20 market-data fetches, so parallel runs would multiply cost and
 * trip provider rate limits.
 *
 * API KEYS: background jobs use the SERVER's env keys, never the browser's.
 * Persisting a user's API keys to disk to replay later is not a trade worth
 * making, and every other background job here already works this way.
 *
 * Tests: tests/scan-queue.test.js
 */

const fs   = require('fs')
const path = require('path')
const { INTERNAL_SECRET } = require('./internal-secret')

const DATA_DIR   = path.join(__dirname, '../data')
const JOBS_FILE  = path.join(DATA_DIR, 'scan-jobs.jsonl')

const MAX_QUEUE       = 20    // reject beyond this many waiting
const MAX_RESULTS     = 50    // completed jobs kept in memory / restored on boot
const MAX_PER_USER    = 3     // a single user can't monopolise the queue
const SCAN_TIMEOUT_MS = 600_000

// ── State ─────────────────────────────────────────────────────────────────────
const _pending = []      // [{ id, userId, params, enqueuedAt }]
const _results = []      // terminal jobs (done | failed), oldest first
let   _running = null    // { id, userId, params, startedAt }
let   _workerRunning = false

const nowIso = () => new Date().toISOString()

function newId() {
  return `scan-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

// ── Enqueue ───────────────────────────────────────────────────────────────────

/**
 * Queue a scan. Returns { id, position } — position 1 means it starts now.
 * Throws when the queue is full or the user already has too many waiting.
 */
function enqueue({ userId = null, params = {}, label = null } = {}) {
  if (_pending.length >= MAX_QUEUE)
    throw new Error(`Scan queue is full (${MAX_QUEUE} waiting). Try again shortly.`)

  const uid = userId != null ? String(userId) : null
  const mine = _pending.filter(p => p.userId === uid).length + (_running?.userId === uid ? 1 : 0)
  if (uid != null && mine >= MAX_PER_USER)
    throw new Error(`You already have ${mine} scans queued or running. Wait for one to finish.`)

  const item = { id: newId(), userId: uid, params, label, enqueuedAt: nowIso() }
  _pending.push(item)
  _kickWorker()
  return { id: item.id, position: _pending.length }
}

/** Cancel a PENDING job. A running scan can't be cancelled — it's already paid for. */
function cancel(id, userId = null) {
  const uid = userId != null ? String(userId) : null
  const idx = _pending.findIndex(p => p.id === id && (uid == null || p.userId === uid))
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

  const item = _pending.shift()
  _running = { id: item.id, userId: item.userId, params: item.params, startedAt: nowIso() }

  const entry = {
    id: item.id, userId: item.userId, params: item.params, label: item.label,
    enqueuedAt: item.enqueuedAt, startedAt: _running.startedAt,
  }

  try {
    entry.result = await _runScan(item.params)
    entry.status = 'done'
  } catch (e) {
    entry.error  = e.message
    entry.status = 'failed'
  }
  entry.finishedAt = nowIso()
  _running = null

  _record(entry)
  setImmediate(_runNext)
}

function _record(entry) {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.appendFileSync(JOBS_FILE, JSON.stringify(entry) + '\n')
  } catch (e) {
    console.warn('[scan-queue] persist failed:', e.message)
  }
  _results.push(entry)
  while (_results.length > MAX_RESULTS) _results.shift()
}

// Run the scan through the existing analyze route over loopback, so the queue
// never duplicates scan logic — one implementation, one place to fix.
async function _runScan(params) {
  const port = process.env.PORT || 3001
  const r = await fetch(`http://127.0.0.1:${port}/api/ai-brain/analyze`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal': '1', 'x-internal-secret': INTERNAL_SECRET,
    },
    body:   JSON.stringify(params),
    signal: AbortSignal.timeout(SCAN_TIMEOUT_MS),
  })
  const data = await r.json()
  // The analyze route is heartbeated, so a late failure arrives as 200 with an
  // `error` body — check both, exactly as the browser client does.
  if (!r.ok || data?.error) throw new Error(data?.error || `HTTP ${r.status}`)
  return data
}

// ── Read ──────────────────────────────────────────────────────────────────────

/** Public view of a job — omits userId. */
function _view(j) {
  if (!j) return null
  return {
    id: j.id,
    status: j.status,
    params: j.params,
    label: j.label ?? null,
    enqueuedAt: j.enqueuedAt ?? null,
    startedAt: j.startedAt ?? null,
    finishedAt: j.finishedAt ?? null,
    error: j.error ?? null,
    result: j.result ?? null,
  }
}

/**
 * Look up one job by id, scoped to its owner. Returns null when it doesn't
 * exist OR belongs to someone else — an unknown id and someone else's id are
 * deliberately indistinguishable.
 */
function getJob(id, userId = null) {
  const uid = userId != null ? String(userId) : null
  const owns = j => uid == null || j.userId === uid

  if (_running?.id === id && owns(_running))
    return _view({ ..._running, status: 'running' })

  const p = _pending.find(x => x.id === id)
  if (p && owns(p))
    return _view({ ...p, status: 'queued', position: _pending.indexOf(p) + 1 })

  const done = [..._results].reverse().find(x => x.id === id)
  return (done && owns(done)) ? _view(done) : null
}

/** A user's jobs, newest first, including anything queued or running. */
function getUserJobs(userId = null, limit = 10) {
  const uid = userId != null ? String(userId) : null
  const mine = j => uid == null || j.userId === uid
  const out = []
  if (_running && mine(_running)) out.push(_view({ ..._running, status: 'running' }))
  for (const p of _pending) if (mine(p)) out.push(_view({ ...p, status: 'queued' }))
  for (const d of [..._results].reverse()) if (mine(d)) out.push(_view(d))
  return out.slice(0, Math.max(1, Math.min(limit, MAX_RESULTS)))
}

/** The user's most recent COMPLETED scan — what to show on a fresh page load. */
function getLatestResult(userId = null) {
  const uid = userId != null ? String(userId) : null
  for (let i = _results.length - 1; i >= 0; i--) {
    const j = _results[i]
    if (j.status === 'done' && (uid == null || j.userId === uid)) return _view(j)
  }
  return null
}

function getQueue() {
  return {
    pending: _pending.length,
    running: _running ? { id: _running.id, startedAt: _running.startedAt } : null,
    completed: _results.length,
  }
}

// ── Startup ───────────────────────────────────────────────────────────────────
// Restore completed jobs so a redeploy doesn't erase a scan the user already
// paid for. Jobs that were mid-flight are gone with the process — they are not
// restored as "running", which would strand a job that will never finish.

function loadPersisted() {
  try {
    if (!fs.existsSync(JOBS_FILE)) return
    const lines = fs.readFileSync(JOBS_FILE, 'utf8').split('\n').filter(Boolean).slice(-MAX_RESULTS)
    for (const line of lines) {
      try {
        const j = JSON.parse(line)
        if (j?.status === 'done' || j?.status === 'failed') _results.push(j)
      } catch { /* skip corrupt line */ }
    }
    if (_results.length) console.log(`[scan-queue] restored ${_results.length} completed scans`)
  } catch (e) {
    console.warn('[scan-queue] could not restore scans:', e.message)
  }
}

loadPersisted()

// Test hook — clears state without touching disk.
function _resetForTests() {
  _pending.length = 0
  _results.length = 0
  _running = null
  _workerRunning = false
}

module.exports = {
  enqueue, cancel, getJob, getUserJobs, getLatestResult, getQueue,
  MAX_QUEUE, MAX_PER_USER, JOBS_FILE, _resetForTests,
}
