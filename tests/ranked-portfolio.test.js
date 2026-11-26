'use strict'
const rp = require('../lib/ranked-portfolio')
const fm = require('../lib/factor-mining')

function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }
const gauss = r => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()) }
const DAY = 86_400_000
const T0 = Date.UTC(2020, 0, 1)

/** `names` stocks, `n` daily bars; `persist` > 0 plants trends that last (past return predicts the next month). */
function universe(names, n, seed, persist = 0) {
  const r = rng(seed), out = {}
  for (let s = 0; s < names; s++) {
    let c = 100, drift = 0
    const bars = []
    for (let i = 0; i < n; i++) {
      if (i % 42 === 0) drift = persist * gauss(r)          // a new trend every two months
      c *= Math.exp(drift + 0.015 * gauss(r))
      bars.push({ t: T0 + i * DAY, c, h: c * 1.005, l: c * 0.995, v: 1e6 * (1 + r()) })
    }
    out[`S${s}`] = bars
  }
  return out
}

describe('pieces', () => {
  it('rankScale maps a cross-section into [−0.5, 0.5] and leaves gaps in the middle', () => {
    expect(rp.rankScale([3, 1, 2, null])).toEqual([0.5, -0.5, 0, 0])
  })
  it('TopkDropout changes at most nDrop names per rebalance', () => {
    const held = new Set(['A', 'B', 'C', 'D'])
    const { next, sold, bought } = rp.rebalance(held, ['E', 'F', 'G', 'A', 'B', 'C', 'D'], { topK: 4, nDrop: 2 })
    expect(next.size).toBe(4)
    expect(sold.length).toBe(2)
    expect(bought).toEqual(['E', 'F'])
  })
  it('a held name with no data that day is sold', () => {
    const { sold } = rp.rebalance(new Set(['A', 'Z']), ['A', 'B', 'C'], { topK: 2, nDrop: 1 })
    expect(sold).toContain('Z')
  })
})

describe('study', () => {
  it('finds a planted pattern (trends that persist) and beats owning the whole list', () => {
    const s = rp.study(fm.toPanel(universe(40, 1300, 7, 0.004)))
    expect(s.model.periods).toBeGreaterThanOrEqual(rp.MIN_TEST)
    expect(s.model.verdict).toBe('outperforms')
    expect(s.model.meanIc).toBeGreaterThan(0)
    expect(s.today.top).toHaveLength(rp.TOP_K)
  })
  it('on noise it rarely claims an edge', () => {
    let claims = 0
    for (let seed = 1; seed <= 8; seed++) if (rp.study(fm.toPanel(universe(30, 1100, seed * 97, 0))).model.verdict === 'outperforms') claims++
    expect(claims).toBeLessThanOrEqual(1)
  })
  it('never uses the future: changing prices after a decision day does not change that decision', () => {
    const bars = universe(25, 1000, 3, 0.003)
    const a = rp.study(fm.toPanel(bars))
    const cut = a.model.curve[5].date
    const changed = Object.fromEntries(Object.entries(bars).map(([k, b]) => [k, b.map(x => (new Date(x.t).toISOString().slice(0, 10) > cut ? { ...x, c: x.c * 3, h: x.h * 3, l: x.l * 3 } : x))]))
    const b = rp.study(fm.toPanel(changed))
    // The first five decisions (made before the cut) and the names they held are identical.
    expect(b.model.curve.slice(0, 5).map(c => c.date)).toEqual(a.model.curve.slice(0, 5).map(c => c.date))
    for (let i = 0; i < 4; i++) expect(b.model.curve[i].portfolio).toBeCloseTo(a.model.curve[i].portfolio, 10)
  })
  it('says what it is and what it is not', () => {
    const s = rp.study(fm.toPanel(universe(20, 900, 5, 0)))
    expect(s.caveats.join(' ')).toMatch(/survivorship/)
    expect(s.params.topK).toBe(rp.TOP_K)
  })
})

describe('run', () => {
  it('keeps the stored study when too few names could be read', async () => {
    await expect(rp.run({ save: false, universe: ['A', 'B'], fetchBars: async () => [] })).rejects.toThrow(/keeping the stored study/)
  })
})
