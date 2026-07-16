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
 *
 * TAMPER EVIDENCE: entries are hash-CHAINED at append time — each entry's
 * chainHash covers its own content plus the previous entry's chainHash, so
 * editing, deleting, or reordering any historical entry breaks every hash
 * after it. verifyChain() walks the file and pinpoints the first break.
 * Entries written before chaining existed are counted as "legacy" and the
 * chain is anchored at the first chained entry.
 *
 * TRUST SCORING: each entry carries a 0-100 trust score and a gold / silver /
 * bronze / quarantined tier, from how well-formed and well-grounded the
 * persona's picks are (entry/target/stop discipline, thesis, and cited
 * sources). The advice trail shows not just what was recommended, but how
 * accountable each recommendation set was.
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

// ── Trust scoring ─────────────────────────────────────────────────────────────

// Per-pick accountability: a pick that names its entry, target, stop, thesis,
// AND cites sources is a fully accountable recommendation; one that's just a
// ticker with vibes is not. Weights favour grounding (thesis + sources).
const TRUST_WEIGHTS = { entryPrice: 15, targetReturn: 15, stopLoss: 20, thesis: 25, sources: 25 }

function scorePick(pick) {
  const p = normalizePick(pick)
  let score = 0
  if (p.entryPrice != null)   score += TRUST_WEIGHTS.entryPrice
  if (p.targetReturn != null) score += TRUST_WEIGHTS.targetReturn
  if (p.stopLoss != null)     score += TRUST_WEIGHTS.stopLoss
  if (p.thesis && String(p.thesis).trim().length >= 20) score += TRUST_WEIGHTS.thesis
  if (p.sources.length > 0)   score += TRUST_WEIGHTS.sources
  return score
}

function trustTier(score) {
  return score >= 80 ? 'gold' : score >= 60 ? 'silver' : score >= 40 ? 'bronze' : 'quarantined'
}

/** Entry-level trust: average pick score + tier, with the weakest pick called out. */
function scoreEntry(recommendations = []) {
  if (!recommendations.length) return { score: 0, tier: 'quarantined', weakest: null }
  const scored = recommendations.map(r => ({ symbol: normalizePick(r).symbol, score: scorePick(r) }))
  const score = Math.round(scored.reduce((s, x) => s + x.score, 0) / scored.length)
  const weakest = scored.reduce((a, b) => (b.score < a.score ? b : a))
  return { score, tier: trustTier(score), weakest }
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
    trust:     scoreEntry(recommendations),
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

// ── Hash chain ────────────────────────────────────────────────────────────────

const GENESIS_HASH = '0'.repeat(64)

// Canonical JSON (sorted keys) so hashing is key-order independent.
function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  return '{' + Object.keys(value).sort().map(k => JSON.stringify(k) + ':' + canonicalJson(value[k])).join(',') + '}'
}

/** Full-length chained hash: entry content (minus chain fields) + prev link. */
function chainHash(prevHash, entry) {
  const { chainHash: _c, prevChainHash: _p, ...content } = entry
  return crypto.createHash('sha256').update(prevHash + '|' + canonicalJson(content)).digest('hex')
}

function readRawEntries(file = JOURNAL_LOG) {
  try {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => {
      try { return JSON.parse(l) } catch { return null }
    }).filter(Boolean)
  } catch { return [] }
}

/**
 * Walk the whole journal and recompute the chain. Entries written before
 * chaining existed ("legacy") anchor the chain at the first chained entry.
 * Returns { valid, entries, chained, legacy, firstBreak }.
 */
function verifyChain(file = JOURNAL_LOG) {
  const entries = readRawEntries(file)
  const legacy = entries.filter(e => !e.chainHash).length
  let expectedPrev = GENESIS_HASH
  let index = 0
  for (const entry of entries) {
    index += 1
    if (!entry.chainHash) continue // legacy, pre-chain entry
    if (entry.prevChainHash !== expectedPrev) {
      return { valid: false, entries: entries.length, chained: entries.length - legacy, legacy,
               firstBreak: { index, id: entry.id, reason: 'prev link mismatch (an earlier chained entry was altered, deleted, or reordered)' } }
    }
    if (chainHash(entry.prevChainHash, entry) !== entry.chainHash) {
      return { valid: false, entries: entries.length, chained: entries.length - legacy, legacy,
               firstBreak: { index, id: entry.id, reason: 'content hash mismatch (this entry was altered after writing)' } }
    }
    expectedPrev = entry.chainHash
  }
  return { valid: true, entries: entries.length, chained: entries.length - legacy, legacy, firstBreak: null }
}

/** Append an entry to the journal (best-effort; never throws to the caller).
 *  Chains it to the last chained entry so history is tamper-evident. */
function appendEntry(entry, file = JOURNAL_LOG) {
  try {
    ensureDir(file)
    const prior = readRawEntries(file)
    const lastChained = [...prior].reverse().find(e => e.chainHash)
    entry.prevChainHash = lastChained ? lastChained.chainHash : GENESIS_HASH
    entry.chainHash = chainHash(entry.prevChainHash, entry)
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
  JOURNAL_LOG, GENESIS_HASH,
  normalizePick, hashEntry, buildEntry, diffEntries,
  appendEntry, readJournal, readJournalWithDiffs,
  scorePick, scoreEntry, trustTier,
  chainHash, canonicalJson, verifyChain,
}
