'use strict'
const C = require('../lib/model-contest')
const L = require('../lib/quant/linalg')

const T0 = Date.UTC(2025, 0, 1)
// A resolved AI Brain prediction with a triple-barrier label over its own 91-day horizon.
function rec(i, { y, vol = 0.3, odds = 0.35, horizonDays = 91, spacingDays = 2 } = {}) {
  return {
    generatedAt: new Date(T0 + i * spacingDays * 864e5).toISOString(), horizonDays,
    barrier: { label: y ? 'target' : 'stop', window: horizonDays },
    targetReturn: 15, stopLoss: 8, assetType: 'stock', compositeScore: 60, confidence: 'Medium',
    quantAtScan: { vol21: vol, character: 'random walk', var95: 0.03, probStressed: 0.2, beta: 1, residualZ: 0 },
    modelOdds: { pTarget: odds }, stopNoise: 'clear',
  }
}

test('below the minimum it waits and adopts nothing', () => {
  const g = L.rng(1)
  const out = C.runTrack(Array.from({ length: 60 }, (_, i) => rec(i, { y: g.uniform() < 0.4 })), 'generic')
  expect(out.ready).toBe(false)
  expect(out.winner).toBeNull()
  expect(out.reason).toMatch(/waiting — 60 of 150/)
})

test('pure noise: no challenger is adopted, however many are tried', () => {
  const g = L.rng(2)
  const rows = Array.from({ length: 400 }, (_, i) => rec(i, { y: g.uniform() < 0.4, vol: 0.1 + g.uniform(), odds: g.uniform() }))
  const out = C.runTrack(rows, 'generic')
  expect(out.ready).toBe(true)
  expect(out.winner).toBeNull()
  expect(out.models.map(m => m.name)).toEqual(expect.arrayContaining([C.CHAMPION, ...C.CHALLENGERS]))
  expect(out.zCritical).toBeGreaterThan(2)                 // Bonferroni over seven challengers
})

test('a signal a straight line cannot draw (target first only in a middle volatility band) is found by a tree model', () => {
  const g = L.rng(3)
  const rows = Array.from({ length: 500 }, (_, i) => {
    const vol = g.uniform() * 1.6
    const inBand = vol > 0.5 && vol < 1.1
    return rec(i, { y: g.uniform() < (inBand ? 0.85 : 0.15), vol, spacingDays: 1 })
  })
  const out = C.runTrack(rows, 'generic')
  expect(out.ready).toBe(true)
  expect(['decisionTree', 'randomForest', 'gradientBoosting', 'knn']).toContain(out.winner)
  const champ = out.models.find(m => m.name === C.CHAMPION)
  expect(out.models[0].brier).toBeLessThan(champ.brier)
})

test('purged: a block is never predicted by picks whose outcome was still unknown', () => {
  // A year-long horizon with picks a day apart: nothing has resolved before any test block starts.
  const g = L.rng(4)
  const rows = Array.from({ length: 200 }, (_, i) => rec(i, { y: g.uniform() < 0.5, horizonDays: 365, spacingDays: 1 }))
  const out = C.runTrack(rows, 'generic')
  expect(out.ready).toBe(false)
  expect(out.reason).toMatch(/no test block/)
})

test('an adopted winner scores a live plan; without one, callers keep their method', () => {
  const g = L.rng(5)
  const rows = Array.from({ length: 500 }, (_, i) => {
    const vol = g.uniform() * 1.6
    return rec(i, { y: g.uniform() < (vol > 0.5 && vol < 1.1 ? 0.85 : 0.15), vol, spacingDays: 1 })
  })
  C._resetForTests()
  const store = C.runContest(rows)
  const plan = C.planLikeFrom({ targetReturn: 15, stopLoss: 8, quantStamp: { vol21: 0.8, character: 'random walk', var95: 0.03, probStressed: 0.2, beta: 1, residualZ: 0 }, planOdds: { odds: { pTarget: 0.35 }, stop: { level: 'clear' } } })
  const inBand = C.winProbFor(store, plan, { records: rows })
  const outBand = C.winProbFor(store, { ...plan, quantAtScan: { ...plan.quantAtScan, vol21: 1.5 } }, { records: rows })
  expect(inBand.contest).toBe(true)
  expect(inBand.p).toBeGreaterThan(outBand.p)
  expect(C.winProbFor({ tracks: { generic: { winner: null } } }, plan, { records: rows })).toBeNull()
})
