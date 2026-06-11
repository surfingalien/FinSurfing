'use strict'
/**
 * Unit tests for utils/portfolio-backtest.js — date alignment, rebalancing
 * math, stop-loss/take-profit behaviour, benchmark, and metrics integration.
 * All series are synthetic and deterministic.
 */

const { runPortfolioBacktest, alignSeries, isPeriodStart } = require('../utils/portfolio-backtest')

// 40 trading days across two months: Jan 02..31 (22d) + Feb 01..25 (18d)
function makeDates(n = 40) {
  const out = []
  let d = new Date('2026-01-02')
  while (out.length < n) {
    const dow = d.getUTCDay()
    if (dow !== 0 && dow !== 6) out.push(d.toISOString().slice(0, 10))
    d = new Date(d.getTime() + 86400000)
  }
  return out
}
const DATES = makeDates(40)

const flatSeries  = (px)        => DATES.map(date => ({ date, close: px }))
const driftSeries = (start, dailyPct) =>
  DATES.map((date, i) => ({ date, close: +(start * (1 + dailyPct / 100) ** i).toFixed(6) }))

describe('alignSeries', () => {
  test('intersects to common dates and drops null closes', () => {
    const a = [{ date: '2026-01-02', close: 1 }, { date: '2026-01-05', close: 2 }, { date: '2026-01-06', close: null }]
    const b = [{ date: '2026-01-05', close: 9 }, { date: '2026-01-06', close: 8 }]
    const { dates, closes } = alignSeries({ A: a, B: b })
    expect(dates).toEqual(['2026-01-05'])
    expect(closes).toEqual({ A: [2], B: [9] })
  })
})

describe('isPeriodStart', () => {
  test('monthly fires on first trading day of a new month', () => {
    expect(isPeriodStart('monthly', '2026-01-30', '2026-02-02')).toBe(true)
    expect(isPeriodStart('monthly', '2026-02-02', '2026-02-03')).toBe(false)
  })
  test('quarterly fires only across quarter boundaries', () => {
    expect(isPeriodStart('quarterly', '2026-03-31', '2026-04-01')).toBe(true)
    expect(isPeriodStart('quarterly', '2026-01-30', '2026-02-02')).toBe(false)
  })
})

describe('runPortfolioBacktest — core accounting', () => {
  test('errors on insufficient overlap', () => {
    const r = runPortfolioBacktest({ seriesBySymbol: { A: flatSeries(100).slice(0, 10), B: flatSeries(50).slice(0, 10) } })
    expect(r.error).toMatch(/Insufficient/)
  })

  test('flat prices → equity stays at initial capital, zero benchmark gap', () => {
    const r = runPortfolioBacktest({
      seriesBySymbol: { A: flatSeries(100), B: flatSeries(50) },
      initialCapital: 10000, rebalance: 'none',
    })
    expect(r.finalValue).toBeCloseTo(10000, 2)
    expect(r.metrics.totalReturn).toBeCloseTo(0, 2)
    expect(r.benchmark.totalReturn).toBeCloseTo(0, 2)
    expect(r.activity.rebalances).toBe(0)
  })

  test('equal-weight default and explicit weights normalize', () => {
    const r = runPortfolioBacktest({ seriesBySymbol: { A: flatSeries(100), B: flatSeries(50) }, rebalance: 'none' })
    expect(r.weights).toEqual({ A: 0.5, B: 0.5 })
    const r2 = runPortfolioBacktest({
      seriesBySymbol: { A: flatSeries(100), B: flatSeries(50) },
      weights: { A: 3, B: 1 }, rebalance: 'none',
    })
    expect(r2.weights).toEqual({ A: 0.75, B: 0.25 })
  })

  test('no-rebalance equals weighted buy-and-hold exactly', () => {
    const r = runPortfolioBacktest({
      seriesBySymbol: { UP: driftSeries(100, 0.5), DN: driftSeries(100, -0.3) },
      initialCapital: 10000, rebalance: 'none',
    })
    expect(r.metrics.totalReturn).toBeCloseTo(r.benchmark.totalReturn, 2)
    expect(r.activity.trades).toBe(2)   // the two initial buys only
  })

  test('monthly rebalance trades back to target weights at the month turn', () => {
    const r = runPortfolioBacktest({
      seriesBySymbol: { UP: driftSeries(100, 1), DN: driftSeries(100, -1) },
      initialCapital: 10000, rebalance: 'monthly',
    })
    expect(r.activity.rebalances).toBe(1)              // one Jan→Feb boundary in the window
    const rebTrades = r.trades.filter(t => t.reason === 'rebalance')
    expect(rebTrades.length).toBeGreaterThanOrEqual(2) // sell winner, buy loser
    const sellUp = rebTrades.find(t => t.symbol === 'UP')
    const buyDn  = rebTrades.find(t => t.symbol === 'DN')
    expect(sellUp.side).toBe('sell')
    expect(buyDn.side).toBe('buy')
  })

  test('threshold rebalance fires when drift exceeds thresholdPct', () => {
    const r = runPortfolioBacktest({
      seriesBySymbol: { UP: driftSeries(100, 2), DN: driftSeries(100, -2) },
      rebalance: 'threshold', thresholdPct: 5,
    })
    expect(r.activity.rebalances).toBeGreaterThan(1)
    // Mean-reversion harvesting on these series: rebalanced portfolio ≠ benchmark
    expect(r.metrics.totalReturn).not.toBeCloseTo(r.benchmark.totalReturn, 1)
  })

  test('stop-loss sells the loser to cash and re-enters on next rebalance', () => {
    const r = runPortfolioBacktest({
      seriesBySymbol: { UP: flatSeries(100), CRASH: driftSeries(100, -2) },
      rebalance: 'monthly', stopLossPct: 10,
    })
    expect(r.activity.stopsTriggered).toBeGreaterThanOrEqual(1)
    const stop = r.trades.find(t => t.reason === 'stop-loss')
    expect(stop.symbol).toBe('CRASH')
    expect(stop.side).toBe('sell')
    // CRASH loses ~55% over the window; stopping at −10% must beat holding it
    expect(r.metrics.totalReturn).toBeGreaterThan(r.benchmark.totalReturn)
    // Re-entry: a rebalance buy of CRASH after the stop
    const stopIdx = r.trades.indexOf(stop)
    const reentry = r.trades.slice(stopIdx + 1).find(t => t.symbol === 'CRASH' && t.side === 'buy')
    expect(reentry).toBeTruthy()
    expect(reentry.reason).toBe('rebalance')
  })

  test('take-profit locks in the winner', () => {
    const r = runPortfolioBacktest({
      seriesBySymbol: { MOON: driftSeries(100, 2), FLAT: flatSeries(100) },
      rebalance: 'none', takeProfitPct: 15,
    })
    expect(r.activity.takesTriggered).toBe(1)
    const take = r.trades.find(t => t.reason === 'take-profit')
    expect(take.symbol).toBe('MOON')
    // Sold at ≥ +15% from entry
    expect(take.price).toBeGreaterThanOrEqual(100 * 1.15 - 0.01)
  })

  test('commissions reduce returns', () => {
    const base = { seriesBySymbol: { UP: driftSeries(100, 1), DN: driftSeries(100, -1) }, rebalance: 'monthly' }
    const free = runPortfolioBacktest(base)
    const paid = runPortfolioBacktest({ ...base, commissionPct: 0.5 })
    expect(paid.finalValue).toBeLessThan(free.finalValue)
  })

  test('metrics come from the shared lib and are present', () => {
    const r = runPortfolioBacktest({
      seriesBySymbol: { A: driftSeries(100, 0.4), B: driftSeries(50, 0.1) },
      rebalance: 'monthly',
    })
    for (const k of ['totalReturn', 'annualReturn', 'sharpeRatio', 'sortinoRatio', 'maxDrawdown', 'volatility', 'var95', 'cvar95']) {
      expect(r.metrics[k]).not.toBeUndefined()
      expect(r.benchmark[k]).not.toBeUndefined()
    }
    expect(r.equity).toHaveLength(40)
    expect(r.benchmarkEquity).toHaveLength(40)
    expect(r.startDate).toBe('2026-01-02')
  })
})
