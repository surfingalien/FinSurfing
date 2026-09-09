'use strict'
/**
 * lib/entity-graph.js — persistence and change detection for exposure edges.
 *
 * A map of who supplies whom is mildly interesting as a snapshot. What it is
 * actually worth is the DIFF between snapshots, because the transitions carry
 * information the levels do not:
 *
 *   added      a company newly names the anchor in its filing — a contract win
 *              that has been disclosed but not yet shown up in revenue
 *   dropped    the anchor is no longer named in the latest filing. This is the
 *              one worth waking up for. A supplier quietly removing a customer
 *              from its concentration disclosure is telling you the
 *              relationship ended, typically a quarter or more before the
 *              revenue line does.
 *   materialityUp/Down
 *              the disclosed revenue percentage moved — the same relationship
 *              getting materially bigger or smaller
 *
 * Deliberately the same shape as lib/signal-flips.js: pure diff over two plain
 * snapshots, with I/O kept separate and best-effort so a disk failure can never
 * take down the route that produced the data.
 *
 * Storage: data/entity-graph.jsonl, one JSON edge per line, latest snapshot per
 * (anchor, symbol, relation) wins on read. Append-only so history survives.
 *
 * Tests: tests/entity-graph.test.js
 */

const fs   = require('fs')
const path = require('path')

const DATA_DIR   = path.join(__dirname, '../data')
const GRAPH_FILE = path.join(DATA_DIR, 'entity-graph.jsonl')

/** Materiality moves smaller than this are disclosure noise, not signal. */
const MATERIALITY_EPSILON = 1.0

const edgeKey = e => `${String(e.anchor).toUpperCase()}::${String(e.symbol).toUpperCase()}::${e.relation}`

// ── Pure diff ────────────────────────────────────────────────────────────────

/**
 * Compare two edge lists for one anchor. Pure.
 *
 * `prev` and `curr` are arrays of edges as produced by exposure-map.buildEdges.
 * Returns changes only — an unchanged relationship produces no row, so an empty
 * result genuinely means "nothing moved" rather than "nothing ran".
 */
function diffEdges(prev = [], curr = []) {
  const prevMap = new Map((prev || []).map(e => [edgeKey(e), e]))
  const currMap = new Map((curr || []).map(e => [edgeKey(e), e]))

  const added = [], dropped = [], materialityMoved = []

  for (const [k, e] of currMap.entries()) {
    const before = prevMap.get(k)
    if (!before) {
      added.push({ type: 'added', symbol: e.symbol, anchor: e.anchor, relation: e.relation, score: e.score,
                   materialityPct: e.materialityPct ?? null, evidence: e.evidence })
      continue
    }
    const a = before.materialityPct, b = e.materialityPct
    if (a != null && b != null && Math.abs(b - a) >= MATERIALITY_EPSILON) {
      materialityMoved.push({
        type: b > a ? 'materiality_up' : 'materiality_down',
        symbol: e.symbol, anchor: e.anchor, relation: e.relation,
        from: a, to: b, deltaPct: +(b - a).toFixed(1), evidence: e.evidence,
      })
    }
  }

  for (const [k, e] of prevMap.entries()) {
    if (currMap.has(k)) continue
    dropped.push({
      type: 'dropped', symbol: e.symbol, anchor: e.anchor, relation: e.relation,
      lastScore: e.score, lastMaterialityPct: e.materialityPct ?? null,
      lastSeenEvidence: e.evidence,
    })
  }

  return { added, dropped, materialityMoved, changed: added.length + dropped.length + materialityMoved.length }
}

/**
 * One-line-per-change summary for alerts and prompt injection.
 * '' when nothing moved, so a caller never announces a non-event.
 */
function diffBlock(anchor, diff) {
  if (!diff || !diff.changed) return ''
  const lines = []
  for (const d of diff.dropped) {
    lines.push(`  ⚠ ${d.symbol} NO LONGER names ${anchor} (was ${d.relation}${d.lastMaterialityPct != null ? `, ${d.lastMaterialityPct}% of revenue` : ''})`)
  }
  for (const d of diff.added) {
    lines.push(`  + ${d.symbol} newly discloses ${anchor} as ${d.relation}${d.materialityPct != null ? ` (${d.materialityPct}% of revenue)` : ''}`)
  }
  for (const d of diff.materialityMoved) {
    lines.push(`  ${d.deltaPct > 0 ? '↑' : '↓'} ${d.symbol} ${anchor} exposure ${d.from}% → ${d.to}%`)
  }
  return `EXPOSURE CHANGES vs last run for ${anchor}:\n${lines.join('\n')}`
}

// ── I/O (best-effort; never throws to the caller) ────────────────────────────

function readAll(file = GRAPH_FILE) {
  try {
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8')
      .split('\n').filter(Boolean)
      .map(l => { try { return JSON.parse(l) } catch { return null } })
      .filter(Boolean)
  } catch { return [] }
}

/** Latest snapshot per edge key, optionally narrowed to one anchor. */
function latestEdges(anchor = null, file = GRAPH_FILE) {
  const want = anchor ? String(anchor).toUpperCase() : null
  const byKey = new Map()
  for (const e of readAll(file)) {
    if (want && String(e.anchor).toUpperCase() !== want) continue
    byKey.set(edgeKey(e), e)   // later lines win
  }
  return [...byKey.values()].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
}

/** Append a full snapshot for one anchor. Returns the count written. */
function writeSnapshot(anchor, edges, { at = new Date().toISOString(), file = GRAPH_FILE } = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    const stamped = (edges || []).map(e => ({ ...e, anchor: String(anchor).toUpperCase(), snapshotAt: at }))
    if (!stamped.length) return 0
    fs.appendFileSync(file, stamped.map(e => JSON.stringify(e)).join('\n') + '\n')
    return stamped.length
  } catch (err) {
    console.warn('[entity-graph] writeSnapshot failed:', err.message)
    return 0
  }
}

/** Anchors currently tracked, with edge counts and when each was last refreshed. */
function trackedAnchors(file = GRAPH_FILE) {
  const byAnchor = new Map()
  for (const e of readAll(file)) {
    const a = String(e.anchor || '').toUpperCase()
    if (!a) continue
    const cur = byAnchor.get(a) || { anchor: a, edges: 0, lastRun: null }
    cur.edges++
    if (!cur.lastRun || (e.snapshotAt && e.snapshotAt > cur.lastRun)) cur.lastRun = e.snapshotAt || cur.lastRun
    byAnchor.set(a, cur)
  }
  return [...byAnchor.values()].sort((a, b) => String(b.lastRun).localeCompare(String(a.lastRun)))
}

module.exports = {
  GRAPH_FILE, MATERIALITY_EPSILON,
  edgeKey, diffEdges, diffBlock,
  readAll, latestEdges, writeSnapshot, trackedAnchors,
}
