'use strict'
const Q = require('../lib/quant-snapshot')
const L = require('../lib/quant/linalg')

const T0 = Date.UTC(2024, 0, 2)
function bars(n, seed, { vol = 0.2, phi = 0, adv = 2e6, bench = null, beta = 1 } = {}) {
  const g = L.rng(seed); let p = 100, e = 0
  return Array.from({ length: n }, (_, i) => {
    e = phi * e + vol / Math.sqrt(252) * g.normal()
    const r = bench ? beta * bench[i] + e : e
    p *= Math.exp(r); return { t: T0 + i * 864e5, o: p * (1 + 0.001 * g.normal()), h: p * 1.008, l: p * 0.992, c: p, v: adv * (1 + 0.2 * g.uniform()), _r: r }
  })
}
test('snapshot measures volatility near the planted level and labels a random walk as such', () => {
  const s = Q.symbolSnapshot(bars(500, 1, { vol: 0.3 }))
  expect(s.vol.forecast21).toBeGreaterThan(0.2); expect(s.vol.forecast21).toBeLessThan(0.42)
  expect(s.vol.move21).toBeCloseTo(s.vol.forecast21 * Math.sqrt(21 / 252), 9)
  expect(['random walk', 'mean-reverting', 'trending']).toContain(s.character.label)
  expect(s.tail.var95).toBeGreaterThan(0.01); expect(s.tail.es95).toBeGreaterThan(s.tail.var95)
  expect(s.liquidity.advUsd).toBeGreaterThan(1e8); expect(s.liquidity.impactBps).toBeGreaterThan(0); expect(s.state.label).toMatch(/calm|stressed/)
})
test('character: persistent increments read as trending, alternating ones as mean-reverting', () => {
  expect(Q.symbolSnapshot(bars(800, 2, { phi: 0.35 })).character.label).toBe('trending')
  expect(Q.symbolSnapshot(bars(800, 3, { phi: -0.35 })).character.label).toBe('mean-reverting')
})
test('beta is measured against a benchmark on common dates', () => {
  const g = L.rng(4), m = Array.from({ length: 400 }, () => 0.01 * g.normal())
  let p = 100; const bench = m.map((r, i) => ({ t: T0 + i * 864e5, c: (p *= Math.exp(r)) }))
  const s = Q.symbolSnapshot(bars(400, 5, { vol: 0.05, bench: m, beta: 1.5 }), { benchBars: bench })
  expect(s.beta.beta).toBeGreaterThan(1.3); expect(s.beta.beta).toBeLessThan(1.7)
})
test('too little history is reported, not guessed; prompt line and stamp only carry measured fields', () => {
  expect(Q.symbolSnapshot(bars(30, 6)).insufficient).toBe(true); expect(Q.snapshotLine('X', Q.symbolSnapshot(bars(30, 6)))).toBeNull(); expect(Q.stampOf(null)).toBeNull()
  const s = Q.symbolSnapshot(bars(300, 7)), line = Q.snapshotLine('ABC', s, { residualZ: -1.8, view: 'cheap vs peers', peers: 6 })
  expect(line).toMatch(/^ABC: vol21f=\d+%/); expect(line).toMatch(/resid=-1.8z/); expect(line).not.toMatch(/NaN|undefined/)
  const st = Q.stampOf(s, { residualZ: -1.8 }); expect(Object.keys(st)).toEqual(['vol21', 'volMethod', 'character', 'vr5', 'hurst', 'var95', 'probStressed', 'beta', 'advUsd', 'residualZ']); expect(st.residualZ).toBe(-1.8)
})
test('cross-section finds the name that lagged its peers', () => {
  const g = L.rng(8), f = Array.from({ length: 200 }, () => 0.01 * g.normal()), map = {}
  for (const s of ['A', 'B', 'C', 'D', 'E']) { let p = 100; map[s] = [{ t: T0, c: 100 }, ...f.map((x, i) => ({ t: T0 + (i + 1) * 864e5, c: (p *= 1 + x + 0.002 * g.normal() + (s === 'E' && i >= 195 ? -0.02 : 0)) }))] }
  const cs = Q.crossSection(map); expect(cs.get('E').residualZ).toBeLessThan(-1.5); expect(Q.crossSection({ A: map.A }).size).toBe(0)
})
test('evidence items and buckets', () => {
  const items = Q.evidenceItems(Q.symbolSnapshot(bars(400, 9)), { residualZ: 1.2, view: 'in line', peers: 5 })
  expect(items.map(i => i.id)).toEqual(expect.arrayContaining(['volatility', 'character', 'tail-risk', 'liquidity', 'vol-state', 'relative']))
  items.forEach(i => expect(i.text).not.toMatch(/NaN|undefined/))
  expect(Q.volBucket(0.1)).toMatch(/low/); expect(Q.volBucket(0.5)).toMatch(/high/); expect(Q.residualBucket(-1.2)).toMatch(/lagging/); expect(Q.residualBucket(null)).toBeNull()
})

// ── Wiring: AI Buy Signals and Agent Hub carry the same evidence ─────────────
test('Buy Signals: each pick with enough history gets a stamp and evidence; thin history gets none', () => {
  const recs = [{ symbol: 'aaa' }, { symbol: 'BBB' }, { symbol: 'CCC' }, { symbol: 'THIN' }]
  const yearBars = { AAA: bars(260, 11), BBB: bars(260, 12), CCC: bars(260, 13), THIN: bars(30, 14) }
  require('../routes/recommendations')._test.attachQuant(recs, yearBars, null)
  for (const r of recs.slice(0, 3)) {
    expect(r.quant.stamp.vol21).toBeGreaterThan(0)
    expect(r.quant.evidence.map(e => e.id)).toEqual(expect.arrayContaining(['volatility', 'tail-risk', 'liquidity']))
  }
  expect(recs[3].quant).toBeUndefined()
})
test('Agent Hub: chart timestamps in seconds are read as dates, and short history yields no quant facts', () => {
  const { quantFacts } = require('../routes/agents')._test
  const sec = bs => bs.map(b => ({ ...b, t: b.t / 1000 }))
  const f = quantFacts(sec(bars(260, 21)), sec(bars(260, 22)))
  expect(f.stamp.vol21).toBeGreaterThan(0)
  expect(f.line).toMatch(/^vol21f=/)
  expect(f.stamp.beta).not.toBeUndefined()
  expect(quantFacts(sec(bars(40, 23)))).toBeNull()
})

test('Buy Signals and Agent Hub plans carry the odds of their own levels', () => {
  const recs = [{ symbol: 'AAA', targetReturn: 15, stopLoss: 7, period: '6m' }]
  require('../routes/recommendations')._test.attachQuant(recs, { AAA: bars(260, 31) }, null)
  expect(recs[0].planOdds.odds.sessions).toBe(126)
  expect(recs[0].planOdds.stop.level).toMatch(/inside-noise|tight|clear/)
  const { quantFacts, levelOdds } = require('../routes/agents')._test
  const sec = bs => bs.map(b => ({ ...b, t: b.t / 1000 }))
  const q = quantFacts(sec(bars(260, 32)))
  const o = levelOdds({ entry: 100, target_1: 108, stop_loss: 96 }, q)
  expect(o.odds.sessions).toBe(21)
  expect(o.odds.pTarget).toBeGreaterThan(0)
  expect(levelOdds({ entry: 100, target_1: 95, stop_loss: 96 }, q)).toBeNull()   // not a long plan
})
