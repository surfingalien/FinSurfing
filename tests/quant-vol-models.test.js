'use strict'
const VM = require('../lib/quant/vol-models')
const L = require('../lib/quant/linalg')

function sim(model, n, seed, p) {
  const g = L.rng(seed), r = []
  let h = p.h0 ?? 1e-4
  for (let t = 0; t < n; t++) {
    const z = g.normal(), e = Math.sqrt(h) * z
    r.push(e)
    if (model === 'garch') h = p.omega + p.alpha * e * e + p.beta * h
    else if (model === 'gjr') h = p.omega + (p.alpha + (e < 0 ? p.gamma : 0)) * e * e + p.beta * h
    else if (model === 'egarch') h = Math.exp(p.omega + p.alpha * (Math.abs(z) - Math.sqrt(2 / Math.PI)) + p.gamma * z + p.beta * Math.log(h))
    else if (model === 'aparch') { const sd = p.omega + p.alpha * Math.pow(Math.abs(e) - p.gamma * e, p.delta) + p.beta * Math.pow(h, p.delta / 2); h = Math.pow(sd, 2 / p.delta) }
  }
  return r
}

const GJR = { omega: 2e-6, alpha: 0.03, gamma: 0.12, beta: 0.88 }
const EGARCH = { omega: -0.3, alpha: 0.12, gamma: -0.1, beta: 0.966 }
const APARCH = { omega: 1e-4, alpha: 0.07, gamma: 0.5, beta: 0.9, delta: 1.3 }

describe('vol-models — parameter recovery by maximum likelihood', () => {
  test('GJR-GARCH recovers alpha, gamma, beta', () => {
    const f = VM.fit('gjr', sim('gjr', 3000, 11, GJR))
    expect(f.params.alpha).toBeCloseTo(GJR.alpha, 1)
    expect(Math.abs(f.params.gamma - GJR.gamma)).toBeLessThan(0.04)
    expect(Math.abs(f.params.beta - GJR.beta)).toBeLessThan(0.03)
    expect(f.persistence).toBeLessThan(1)
  })
  test('EGARCH recovers the asymmetry (gamma < 0) and beta', () => {
    const f = VM.fit('egarch', sim('egarch', 3000, 11, EGARCH))
    expect(f.params.gamma).toBeLessThan(0)
    expect(Math.abs(f.params.gamma - EGARCH.gamma)).toBeLessThan(0.04)
    expect(Math.abs(f.params.beta - EGARCH.beta)).toBeLessThan(0.02)
  })
  test('APARCH recovers gamma and a power delta near the truth', () => {
    const f = VM.fit('aparch', sim('aparch', 3000, 11, APARCH))
    expect(Math.abs(f.params.gamma - APARCH.gamma)).toBeLessThan(0.15)
    expect(Math.abs(f.params.delta - APARCH.delta)).toBeLessThan(0.4)
    expect(f.persistence).toBeLessThan(1)
  })
  test('on asymmetric data the asymmetric models fit better than GARCH by AIC', () => {
    const r = sim('gjr', 2500, 21, GJR)
    const garch = VM.fit('garch', r), gjr = VM.fit('gjr', r)
    expect(gjr.aic).toBeLessThan(garch.aic)
    expect(gjr.logLik).toBeGreaterThan(garch.logLik)
  })
  test('nested: GARCH log-likelihood ≥ ARCH (GARCH contains ARCH)', () => {
    const r = sim('garch', 1500, 5, { omega: 2e-6, alpha: 0.08, beta: 0.9 })
    expect(VM.fit('garch', r).logLik).toBeGreaterThanOrEqual(VM.fit('arch', r).logLik - 1e-6)
  })
  test('rejects short series and unknown models', () => {
    expect(() => VM.fit('garch', [0.01, -0.01])).toThrow(/at least 100/)
    expect(() => VM.fit('figarch', new Array(200).fill(0.01))).toThrow(/unknown model/)
  })
})

describe('vol-models — filtering and forecasts', () => {
  test('filter never looks ahead: h[t] is unchanged when later returns change', () => {
    const r = sim('gjr', 400, 3, GJR), p = { ...GJR }
    for (const m of ['garch', 'gjr', 'arch']) {
      const params = m === 'arch' ? { omega: 2e-5, alpha: 0.3 } : m === 'garch' ? { omega: 2e-6, alpha: 0.08, beta: 0.9 } : p
      const a = VM.filter(m, params, r), r2 = r.slice(); r2[300] = 0.2
      const b = VM.filter(m, params, r2)
      for (let t = 0; t <= 300; t++) expect(b[t]).toBe(a[t])
      expect(b[301]).not.toBe(a[301])
    }
  })
  test('GARCH forecast path converges to the long-run variance', () => {
    const f = VM.fit('garch', sim('garch', 2000, 9, { omega: 2e-6, alpha: 0.08, beta: 0.9 }))
    const path = VM.forecastPath(f, 2000)
    expect(path[path.length - 1]).toBeCloseTo(VM.longRunVar(f), 8)
  })
  test('EWMA forecast is flat; Monte Carlo forecasts are seeded (repeatable)', () => {
    const r = sim('egarch', 800, 4, EGARCH)
    const ew = VM.fit('ewma', r), p = VM.forecastPath(ew, 5)
    expect(new Set(p).size).toBe(1)
    const f = VM.fit('egarch', r)
    expect(VM.forecastPath(f, 10)).toEqual(VM.forecastPath(f, 10))
  })
  test('summarize gives annualised vols and a leverage flag', () => {
    const s = VM.summarize(VM.fit('gjr', sim('gjr', 2000, 2, GJR)))
    expect(s.forecastVol21).toBeGreaterThan(0.05)
    expect(s.forecastVol21).toBeLessThan(1)
    expect(s.forecastPath).toHaveLength(21)
    expect(s.leverage).toBe(true)
  })
  test('fitAll fits all six models', () => {
    const out = VM.fitAll(sim('gjr', 800, 8, GJR))
    expect(Object.keys(out.models).sort()).toEqual([...VM.MODELS].sort())
    expect(out.errors).toEqual({})
  })
})

describe('vol-models — out-of-sample contest', () => {
  test('Diebold–Mariano t: a clearly lower loss series is significant, identical is zero', () => {
    const g = L.rng(1), d = Array.from({ length: 300 }, () => -0.2 + 0.5 * g.normal())
    expect(VM.dmTest(d).t).toBeLessThan(-3)
    expect(VM.dmTest(new Array(50).fill(0)).t).toBe(0)
  })
  test('compareModels ranks every model, never prefers ARCH(1) on persistent data, and states a verdict', async () => {
    const r = sim('gjr', 1100, 6, GJR)
    const c = await VM.compareModels(r, { refitEvery: 63, yieldFn: async () => {} })
    expect(c.ranking).toHaveLength(6)
    expect(c.reference).toBe('garch')
    const arch = c.ranking.find(x => x.model === 'arch')
    expect(arch.vsGarch.worse).toBe(true)               // ARCH(1) cannot carry persistent volatility
    expect(typeof c.verdict).toBe('string')
    expect(c.testDays).toBe(1100 - Math.floor(1100 * 0.7))
  })
  test('compareModels refuses too little data', async () => {
    await expect(VM.compareModels(new Array(200).fill(0.01))).rejects.toThrow(/360 returns/)
  })
})
