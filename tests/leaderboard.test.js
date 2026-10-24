'use strict'

const { buildLeaderboard } = require('../lib/leaderboard')

const c = (alphaWins, nBench, extra = {}) => ({ sufficient: true, alphaWins, nBench, alphaWinRate: alphaWins / nBench, wins: alphaWins, nScored: nBench, ...extra })

test('ranked by what the record can vouch for (lower bound), not the luckiest raw rate', () => {
  const lb = buildLeaderboard({
    overall: c(500, 1000),
    byPersona: { buffett: c(4, 5), lynch: c(70, 100) },
    bySurface: { 'ai-brain': c(300, 600), advisory: c(40, 100) },
    byMethod: { debate: { sufficient: false } },
  })
  expect(lb.metric).toBe('beat-the-benchmark rate')
  expect(lb.rows.map(r => r.name)).toEqual(['lynch', 'ai-brain', 'buffett', 'advisory'])
  const by = Object.fromEntries(lb.rows.map(r => [r.name, r]))
  expect(by.lynch.vsOverall).toBe('above')
  expect(by.buffett.vsOverall).toBe('no clear difference')     // 80% on five picks
  expect(by.advisory.vsOverall).toBe('below')
  expect(lb.rows.some(r => r.name === 'debate')).toBe(false)   // not enough decisions yet
})

test('the random baseline sits on the same table once both sides have outcomes', () => {
  const lb = buildLeaderboard({ overall: c(50, 100) }, { verdict: 'no-difference', metric: 'alphaWinRate', ai: { n: 40, alphaWinRate: 0.55 }, shadow: { n: 40, alphaWinRate: 0.5 } })
  expect(lb.rows.map(r => r.name)).toEqual(['AI Brain picks', 'Random picks, same list'])
  expect(buildLeaderboard({ overall: c(50, 100) }, { verdict: 'insufficient' }).rows).toEqual([])
})
