'use strict'
const { cpcv, combinations, trainIndices } = require('../lib/cpcv')
const { selectionProblem } = require('../lib/strategy-lab')
const { rng } = require('../lib/quant/linalg')

const noise = (T, seed, sd = 0.01, mu = 0) => { const g = rng(seed); return Array.from({ length: T }, () => mu + sd * g.normal()) }

test('split and path counts follow C(N,k) and C(N−1,k−1)', () => {
  expect(combinations(6, 2)).toHaveLength(15)
  const r = cpcv([noise(600, 1), noise(600, 2)], { nGroups: 6, kTest: 2 })
  expect(r.splits).toBe(15)
  expect(r.nPaths).toBe(5)
  expect(r.pathSharpes).toHaveLength(5)
})

test('one real edge among noise: the procedure finds it on every split and generalises', () => {
  const T = 1260
  const cands = [noise(T, 100, 0.01, 0.0012), ...Array.from({ length: 9 }, (_, i) => noise(T, i + 1))]
  const r = cpcv(cands)
  expect(r.generalises).toBe(true)
  expect(r.medianSharpe).toBeGreaterThan(1)
  expect(r.selectionStability).toBeGreaterThan(0.9)
})

test('best of pure noise does not generalise in most histories', () => {
  let generalised = 0
  for (let s = 0; s < 40; s++) {
    const r = cpcv(Array.from({ length: 20 }, (_, i) => noise(756, s * 100 + i)))
    if (r.generalises) generalised++
  }
  expect(generalised).toBeLessThan(28)          // ~half by chance; never systematically positive
})

test('purge and embargo drop the bars next to each held-out block from training', () => {
  const bounds = [[0, 100], [100, 200], [200, 300], [300, 400]]
  const tr = trainIndices(400, bounds, [1], { purge: 5, embargo: 3 })
  expect(tr).not.toContain(150)                       // held out
  for (let t = 95; t < 100; t++) expect(tr).not.toContain(t)   // purged before
  for (let t = 200; t < 203; t++) expect(tr).not.toContain(t)  // embargoed after
  expect(tr).toContain(94); expect(tr).toContain(203)
  expect(tr).toHaveLength(400 - 100 - 5 - 3)
  expect(trainIndices(400, bounds, [0], { purge: 5, embargo: 0 })).toHaveLength(300)   // nothing before block 0 to purge
})

test('too short, mismatched or ill-posed inputs', () => {
  expect(cpcv([noise(50, 1), noise(50, 2)])).toBeNull()
  expect(() => cpcv([noise(200, 1), noise(199, 2)])).toThrow(/same number of bars/)
  expect(() => cpcv([noise(200, 1)], { nGroups: 4, kTest: 4 })).toThrow(/kTest/)
})

test('selectionProblem names PBO first, then CPCV', () => {
  expect(selectionProblem({ pbo: { overfit: true }, cpcv: { generalises: false } })).toMatch(/PBO/)
  expect(selectionProblem({ pbo: { overfit: false }, cpcv: { generalises: false } })).toMatch(/CPCV/)
  expect(selectionProblem({ pbo: { overfit: false }, cpcv: { generalises: true } })).toBeNull()
  expect(selectionProblem({ pbo: null, cpcv: null })).toBeNull()
})
