'use strict'
/**
 * lib/scan-diff.js — what changed between two AI Brain scans of the same list.
 *
 * Pure. No model is called: this only compares two stored scan results.
 *
 * A discovery scan builds a NEW list each time and deliberately sends the
 * previous scan's names to the back (lib/scan-universe.js), so "this name is
 * gone" usually means "it was not looked at", not "the model changed its
 * mind". Every difference is therefore labelled by what the scans can
 * actually support:
 *
 *   changed   — picked in both scans, and the verdict moved (signal-flips'
 *               camps: a buy that became Avoid is `high`)
 *   rescored  — picked in both, same verdict, composite score moved by at
 *               least SCORE_MOVE points (a fixed display threshold, not tuned)
 *   added     — picked now, not before; `seenBefore` says whether the previous
 *               scan had analysed it and left it out
 *   dropped   — picked before, not now, with the reason:
 *                 'not-picked'  it was analysed again and left out (a view)
 *                 'unpriced'    it could not be priced, so it was not analysed
 *                 'not-in-list' the list rotated and it was not looked at
 *
 * Two scans are comparable only when they asked the same question: the same
 * scan mode (or the same explicit symbol list) and the same horizon.
 *
 * Tests: tests/scan-diff.test.js
 */

const { camp } = require('./signal-flips')

const SCORE_MOVE = 10

const up = s => String(s || '').toUpperCase()
const num = v => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null)

/** The question a scan asked — two scans with the same key can be compared. */
function scanKey(params = {}, result = {}) {
  const horizon = params.horizon || result.horizon || ''
  const symbols = Array.isArray(params.symbols) && params.symbols.length
    ? [...new Set(params.symbols.map(up))].sort().join(',')
    : null
  const mode = symbols ? `symbols:${symbols}` : `mode:${params.scanMode || result.scanMode || 'broad'}`
  return `${mode}|${horizon}`
}

function pickOf(s) {
  return {
    symbol: up(s.symbol),
    verdict: s.agentVerdict || null,
    score: num(s.compositeScore),
    actionable: s.actionable !== false,
  }
}

function picksOf(result) {
  const out = new Map()
  for (const s of result?.rankedStocks || []) {
    const p = pickOf(s)
    if (p.symbol && !out.has(p.symbol)) out.set(p.symbol, p)
  }
  return out
}

const setOf = list => new Set((list || []).map(up))

/**
 * @param {object} prev  an earlier scan result (routes/ai-brain.js response)
 * @param {object} curr  the later one
 */
function diffScans(prev, curr) {
  const a = picksOf(prev), b = picksOf(curr)
  const prevAnalysed = setOf(prev?.universeAnalyzed)
  const currAnalysed = setOf(curr?.universeAnalyzed)
  const currUnpriced = setOf(curr?.unpricedSymbols)

  const changed = [], rescored = [], added = [], dropped = []
  let unchanged = 0

  for (const [symbol, now] of b) {
    const was = a.get(symbol)
    if (!was) {
      added.push({ symbol, verdict: now.verdict, score: now.score, actionable: now.actionable, seenBefore: prevAnalysed.has(symbol) })
      continue
    }
    const from = camp(was.verdict), to = camp(now.verdict)
    const scoreMove = was.score != null && now.score != null ? now.score - was.score : null
    if (up(was.verdict) !== up(now.verdict) && from && to) {
      changed.push({
        symbol, from: was.verdict, to: now.verdict, scoreFrom: was.score, scoreTo: now.score,
        severity: (from === 'bullish' && to === 'bearish') || (from === 'bearish' && to === 'bullish') ? 'high' : 'normal',
      })
    } else if (scoreMove != null && Math.abs(scoreMove) >= SCORE_MOVE) {
      rescored.push({ symbol, verdict: now.verdict, scoreFrom: was.score, scoreTo: now.score, move: scoreMove })
    } else unchanged += 1
  }

  for (const [symbol, was] of a) {
    if (b.has(symbol)) continue
    const reason = currAnalysed.has(symbol) ? 'not-picked' : currUnpriced.has(symbol) ? 'unpriced' : 'not-in-list'
    dropped.push({ symbol, verdict: was.verdict, score: was.score, actionable: was.actionable, reason })
  }

  changed.sort((x, y) => (x.severity === y.severity ? x.symbol.localeCompare(y.symbol) : x.severity === 'high' ? -1 : 1))
  rescored.sort((x, y) => Math.abs(y.move) - Math.abs(x.move))
  added.sort((x, y) => (y.score ?? -1) - (x.score ?? -1))
  const order = { 'not-picked': 0, unpriced: 1, 'not-in-list': 2 }
  dropped.sort((x, y) => order[x.reason] - order[y.reason] || x.symbol.localeCompare(y.symbol))

  return {
    prevAt: prev?.processedAt ?? null,
    currAt: curr?.processedAt ?? null,
    changed, rescored, added, dropped, unchanged,
    scoreMove: SCORE_MOVE,
    // The scans' own words for the market, only when they differ.
    regime: prev?.marketRegime && curr?.marketRegime && prev.marketRegime !== curr.marketRegime
      ? { from: prev.marketRegime, to: curr.marketRegime } : null,
    nothingChanged: !changed.length && !rescored.length && !added.length && !dropped.length,
  }
}

/**
 * From a user's completed scan jobs (newest first, each `{params, result}`),
 * find the one shown (`at` = its result.processedAt, default the newest) and
 * the newest earlier scan that asked the same question.
 */
function findComparable(jobs = [], at = null) {
  const done = jobs.filter(j => j && j.status === 'done' && j.result && !j.result.error)
  const i = at ? done.findIndex(j => j.result.processedAt === at) : 0
  if (i < 0 || !done[i]) return { current: null, previous: null }
  const current = done[i]
  const key = scanKey(current.params, current.result)
  const previous = done.slice(i + 1).find(j => scanKey(j.params, j.result) === key) || null
  return { current, previous, key }
}

module.exports = { SCORE_MOVE, scanKey, diffScans, findComparable }
