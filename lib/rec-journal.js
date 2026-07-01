'use strict'
/**
 * lib/rec-journal.js — "decisions as commits" journal for AI recommendations.
 *
 * Each time the Advisory generates a recommendation set we append a versioned,
 * content-hashed entry (like a git commit): a short id, timestamp, the rationale
 * as the "commit message", and the normalized picks. The journal can then be
 * read back and DIFFED between versions — "last run said accumulate NVDA citing
 * X; this run trimmed it, and here's exactly what changed" — which is the
 * explainability/audit win, without any execution.
 *
 * Append-only JSONL under data/ (same pattern as the brain-learnings prediction
 * log). Pure helpers (hash/diff/normalize) + thin file I/O with an injectable
 * path for tests. No user input reaches the file path. No Claude usage.
 */

const fs   = require('fs')
const path = require('path')
const crypto = require('crypto')

const DATA_DIR     = path.join(__dirname, '../data')
const JOURNAL_LOG  = path.join(DATA_DIR, 'rec-journal.jsonl')

// Stable subset of a recommendation used for hashing + diffing.
function normalizePick(rec) {
  return {
    symbol:       String(rec.symbol || '').toUpperCase(),
    type:         rec.type ?? null,
    entryPrice:   rec.entryPrice ?? null,
    targetReturn: rec.targetReturn ?? null,
    stopLoss:     rec.stopLoss ?? null,
    thesis:       rec.thesis ?? null,
    // Evidence the pick was grounded in (source-grounded citations). Recorded so
    // the journal shows not just WHAT was decided but on WHAT basis.
    sources:      Array.isArray(rec.sources) ? rec.sources.map(String) : [],
  }
}

// Deterministic 8-char content hash over the picks (canonicalised by symbol)
// plus the rationale — same inputs ⇒ same id, any change ⇒ new id.
function hashEntry(picks, rationale = '') {
  const canonical = [...picks]
    .map(normalizePick)
    .sort((a, b) => a.symbol.localeCompare(b.symbol))
  const payload = JSON.stringify({ picks: canonical, rationale: rationale || '' })
  return crypto.createHash('sha256').update(payload).digest('hex').slice(0, 8)
}

/** Build a journal entry (a "commit") from a generated recommendation set. */
function buildEntry({ recommendations = [], rationale = '', persona = null, params = {}, userId = null, at = null }) {
  const picks = recommendations.map(normalizePick)
  return {
    id:        hashEntry(recommendations, rationale),
    at:        at || new Date().toISOString(),
    userId:    userId != null ? String(userId) : null,
    persona:   persona || 'default',
    rationale: rationale || '',
    params:    { includeMacro: !!params.includeMacro, includeFilings: !!params.includeFilings, includeFunds: !!params.includeFunds, focus: params.focus || null },
    count:     picks.length,
    picks,
  }
}

const DIFF_FIELDS = ['entryPrice', 'targetReturn', 'stopLoss', 'thesis', 'type']

/**
 * Diff two pick lists by symbol → { added, removed, changed }.
 * `added`/`removed` are symbol arrays; `changed` is [{ symbol, fields:{ field:{from,to} } }].
 */
function diffEntries(prevPicks = [], nextPicks = []) {
  const prev = new Map(prevPicks.map(p => [normalizePick(p).symbol, normalizePick(p)]))
  const next = new Map(nextPicks.map(p => [normalizePick(p).symbol, normalizePick(p)]))

  const added   = [...next.keys()].filter(s => !prev.has(s))
  const removed = [...prev.keys()].filter(s => !next.has(s))
  const changed = []
  for (const [sym, n] of next) {
    if (!prev.has(sym)) continue
    const p = prev.get(sym)
    const fields = {}
    for (const f of DIFF_FIELDS) {
      if (p[f] !== n[f]) fields[f] = { from: p[f], to: n[f] }
    }
    if (Object.keys(fields).length) changed.push({ symbol: sym, fields })
  }
  return { added, removed, changed }
}

// ── File I/O ──────────────────────────────────────────────────────────────────

function ensureDir(file) {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

/** Append an entry to the journal (best-effort; never throws to the caller). */
function appendEntry(entry, file = JOURNAL_LOG) {
  try {
    ensureDir(file)
    fs.appendFileSync(file, JSON.stringify(entry) + '\n')
    return true
  } catch (e) {
    console.warn('[rec-journal] append failed:', e.message)
    return false
  }
}

/** Read journal entries, newest first, optionally filtered by user + limited. */
function readJournal({ userId = null, limit = 20, file = JOURNAL_LOG } = {}) {
  let lines
  try {
    if (!fs.existsSync(file)) return []
    lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
  } catch { return [] }
  const entries = []
  for (const line of lines) {
    try { entries.push(JSON.parse(line)) } catch { /* skip corrupt line */ }
  }
  const filtered = userId != null ? entries.filter(e => e.userId === String(userId)) : entries
  return filtered.reverse().slice(0, limit)
}

/**
 * Read journal with each entry annotated with a diff vs the chronologically
 * previous entry for the same user — the "what changed since last time" view.
 */
function readJournalWithDiffs(opts = {}) {
  const entries = readJournal(opts) // newest first
  return entries.map((entry, i) => {
    const prev = entries[i + 1] // the next-older entry
    return { ...entry, diff: prev ? diffEntries(prev.picks, entry.picks) : null, prevId: prev?.id ?? null }
  })
}

module.exports = {
  JOURNAL_LOG,
  normalizePick, hashEntry, buildEntry, diffEntries,
  appendEntry, readJournal, readJournalWithDiffs,
}
