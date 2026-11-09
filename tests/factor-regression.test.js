'use strict'
const FR = require('../lib/factor-regression')
const { rng } = require('../lib/quant/linalg')

const CSV = `This file was created by using the 202609 CRSP database.

,Mkt-RF,SMB,HML,RMW,CMA,RF
20260928,   0.50,    0.10,   -0.20,    0.05,    0.00,    0.01
20260929,  -0.30,    0.00,    0.10,   -0.05,    0.02,    0.01

  Annual Factors: January-December
,Mkt-RF,SMB,HML,RMW,CMA,RF
  2025,   10.0,   1.0,   2.0,   3.0,   4.0,   5.0
`

function synthetic(n = 750, { alphaPct = 0.04, betas = [1.2, 0.5, -0.3, 0, 0, 0.2] } = {}) {
  const g = rng(7), factors = new Map(), bars = []
  let px = 100
  const start = Date.UTC(2023, 0, 2)
  bars.push({ t: start - 86400e3, c: px })
  for (let i = 0; i < n; i++) {
    const d = new Date(start + i * 86400e3).toISOString().slice(0, 10)
    const f = { 'Mkt-RF': g.normal(), SMB: 0.5 * g.normal(), HML: 0.5 * g.normal(), RMW: 0.4 * g.normal(), CMA: 0.4 * g.normal(), Mom: 0.6 * g.normal(), RF: 0.01 }
    factors.set(d, f)
    const r = alphaPct + FR.FACTORS.reduce((a, k, j) => a + betas[j] * f[k], 0) + 0.3 * g.normal() + f.RF
    px *= 1 + r / 100
    bars.push({ t: start + i * 86400e3, c: px })
  }
  return { factors, bars }
}

describe('Fama–French factor regression', () => {
  test('parses only the daily table of a Ken French file', () => {
    const m = FR.parseFrenchCsv(CSV)
    expect([...m.keys()]).toEqual(['2026-09-28', '2026-09-29'])
    expect(m.get('2026-09-28')).toMatchObject({ 'Mkt-RF': 0.5, HML: -0.2, RF: 0.01 })
  })

  test('recovers planted betas and alpha; alpha is annualised with a Newey–West t', () => {
    const { factors, bars } = synthetic()
    const r = FR.regress(bars, factors, { years: 3 })
    const b = Object.fromEntries(r.betas.map(x => [x.factor, x.beta]))
    // Tolerances ≈ 3 standard errors at this noise (0.3%/day over ~750 days).
    expect(Math.abs(b['Mkt-RF'] - 1.2)).toBeLessThan(0.05)
    expect(Math.abs(b.SMB - 0.5)).toBeLessThan(0.08)
    expect(Math.abs(b.HML + 0.3)).toBeLessThan(0.08)
    expect(Math.abs(b.RMW)).toBeLessThan(0.08)
    expect(Math.abs(r.alphaAnnualPct - 0.04 * 252)).toBeLessThan(9)
    expect(r.alphaT).toBeGreaterThan(2)
    expect(r.lag).toBe(Math.floor(4 * (r.n / 100) ** (2 / 9)))
    expect(r.r2).toBeGreaterThan(0.5)
    expect(FR.describe(r, 'TEST')).toMatch(/market beta 1\.2/)
  })

  test('Newey–West widens the errors when residuals are autocorrelated', () => {
    const g = rng(3), n = 600, X = [], resid = []
    let e = 0, x = 0
    for (let i = 0; i < n; i++) { x = 0.9 * x + g.normal(); e = 0.9 * e + g.normal(); X.push([1, x]); resid.push(e) }
    const V = FR.neweyWest(X, resid, 10)
    const V0 = FR.neweyWest(X, resid, 0)
    expect(V[1][1]).toBeGreaterThan(V0[1][1] * 2)
  })

  test('too little overlap is refused, not regressed', () => {
    const { factors, bars } = synthetic(60)
    expect(() => FR.regress(bars, factors)).toThrow(/only \d+ days overlap/)
    expect(() => FR.regress(bars, new Map())).toThrow(/no factor data/)
  })
})
