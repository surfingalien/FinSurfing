'use strict'
// A validated strategy must also work at nearby settings; a lone winning
// setting among losers is luck, and is marked "fragile".

const mockExact = { fastPeriod: 20, slowPeriod: 50 }
jest.mock('../utils/backtest', () => {
  const actual = jest.requireActual('../utils/backtest')
  return {
    ...actual,
    // Signals carry a marker: 1 for the exact config, 2 for any other.
    generateSignals: (closes, strategy, params) => new Array(closes.length).fill(params.fastPeriod === mockExact.fastPeriod && params.slowPeriod === mockExact.slowPeriod ? 1 : 2),
    simulateWithSignals: (ts, closes, signals) => {
      const exact = signals[0] === 1
      const m = { totalTrades: 6, alpha: exact ? 5 : -3, sharpeRatio: exact ? 1.2 : -0.4, totalReturn: 1, buyHoldReturn: 1, maxDrawdown: 5 }
      return { metrics: m, equity: closes.map((c, i) => ({ value: 10000 * (1 + (exact ? 0.001 : -0.0005) * i + 0.0001 * Math.sin(i)) })) }
    },
  }
})

const lab = require('../lib/strategy-lab')

test('neighbours move one parameter ~20% each way and keep the required ordering', () => {
  const ns = lab.neighborParams('sma_crossover', { fastPeriod: 20, slowPeriod: 50 })
  expect(ns).toEqual(expect.arrayContaining([{ fastPeriod: 16, slowPeriod: 50 }, { fastPeriod: 24, slowPeriod: 50 }, { fastPeriod: 20, slowPeriod: 40 }, { fastPeriod: 20, slowPeriod: 60 }]))
  expect(lab.neighborParams('sma_crossover', { fastPeriod: 45, slowPeriod: 50 }).every(p => p.fastPeriod < p.slowPeriod)).toBe(true)
  expect(lab.neighborParams('nope', {})).toEqual([])
})

test('a config that only works at its exact settings is fragile, not validated', () => {
  const n = 300
  const ts = Array.from({ length: n }, (_, i) => 1_700_000_000 + i * 86400)
  const closes = Array.from({ length: n }, (_, i) => 100 + i * 0.1)
  const [p] = lab.evaluateProposals([{ strategy: 'sma_crossover', params: mockExact }], ts, closes)
  expect(p.robustness).toMatchObject({ tested: 4, passed: 0, plateau: false })
  expect(p.verdict).toBe('fragile')
})
