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
// A tight 4% stop: the stop-out cap (1% / 4% = 25%) sits above the 20%
// position cap, so these limit tests still exercise the limit they name.
const br = px => ({ stop: px * 0.96, t1: px * 1.05, t2: px * 1.1 })

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
    const r = evaluateOrder({ portfolio: p, symbol: 'AAPL', side: 'buy', price: 100, bracket: br(100) })
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
    const r = evaluateOrder({ portfolio: flat(), symbol: 'AAPL', side: 'buy', price: 100, bracket: br(100), lim })
    expect(r.ok).toBe(true)
    expect(r.value).toBeLessThanOrEqual(10_000 * 0.20 + 0.01)  // $2,000 cap
  })

  test('rejects a buy when the position is already at its cap', () => {
    const p = { ...flat(), cash: 8000, positions: { AAPL: { shares: 20, avgCost: 100 } } }
    const r = evaluateOrder({ portfolio: p, symbol: 'AAPL', side: 'buy', price: 100, bracket: br(100), lim })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/max position cap/i)
  })

  test('rejects a NEW position past maxOpenPositions but still allows adding to an existing one', () => {
    const positions = { A: { shares: 1, avgCost: 10 }, B: { shares: 1, avgCost: 10 }, C: { shares: 1, avgCost: 10 } }
    const p = { ...flat(), cash: 9000, positions }
    expect(evaluateOrder({ portfolio: p, symbol: 'D', side: 'buy', price: 100, bracket: br(100), lim }).ok).toBe(false)
    expect(evaluateOrder({ portfolio: p, symbol: 'A', side: 'buy', price: 10, bracket: br(10), lim }).ok).toBe(true)
  })

  test('rejects once the daily trade cap is hit', () => {
    const today = new Date('2026-05-05T15:00:00.000Z')
    const trades = [
      { at: '2026-05-05T10:00:00.000Z', status: 'filled' },
      { at: '2026-05-05T11:00:00.000Z', status: 'filled' },
    ]
    const r = evaluateOrder({ portfolio: flat(), trades, symbol: 'AAPL', side: 'buy', price: 100, bracket: br(100), now: today, lim })
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
    expect(evaluateOrder({ portfolio: flat(), trades, symbol: 'AAPL', side: 'buy', price: 100, bracket: br(100), now: today, lim }).ok).toBe(true)
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
    const r = evaluateOrder({ portfolio: p, symbol: 'AAPL', side: 'buy', price: 10, bracket: br(10), lim })
    expect(r.ok).toBe(false)
    expect(r.reason).toMatch(/minimum|insufficient/i)
  })

  test('rejects invalid inputs rather than guessing', () => {
    expect(evaluateOrder({ portfolio: flat(), symbol: '', side: 'buy', price: 10, bracket: br(10) }).ok).toBe(false)
    expect(evaluateOrder({ portfolio: flat(), symbol: 'A', side: 'hold', price: 10 }).ok).toBe(false)
    expect(evaluateOrder({ portfolio: flat(), symbol: 'A', side: 'buy', price: 0, bracket: br(0) }).ok).toBe(false)
    expect(evaluateOrder({ portfolio: flat(), symbol: 'A', side: 'buy', price: -5 }).ok).toBe(false)
  })
})

describe('applyOrder', () => {
  test('buy reduces cash and opens the position', () => {
    const { portfolio, trade } = applyOrder(flat(), { symbol: 'AAPL', side: 'buy', price: 100, bracket: br(100), shares: 10 })
    expect(portfolio.cash).toBe(9000)
    expect(portfolio.positions.AAPL.shares).toBe(10)
    expect(trade.status).toBe('filled')
  })

  test('adding to a position blends the average cost', () => {
    let p = applyOrder(flat(), { symbol: 'AAPL', side: 'buy', price: 100, bracket: br(100), shares: 10 }).portfolio
    p = applyOrder(p, { symbol: 'AAPL', side: 'buy', price: 200, bracket: br(200), shares: 10 }).portfolio
    expect(p.positions.AAPL.shares).toBe(20)
    expect(p.positions.AAPL.avgCost).toBeCloseTo(150, 6)
  })

  test('full sell closes the position and books realized P&L', () => {
    const bought = applyOrder(flat(), { symbol: 'AAPL', side: 'buy', price: 100, bracket: br(100), shares: 10 }).portfolio
    const { portfolio, trade } = applyOrder(bought, { symbol: 'AAPL', side: 'sell', price: 130, shares: 10 })
    expect(portfolio.positions.AAPL).toBeUndefined()
    expect(trade.realized).toBeCloseTo(300, 6)
    expect(portfolio.cash).toBeCloseTo(10_300, 6)
  })

  test('round-trip at the same price is cash-neutral', () => {
    const bought = applyOrder(flat(), { symbol: 'AAPL', side: 'buy', price: 100, bracket: br(100), shares: 10 }).portfolio
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

describe('brackets — no position without an exit, and exits are mechanical', () => {
  const { bracketExits, validBracket } = require('../lib/paper-broker')

  test('a buy with no trade plan, or a stop above the price, is refused', () => {
    expect(evaluateOrder({ portfolio: flat(), symbol: 'A', side: 'buy', price: 100 })).toMatchObject({ ok: false, reason: expect.stringMatching(/never opened without a stop/) })
    expect(validBracket({ stop: 101, t2: 120 }, 100).ok).toBe(false)
    expect(validBracket({ stop: 90, t2: 99 }, 100).ok).toBe(false)
  })

  test('size falls as risk rises: the stop-out cap and the volatility cap bind before the % cap', () => {
    const wideStop = evaluateOrder({ portfolio: flat(), symbol: 'A', side: 'buy', price: 100, bracket: { stop: 80, t2: 130 } })
    expect(wideStop).toMatchObject({ ok: true, limitedBy: 'stop-out risk' })
    expect(wideStop.value).toBeCloseTo(500, 0)            // 1% of $10k ÷ 20% stop
    const jumpy = evaluateOrder({ portfolio: flat(), symbol: 'A', side: 'buy', price: 100, bracket: br(100), atrPct: 5 })
    expect(jumpy).toMatchObject({ ok: true, limitedBy: 'volatility' })
    expect(jumpy.value).toBeCloseTo(500, 0)               // 0.25% of $10k ÷ 5% ATR
  })

  const held = (bracket, extra = {}) => ({ ...flat(), cash: 0, positions: { A: { shares: 10, avgCost: 100, openedAt: '2026-10-01T14:00:00Z', bracket: { t1Done: false, ...bracket }, ...extra } } })
  const now = new Date('2026-10-05T15:00:00Z')

  test('stop first, then target, then T1 (half), then time', () => {
    const b = { stop: 95, t1: 105, t2: 110 }
    expect(bracketExits(held(b), { A: 94 }, { now }).exits).toEqual([{ symbol: 'A', kind: 'stop', fraction: 1, price: 94 }])
    expect(bracketExits(held(b), { A: 111 }, { now }).exits[0]).toMatchObject({ kind: 'target', fraction: 1 })
    expect(bracketExits(held(b), { A: 106 }, { now }).exits[0]).toMatchObject({ kind: 't1', fraction: 0.5 })
    expect(bracketExits(held(b), { A: 101 }, { now }).exits).toEqual([])
    expect(bracketExits(held(b), { A: 101 }, { now: new Date('2026-11-05T15:00:00Z') }).exits[0]).toMatchObject({ kind: 'time' })
  })

  test('booking T1 sells half and moves the stop to breakeven — the rest can no longer close as a loss', () => {
    const p = held({ stop: 95, t1: 105, t2: 110 })
    const { portfolio, trade } = applyOrder(p, { symbol: 'A', side: 'sell', price: 106, shares: 5, exitKind: 't1' })
    expect(trade.exitKind).toBe('t1')
    expect(portfolio.positions.A).toMatchObject({ shares: 5, bracket: { t1Done: true, stop: 100 } })
    expect(bracketExits(portfolio, { A: 99.5 }, { now }).exits[0]).toMatchObject({ kind: 'breakeven-stop', fraction: 1 })
    expect(bracketExits(portfolio, { A: 106 }, { now }).exits).toEqual([])   // T1 is not booked twice
  })

  test('a partial sell takes exactly the fraction; an exit is never blocked by the daily trade cap', () => {
    const p = held({ stop: 95, t1: 105, t2: 110 })
    expect(evaluateOrder({ portfolio: p, symbol: 'A', side: 'sell', price: 106, fraction: 0.5 }).shares).toBe(5)
    const busy = Array.from({ length: 10 }, () => ({ at: now.toISOString(), status: 'filled' }))
    expect(evaluateOrder({ portfolio: p, trades: busy, symbol: 'A', side: 'sell', price: 94, now, exit: true }).ok).toBe(true)
    expect(evaluateOrder({ portfolio: flat(), trades: busy, symbol: 'B', side: 'buy', price: 100, bracket: br(100), now }).ok).toBe(false)
  })

  test('positions opened before brackets existed are reported, never touched', () => {
    const legacy = { ...flat(), positions: { OLD: { shares: 1, avgCost: 50 } } }
    expect(bracketExits(legacy, { OLD: 1 }, { now })).toEqual({ exits: [], unmanaged: ['OLD'] })
  })

  test('performance reports how positions actually ended', () => {
    const trades = [
      { status: 'filled', side: 'sell', realized: 30, exitKind: 't1' },
      { status: 'filled', side: 'sell', realized: 0, exitKind: 'breakeven-stop' },
      { status: 'filled', side: 'sell', realized: -50, exitKind: 'stop' },
    ]
    expect(performance(flat(), trades).exitsByKind).toEqual({ t1: { n: 1, realized: 30 }, 'breakeven-stop': { n: 1, realized: 0 }, stop: { n: 1, realized: -50 } })
  })
})
