'use strict'

/**
 * lib/durable-files.js
 *
 * Makes the Brain's learning stores survive a deploy.
 *
 * Every learning store in this repo (prediction log, decision log, strategy
 * library, learned lessons, baseline weights, recommendation journal, entity
 * graph, paper book, scan results) is a file under data/. Railway's filesystem
 * is ephemeral, so each deploy reset them: the prediction log went back to the
 * handful of rows tracked in git and everything else to empty. Deploys have
 * been 8-28 days apart, so a 30-day outcome could never resolve — the
 * self-improvement loop was learning from nothing, and nothing said so.
 *
 * Rewriting a dozen synchronous file stores against an async database would
 * touch every read path in the Brain. Instead this MIRRORS the files:
 *
 *   restoreSync()  — at boot, BEFORE any module reads data/ (ai-job-queue loads
 *                    at require time), pull each file's last snapshot out of
 *                    Postgres and write it to disk. The DB copy wins: it is the
 *                    one that survived. Runs in a child process so it can be
 *                    synchronous without blocking on an async driver.
 *   startMirror()  — every FLUSH_MS, push any file whose content changed.
 *   installShutdownFlush() — one last push on SIGTERM (Railway's deploy
 *                    signal), bounded by a deadline.
 *
 * The rule the whole module is built around: a failed restore must NEVER be
 * followed by a flush. If the DB was unreachable at boot, the disk holds the
 * git seed, and pushing that would overwrite the real history with six rows.
 * So a file is flushed only after its restore positively succeeded — either a
 * snapshot came back, or the DB answered that none exists yet.
 *
 * Concurrency: each row carries a version and writes are conditional on it. A
 * conflict (another instance wrote first — the old/new overlap during a
 * deploy) is logged and the newer version adopted, so the process that keeps
 * running is authoritative. Writes the outgoing instance made inside that
 * overlap window are the known, bounded loss.
 *
 * Inert without DATABASE_URL (local dev keeps plain files) or with
 * DURABLE_FILES=off.
 */

const fs     = require('fs')
const path   = require('path')
const zlib   = require('zlib')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const { PREDICTION_LOG } = require('./prediction-log-path')

const { DATA_DIR } = require('./data-dir')

// tailOk: only the newest lines are ever read, so an oversized file may be
// mirrored as its tail rather than skipped. Everything else is all-or-nothing:
// a truncated strategy library or prediction log would be silently wrong.
const FILES = [
  { name: 'ai-brain-predictions.jsonl',     path: PREDICTION_LOG },
  { name: 'learning-store.jsonl',           path: path.join(DATA_DIR, 'learning-store.jsonl') },
  { name: 'strategy-library.jsonl',         path: path.join(DATA_DIR, 'strategy-library.jsonl') },
  { name: 'brain-learnings.json',           path: path.join(DATA_DIR, 'brain-learnings.json') },
  { name: 'brain-learnings-overrides.json', path: path.join(DATA_DIR, 'brain-learnings-overrides.json') },
  { name: 'ml-baseline-weights.json',       path: path.join(DATA_DIR, 'ml-baseline-weights.json') },
  { name: 'rec-journal.jsonl',              path: path.join(DATA_DIR, 'rec-journal.jsonl') },
  { name: 'entity-graph.jsonl',             path: path.join(DATA_DIR, 'entity-graph.jsonl') },
  { name: 'paper-portfolio.json',           path: path.join(DATA_DIR, 'paper-portfolio.json') },
  { name: 'paper-trades.jsonl',             path: path.join(DATA_DIR, 'paper-trades.jsonl') },
  { name: 'research-theses.jsonl',          path: process.env.RESEARCH_THESES_LOG || path.join(DATA_DIR, 'research-theses.jsonl') },
  { name: 'brain-refinements.jsonl',        path: path.join(DATA_DIR, 'brain-refinements.jsonl'), tailOk: true },
  { name: 'scan-jobs.jsonl',                path: path.join(DATA_DIR, 'scan-jobs.jsonl'),        tailOk: true },
]

const FLUSH_MS          = 30_000
const RESTORE_TIMEOUT   = 20_000
const SHUTDOWN_DEADLINE = 8_000
const MAX_BYTES = Math.max(1, Number(process.env.DURABLE_FILES_MAX_MB) || 32) * 1024 * 1024

const CREATE_TABLE = `
  CREATE TABLE IF NOT EXISTS durable_files (
    name        TEXT        PRIMARY KEY,
    content     BYTEA       NOT NULL,
    sha256      TEXT        NOT NULL,
    bytes       BIGINT      NOT NULL,
    version     INTEGER     NOT NULL,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`

// ── Pure helpers ──────────────────────────────────────────────────────────────

const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex')
const encode = buf => zlib.gzipSync(buf)
const decode = buf => zlib.gunzipSync(buf)

/** Newest whole lines of buf fitting in maxBytes (never a partial first line). */
function tailLines(buf, maxBytes) {
  if (buf.length <= maxBytes) return buf
  const start = buf.length - maxBytes
  if (buf[start - 1] === 0x0a) return buf.subarray(start)   // cut already on a line boundary
  const nl = buf.indexOf(0x0a, start)
  return nl === -1 ? Buffer.alloc(0) : buf.subarray(nl + 1)
}

/** What to persist for a file's current bytes, or a reason not to. */
function payloadFor(entry, buf, maxBytes = MAX_BYTES) {
  if (buf.length <= maxBytes) return { payload: buf, truncated: false }
  if (entry.tailOk) return { payload: tailLines(buf, maxBytes), truncated: true }
  return { skip: `exceeds ${Math.round(maxBytes / 1048576)}MB and is not safe to truncate` }
}

function writeAtomic(file, buf) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.restore-${process.pid}`
  fs.writeFileSync(tmp, buf)
  fs.renameSync(tmp, file)
}

// ── Restore (runs inside the child process) ──────────────────────────────────

/**
 * Pull every registered file's snapshot and write it to disk.
 * Returns { files: { name: { status, version, sha } } } where status is
 *   'restored' — DB snapshot written to disk (DB wins)
 *   'absent'   — DB has no row yet; disk is the seed, first flush creates it
 *   'corrupt'  — row unreadable; disk left alone AND never flushed, so a bad
 *                row can't be "repaired" by overwriting it with the git seed
 */
async function restoreFromDb(query, files = FILES) {
  await query(CREATE_TABLE)
  const { rows } = await query(
    'SELECT name, content, sha256, version FROM durable_files WHERE name = ANY($1)',
    [files.map(f => f.name)],
  )
  const byName = new Map(rows.map(r => [r.name, r]))
  const out = {}
  for (const f of files) {
    const row = byName.get(f.name)
    if (!row) { out[f.name] = { status: 'absent', version: 0, sha: null }; continue }
    try {
      const buf = decode(row.content)
      if (sha256(buf) !== row.sha256) throw new Error('checksum mismatch')
      writeAtomic(f.path, buf)
      out[f.name] = { status: 'restored', version: row.version, sha: row.sha256, bytes: buf.length }
    } catch (e) {
      out[f.name] = { status: 'corrupt', version: row.version, sha: row.sha256, error: e.message }
    }
  }
  return { files: out }
}

// ── Parent-side state ─────────────────────────────────────────────────────────

let _enabled  = false
let _reason   = 'not started'
let _state    = new Map()   // name → { version, sha, mtimeMs, size, flushable, conflicts, lastFlushAt, note }
let _timer    = null
let _flushing = null

function _wanted(env = process.env) {
  if (!env.DATABASE_URL) return 'no DATABASE_URL — plain files only'
  if (String(env.DURABLE_FILES || '').toLowerCase() === 'off') return 'disabled by DURABLE_FILES=off'
  return null
}

function _statOf(file) {
  try { const s = fs.statSync(file); return { mtimeMs: s.mtimeMs, size: s.size } }
  catch { return null }
}

/** Adopt a restore summary. Exported for tests; restoreSync() is the real caller. */
function _adopt(summary, files = FILES) {
  _state = new Map()
  for (const f of files) {
    const r = summary?.files?.[f.name]
    const st = _statOf(f.path)
    _state.set(f.name, {
      version:   r?.version ?? 0,
      sha:       r?.sha ?? null,
      // A file restored or confirmed-absent is safe to flush; anything else
      // (corrupt row, or a file the restore didn't report on) is not.
      flushable: r?.status === 'restored' || r?.status === 'absent',
      status:    r?.status || 'unknown',
      mtimeMs:   r?.status === 'restored' ? st?.mtimeMs ?? null : null,
      size:      r?.status === 'restored' ? st?.size ?? null : null,
      conflicts: 0,
      lastFlushAt: null,
      note:      r?.error || null,
    })
  }
  _enabled = true
  _reason  = 'active'
}

/**
 * Synchronous boot-time restore. Call before any module that reads data/ is
 * required. Never throws: on any failure the mirror stays DISABLED for this
 * process (see header — flushing after a failed restore destroys history).
 */
function restoreSync({ env = process.env, exec = execFileSync } = {}) {
  const skip = _wanted(env)
  if (skip) { _enabled = false; _reason = skip; return { enabled: false, reason: skip } }
  try {
    const stdout = exec(process.execPath, [path.join(__dirname, 'durable-files-restore.js')], {
      env, timeout: RESTORE_TIMEOUT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    })
    const line = String(stdout).trim().split('\n').pop()
    const summary = JSON.parse(line)
    if (summary.error) throw new Error(summary.error)
    _adopt(summary)
    const counts = {}
    for (const r of Object.values(summary.files)) counts[r.status] = (counts[r.status] || 0) + 1
    console.log('[durable-files] restore:', JSON.stringify(counts))
    for (const [name, r] of Object.entries(summary.files)) {
      if (r.status === 'corrupt') console.error(`[durable-files] ${name}: stored snapshot unreadable (${r.error}) — left untouched, not flushing`)
    }
    return { enabled: true, summary }
  } catch (e) {
    _enabled = false
    _reason  = `restore failed: ${e.message.split('\n')[0].slice(0, 200)}`
    console.error(`[durable-files] ${_reason} — learning stores will NOT be persisted this run (refusing to overwrite the stored history with the local seed)`)
    return { enabled: false, reason: _reason }
  }
}

async function _flushOne(query, entry, { retryConflict = true } = {}) {
  const s = _state.get(entry.name)
  if (!s?.flushable) return 'skipped'
  const st = _statOf(entry.path)
  if (!st) return 'missing'              // never delete the stored copy because a file is absent
  if (st.mtimeMs === s.mtimeMs && st.size === s.size) return 'unchanged'

  const buf = fs.readFileSync(entry.path)
  const p = payloadFor(entry, buf)
  if (p.skip) {
    if (s.note !== p.skip) console.warn(`[durable-files] ${entry.name}: ${p.skip} — not persisted`)
    s.note = p.skip; s.mtimeMs = st.mtimeMs; s.size = st.size
    return 'too-large'
  }
  const digest = sha256(p.payload)
  if (digest === s.sha) { s.mtimeMs = st.mtimeMs; s.size = st.size; return 'unchanged' }

  const { rows } = await query(
    `INSERT INTO durable_files (name, content, sha256, bytes, version, updated_at)
       VALUES ($1, $2, $3, $4, 1, NOW())
     ON CONFLICT (name) DO UPDATE
       SET content = EXCLUDED.content, sha256 = EXCLUDED.sha256, bytes = EXCLUDED.bytes,
           version = durable_files.version + 1, updated_at = NOW()
     WHERE durable_files.version = $5
     RETURNING version`,
    [entry.name, encode(p.payload), digest, p.payload.length, s.version],
  )
  if (!rows.length) {
    // Another instance wrote since we last synced. The running process is the
    // authoritative one: adopt their version so the next tick writes ours.
    s.conflicts++
    const cur = await query('SELECT version FROM durable_files WHERE name = $1', [entry.name])
    s.version = cur.rows[0]?.version ?? s.version
    console.warn(`[durable-files] ${entry.name}: version conflict (another instance wrote) — ${retryConflict ? 'will overwrite next tick' : 'dropped at shutdown'}`)
    return 'conflict'
  }
  s.version = rows[0].version
  s.sha = digest
  s.mtimeMs = st.mtimeMs; s.size = st.size
  s.lastFlushAt = new Date().toISOString()
  s.note = p.truncated ? `stored newest ${p.payload.length} of ${buf.length} bytes` : null
  return 'flushed'
}

/** Push every changed file. Serialised: overlapping ticks share one run. */
function flushChanged({ query, files = FILES, retryConflict = true } = {}) {
  if (!_enabled) return Promise.resolve({})
  if (_flushing) return _flushing
  const q = query || require('../db/db').query
  _flushing = (async () => {
    const results = {}
    for (const f of files) {
      try { results[f.name] = await _flushOne(q, f, { retryConflict }) }
      catch (e) {
        results[f.name] = 'error'
        const s = _state.get(f.name); if (s) s.note = `flush failed: ${e.message}`
        console.warn(`[durable-files] ${f.name}: flush failed:`, e.message)
      }
    }
    return results
  })().finally(() => { _flushing = null })
  return _flushing
}

function startMirror({ intervalMs = FLUSH_MS } = {}) {
  if (!_enabled || _timer) return false
  _timer = setInterval(() => { flushChanged().catch(() => {}) }, intervalMs)
  if (_timer.unref) _timer.unref()
  return true
}

/**
 * Flush once more on SIGTERM/SIGINT, then exit. Installing a handler replaces
 * Node's default exit-on-signal, so this handler must exit itself — bounded by
 * a deadline so a hung DB can't hold a deploy.
 */
function installShutdownFlush() {
  if (!_enabled) return false
  let done = false
  const onSignal = sig => {
    if (done) return
    done = true
    if (_timer) { clearInterval(_timer); _timer = null }
    const deadline = setTimeout(() => {
      console.warn(`[durable-files] ${sig}: final flush timed out`)
      process.exit(0)
    }, SHUTDOWN_DEADLINE)
    flushChanged({ retryConflict: false })
      .then(r => console.log(`[durable-files] ${sig}: final flush`, JSON.stringify(r)))
      .catch(e => console.warn(`[durable-files] ${sig}: final flush failed:`, e.message))
      .finally(() => { clearTimeout(deadline); process.exit(0) })
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT',  () => onSignal('SIGINT'))
  return true
}

/** Server-side aggregate for observability — names, versions, no content. */
function status() {
  return {
    enabled: _enabled,
    reason:  _reason,
    files: [..._state.entries()].map(([name, s]) => ({
      name, restoredAs: s.status, flushable: s.flushable, version: s.version,
      lastFlushAt: s.lastFlushAt, conflicts: s.conflicts, note: s.note,
    })),
  }
}

function _resetForTests() {
  if (_timer) clearInterval(_timer)
  _enabled = false; _reason = 'not started'; _state = new Map(); _timer = null; _flushing = null
}

module.exports = {
  FILES, MAX_BYTES, CREATE_TABLE,
  restoreSync, restoreFromDb, flushChanged, startMirror, installShutdownFlush, status,
  // pure / test hooks
  tailLines, payloadFor, sha256, encode, decode, _adopt, _resetForTests,
}
