'use strict'
/**
 * Unit tests for lib/portfolio-metrics.js — extracted from routes/analytics.js
 * and extended with volatility, VaR/CVaR, and weighted portfolio series.
 */

const {
  dailyReturns, sharpeRatio, sortinoRatio, annualizedVolatility,
  maxDrawdown, annualizedReturn, valueAtRisk, conditionalVaR,
  pearson, beta, weightedReturnSeries, equityFromReturns,
  TRADING_DAYS, RISK_FREE_ANNUAL,
} = require('../lib/portfolio-metrics')

// 30 deterministic alternating returns: +1%, -0.5%, repeated
const altReturns = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.01 : -0.005))

describe('dailyReturns', () => {
  test('computes simple returns', () => {
    expect(dailyReturns([100, 110, 99])).toEqual([0.1, -0.1])
  })
  test('empty for short input', () => {
    expect(dailyReturns([100])).toEqual([])
  })
})

describe('sharpeRatio / sortinoRatio', () => {
  test('null when fewer than 20 observations', () => {
    expect(sharpeRatio(altReturns.slice(0, 19))).toBeNull()
    expect(sortinoRatio(altReturns.slice(0, 19))).toBeNull()
  })

  test('sharpe matches hand-computed value', () => {
    const m  = altReturns.reduce((s, v) => s + v, 0) / altReturns.length
    const sd = Math.sqrt(altReturns.reduce((s, v) => s + (v - m) ** 2, 0) / altReturns.length)
    const expected = (m * TRADING_DAYS - RISK_FREE_ANNUAL) / (sd * Math.sqrt(TRADING_DAYS))
    expect(sharpeRatio(altReturns)).toBeCloseTo(expected, 10)
  })

  test('sortino null when there are no down days', () => {
    expect(sortinoRatio(new Array(30).fill(0.01))).toBeNull()
  })

  test('sortino penalizes only downside', () => {
    expect(sortinoRatio(altReturns)).toBeGreaterThan(sharpeRatio(altReturns))
  })
})

describe('annualizedVolatility', () => {
  test('zero for constant returns', () => {
    expect(annualizedVolatility(new Array(30).fill(0.01))).toBeCloseTo(0, 10)
  })
  test('scales daily stddev by sqrt(252)', () => {
    const m  = altReturns.reduce((s, v) => s + v, 0) / altReturns.length
    const sd = Math.sqrt(altReturns.reduce((s, v) => s + (v - m) ** 2, 0) / altReturns.length)
    expect(annualizedVolatility(altReturns)).toBeCloseTo(sd * Math.sqrt(252), 10)
  })
})

describe('maxDrawdown / annualizedReturn', () => {
  test('drawdown finds the worst peak-to-trough', () => {
    // peak 120 → trough 60 = -50%
    expect(maxDrawdown([100, 120, 90, 60, 110])).toBeCloseTo(-0.5, 10)
  })
  test('zero drawdown on a monotonic rise', () => {
    expect(maxDrawdown([1, 2, 3, 4])).toBe(0)
  })
  test('annualizedReturn compounds a known doubling', () => {
    // doubles over exactly 252 closes ⇒ slightly over one year of gaps
    const series = [100, ...new Array(251).fill(0).map((_, i) => 100 + (100 * (i + 1)) / 251)]
    expect(series[series.length - 1]).toBeCloseTo(200, 6)
    const years = series.length / 252
    expect(annualizedReturn(series)).toBeCloseTo(2 ** (1 / years) - 1, 10)
  })
})

describe('valueAtRisk / conditionalVaR', () => {
  // 100 returns: -5%, -4%, -3%, -2%, -1%, then 95 × +0.5%
  const tailReturns = [-0.05, -0.04, -0.03, -0.02, -0.01, ...new Array(95).fill(0.005)]

  test('VaR(95) is the 5th-percentile return', () => {
    expect(valueAtRisk(tailReturns, 0.95)).toBeCloseTo(-0.01, 10)   // index 5 of sorted 100
  })
  test('CVaR(95) is the mean of the tail at/below VaR', () => {
    expect(conditionalVaR(tailReturns, 0.95)).toBeCloseTo((-0.05 - 0.04 - 0.03 - 0.02 - 0.01) / 5, 10)
  })
  test('null on short series', () => {
    expect(valueAtRisk([0.01, -0.01])).toBeNull()
    expect(conditionalVaR([0.01, -0.01])).toBeNull()
  })
})

describe('pearson / beta', () => {
  const mkt = [0.01, -0.02, 0.015, 0.005, -0.01, 0.02, -0.005, 0.01]

  test('perfectly correlated scaled series: r=1, beta=scale', () => {
    const stock = mkt.map(r => r * 1.5)
    expect(pearson(stock, mkt)).toBeCloseTo(1, 10)
    expect(beta(stock, mkt)).toBeCloseTo(1.5, 10)
  })
  test('inverse series: r=-1, beta=-1', () => {
    const inv = mkt.map(r => -r)
    expect(pearson(inv, mkt)).toBeCloseTo(-1, 10)
    expect(beta(inv, mkt)).toBeCloseTo(-1, 10)
  })
  test('null under 5 observations', () => {
    expect(pearson([0.01], [0.01])).toBeNull()
    expect(beta([0.01], [0.01])).toBeNull()
  })
})

describe('weightedReturnSeries', () => {
  const a = [100, 110, 121]      // +10%, +10%
  const b = [100, 90, 99]        // -10%, +10%

  test('equal weight when weights omitted', () => {
    expect(weightedReturnSeries([a, b])).toEqual([0, 0.1])
  })
  test('explicit weights are normalized', () => {
    // 3:1 → 0.75*10% + 0.25*(-10%) = 5%
    const r = weightedReturnSeries([a, b], [3, 1])
    expect(r[0]).toBeCloseTo(0.05, 10)
    expect(r[1]).toBeCloseTo(0.1, 10)
  })
  test('right-aligns to the shortest series', () => {
    const long = [50, 100, 110, 121]   // extra leading close ignored
    expect(weightedReturnSeries([long, b]).length).toBe(2)
  })
  test('all-zero weights fall back to equal weighting', () => {
    expect(weightedReturnSeries([a, b], [0, 0])).toEqual([0, 0.1])
  })
  test('empty input → empty output', () => {
    expect(weightedReturnSeries([])).toEqual([])
    expect(weightedReturnSeries([[100]])).toEqual([])
  })
})

describe('equityFromReturns', () => {
  test('reconstructs compounding curve', () => {
    expect(equityFromReturns([0.1, -0.5])).toEqual([1, 1.1, 0.55])
  })
  test('round-trips with dailyReturns', () => {
    const eq = equityFromReturns(altReturns, 100)
    const rt = dailyReturns(eq)
    rt.forEach((r, i) => expect(r).toBeCloseTo(altReturns[i], 10))
  })
})
