'use strict'

/**
 * lib/learning-health.js — do the Brain's learnings hold up against outcomes?
 *
 * The nightly meta-analysis has a model READ the computed stats and write
 * "learnings" — yes/no flags ("volume confirmation is predictive") and free-
 * text findings — which are then injected into every scan. Nothing checked
 * them. A flag could say YES on a raw 52%-vs-48% split of twenty picks, or
 * contradict the very stats it was handed, and still steer every pick.
 *
 * Three checks, all deterministic (the model proposes, code judges):
 *
 *   1. auditFlags     each flag maps to a comparison computeStats already makes
 *                     (FLAG_TESTS). A two-proportion test on the alpha win
 *                     rates decides: a YES needs a clear effect in its stated
 *                     direction; a NO is contradicted by a clear effect. Below
 *                     MIN_SEGMENT_N on either side it is "insufficient" — a
 *                     claim about something never measured is dropped, not
 *                     kept as a default.
 *   2. auditLearnings each free-text learning must cite the stats it rests on
 *                     as a trailing `[path, path]`; the paths must resolve to
 *                     segments with enough picks, and any figure it states must
 *                     occur in them (claim-support.verifyCitation). Uncited or
 *                     fabricated → dropped.
 *   3. judgeEffect    picks made WITH learnings injected vs WITHOUT
 *                     (stats.byLearnings, from the `learningsVersion` stamped on
 *                     each prediction). When the learnings measurably HURT,
 *                     brain-learnings withholds them from the prompt — which
 *                     also makes the next picks the comparison's "without"
 *                     cohort, so the decision keeps being re-tested.
 *
 * Caveat stated wherever (3) is shown: the "without" cohort is mostly the
 * system's early weeks, so the comparison is confounded by time and regime.
 * Alpha vs a benchmark removes the market's direction, not every difference.
 *
 * Pure. Tests: tests/learning-health.test.js
 */

const { normCdf } = require('./calibration-stats')
const { verifyCitation } = require('./claim-support')

const MIN_SEGMENT_N = 10
const ALPHA = 0.05

/** Alpha-win counts of a stats segment (or a pool of them); wins/n when no benchmark. */
function counts(...segs) {
  const s = segs.filter(Boolean)
  if (!s.length) return null
  const useBench = s.every(x => x.nBench > 0)
  const k = s.reduce((a, x) => a + ((useBench ? x.alphaWins : x.wins) || 0), 0)
  const n = s.reduce((a, x) => a + ((useBench ? x.nBench : x.n) || 0), 0)
  return n > 0 ? { k, n } : null
}

/**
 * Two-proportion z-test, A vs B. `decided` only when both sides have
 * MIN_SEGMENT_N and the two-sided p < ALPHA.
 */
function compare(a, b, { minN = MIN_SEGMENT_N } = {}) {
  if (!a || !b) return { status: 'insufficient', reason: 'one side was never measured' }
  if (a.n < minN || b.n < minN) return { status: 'insufficient', reason: `n=${a.n} vs n=${b.n}; each side needs ${minN}`, a, b }
  const pa = a.k / a.n, pb = b.k / b.n
  const pool = (a.k + b.k) / (a.n + b.n)
  const se = Math.sqrt(pool * (1 - pool) * (1 / a.n + 1 / b.n))
  const z = se > 0 ? (pa - pb) / se : 0
  const p = 2 * (1 - normCdf(Math.abs(z)))
  const decided = p < ALPHA
  return {
    status:    decided ? (pa > pb ? 'higher' : 'lower') : 'no-difference',
    diff:      +(pa - pb).toFixed(3),
    p:         +p.toFixed(4),
    a, b,
  }
}

// Each flag the meta-analysis writes, as the comparison that would establish it.
// `expect` is the direction a TRUE flag claims for side A relative to side B.
const FLAG_TESTS = {
  conflictSignalUseful:         { expect: 'lower',  a: s => counts(s.conflictImpact?.conflict),            b: s => counts(s.conflictImpact?.noConflict),                                     what: 'picks with agent conflict vs without' },
  volumeConfirmationPredictive: { expect: 'higher', a: s => counts(s.byVolumeSignal?.Confirming),          b: s => counts(s.byVolumeSignal?.Weak, s.byVolumeSignal?.Diverging),               what: 'Confirming volume vs Weak/Diverging' },
  earningsWindowRisky:          { expect: 'lower',  a: s => counts(s.earningsWindowImpact?.imminent, s.earningsWindowImpact?.upcoming), b: s => counts(s.earningsWindowImpact?.distant), what: 'earnings ≤21d vs later' },
  optionsBullishPredictive:     { expect: 'higher', a: s => counts(s.optionsFlowImpact?.bullish),          b: s => counts(s.optionsFlowImpact?.neutral, s.optionsFlowImpact?.bearish),        what: 'P/C<0.70 vs P/C≥0.70' },
  confidenceCalibrated:         { expect: 'higher', a: s => counts(s.calibration?.High),                   b: s => counts(s.calibration?.Low),                                               what: 'High vs Low stated confidence' },
}

/**
 * @returns {{[flag]: {claim, verdict, keep, reason, test}}}
 *   verdict: supported | consistent | contradicted | unsupported | insufficient
 */
function auditFlags(learnings, stats) {
  const out = {}
  for (const [flag, t] of Object.entries(FLAG_TESTS)) {
    const claim = learnings?.[flag]
    if (claim !== true && claim !== false) continue
    const test = compare(t.a(stats || {}), t.b(stats || {}))
    let verdict
    if (test.status === 'insufficient') verdict = 'insufficient'
    else if (test.status === 'no-difference') verdict = claim ? 'unsupported' : 'consistent'
    else if (test.status === t.expect) verdict = claim ? 'supported' : 'contradicted'
    else verdict = 'contradicted'
    const keep = verdict === 'supported' || verdict === 'consistent'
    const reason = test.status === 'insufficient'
      ? `${t.what}: ${test.reason}`
      : `${t.what}: ${(test.diff * 100).toFixed(1)} pts, p=${test.p}`
    out[flag] = { claim, verdict, keep, reason, test: { status: test.status, diff: test.diff ?? null, p: test.p ?? null } }
  }
  return out
}

/** Resolve a dotted stats path, e.g. "byVolumeSignal.Confirming". */
function resolvePath(stats, p) {
  return String(p).trim().replace(/^stats\./, '').split('.').filter(Boolean)
    .reduce((node, k) => (node != null && typeof node === 'object' ? node[k] : undefined), stats)
}

// Rates are stored as fractions; the model writes percentages. Render both so
// "62%" is checked against 0.62 honestly rather than failing on format.
function renderEvidence(node, prefix = '') {
  if (node == null) return ''
  if (typeof node !== 'object') {
    if (typeof node === 'number' && node > 0 && node <= 1 && /rate|lo$|hi$|first|neither/i.test(prefix)) {
      return `${prefix} ${node} ${(node * 100).toFixed(0)}% ${(node * 100).toFixed(1)}%`
    }
    return `${prefix} ${node}`
  }
  return Object.entries(node).map(([k, v]) => renderEvidence(v, k)).join(' ; ')
}

const CITE_RE = /\[([^\]]+)\]\s*$/

/**
 * @returns {{kept: string[], rejected: Array<{text, reason}>}}
 */
function auditLearnings(keyLearnings, stats, { minN = MIN_SEGMENT_N } = {}) {
  const kept = [], rejected = []
  for (const raw of keyLearnings || []) {
    const text = String(raw || '').trim()
    if (!text) continue
    const m = text.match(CITE_RE)
    if (!m) { rejected.push({ text, reason: 'cites no statistic' }); continue }
    const paths = m[1].split(',').map(s => s.trim()).filter(Boolean)
    const nodes = paths.map(p => ({ p, node: resolvePath(stats, p) }))
    const missing = nodes.filter(x => x.node == null || typeof x.node !== 'object')
    if (missing.length) { rejected.push({ text, reason: `cites ${missing.map(x => x.p).join(', ')}, which is not in the stats` }); continue }
    const thin = nodes.filter(x => Number.isFinite(x.node.n) && x.node.n < minN)
    if (thin.length) { rejected.push({ text, reason: `rests on ${thin.map(x => `${x.p} (n=${x.node.n})`).join(', ')} — fewer than ${minN} picks` }); continue }
    const body = text.replace(CITE_RE, '').trim()
    const check = verifyCitation(body, nodes.map(x => renderEvidence(x.node, x.p)).join(' ; '))
    if (check.verdict === 'fabricated-number') { rejected.push({ text, reason: check.reason }); continue }
    kept.push(text)
  }
  return { kept, rejected }
}

/**
 * Picks made with learnings injected vs without. `stats.byLearnings` = { on, off }.
 * verdict: helping | hurting | no-difference | insufficient
 */
function judgeEffect(stats) {
  const on = stats?.byLearnings?.on, off = stats?.byLearnings?.off
  const test = compare(counts(on), counts(off))
  const verdict = test.status === 'higher' ? 'helping'
    : test.status === 'lower' ? 'hurting'
    : test.status === 'no-difference' ? 'no-difference'
    : 'insufficient'
  return {
    verdict,
    on:  on  ? { n: on.nBench || on.n,  rate: on.alphaWinRate ?? on.winRate,  lo: on.alphaWinRateLo ?? on.winRateLo,  hi: on.alphaWinRateHi ?? on.winRateHi }  : null,
    off: off ? { n: off.nBench || off.n, rate: off.alphaWinRate ?? off.winRate, lo: off.alphaWinRateLo ?? off.winRateLo, hi: off.alphaWinRateHi ?? off.winRateHi } : null,
    diff: test.diff ?? null,
    p:    test.p ?? null,
    reason: test.status === 'insufficient' ? test.reason : null,
    caveat: 'the without-learnings picks are mostly from the system\'s early weeks, so time and market regime differ between the two groups; alpha vs a benchmark removes the market\'s direction, not every difference',
  }
}

/** Everything the status surfaces need, from the stored learnings document. */
function learningHealth(learnings) {
  if (!learnings) return { available: false, reason: 'no learnings written yet' }
  const stats = learnings.stats || {}
  const flags = auditFlags(learnings, stats)
  const { kept, rejected } = auditLearnings(learnings.keyLearnings, stats)
  const effect = judgeEffect(stats)
  return {
    available: true,
    updatedAt: learnings.updatedAt || null,
    flags,
    learnings: { kept: kept.length, rejected },
    effect,
    withheld: effect.verdict === 'hurting',
  }
}

module.exports = {
  compare, counts, auditFlags, auditLearnings, judgeEffect, learningHealth,
  resolvePath, FLAG_TESTS, MIN_SEGMENT_N,
}
