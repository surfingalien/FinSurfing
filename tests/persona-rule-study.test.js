'use strict'
const rules = require('../lib/persona-rules')
const st = require('../lib/persona-rule-study')
const fm = require('../lib/factor-mining')

const DAY = 86_400_000
function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }
const gauss = r => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()) }

describe('the shared persona score', () => {
  it('matches the formula the page used', () => {
    const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.2)
    // growth: 50 + 30*.35*2 + 20*.25*2 + 10*.05*2 + 10*.10*2 (+ momentum)
    const base = 50 + 30 * 0.35 * 2 + 20 * 0.25 * 2 + 10 * 0.05 * 2 + 10 * 0.10 * 2
    const s = rules.scoreFor('growth', { revenueGrowthPct: 30, earningsGrowthPct: 20, pe: 20, beta: 0.9 }, [])
    expect(s).toBe(Math.round(base))
    expect(rules.scoreFor('growth', { revenueGrowthPct: 30, earningsGrowthPct: 20, pe: 20, beta: 0.9 }, closes)).toBeGreaterThan(s)
  })
  it('missing inputs are neutral', () => {
    expect(rules.scoreFor('value', { revenueGrowthPct: null, earningsGrowthPct: null, pe: null, beta: null }, [])).toBe(50)
  })
})

/** n stocks; each has a constant P/E "type"; low-P/E names drift up when `edge`. */
function market(n, seed, edge) {
  const r = rng(seed), bars = {}, pe = {}
  const len = 1300
  const spy = []; let sp = 100
  for (let i = 0; i < len; i++) { sp *= Math.exp(0.0003 + 0.01 * gauss(r)); spy.push({ t: Date.UTC(2020, 0, 1) + i * DAY, c: sp }) }
  bars.SPY = spy
  for (let k = 0; k < n; k++) {
    const sym = `S${k}`
    pe[sym] = k % 2 ? 12 : 45
    const drift = edge && pe[sym] < 15 ? 0.0015 : 0
    let p = 100; const b = []
    for (let i = 0; i < len; i++) { p *= Math.exp(drift + 0.015 * gauss(r)); b.push({ t: Date.UTC(2020, 0, 1) + i * DAY, c: p }) }
    bars[sym] = b
  }
  const snapshots = Object.fromEntries(Object.keys(pe).map(s => [s, (d, price) => ({ pe: pe[s], revenueGrowthYoY: 0, epsTtm: price ? price / pe[s] : 1 })]))
  return { panel: fm.toPanel(bars), snapshots }
}

describe('the five-year study', () => {
  it('finds a planted value effect for the Value Seeker', () => {
    const { panel, snapshots } = market(30, 4, true)
    const r = st.study(panel, snapshots, { personas: ['value'] })
    expect(r.personas.value.periods).toBeGreaterThanOrEqual(st.MIN_PERIODS)
    expect(r.personas.value.verdict).toBe('outperforms')
    expect(r.personas.value.icMean).toBeGreaterThan(0)
  })
  it('on noise the verdict is rarely outperforms', () => {
    let wins = 0
    for (let s = 1; s <= 6; s++) {
      const { panel, snapshots } = market(30, s * 13, false)
      if (st.study(panel, snapshots, { personas: ['value'] }).personas.value.verdict === 'outperforms') wins++
    }
    expect(wins).toBeLessThanOrEqual(1)
  })
  it('never reads later prices: rewriting the future does not change past scores', () => {
    const { panel } = market(12, 7, false)
    const d = fm.rebalanceDates(Object.fromEntries(Object.entries(panel).filter(([k]) => k !== 'SPY')))[3]
    const p = panel.S1, spy = panel.SPY
    const a = st.inputsAt(p, spy, d, null)
    const i = p.idx.get(d)
    for (let k = i + 1; k < p.c.length; k++) p.c[k] *= 3
    expect(st.inputsAt(p, spy, d, null)).toEqual(a)
  })
  it('asks the fundamentals for the rebalance date and a year before, never later', () => {
    const { panel } = market(12, 9, false)
    const asked = []
    const snaps = Object.fromEntries(Object.keys(panel).filter(s => s !== 'SPY').map(s => [s, d => { asked.push(d); return null }]))
    const r = st.study(panel, snaps, { personas: ['value'] })
    const last = fm.rebalanceDates(Object.fromEntries(Object.entries(panel).filter(([k]) => k !== 'SPY'))).pop()
    expect(asked.every(d => d <= last)).toBe(true)
    expect(r.dates).toBeGreaterThan(0)
  })
  it('a run reading too few names keeps the stored study', async () => {
    await expect(st.run({ fetchBars: async () => [], universe: ['AAA'], save: false })).rejects.toThrow(/stored study is kept/)
  })
  it('is a weekly job, mirrored and gitignored', () => {
    expect(require('../lib/durable-files').FILES.map(f => f.name)).toContain('persona-rule-study.json')
    expect(require('fs').readFileSync('.gitignore', 'utf8')).toMatch(/persona-rule-study\.json/)
  })
})
