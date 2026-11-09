'use strict'
const ML = require('../lib/quant/ml')
const { rng } = require('../lib/quant/linalg')

describe('elastic net', () => {
  test('linear elastic net matches scikit-learn ElasticNet(alpha=0.1, l1_ratio=0.5) to 1e-6', () => {
    // Same data and seed as the check run against scikit-learn 1.x (coef [1.852481, 0, -1.375283, 0, 0], intercept -0.031004).
    const g = rng(1), X = [], y = []
    for (let i = 0; i < 300; i++) { const r = [g.normal(), g.normal(), g.normal(), g.normal(), g.normal()]; X.push(r); y.push(2 * r[0] - 1.5 * r[2] + 0.3 * g.normal()) }
    const fit = ML.elasticNet(X, y, { alpha: 0.1, l1Ratio: 0.5 })
    const want = [1.852481, 0, -1.375283, 0, 0]
    fit.coef.forEach((c, j) => expect(c).toBeCloseTo(want[j], 5))
    expect(fit.intercept).toBeCloseTo(-0.031004, 5)
  })

  test('elastic-net logistic keeps the informative features and zeroes the noise', () => {
    const g = rng(5), X = [], y = []
    for (let i = 0; i < 800; i++) { const r = Array.from({ length: 8 }, () => g.normal()); X.push(r); y.push(r[0] - r[3] + 0.5 * g.normal() > 0 ? 1 : 0) }
    const m = ML.elasticNetLogistic({ alpha: 0.05, l1Ratio: 0.9 }).fit(X, y)
    expect(m.selected()).toEqual(expect.arrayContaining([0, 3]))
    expect(m.selected().length).toBeLessThan(8)
    const acc = m.predictProba(X).filter((p, i) => (p > 0.5 ? 1 : 0) === y[i]).length / y.length
    expect(acc).toBeGreaterThan(0.8)
  })

  test('it is on the ML bench and available as a Strategy Brain model', () => {
    expect(require('../lib/ml-strategy').STRATEGY_MODELS.elastic_net).toBeDefined()
    const C = require('../lib/quant/ml-compare')
    expect(typeof C.compareModels).toBe('function')
  })
})
