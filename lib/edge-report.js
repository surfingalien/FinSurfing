'use strict'
/**
 * lib/edge-report.js
 *
 * Edge mining over the AI Brain's resolved-prediction stats.
 *
 * computeStats() (lib/brain-learnings.js) already derives per-segment
 * calibration deterministically — confidence, ensemble agreement, asset
 * type, sector, TA pattern, composite-score band, macro regime, and which
 * model/prompt version produced the pick. This module ranks every
 * one of those segments by edge (segment alpha win rate minus the overall
 * alpha win rate) under a sample-size floor, answering "where is the alpha
 * actually concentrated?" Pure math over stats the engine computed — no LLM,
 * no I/O.
 *
 * Multiple comparisons. Testing ~30 segments and printing the top five
 * guarantees "edges": at n=10 a segment of a 50% system lands at ≥70% about
 * one time in six by chance alone. Each segment is therefore tested against
 * the overall rate (binomial, two-sided), and only those surviving a
 * Benjamini–Hochberg correction across EVERY segment tested are reported as
 * edges or drags. The rest stay in `segments` with `significant: false`, so
 * nothing is hidden — it is just not called an edge.
 *
 * Tests: tests/edge-report.test.js
 */

const { wilson, binomialPValue, benjaminiHochberg } = require('./calibration-stats')

const SCORE_BANDS = { low: 'score <40', mid: 'score 40-69', high: 'score 70-79', elite: 'score ≥80' }
const FDR = 0.10

// [display dimension, computeStats key]
const DIMENSIONS = [
  ['confidence', 'calibration'],
  ['ensemble',   'ensemble'],
  ['asset',      'byAssetType'],
  ['sector',     'bySector'],
  ['pattern',    'byPattern'],
  ['composite',  'byCompositeScore'],
  // Conditions at SCAN time, not outcomes. That distinction is the rule for
  // this list: segmenting returns by something only knowable afterwards (the
  // triple-barrier label, say) is circular — "the picks that hit their target
  // did well" is arithmetic, not an edge. Every key here is a fact the scan
  // already knew when it made the call.
  ['regime',     'byRegime'],
  ['model',      'byModelVersion'],
]

// The overall rate must be measured at the SAME horizon as the segments, or
// every "edge" is partly the gap between a 7d and a 30d rate.
function overallRate(stats) {
  if (stats?.segmentHorizon === 30) return stats?.h30?.alphaWinRate ?? null
  if (stats?.segmentHorizon === 7)  return stats?.h7?.alphaWinRate ?? null
  return stats?.h30?.alphaWinRate ?? stats?.h7?.alphaWinRate ?? null
}

/**
 * @param {object} stats — computeStats() output
 * @param {object} [opts]
 * @param {number} [opts.minN=10] — minimum benchmark-matched picks per segment
 * @returns {{ overall, tested, segments, topEdges, topDrags }}
 *          segments sorted best-edge-first, each with pValue + significant;
 *          topEdges/topDrags contain ONLY segments surviving the correction.
 */
function computeEdgeReport(stats, { minN = 10, fdr = FDR } = {}) {
  const overall = overallRate(stats)
  if (overall == null) return { overall: null, tested: 0, segments: [], topEdges: [], topDrags: [] }

  const segments = []
  for (const [dimension, key] of DIMENSIONS) {
    for (const [name, seg] of Object.entries(stats[key] || {})) {
      // An alpha rate only — the old fallback to the raw win rate compared a
      // different quantity against the overall ALPHA rate.
      const rate = seg?.alphaWinRate
      if (rate == null) continue
      const n = seg.nBench ?? seg.n
      if (!n || n < minN) continue
      const k = seg.alphaWins ?? Math.round(rate * n)
      const ci = wilson(k, n)
      segments.push({
        dimension,
        segment: key === 'byCompositeScore' ? (SCORE_BANDS[name] || name) : name,
        n,
        alphaWinRate: rate,
        lo: ci.lo,
        hi: ci.hi,
        edge: +(rate - overall).toFixed(3),
        pValue: +binomialPValue(k, n, overall).toFixed(4),
      })
    }
  }
  const keep = benjaminiHochberg(segments.map(s => s.pValue), fdr)
  segments.forEach((s, i) => { s.significant = keep[i] })
  segments.sort((a, b) => b.edge - a.edge)

  return {
    overall,
    tested: segments.length,
    segments,
    topEdges: segments.filter(s => s.significant && s.edge > 0).slice(0, 5),
    topDrags: segments.filter(s => s.significant && s.edge < 0).slice(-5).reverse(),
  }
}

/** Compact text block for chat/prompt surfaces; '' when there's nothing to report. */
function edgeBlock(report, { minN = 10 } = {}) {
  if (!report || report.overall == null || !report.segments.length) return ''
  const pc  = v => `${Math.round(v * 100)}%`
  const fmt = s => `${s.dimension}=${s.segment} ${pc(s.alphaWinRate)} [${pc(s.lo)}–${pc(s.hi)}] (${s.edge > 0 ? '+' : ''}${Math.round(s.edge * 100)}pt, n=${s.n})`
  if (!report.topEdges.length && !report.topDrags.length) {
    return `NO MEASURED EDGE: none of ${report.tested} segments (n≥${minN}) differs from the overall ${pc(report.overall)} alpha win rate beyond chance (FDR ${Math.round(FDR * 100)}%). Treat segment differences as noise; do not tilt toward any of them.`
  }
  const lines = [`MEASURED EDGE vs overall ${pc(report.overall)} alpha win rate — segments that differ beyond chance (${report.tested} tested, n≥${minN}, FDR ${Math.round(FDR * 100)}%; 95% intervals in brackets):`]
  if (report.topEdges.length) lines.push('Strongest: ' + report.topEdges.map(fmt).join(' | '))
  if (report.topDrags.length) lines.push('Weakest: ' + report.topDrags.map(fmt).join(' | '))
  return lines.join('\n')
}

module.exports = { computeEdgeReport, edgeBlock, overallRate }
