'use strict'
const tb = require('../lib/turbulence')

function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }
const gauss = r => { let u = 0; while (u === 0) u = r(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * r()) }
const DAY = 86_400_000, T0 = Date.UTC(2020, 0, 1)

/**
 * Twelve correlated assets (one common factor). From `breakAt` on for `breakLen` days the
 * relationships break: assets move AGAINST the factor by an ordinary-sized amount — every
 * single-asset move stays normal-sized, only the cross-asset pattern is unusual.
 */
function market(n, seed, breakAt = null, breakLen = 10) {
  const r = rng(seed), out = {}
  const px = tb.ASSETS.map(() => 100)
  tb.ASSETS.forEach(s => { out[s] = [] })
  for (let i = 0; i < n; i++) {
    const f = gauss(r) * 0.01
    const broken = breakAt != null && i >= breakAt && i < breakAt + breakLen
    tb.ASSETS.forEach((s, a) => {
      const loading = broken ? (a % 2 ? 1 : -1) : 1
      px[a] *= Math.exp(loading * f + gauss(r) * 0.004)
      out[s].push({ t: T0 + i * DAY, c: px[a] })
    })
  }
  return out
}

describe('turbulence', () => {
  it('flags a correlation break that no single asset shows', () => {
    const a = tb.analyse(market(700, 3, 690, 10))
    expect(a.state).toBe('turbulent')
    expect(a.value).toBeGreaterThan(2)
  })
  it('ordinary days are mostly calm, and about 10% read turbulent by construction', () => {
    const { R } = tb.alignReturns(market(900, 11))
    const st = tb.states(tb.turbulenceSeries(R)).filter(s => s?.state)
    const turbulent = st.filter(s => s.state === 'turbulent').length / st.length
    expect(st.filter(s => s.state === 'calm').length / st.length).toBeGreaterThan(0.6)
    expect(turbulent).toBeLessThan(0.2)
  })
  it('an ordinary day is about 1', () => {
    const { R } = tb.alignReturns(market(800, 5))
    const raw = tb.turbulenceSeries(R).filter(v => v != null)
    const mean = raw.reduce((a, b) => a + b, 0) / raw.length
    expect(mean).toBeGreaterThan(0.7)
    expect(mean).toBeLessThan(1.4)
  })
  it('never uses later days: appending days does not change an earlier label', () => {
    const full = market(800, 9)
    const cut = Object.fromEntries(Object.entries(full).map(([k, b]) => [k, b.slice(0, 650)]))
    const a = tb.states(tb.turbulenceSeries(tb.alignReturns(cut).R))
    const b = tb.states(tb.turbulenceSeries(tb.alignReturns(full).R))
    expect(b.slice(0, a.length)).toEqual(a)
  })
  it('needs every asset; too little history is null, not calm', () => {
    const m = market(700, 2); delete m.GLD
    expect(tb.analyse(m)).toBeNull()
    expect(tb.analyse(market(300, 2))).toBeNull()
  })
  it('describes itself in one citable line', () => {
    expect(tb.describe(tb.analyse(market(700, 3, 690, 10)))).toMatch(/turbulent .*percentile of the past year/)
  })
  it('getCurrentTurbulence never throws', async () => {
    tb._resetForTests()
    expect(await tb.getCurrentTurbulence({ fetchBars: async () => { throw new Error('down') } })).toBeNull()
  })
})

describe('recorded on picks and segmented', () => {
  it('computeStats splits resolved picks by turbulence at scan time; unstamped picks are excluded', () => {
    const bl = require('../lib/brain-learnings')
    let k = 0
    const p = (state, win) => ({ symbol: `T${k++}`, generatedAt: new Date(T0 + k * 9 * DAY).toISOString(), basePrice: 100, price7d: win ? 105 : 95, benchRet7d: 0, entered: true, turbulenceAtScan: state })
    const s = bl.computeStats([p('calm', true), p('calm', false), p('turbulent', false), { ...p(null, true), turbulenceAtScan: undefined }])
    expect(s.byTurbulence.calm.n).toBe(2)
    expect(s.byTurbulence.turbulent.n).toBe(1)
  })
  it('is an edge-report dimension', () => {
    expect(require('../lib/edge-report').DIMENSIONS.map(d => d[0])).toContain('turbulence')
  })
})
