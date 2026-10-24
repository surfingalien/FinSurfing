'use strict'

/**
 * lib/leaderboard.js — every decider on the record in one ranked table.
 *
 * The Track record already shows personas, research methods, surfaces, models
 * and the random baseline in separate places. Live agent benchmarks
 * (live-trade-bench, DeepFund, Alpha Arena) put them on one leaderboard; the
 * trap is ranking by the raw rate, where a 4-for-5 streak beats 60-for-100.
 * Rows are ranked by the LOWER end of the 95% Wilson interval — what the
 * record can vouch for — and each says whether its interval sits above, below
 * or across the overall rate. Pure. Tests: tests/leaderboard.test.js
 */

const { wilson } = require('./calibration-stats')

const GROUPS = [
  ['bySurface', 'AI surface'],
  ['byPersona', 'Investor persona'],
  ['byMethod', 'Research method'],
  ['byModel', 'Model'],
  ['byPriceRegime', 'Price regime at decision'],
]

/**
 * @param {object} decisions  learning-store calibration report
 * @param {object} [vsRandom] shadow-baseline comparison
 * @returns {{ overall, metric, rows }}
 */
function buildLeaderboard(decisions, vsRandom = null) {
  const overallC = decisions?.overall
  const useAlpha = overallC?.alphaWinRate != null
  const overall = useAlpha ? overallC?.alphaWinRate : overallC?.winRate ?? null
  const rows = []
  for (const [key, group] of GROUPS) {
    for (const [name, c] of Object.entries(decisions?.[key] || {})) {
      if (!c?.sufficient) continue
      const k = useAlpha ? c.alphaWins : c.wins, n = useAlpha ? c.nBench : c.nScored
      if (!(n > 0)) continue
      rows.push(row(group, name, k, n, c.avgAlpha ?? null, overall))
    }
  }
  if (vsRandom && vsRandom.verdict !== 'insufficient') {
    const pick = side => {
      const x = vsRandom[side]; if (!x?.n) return null
      const r = vsRandom.metric === 'alphaWinRate' ? x.alphaWinRate : x.winRate
      return r == null ? null : row('AI vs random (same list)', side === 'ai' ? 'AI Brain picks' : 'Random picks, same list', Math.round(r * x.n), x.n, null, overall)
    }
    for (const r of [pick('ai'), pick('shadow')]) if (r) rows.push(r)
  }
  rows.sort((a, b) => b.lo - a.lo || b.n - a.n)
  return { overall, metric: useAlpha ? 'beat-the-benchmark rate' : 'win rate', rows }
}

function row(group, name, k, n, avgAlpha, overall) {
  const ci = wilson(k, n)
  return {
    group, name, n, wins: k,
    rate: +(k / n).toFixed(3), lo: +ci.lo.toFixed(3), hi: +ci.hi.toFixed(3),
    avgAlpha,
    vsOverall: overall == null ? null : ci.lo > overall ? 'above' : ci.hi < overall ? 'below' : 'no clear difference',
  }
}

module.exports = { GROUPS, buildLeaderboard }
