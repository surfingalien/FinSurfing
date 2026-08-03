'use strict'
/**
 * Unit tests for lib/paper-broker.js — the bounded write surface.
 *
 * These are the safety boundary tests: every limit that stops the AI from
 * doing something it shouldn't is exercised here, on the PURE functions
 * (no disk, no env mutation beyond the kill switch check).
 */

const {
  emptyPortfolio, equity, positionsView, tradesToday, evaluateOrder, applyOrder,
  performance, isEnabled, CEILINGS,
} = require('../lib/paper-broker')

const flat = () => emptyPortfolio(10_000)

describe('equity', () => {
  test('cash only', () => {
    expect(equity(flat())).toBe(10_000)
  })

  test('marks positions to the price map', () => {
    const p = { ...flat(), cash: 5000, positions: { AAPL: { shares: 10, avgCost: 100 } } }
    expect(equity(p, { AAPL: 150 })).toBe(6500)
  })

  test('falls back to cost when a price is missing (never NaN)', () => {
    const p = { ...flat(), cash: 5000, positions: { AAPL: { shares: 10, avgCost: 100 } } }
    expect(equity(p, {})).toBe(6000)
  })
})

describe('evaluateOrder — structural bans', () => {
  test('NO SHORTING: cannot sell a symbol that is not held', () => {
    const r = evaluateOrder({ portfolio: flat(), symbol: 'AAPL', side: 'sell', price: 100 })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/no position/i)
  })

  test('NO LEVERAGE: buy size is capped by available cash', () => {
    // maxPositionPct would allow more, but there is only $500 cash
    const p = { ...flat(), cash: 500, positions: {} }
    const r = evaluateOrder({ portfolio: p, symbol: 'AAPL', side: 'buy', price: 100 })
    expect(r.ok).toBe(true)
    expect(r.value).toBeLessThanOrEqual(500)
    expect(r.shares).toBeLessThanOrEqual(5)
  })

  test('sell liquidates exactly the held quantity, never more', () => {
    const p = { ...flat(), cash: 0, positions: { AAPL: { shares: 7, avgCost: 90 } } }
    const r = evaluateOrder({ portfolio: p, symbol: 'AAPL', side: 'sell', price: 100 })
    expect(r.ok).toBe(true)
    expect(r.shares).toBe(7)
  })
})

describe('evaluateOrder — hard limits', () => {
  const lim = { maxPositionPct: 20, maxOpenPositions: 3, maxTradesPerDay: 2, minOrderValue: 100 }

  test('position size is capped at maxPositionPct of equity', () => {
    const r = evaluateOrder({ portfolio: flat(), symbol: 'AAPL', side: 'buy', price: 100, lim })
    expect(r.ok).toBe(true)
    expect(r.value).toBeLessThanOrEqual(10_000 * 0.20 + 0.01)  // $2,000 cap
  })

  test('rejects a buy when the position is already at its cap', () => {
    const p = { ...flat(), cash: 8000, positions: { AAPL: { shares: 20, avgCost: 100 } } }
    const r = evaluateOrder({ portfolio: p, symbol: 'AAPL', side: 'buy', price: 100, lim })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/max 20%/i)
  })

  test('rejects a NEW position past maxOpenPositions but still allows adding to an existing one', () => {
    const positions = { A: { shares: 1, avgCost: 10 }, B: { shares: 1, avgCost: 10 }, C: { shares: 1, avgCost: 10 } }
    const p = { ...flat(), cash: 9000, positions }
    expect(evaluateOrder({ portfolio: p, symbol: 'D', side: 'buy', price: 100, lim }).ok).toBe(false)
    expect(evaluateOrder({ portfolio: p, symbol: 'A', side: 'buy', price: 10, lim }).ok).toBe(true)
  })

  test('rejects once the daily trade cap is hit', () => {
    const today = new Date('2026-05-05T15:00:00.000Z')
    const trades = [
      { at: '2026-05-05T10:00:00.000Z', status: 'filled' },
      { at: '2026-05-05T11:00:00.000Z', status: 'filled' },
    ]
    const r = evaluateOrder({ portfolio: flat(), trades, symbol: 'AAPL', side: 'buy', price: 100, now: today, lim })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/daily trade limit/i)
  })

  test('yesterday trades do not count against today cap', () => {
    const today = new Date('2026-05-05T15:00:00.000Z')
    const trades = [
      { at: '2026-05-04T10:00:00.000Z', status: 'filled' },
      { at: '2026-05-04T11:00:00.000Z', status: 'filled' },
    ]
    expect(tradesToday(trades, today)).toBe(0)
    expect(evaluateOrder({ portfolio: flat(), trades, symbol: 'AAPL', side: 'buy', price: 100, now: today, lim }).ok).toBe(true)
  })

  test('rejected orders (not fills) never consume the daily budget', () => {
    const today = new Date('2026-05-05T15:00:00.000Z')
    const trades = [
      { at: '2026-05-05T10:00:00.000Z', status: 'rejected' },
      { at: '2026-05-05T11:00:00.000Z', status: 'rejected' },
    ]
    expect(tradesToday(trades, today)).toBe(0)
  })

  test('rejects dust orders below the minimum', () => {
    const p = { ...flat(), cash: 50, positions: {} }
    const r = evaluateOrder({ portfolio: p, symbol: 'AAPL', side: 'buy', price: 10, lim })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/minimum|insufficient/i)
  })

  test('rejects invalid inputs rather than guessing', () => {
    expect(evaluateOrder({ portfolio: flat(), symbol: '', side: 'buy', price: 10 }).ok).toBe(false)
    expect(evaluateOrder({ portfolio: flat(), symbol: 'A', side: 'hold', price: 10 }).ok).toBe(false)
    expect(evaluateOrder({ portfolio: flat(), symbol: 'A', side: 'buy', price: 0 }).ok).toBe(false)
    expect(evaluateOrder({ portfolio: flat(), symbol: 'A', side: 'buy', price: -5 }).ok).toBe(false)
  })
})

describe('applyOrder', () => {
  test('buy reduces cash and opens the position', () => {
    const { portfolio, trade } = applyOrder(flat(), { symbol: 'AAPL', side: 'buy', price: 100, shares: 10 })
    expect(portfolio.cash).toBe(9000)
    expect(portfolio.positions.AAPL.shares).toBe(10)
    expect(trade.status).toBe('filled')
  })

  test('adding to a position blends the average cost', () => {
    let p = applyOrder(flat(), { symbol: 'AAPL', side: 'buy', price: 100, shares: 10 }).portfolio
    p = applyOrder(p, { symbol: 'AAPL', side: 'buy', price: 200, shares: 10 }).portfolio
    expect(p.positions.AAPL.shares).toBe(20)
    expect(p.positions.AAPL.avgCost).toBeCloseTo(150, 6)
  })

  test('full sell closes the position and books realized P&L', () => {
    const bought = applyOrder(flat(), { symbol: 'AAPL', side: 'buy', price: 100, shares: 10 }).portfolio
    const { portfolio, trade } = applyOrder(bought, { symbol: 'AAPL', side: 'sell', price: 130, shares: 10 })
    expect(portfolio.positions.AAPL).toBeUndefined()
    expect(trade.realized).toBeCloseTo(300, 6)
    expect(portfolio.cash).toBeCloseTo(10_300, 6)
  })

  test('round-trip at the same price is cash-neutral', () => {
    const bought = applyOrder(flat(), { symbol: 'AAPL', side: 'buy', price: 100, shares: 10 }).portfolio
    const { portfolio } = applyOrder(bought, { symbol: 'AAPL', side: 'sell', price: 100, shares: 10 })
    expect(portfolio.cash).toBeCloseTo(10_000, 6)
  })
})

describe('performance', () => {
  test('summarizes equity, realized P&L and win rate', () => {
    const p = { ...flat(), cash: 10_300, positions: {}, startingCash: 10_000 }
    const trades = [
      { status: 'filled', side: 'buy',  realized: null },
      { status: 'filled', side: 'sell', realized: 300 },
      { status: 'filled', side: 'sell', realized: -100 },
      { status: 'rejected' },
    ]
    const perf = performance(p, trades)
    expect(perf.equity).toBe(10_300)
    expect(perf.totalReturnPct).toBe(3)
    expect(perf.realizedPnl).toBe(200)
    expect(perf.closedTrades).toBe(2)
    expect(perf.winRate).toBe(0.5)
    expect(perf.rejectedOrders).toBe(1)
  })
})

describe('kill switch', () => {
  const prev = process.env.PAPER_TRADING_ENABLED
  afterEach(() => {
    if (prev === undefined) delete process.env.PAPER_TRADING_ENABLED
    else process.env.PAPER_TRADING_ENABLED = prev
  })

  test('disabled by default (absent env)', () => {
    delete process.env.PAPER_TRADING_ENABLED
    expect(isEnabled()).toBe(false)
  })

  test('only the exact string "true" enables it', () => {
    for (const v of ['false', '1', 'TRUE', 'yes', '']) {
      process.env.PAPER_TRADING_ENABLED = v
      expect(isEnabled()).toBe(false)
    }
    process.env.PAPER_TRADING_ENABLED = 'true'
    expect(isEnabled()).toBe(true)
  })
})

describe('limit ceilings', () => {
  const keys = ['PAPER_MAX_POSITION_PCT', 'PAPER_MAX_OPEN_POSITIONS', 'PAPER_MAX_TRADES_PER_DAY']
  const saved = {}
  beforeEach(() => keys.forEach(k => { saved[k] = process.env[k] }))
  afterEach(() => keys.forEach(k => {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }))

  test('env can TIGHTEN a limit', () => {
    process.env.PAPER_MAX_POSITION_PCT = '5'
    expect(require('../lib/paper-broker').limits().maxPositionPct).toBe(5)
  })

  test('env can NEVER loosen a limit past the hard ceiling', () => {
    process.env.PAPER_MAX_POSITION_PCT   = '90'
    process.env.PAPER_MAX_TRADES_PER_DAY = '9999'
    const l = require('../lib/paper-broker').limits()
    expect(l.maxPositionPct).toBe(CEILINGS.maxPositionPct)
    expect(l.maxTradesPerDay).toBe(CEILINGS.maxTradesPerDay)
  })

  test('garbage env values fall back to the ceiling', () => {
    process.env.PAPER_MAX_POSITION_PCT = 'abc'
    expect(require('../lib/paper-broker').limits().maxPositionPct).toBe(CEILINGS.maxPositionPct)
    process.env.PAPER_MAX_POSITION_PCT = '-5'
    expect(require('../lib/paper-broker').limits().maxPositionPct).toBe(CEILINGS.maxPositionPct)
  })
})

describe('positionsView', () => {
  test('reports unrealized P&L and flags unpriced positions', () => {
    const p = { ...flat(), positions: { AAPL: { shares: 10, avgCost: 100 }, XYZ: { shares: 5, avgCost: 20 } } }
    const view = positionsView(p, { AAPL: 120 })
    const aapl = view.find(v => v.symbol === 'AAPL')
    const xyz  = view.find(v => v.symbol === 'XYZ')
    expect(aapl.unrealized).toBe(200)
    expect(aapl.unrealizedPct).toBe(20)
    expect(aapl.priced).toBe(true)
    expect(xyz.priced).toBe(false)
    expect(xyz.unrealized).toBe(0)   // held at cost, not invented
  })
})
