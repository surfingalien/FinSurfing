'use strict'

/**
 * utils/backtest.js execution model: costs and fill timing.
 *
 * The engine used to fill at the close of the bar that generated the signal
 * (a price nobody can trade at — the signal does not exist until that close
 * prints) and charged nothing, while the EV gate charges 10-60bps per round
 * trip. These pin the corrected model.
 */

const { simulateWithSignals, simulate, costBpsForSymbol, DEFAULT_FILL } = require('../utils/backtest')

const DAY = 86400
const ts = n => Array.from({ length: n }, (_, i) => 1_700_000_000 + i * DAY)

describe('fill timing', () => {
  const closes  = [100, 100, 110, 120, 120]
  const signals = [0, 1, 0, -1, 0]

  test('defaults to next-bar fills', () => {
    expect(DEFAULT_FILL).toBe('next')
  })

  test('a signal on bar i fills on bar i+1, not at the close that produced it', () => {
    const { trades } = simulateWithSignals(ts(5), closes, signals, 10_000, { costBps: 0 })
    expect(trades[0]).toMatchObject({ type: 'buy', price: 110 })     // bar 2, not bar 1's 100
    expect(trades[1]).toMatchObject({ type: 'sell', price: 120 })    // bar 4
  })

  test('fills at the next open when opens are supplied', () => {
    const opens = [100, 100, 104, 118, 119]
    const { trades } = simulateWithSignals(ts(5), closes, signals, 10_000, { costBps: 0, opens })
    expect(trades[0].price).toBe(104)
    expect(trades[1].price).toBe(119)
  })

  test("legacy same-bar fills stay available as fill:'close'", () => {
    const { trades } = simulateWithSignals(ts(5), closes, signals, 10_000, { costBps: 0, fill: 'close' })
    expect(trades[0].price).toBe(100)
    expect(trades[1].price).toBe(120)
  })

  test('a signal on the final bar never fills', () => {
    const { trades } = simulateWithSignals(ts(3), [100, 101, 102], [0, 0, 1], 10_000, { costBps: 0 })
    expect(trades).toEqual([])
  })
})

describe('costs', () => {
  const closes  = [100, 100, 100, 110, 110]
  const signals = [1, 0, -1, 0, 0]

  test('half the round trip is charged on each side, and pnl is net', () => {
    const { trades, metrics } = simulateWithSignals(ts(5), closes, [0, 1, 0, -1, 0], 10_000, { costBps: 60, fill: 'close' })
    expect(trades[0].netPrice).toBeCloseTo(100.3, 6)
    expect(trades[1].netPrice).toBeCloseTo(110 * 0.997, 6)
    expect(trades[1].pnl).toBeCloseTo(((110 * 0.997) / 100.3 - 1) * 100, 1)
    expect(metrics.costBps).toBe(60)
    expect(metrics.costPaid).toBeGreaterThan(0)
  })

  test('costs lower the return; zero cost reproduces the frictionless number', () => {
    const free = simulateWithSignals(ts(5), closes, signals, 10_000, { costBps: 0, fill: 'close' }).metrics
    const paid = simulateWithSignals(ts(5), closes, signals, 10_000, { costBps: 60, fill: 'close' }).metrics
    expect(free.totalReturn).toBe(0)
    expect(paid.totalReturn).toBeLessThan(0)
  })

  test('high turnover pays for it: the same drift traded daily loses to holding once', () => {
    const n = 60
    const c = Array.from({ length: n }, (_, i) => 100 * (1 + 0.001 * i))
    const churn = Array.from({ length: n }, (_, i) => (i % 2 === 0 ? 1 : -1))
    const hold  = Array.from({ length: n }, (_, i) => (i === 0 ? 1 : 0))
    const a = simulateWithSignals(ts(n), c, churn, 10_000, { costBps: 60 }).metrics
    const b = simulateWithSignals(ts(n), c, hold,  10_000, { costBps: 60 }).metrics
    expect(a.totalReturn).toBeLessThan(b.totalReturn)
  })

  test('buy-and-hold pays the same round trip, so alpha compares like with like', () => {
    const m = simulateWithSignals(ts(5), closes, [0, 0, 0, 0, 0], 10_000, { costBps: 60 }).metrics
    expect(m.buyHoldReturn).toBeCloseTo(((110 * 0.997) / (100 * 1.003) - 1) * 100, 1)
  })

  test('an open position is liquidated at the end net of cost, in equity too', () => {
    const r = simulateWithSignals(ts(3), [100, 100, 100], [1, 0, 0], 10_000, { costBps: 100, fill: 'close' })
    expect(r.trades.at(-1)).toMatchObject({ open: true })
    expect(r.metrics.finalValue).toBeLessThan(10_000)
    expect(r.equity.at(-1).value).toBe(r.metrics.finalValue)
  })

  test('simulate() forwards the execution options', () => {
    const c = Array.from({ length: 80 }, (_, i) => 100 + 10 * Math.sin(i / 4))
    const free = simulate(ts(80), c, 'rsi_threshold', { period: 5, oversold: 40, overbought: 60 }, 10_000, { costBps: 0 }).metrics
    const paid = simulate(ts(80), c, 'rsi_threshold', { period: 5, oversold: 40, overbought: 60 }, 10_000, { costBps: 60 }).metrics
    expect(free.totalTrades).toBeGreaterThan(0)
    expect(paid.totalReturn).toBeLessThan(free.totalReturn)
  })
})

describe('costBpsForSymbol', () => {
  test('uses the EV gate table by asset class', () => {
    expect(costBpsForSymbol('BTC-USD')).toBe(60)
    expect(costBpsForSymbol('AAPL')).toBe(10)
    expect(costBpsForSymbol('SPY', 'etf')).toBe(8)
  })
})
