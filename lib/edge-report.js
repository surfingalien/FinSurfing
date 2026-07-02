'use strict'
/**
 * lib/edge-report.js
 *
 * Edge mining over the AI Brain's resolved-prediction stats.
 *
 * computeStats() (lib/brain-learnings.js) already derives per-segment
 * calibration deterministically — confidence, ensemble agreement, asset
 * type, sector, TA pattern, composite-score band. This module ranks every
 * one of those segments by measured edge (segment alpha win rate minus the
 * overall alpha win rate) under a sample-size floor, answering "where is
 * the alpha actually concentrated?" in a single sorted list. Pure math over
 * stats the engine computed — no LLM, no I/O.
 *
 * Tests: tests/edge-report.test.js
 */

const SCORE_BANDS = { low: 'score <40', mid: 'score 40-69', high: 'score 70-79', elite: 'score ≥80' }

// [display dimension, computeStats key]
const DIMENSIONS = [
  ['confidence', 'calibration'],
  ['ensemble',   'ensemble'],
  ['asset',      'byAssetType'],
  ['sector',     'bySector'],
  ['pattern',    'byPattern'],
  ['composite',  'byCompositeScore'],
]

/**
 * @param {object} stats — computeStats() output
 * @param {object} [opts]
 * @param {number} [opts.minN=10] — minimum resolved picks for a segment to count
 * @returns {{ overall: number|null, segments: Array, topEdges: Array, topDrags: Array }}
 *          segments sorted best-edge-first; topDrags most-negative-first.
 */
function computeEdgeReport(stats, { minN = 10 } = {}) {
  const overall = stats?.h30?.alphaWinRate ?? stats?.h7?.alphaWinRate ?? null
  if (overall == null) return { overall: null, segments: [], topEdges: [], topDrags: [] }

  const segments = []
  for (const [dimension, key] of DIMENSIONS) {
    for (const [name, seg] of Object.entries(stats[key] || {})) {
      const rate = seg?.alphaWinRate ?? seg?.winRate ?? null
      if (rate == null || !seg.n || seg.n < minN) continue
      segments.push({
        dimension,
        segment: key === 'byCompositeScore' ? (SCORE_BANDS[name] || name) : name,
        n: seg.n,
        alphaWinRate: rate,
        edge: +(rate - overall).toFixed(3),
      })
    }
  }
  segments.sort((a, b) => b.edge - a.edge)

  return {
    overall,
    segments,
    topEdges: segments.filter(s => s.edge > 0).slice(0, 5),
    topDrags: segments.filter(s => s.edge < 0).slice(-5).reverse(),
  }
}

/** Compact text block for chat/prompt surfaces; '' when there's nothing to report. */
function edgeBlock(report, { minN = 10 } = {}) {
  if (!report || report.overall == null || !report.segments.length) return ''
  const pc  = v => `${Math.round(v * 100)}%`
  const fmt = s => `${s.dimension}=${s.segment} ${pc(s.alphaWinRate)} (${s.edge > 0 ? '+' : ''}${Math.round(s.edge * 100)}pt, n=${s.n})`
  const lines = [`MEASURED EDGE vs overall ${pc(report.overall)} alpha win rate (segments with n≥${minN}):`]
  if (report.topEdges.length) lines.push('Strongest: ' + report.topEdges.map(fmt).join(' | '))
  if (report.topDrags.length) lines.push('Weakest: ' + report.topDrags.map(fmt).join(' | '))
  return lines.join('\n')
}

module.exports = { computeEdgeReport, edgeBlock }
