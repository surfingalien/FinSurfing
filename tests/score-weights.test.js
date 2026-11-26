'use strict'
const sw = require('../lib/score-weights')

function rng(seed) { let s = seed; return () => { s = (s * 16807) % 2147483647; return s / 2147483647 } }
const T0 = Date.UTC(2026, 0, 1), DAY = 86_400_000

/** n picks, each its own symbol; outcome = f(scores) + noise. */
function picks(n, seed, outcome) {
  const r = rng(seed), out = []
  for (let k = 0; k < n; k++) {
    const sc = { fundamentalScore: 40 + 50 * r(), technicalScore: 40 + 50 * r(), sentimentScore: 40 + 50 * r(), macroScore: 40 + 50 * r(), riskScore: 40 + 50 * r() }
    const ret = outcome(sc) + (r() - 0.5) * 20
    out.push({ symbol: `P${k}`, generatedAt: new Date(T0 + k * DAY).toISOString(), basePrice: 100, price30d: 100 + ret, benchRet30d: 0, entered: true, ...sc })
  }
  return out
}

describe('learned score weights', () => {
  it('the grid covers the simplex at 0.1', () => {
    const g = sw.simplexGrid()
    expect(g).toHaveLength(1001)
    expect(g.every(w => Math.abs(w.reduce((a, b) => a + b, 0) - 1) < 1e-9)).toBe(true)
  })
  it('not enough picks: stated weights, with the reason', () => {
    const r = sw.fit(picks(40, 1, () => 0))
    expect(r.adopted).toBe(false)
    expect(r.reason).toMatch(/needed/)
  })
  it('adopts weights that rank the newest picks better when the outcome follows one score', () => {
    const r = sw.fit(picks(300, 2, s => (s.technicalScore - 65) * 0.8))
    expect(r.adopted).toBe(true)
    expect(r.weights.technicalScore).toBeGreaterThanOrEqual(0.6)
    expect(r.validation.holdoutRho).toBeGreaterThan(r.validation.statedHoldoutRho)
  })
  it('on noise the stated weights stay (rarely adopted)', () => {
    let adopted = 0
    for (let s = 1; s <= 10; s++) if (sw.fit(picks(300, s * 7, () => 0)).adopted) adopted++
    expect(adopted).toBeLessThanOrEqual(1)
  })
  it('rankScoreFor is null unless adopted and every score is present', () => {
    const store = { adopted: true, weights: { fundamentalScore: 0, technicalScore: 1, sentimentScore: 0, macroScore: 0, riskScore: 0 } }
    expect(sw.rankScoreFor(store, { fundamentalScore: 1, technicalScore: 80, sentimentScore: 1, macroScore: 1, riskScore: 1 })).toBe(80)
    expect(sw.rankScoreFor(store, { technicalScore: 80 })).toBeNull()
    expect(sw.rankScoreFor({ adopted: false }, { technicalScore: 80 })).toBeNull()
  })
  it('a stock named repeatedly in one window counts once', () => {
    const p = picks(200, 3, () => 0).map(x => ({ ...x, symbol: 'SAME', generatedAt: new Date(T0).toISOString() }))
    expect(sw.rowsFrom(p).rows).toHaveLength(1)
  })
})
