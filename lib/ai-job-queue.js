'use strict'
/**
 * lib/ai-job-queue.js
 *
 * Background jobs for the long AI surfaces — start one, close the browser,
 * come back to the result.
 *
 * An AI Brain scan runs 2–4 minutes; an Advisory generation is a 16k-token
 * call. Holding an HTTP connection open for either ties the result to a live
 * browser tab: close it, lose the work, pay for the LLM call anyway. On mobile
 * the connection frequently died on its own, surfacing as a bare "Load failed"
 * (see lib/http-heartbeat.js). Here the request only ENQUEUES; the job runs on
 * the server and the result is persisted, so the tab is irrelevant to whether
 * the work completes.
 *
 * ONE QUEUE, MANY KINDS. Both surfaces have the same shape — a long internal
 * POST whose result must outlive the request — so they share this queue via the
 * JOB_KINDS registry rather than each getting a near-identical copy. Two
 * hand-maintained job queues drift; adding a kind here is one table entry.
 *
 * Follows lib/backtest-queue.js (sequential worker, JSONL persistence,
 * in-memory ring buffer) rather than inventing another job model.
 *
 * Jobs run ONE AT A TIME on purpose: each is an expensive LLM call plus a fan
 * of market-data fetches, so parallel runs would multiply cost and trip
 * provider rate limits.
 *
 * API KEYS: background jobs use the SERVER's env keys, never the browser's.
 * Persisting a user's API keys to disk to replay later is not a trade worth
 * making, and every other background job here already works this way.
 *
 * Tests: tests/ai-job-queue.test.js
 */

const fs   = require('fs')
const path = require('path')
const { INTERNAL_SECRET } = require('./internal-secret')

const DATA_DIR   = path.join(__dirname, '../data')
// Named for the original scan-only queue on purpose: keeping the filename means
// scans a user already paid for survive this generalisation.
const JOBS_FILE  = path.join(DATA_DIR, 'scan-jobs.jsonl')

const MAX_QUEUE       = 20    // reject beyond this many waiting
const MAX_RESULTS     = 50    // completed jobs kept in memory / restored on boot
const MAX_PER_USER    = 3     // a single user can't monopolise the queue

/**
 * The job kinds this queue can run. Each maps to an internal endpoint that
 * already implements the work, so the queue never duplicates business logic —
 * it only decides WHEN something runs and remembers the answer.
 */
const JOB_KINDS = {
  scan: {
    path:      '/api/ai-brain/analyze',
    timeoutMs: 600_000,
    noun:      'scan',
    prefix:    'scan',
  },
  recommendations: {
    path:      '/api/recommendations',
    timeoutMs: 300_000,
    noun:      'recommendation run',
    prefix:    'rec',
  },
}
const DEFAULT_KIND = 'scan'

// ── State ─────────────────────────────────────────────────────────────────────
const _pending = []      // [{ id, userId, params, enqueuedAt }]
const _results = []      // terminal jobs (done | failed), oldest first
let   _running = null    // { id, userId, params, startedAt }
let   _workerRunning = false

const nowIso = () => new Date().toISOString()

function newId(kind) {
  const prefix = JOB_KINDS[kind]?.prefix || 'job'
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
}

// ── Enqueue ───────────────────────────────────────────────────────────────────

/**
 * Queue a job. Returns { id, position } — position 1 means it starts now.
 * Throws when the kind is unknown, the queue is full, or the user already has
 * too many waiting.
 */
function enqueue({ userId = null, kind = DEFAULT_KIND, params = {}, label = null } = {}) {
  const def = JOB_KINDS[kind]
  if (!def) throw new Error(`Unknown job kind: ${kind}`)
  if (_pending.length >= MAX_QUEUE)
    throw new Error(`The queue is full (${MAX_QUEUE} waiting). Try again shortly.`)

  const uid = userId != null ? String(userId) : null
  const mine = _pending.filter(p => p.userId === uid).length + (_running?.userId === uid ? 1 : 0)
  if (uid != null && mine >= MAX_PER_USER)
    throw new Error(`You already have ${mine} jobs queued or running. Wait for one to finish.`)

  const item = { id: newId(kind), userId: uid, kind, params, label, enqueuedAt: nowIso() }
  _pending.push(item)
  _kickWorker()
  return { id: item.id, position: _pending.length }
}

/** Cancel a PENDING job. A running job can't be cancelled — it's already paid for. */
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
  _running = { id: item.id, userId: item.userId, kind: item.kind, params: item.params, startedAt: nowIso() }

  const entry = {
    id: item.id, userId: item.userId, kind: item.kind, params: item.params, label: item.label,
    enqueuedAt: item.enqueuedAt, startedAt: _running.startedAt,
  }

  try {
    entry.result = await _runJob(item.kind, item.params)
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
    console.warn('[ai-jobs] persist failed:', e.message)
  }
  _results.push(entry)
  while (_results.length > MAX_RESULTS) _results.shift()
}

// Run the job through its existing route over loopback, so the queue never
// duplicates business logic — one implementation, one place to fix.
async function _runJob(kind, params) {
  const def = JOB_KINDS[kind] || JOB_KINDS[DEFAULT_KIND]
  const port = process.env.PORT || 3001
  const r = await fetch(`http://127.0.0.1:${port}${def.path}`, {
    method:  'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-internal': '1', 'x-internal-secret': INTERNAL_SECRET,
    },
    body:   JSON.stringify(params),
    signal: AbortSignal.timeout(def.timeoutMs),
  })
  const data = await r.json()
  // Both routes are heartbeated, so a late failure arrives as 200 with an
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
    kind: j.kind ?? DEFAULT_KIND,
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

/** A user's jobs, newest first, including anything queued or running.
 *  `kind` narrows to one surface so Advisory doesn't show Brain scans. */
function getUserJobs(userId = null, limit = 10, kind = null) {
  const uid = userId != null ? String(userId) : null
  const mine = j => (uid == null || j.userId === uid) &&
                    (kind == null || (j.kind ?? DEFAULT_KIND) === kind)
  const out = []
  if (_running && mine(_running)) out.push(_view({ ..._running, status: 'running' }))
  for (const p of _pending) if (mine(p)) out.push(_view({ ...p, status: 'queued' }))
  for (const d of [..._results].reverse()) if (mine(d)) out.push(_view(d))
  return out.slice(0, Math.max(1, Math.min(limit, MAX_RESULTS)))
}

/** The user's most recent COMPLETED job of a kind — what a fresh page load shows. */
function getLatestResult(userId = null, kind = null) {
  const uid = userId != null ? String(userId) : null
  for (let i = _results.length - 1; i >= 0; i--) {
    const j = _results[i]
    if (j.status !== 'done') continue
    if (uid != null && j.userId !== uid) continue
    if (kind != null && (j.kind ?? DEFAULT_KIND) !== kind) continue
    return _view(j)
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
    if (_results.length) console.log(`[ai-jobs] restored ${_results.length} completed jobs`)
  } catch (e) {
    console.warn('[ai-jobs] could not restore jobs:', e.message)
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
  JOB_KINDS, DEFAULT_KIND, MAX_QUEUE, MAX_PER_USER, JOBS_FILE, _resetForTests,
}
