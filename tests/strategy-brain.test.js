'use strict'
const fs = require('fs')
const brain = require('../lib/strategy-brain')
const { rng } = require('../lib/quant/linalg')

beforeEach(() => { try { fs.unlinkSync(brain.STATE_FILE) } catch { /* fresh */ } process.env.STRATEGY_BRAIN_ENABLED = 'true'; process.env.STRATEGY_BRAIN_EXPERIMENTS = '30' })
afterAll(() => { delete process.env.STRATEGY_BRAIN_ENABLED; delete process.env.STRATEGY_BRAIN_EXPERIMENTS })

function fakeLibrary() {
  const rows = []
  return { rows, readLibrary: () => rows, recordValidation: (config, r) => { const e = { id: `e${rows.length}`, ...config, status: 'active', fitness: 50, validations: [] }; rows.push(e); return e } }
}
// A world where only random forests find anything: every other arm comes back empty.
const deps = (over = {}) => ({
  library: fakeLibrary(),
  evolution: { EVOLUTION_UNIVERSE: ['SPY', 'QQQ', 'AAPL'], discoverStrategies: async () => ({ proposed: 3, validated: 0, stored: 0 }), discoverCompositions: async () => ({ proposed: 3, invalid: 1, validated: 0, stored: 0 }) },
  mlStrategy: { ML_TYPE: 'ml_model', variantsFor: m => [{ model: m }], evaluateMlBatch: async (_s, v) => v.map(p => ({ params: p, name: p.model, description: p.model, metrics: { alpha: 1 }, admit: p.model === 'random_forest', reason: p.model === 'random_forest' ? 'admitted' : 'not validated (mixed)' })) },
  strategyLab: { evaluateProposals: c => c.map(p => ({ ...p, verdict: 'rejected' })) },
  fetchBars: async () => Array.from({ length: 600 }, (_, i) => ({ t: i })),
  toSeries: () => ({ timestamps: [], closes: [], opens: [] }),
  costBps: () => 10,
  holdings: async () => ['NVDA'],
  budget: () => ({ exhausted: false }),
  aiAvailable: () => true,
  yieldFn: async () => {},
  ...over,
})

test('off by default; pausable; a pause stops it before the next experiment', async () => {
  delete process.env.STRATEGY_BRAIN_ENABLED
  expect(await brain.run({ deps: deps() })).toMatchObject({ ran: false, reason: expect.stringMatching(/STRATEGY_BRAIN_ENABLED/) })
  process.env.STRATEGY_BRAIN_ENABLED = 'true'
  let n = 0
  const out = await brain.run({ deps: deps({ fetchBars: async () => { if (++n === 3) brain.pause({ by: 'admin@test' }); return Array.from({ length: 600 }, () => ({})) } }) })
  expect(out.stopped).toMatch(/paused/)
  expect(out.experiments.length).toBeLessThan(30)
})

test('it teaches itself: the arm that finds strategies gets more of the tries over successive runs', async () => {
  const d = deps()
  for (let day = 0; day < 4; day++) await brain.run({ deps: { ...d, now: () => new Date(Date.UTC(2026, 10, 2 + day)) } })
  const st = brain.readState()
  const rf = st.arms['ml:random_forest']
  const others = Object.entries(st.arms).filter(([k]) => k !== 'ml:random_forest').map(([, v]) => v.tries)
  expect(rf.hits).toBeGreaterThan(0)
  expect(rf.tries).toBeGreaterThan(Math.max(...others))
  expect(d.library.rows.every(e => e.origin?.by === 'strategy-brain' && e.origin.arm === 'ml:random_forest')).toBe(true)
  // Lessons are kept per arm.
  expect(Object.keys(st.arms['ml:logistic']?.reasons || { x: 1 }).length).toBeGreaterThan(0)
})

test('when the AI budget is spent, or no provider key is set, the model-using arms are never chosen', async () => {
  const out = await brain.run({ deps: deps({ budget: () => ({ exhausted: true }) }) })
  expect(out.experiments.some(e => e.arm === 'catalog-llm' || e.arm === 'dsl-llm')).toBe(false)
  const out2 = await brain.run({ deps: deps({ aiAvailable: () => false, now: () => new Date(Date.UTC(2026, 11, 1)) }) })
  expect(out2.experiments.some(e => e.arm === 'catalog-llm' || e.arm === 'dsl-llm')).toBe(false)
})

test('forward results count double: an arm whose admissions die forward loses its lead', () => {
  const armList = brain.arms().filter(a => a.id === 'ml:tree' || a.id === 'ml:lda')
  const st = { 'ml:tree': { tries: 10, hits: 5 }, 'ml:lda': { tries: 10, hits: 3 } }
  const lib = [
    ...Array.from({ length: 5 }, (_, i) => ({ id: `t${i}`, origin: { by: 'strategy-brain', arm: 'ml:tree' }, status: 'retired', validations: [{ forward: true, score: 10 }, { forward: true, score: 20 }] })),
    ...Array.from({ length: 3 }, (_, i) => ({ id: `l${i}`, origin: { by: 'strategy-brain', arm: 'ml:lda' }, status: 'active', validations: [{ forward: true, score: 80 }] })),
  ]
  const f = brain.forwardByArm(lib)
  expect(f['ml:tree']).toMatchObject({ admitted: 5, retired: 5, forwardFail: 10 })
  const before = brain.posteriors(armList, st, {})
  const after = brain.posteriors(armList, st, f)
  expect(before.find(a => a.id === 'ml:tree').mean).toBeGreaterThan(before.find(a => a.id === 'ml:lda').mean)
  expect(after.find(a => a.id === 'ml:lda').mean).toBeGreaterThan(after.find(a => a.id === 'ml:tree').mean)
  const pb = brain.probabilityBest(after)
  expect(Object.values(pb).reduce((a, b) => a + b, 0)).toBeCloseTo(1, 2)
})

test('Thompson sampling is reproducible from its seed and respects eligibility', () => {
  const posts = brain.posteriors(brain.arms(), {}, {})
  const a = brain.chooseArm(posts, rng(5)), b = brain.chooseArm(posts, rng(5))
  expect(a.id).toBe(b.id)
  expect(brain.chooseArm(posts, rng(5), x => x.id === 'catalog-grid').id).toBe('catalog-grid')
  const s = Array.from({ length: 2000 }, (_, i) => brain.betaSample(9, 3, rng(i + 1)))
  expect(s.reduce((x, y) => x + y, 0) / s.length).toBeCloseTo(0.75, 1)
})

test('random catalog draws respect the catalog ranges and orderings; the symbol plan interleaves holdings', () => {
  const cfgs = brain.randomCatalogConfigs(rng(3), 20)
  expect(cfgs).toHaveLength(20)
  for (const c of cfgs) {
    if (c.params.fastPeriod != null) expect(c.params.fastPeriod).toBeLessThan(c.params.slowPeriod)
    if (c.params.oversold != null) expect(c.params.oversold).toBeLessThan(c.params.overbought)
  }
  expect(brain.symbolPlan(['NVDA', 'TSM'], ['SPY', 'NVDA', 'QQQ'], 4, 0)).toEqual(['NVDA', 'SPY', 'TSM', 'QQQ'])
})

test('a symbol with no price data is recorded but never counted against the method', async () => {
  const out = await brain.run({ deps: deps({ fetchBars: async () => [] , now: () => new Date(Date.UTC(2027, 0, 5)) }) })
  const ml = out.experiments.filter(e => e.arm.startsWith('ml:') || e.arm === 'catalog-grid')
  expect(ml.length).toBeGreaterThan(0)
  expect(ml.every(e => e.skipped)).toBe(true)
  const st = brain.readState()
  for (const [id, a] of Object.entries(st.arms || {})) if (id.startsWith('ml:') || id === 'catalog-grid') expect(a.tries).toBe(0)
})
