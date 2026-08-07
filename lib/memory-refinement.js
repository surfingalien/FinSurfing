'use strict'
/**
 * lib/memory-refinement.js — reviewable, reversible refinement log for the AI
 * Brain's memory.
 *
 * The Brain's memory changes two ways: the nightly meta-analysis rewrites
 * brain-learnings.json wholesale, and a human edits the overrides layer
 * (pin / suppress / directive note). Both were destructive — latest write
 * wins, no history, no undo. A bad nightly regeneration or a mistaken
 * suppression was unrecoverable, and there was no way to ask "why does the
 * Brain believe this, and when did it start?".
 *
 * This adapts Prime Intellect's Continual Harness model (prime-agent's
 * `/refine`): memory advances through SMALL, EVIDENCE-BACKED, REVIEWABLE
 * updates rather than opaque rewrites, and every update is recorded with a
 * snapshot so it can be rolled back.
 *
 * Each refinement entry records:
 *   actor     — 'ai' (nightly meta-analysis) or 'human' (operator edit)
 *   kind      — 'learnings' or 'overrides'
 *   evidence  — WHY this update happened (resolved-prediction count, win
 *               rates, or the operator's stated reason). Refinements without
 *               evidence are still allowed but are marked unevidenced.
 *   diff      — what actually changed, field by field
 *   snapshot  — the FULL prior state, so revert is exact rather than inferred
 *
 * Append-only JSONL, hash-chained with the same canonical-json used by
 * rec-journal, so the history is tamper-evident too: editing or deleting a
 * past refinement breaks verification.
 *
 * Pure helpers (diffing/summarising) are separated from file I/O and take an
 * injectable path, so they're testable without touching the real data dir.
 */

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')
const { canonicalJson } = require('./canonical-json')

const DATA_DIR        = path.join(__dirname, '../data')
const REFINEMENT_LOG  = path.join(DATA_DIR, 'brain-refinements.jsonl')
const GENESIS_HASH    = '0'.repeat(64)

// Keep the log bounded: snapshots make entries fat, and the useful window for
// "why did the Brain change its mind" is recent history, not all time.
const MAX_ENTRIES = 200

// ── Pure: diffing ─────────────────────────────────────────────────────────────

const norm = s => String(s == null ? '' : s).trim().toLowerCase()

/** Set difference for the string-list override fields. */
function diffList(before = [], after = []) {
  const b = new Set((before || []).map(norm))
  const a = new Set((after || []).map(norm))
  return {
    added:   (after || []).filter(x => !b.has(norm(x))),
    removed: (before || []).filter(x => !a.has(norm(x))),
  }
}

/**
 * Diff two overrides states → { pinned:{added,removed}, suppressed:{...},
 * note:{from,to} } with unchanged fields omitted. Empty object = no-op edit.
 */
function diffOverrides(before = {}, after = {}) {
  const out = {}
  const pinned = diffList(before.pinned, after.pinned)
  if (pinned.added.length || pinned.removed.length) out.pinned = pinned
  const suppressed = diffList(before.suppressed, after.suppressed)
  if (suppressed.added.length || suppressed.removed.length) out.suppressed = suppressed
  if ((before.note || '') !== (after.note || '')) {
    out.note = { from: before.note || '', to: after.note || '' }
  }
  return out
}

/**
 * Diff two learnings documents. Only the fields that steer the next scan are
 * compared — the full stats blob changes every night and would drown the diff.
 */
const LEARNING_SCALARS = [
  'promptInjection', 'bestCompositeThreshold', 'conflictSignalUseful',
  'confidenceCalibrated', 'volumeConfirmationPredictive',
  'earningsWindowRisky', 'optionsBullishPredictive',
]

function diffLearnings(before = {}, after = {}) {
  const out = {}
  const keys = diffList(before.keyLearnings, after.keyLearnings)
  if (keys.added.length || keys.removed.length) out.keyLearnings = keys
  for (const f of LEARNING_SCALARS) {
    const b = before[f] ?? null
    const a = after[f] ?? null
    if (b !== a) (out.fields ||= {})[f] = { from: b, to: a }
  }
  return out
}

/** True when a diff object contains no actual change. */
function isEmptyDiff(diff) {
  return !diff || Object.keys(diff).length === 0
}

/** One-line human summary of a diff, for list views and the Telegram bot. */
function summarizeDiff(kind, diff) {
  if (isEmptyDiff(diff)) return 'no change'
  const parts = []
  const push = (label, d) => {
    if (!d) return
    if (d.added?.length)   parts.push(`+${d.added.length} ${label}`)
    if (d.removed?.length) parts.push(`-${d.removed.length} ${label}`)
  }
  push('pinned', diff.pinned)
  push('suppressed', diff.suppressed)
  push('learnings', diff.keyLearnings)
  if (diff.note) parts.push(diff.note.to ? 'directive set' : 'directive cleared')
  if (diff.fields) parts.push(`${Object.keys(diff.fields).length} field(s) changed`)
  return parts.join(', ') || 'no change'
}

// ── Hash chain ────────────────────────────────────────────────────────────────

function chainHash(prevHash, entry) {
  const { chainHash: _c, prevChainHash: _p, ...content } = entry
  return crypto.createHash('sha256').update(prevHash + '|' + canonicalJson(content)).digest('hex')
}

// ── File I/O ──────────────────────────────────────────────────────────────────

function ensureDir(file) {
  const dir = path.dirname(file)
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
}

function readRefinements({ limit = 50, file = REFINEMENT_LOG } = {}) {
  const all = readAll(file)
  return all.slice(-limit).reverse() // newest first
}

function readAll(file = REFINEMENT_LOG) {
  try {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

/**
 * Record one refinement. Returns the entry, or null when the update changed
 * nothing (a no-op edit shouldn't pollute the history).
 *
 * @param {'ai'|'human'} actor
 * @param {'learnings'|'overrides'} kind
 * @param {object} before  full prior state (stored as the revert snapshot)
 * @param {object} after   full new state
 * @param {object|string} evidence  why this happened
 */
function recordRefinement({ actor, kind, before = {}, after = {}, evidence = null, file = REFINEMENT_LOG }) {
  const diff = kind === 'overrides' ? diffOverrides(before, after) : diffLearnings(before, after)
  if (isEmptyDiff(diff)) return null

  const prior = readAll(file)
  const prev = prior.length ? prior[prior.length - 1] : null
  const entry = {
    seq:       prior.length ? prior[prior.length - 1].seq + 1 : 1,
    at:        new Date().toISOString(),
    actor:     actor === 'ai' ? 'ai' : 'human',
    kind:      kind === 'learnings' ? 'learnings' : 'overrides',
    evidence:  evidence == null ? null : (typeof evidence === 'string' ? { reason: evidence } : evidence),
    evidenced: evidence != null,
    diff,
    summary:   summarizeDiff(kind, diff),
    // Full prior state — revert restores this verbatim rather than trying to
    // invert a diff (inversion is lossy once several edits stack up).
    snapshot:  before,
  }
  entry.prevChainHash = prev ? prev.chainHash : GENESIS_HASH
  entry.chainHash = chainHash(entry.prevChainHash, entry)

  try {
    ensureDir(file)
    fs.appendFileSync(file, JSON.stringify(entry) + '\n')
    trim(file)
  } catch (e) {
    console.warn('[memory-refinement] append failed:', e.message)
    return null
  }
  return entry
}

// Drop the oldest entries past MAX_ENTRIES. The chain stays verifiable from
// the first RETAINED entry (verifyChain anchors on it), the same way
// rec-journal tolerates pre-chain legacy rows.
function trim(file = REFINEMENT_LOG) {
  const all = readAll(file)
  if (all.length <= MAX_ENTRIES) return
  const kept = all.slice(-MAX_ENTRIES)
  fs.writeFileSync(file, kept.map(e => JSON.stringify(e)).join('\n') + '\n')
}

/**
 * Recompute the chain over retained entries. Anchors on the first retained
 * entry's own prevChainHash so trimming doesn't read as tampering.
 */
function verifyChain(file = REFINEMENT_LOG) {
  const entries = readAll(file)
  if (!entries.length) return { valid: true, entries: 0, firstBreak: null }
  let expectedPrev = entries[0].prevChainHash
  for (const e of entries) {
    if (e.prevChainHash !== expectedPrev) {
      return { valid: false, entries: entries.length,
               firstBreak: { seq: e.seq, reason: 'prev link mismatch (an earlier refinement was altered, deleted, or reordered)' } }
    }
    if (chainHash(e.prevChainHash, e) !== e.chainHash) {
      return { valid: false, entries: entries.length,
               firstBreak: { seq: e.seq, reason: 'content hash mismatch (this refinement was altered after writing)' } }
    }
    expectedPrev = e.chainHash
  }
  return { valid: true, entries: entries.length, firstBreak: null }
}

/** Look up the snapshot to restore for a given refinement seq. */
function snapshotFor(seq, file = REFINEMENT_LOG) {
  const entry = readAll(file).find(e => e.seq === Number(seq))
  if (!entry) return null
  return { kind: entry.kind, snapshot: entry.snapshot, entry }
}

module.exports = {
  REFINEMENT_LOG, GENESIS_HASH, MAX_ENTRIES,
  // pure
  diffList, diffOverrides, diffLearnings, isEmptyDiff, summarizeDiff, chainHash,
  // io
  recordRefinement, readRefinements, readAll, verifyChain, snapshotFor,
}
