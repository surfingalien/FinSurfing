'use strict'
const D = require('../lib/discovery-sources')
const L = require('../lib/quant/linalg')

const T0 = Date.UTC(2025, 0, 2)
// A sector: every name loads on one common factor; `lag` names drop 6% over the last five sessions on their own.
function sector({ n = 10, days = 260, lag = [], seed = 1 } = {}) {
  const g = L.rng(seed), m = Array.from({ length: days }, () => 0.01 * g.normal())
  const out = {}
  for (let k = 0; k < n; k++) {
    const s = `N${k}`; let p = 100
    out[s] = m.map((x, i) => {
      const own = 0.006 * g.normal() + (lag.includes(s) && i >= days - 5 ? -0.012 : 0)
      return { t: T0 + i * 864e5, c: (p *= Math.exp(x + own)) }
    })
  }
  return out
}

test('a name falling behind what its sector explains is found; the rest are not', () => {
  const d = D.findDislocations(sector({ lag: ['N3'] }))
  expect(d.cheap.map(x => x.symbol)).toEqual(['N3'])
  expect(d.cheap[0].residualZ).toBeLessThanOrEqual(-2)
})

test('too few names gives nothing rather than a guess', () => {
  expect(D.findDislocations(sector({ n: 4 })).cheap).toEqual([])
})

test('a cointegrated pair that has stretched names its cheap leg, and the false-positive count is reported', () => {
  const g = L.rng(5), days = 400, base = []
  let p = 100
  for (let i = 0; i < days; i++) base.push((p *= Math.exp(0.012 * g.normal())))
  let e = 0
  const A = base.map((c, i) => ({ t: T0 + i * 864e5, c }))
  const B = base.map((c, i) => { e = 0.8 * e + 0.004 * g.normal(); const shock = i >= days - 3 ? -0.05 : 0; return { t: T0 + i * 864e5, c: c * Math.exp(e + shock) } })
  const out = D.findPairDivergences({ A, B })
  expect(out.tested).toBe(1)
  expect(out.expectedFalsePositives).toBe(0.1)
  expect(out.pairs).toEqual([expect.objectContaining({ cheap: 'B', rich: 'A' })])
  expect(out.pairs[0].z).toBeGreaterThanOrEqual(2)
})

test('scan candidates come only from a fresh store, carry their reason, and are capped', () => {
  const store = { at: new Date().toISOString(), sectors: {
    Energy: { dislocations: [{ symbol: 'XOM', residualZ: -2.4 }], pairs: [{ cheap: 'CVX', rich: 'COP', z: 2.3 }] },
    Utilities: { dislocations: [{ symbol: 'NEE', residualZ: -2.1 }, { symbol: 'DUK', residualZ: -2.0 }, { symbol: 'SO', residualZ: -2.0 }], pairs: [] },
  } }
  const energy = D.candidatesFor(store, 'Energy')
  expect(energy).toEqual([
    { symbol: 'XOM', source: 'dislocation', why: expect.stringMatching(/-2.4σ behind Energy/) },
    { symbol: 'CVX', source: 'pair', why: expect.stringMatching(/COP/) },
  ])
  expect(D.candidatesFor(store, null)).toHaveLength(4)
  expect(D.candidatesFor({ ...store, at: '2020-01-01T00:00:00Z' }, 'Energy')).toEqual([])
})

test('a refresh that could read almost nothing refuses to overwrite the stored lists', async () => {
  await expect(D.refreshDiscovery({ pools: { Energy: ['A', 'B'] }, fetchBars: async () => [] })).rejects.toThrow(/keeping the stored/)
})
