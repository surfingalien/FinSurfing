'use strict'

const fm = require('../lib/factor-mining')

function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }
const gauss = r => { const u = Math.max(1e-9, r()), v = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) }

/** n stocks over `days` bars; drift(k) gives stock k's daily drift (persistent → momentum works). */
function universe({ n = 40, days = 1260, seed = 11, drift = () => 0, vol = 0.015 }) {
  const r = rng(seed), t0 = Date.UTC(2021, 0, 4), out = {}
  for (let k = 0; k < n; k++) {
    let c = 50 + k
    const bars = []
    for (let i = 0; i < days; i++) {
      c *= 1 + drift(k, i) + vol * gauss(r)
      bars.push({ t: t0 + i * 86400000, c, h: c * 1.01, l: c * 0.99, v: 1e6 * (1 + r()) })
    }
    out[`S${k}`] = bars
  }
  return out
}

test('Spearman: perfect, reversed, and tied ranks', () => {
  expect(fm.spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBeCloseTo(1, 10)
  expect(fm.spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBeCloseTo(-1, 10)
  expect(fm.ranks([5, 1, 5, 2])).toEqual([3.5, 1, 3.5, 2])
  expect(fm.spearman([1, 1, 1], [1, 2, 3])).toBeNull()
})

test('no lookahead: every factor at day i is unchanged when the bars after i are changed', () => {
  const u = universe({ n: 1, days: 400 })
  const bars = u.S0
  const i = 300
  const altered = bars.map((b, k) => (k > i ? { ...b, c: b.c * 3, h: b.h * 3, l: b.l * 3, v: b.v * 9 } : b))
  const P = b => ({ c: b.map(x => x.c), h: b.map(x => x.h), l: b.map(x => x.l), v: b.map(x => x.v) })
  for (const [name, f] of Object.entries(fm.FACTORS)) {
    expect([name, f.fn(P(altered), i)]).toEqual([name, f.fn(P(bars), i)])
  }
})

test('pure noise: nothing is admitted, and every candidate counted as a trial', () => {
  const lib = fm.mineFactors(universe({ seed: 23 }))
  expect(lib.tested).toBe(Object.keys(fm.FACTORS).length)
  expect(lib.admitted).toEqual([])
  for (const f of lib.factors.filter(x => x.deflated)) expect(f.deflated.nTrials).toBe(2 * lib.tested)   // both directions
  expect(lib.periods).toBeGreaterThan(40)          // non-overlapping 21-day periods over ~4 years
})

test('the false-admission rate on noise: no factor admitted across 15 skill-less universes', () => {
  // The gate was once fed only direction-chosen (always positive) Sharpes and
  // admitted a noise factor in 34 of 40 runs. Pinned so it cannot drift back.
  let falseRuns = 0
  for (let seed = 1; seed <= 15; seed++) if (fm.mineFactors(universe({ seed: seed * 7919 })).admitted.length) falseRuns++
  expect(falseRuns).toBe(0)
})

test('a planted persistent-drift universe admits momentum, as-is, confirmed on the holdout', () => {
  // Each stock keeps its own drift: past winners keep winning — momentum works.
  const lib = fm.mineFactors(universe({ seed: 5, drift: k => (k - 20) * 0.00012 }))
  const mom = lib.factors.find(f => f.name === 'mom_12_1')
  expect(mom).toMatchObject({ verdict: 'admitted', direction: 'as-is' })
  expect(mom.holdout.meanIc).toBeGreaterThan(0)
  expect(mom.latest.values.length).toBe(40)
  expect(lib.admitted).toContain('mom_12_1')
  expect(lib.caveats[0]).toMatch(/survivorship/)
})

test('a symbol reads its percentile on admitted factors from its own bars', () => {
  const u = universe({ seed: 5, drift: k => (k - 20) * 0.00012 })
  const lib = fm.mineFactors(u)
  const top = fm.percentilesFor(u.S39, lib).find(p => p.name === 'mom_12_1')
  const bottom = fm.percentilesFor(u.S0, lib).find(p => p.name === 'mom_12_1')
  expect(top.percentile).toBeGreaterThan(80)
  expect(bottom.percentile).toBeLessThan(20)
  expect(fm.percentilesFor(u.S0, { factors: [] })).toEqual([])
})

test('runMining fetches with bounded concurrency, tolerates a failed name, and saves', async () => {
  const u = universe({ n: 15, seed: 3 })
  let inFlight = 0, peak = 0
  const fetchBars = async s => {
    inFlight++; peak = Math.max(peak, inFlight)
    await new Promise(r => setTimeout(r, 1))
    inFlight--
    if (s === 'S1') throw new Error('down')
    return u[s]
  }
  const lib = await fm.runMining({ fetchBars, universe: Object.keys(u), concurrency: 3, minUniverse: 10 })
  expect(peak).toBeLessThanOrEqual(3)
  expect(lib.universe).toBe(14)
  expect(lib.requested).toBe(15)
  expect(fm.readLibrary()).toMatchObject({ universe: 14, tested: lib.tested })
})

test('a data outage never overwrites the stored library with a run over a handful of names', async () => {
  fm.saveLibrary({ ranAt: 'last-week', universe: 60, tested: 12, admitted: [], factors: [] })
  const u = universe({ n: 5, seed: 3 })
  await expect(fm.runMining({ fetchBars: async s => u[s] || [], universe: [...Object.keys(u), 'X1', 'X2'] }))
    .rejects.toThrow(/only 5 of 7 names had 5 years of bars — too few to rank; the stored library is kept/)
  expect(fm.readLibrary().ranAt).toBe('last-week')
})

test('SEC fundamental factors read only what was filed by each rebalance date', () => {
  const u = universe({ n: 30, seed: 9 })
  // Each stock reports EPS every quarter, filed 40 days after the quarter ends;
  // stocks with higher k report more earnings.
  const fundamentals = {}
  for (const [k, sym] of Object.keys(u).entries()) {
    const eps = []
    for (let q = 0; q < 22; q++) {
      const end = new Date(Date.UTC(2020, 0, 1) + q * 91 * 86400000).toISOString().slice(0, 10)
      const start = new Date(Date.parse(end) - 90 * 86400000).toISOString().slice(0, 10)
      const filed = new Date(Date.parse(end) + 40 * 86400000).toISOString().slice(0, 10)
      eps.push({ start, end, val: 0.1 + k * 0.05, filed })
    }
    fundamentals[sym] = { series: { eps, revenue: [], netIncome: [], ocf: [], capex: [], equity: [], assets: [], debt: [], shares: [] } }
  }
  const lib = fm.mineFactors(u, { fundamentals })
  const ey = lib.factors.find(f => f.name === 'earnings_yield')
  expect(ey.periods).toBeGreaterThan(30)
  // a snapshot on a date before a quarter's filing does not see that quarter
  const p = { c: [100], days: ['2020-05-01'], fund: fundamentals.S0 }
  expect(fm.FACTORS.earnings_yield.fn(p, 0)).toBeNull()      // only one quarter filed by then — no trailing four
})
