'use strict'

// Phase 1 risk controls on the paper book: slippage on every fill, a daily
// loss limit, pre-trade checks on the quote, and the equity curve per day.

process.env.PAPER_TRADING_ENABLED = 'true'
const pb = require('../lib/paper-broker')
const jobs = require('../lib/scheduled-jobs')

const quote = rows => ({ ok: true, status: 200, json: async () => ({ quoteResponse: { result: Object.entries(rows).map(([symbol, v]) => (typeof v === 'number' ? { symbol, regularMarketPrice: v } : { symbol, ...v })) } }) })
let realFetch
beforeEach(() => { realFetch = global.fetch; pb.reset(10_000) })
afterEach(() => { global.fetch = realFetch; delete process.env.PAPER_SLIPPAGE_BPS; delete process.env.PAPER_DAILY_LOSS_PCT })
afterAll(() => { delete process.env.PAPER_TRADING_ENABLED })

const BRACKET = { stop: 94, t1: 106, t2: 112 }

describe('slippage', () => {
  test('half the asset class round trip per side; env may only make it worse', () => {
    expect(pb.slippageBps('AAPL')).toBe(5)
    expect(pb.slippageBps('BTC-USD')).toBe(30)
    process.env.PAPER_SLIPPAGE_BPS = '1'
    expect(pb.slippageBps('AAPL')).toBe(5)                 // cannot make fills better
    process.env.PAPER_SLIPPAGE_BPS = '20'
    expect(pb.slippageBps('AAPL')).toBe(20)
    expect(pb.fillPrice(100, 'buy', 10)).toBeCloseTo(100.1, 6)
    expect(pb.fillPrice(100, 'sell', 10)).toBeCloseTo(99.9, 6)
  })

  test('a fill records the quote, the slippage and its cost; performance totals it', () => {
    const r = pb.execute({ symbol: 'NVDA', side: 'buy', price: 100, bracket: BRACKET })
    expect(r.ok).toBe(true)
    expect(r.trade).toMatchObject({ quotePrice: 100, price: 100.05, slippageBps: 5 })
    expect(r.trade.slippageCost).toBeCloseTo(r.trade.shares * 0.05, 2)
    expect(pb.snapshot().performance.slippagePaid).toBeCloseTo(r.trade.slippageCost, 2)
  })
})

describe('pre-trade checks', () => {
  const now = new Date('2026-11-03T16:00:00Z')            // Tue 11:00 ET
  test('a stale last-known quote, an old quote and a closed market are refused; crypto trades any hour', () => {
    expect(pb.preTradeCheck({ symbol: 'AAPL', quote: { stale: true }, now, marketOpen: true }).reason).toMatch(/stale/)
    expect(pb.preTradeCheck({ symbol: 'AAPL', quote: { at: now.getTime() / 1000 - 3600 }, now, marketOpen: true }).reason).toMatch(/60 min old/)
    expect(pb.preTradeCheck({ symbol: 'AAPL', quote: { at: now.getTime() }, now, marketOpen: false }).reason).toMatch(/closed/)
    expect(pb.preTradeCheck({ symbol: 'AAPL', quote: { at: now.getTime() }, now: new Date('2026-11-01T16:00:00Z') }).reason).toMatch(/closed/)   // a Sunday
    expect(pb.preTradeCheck({ symbol: 'BTC-USD', quote: { at: now.getTime() }, now: new Date('2026-11-01T16:00:00Z') }).ok).toBe(true)
    expect(pb.preTradeCheck({ symbol: 'AAPL', quote: { at: now.getTime() }, now, marketOpen: true }).ok).toBe(true)
  })

  test('a buy that fails is refused and logged; an exit that fails waits for the next run, unlogged', () => {
    const buy = pb.execute({ symbol: 'AAPL', side: 'buy', price: 100, bracket: BRACKET, quote: { stale: true }, marketOpen: true })
    expect(buy).toMatchObject({ ok: false, reason: expect.stringMatching(/^pre-trade: quote is a stale/) })
    expect(pb.loadTrades().at(-1)).toMatchObject({ status: 'rejected', rejectReason: expect.stringMatching(/pre-trade/) })

    pb.execute({ symbol: 'AAPL', side: 'buy', price: 100, bracket: BRACKET })
    const n = pb.loadTrades().length
    const exit = pb.execute({ symbol: 'AAPL', side: 'sell', price: 90, exitKind: 'stop', quote: { at: Date.now() }, marketOpen: false })
    expect(exit).toMatchObject({ ok: false, deferred: true, reason: 'US market is closed' })
    expect(pb.loadTrades().length).toBe(n)
    expect(pb.loadPortfolio().positions.AAPL).toBeDefined()
  })

  test('the hourly manager defers a stop while the market is closed and fills it once open', async () => {
    pb.execute({ symbol: 'AMD', side: 'buy', price: 100, bracket: BRACKET })
    global.fetch = jest.fn(async () => quote({ AMD: { regularMarketPrice: 90, regularMarketTime: Math.floor(Date.now() / 1000) } }))
    const closed = await jobs._paperManageForTests({ marketOpen: false })
    expect(closed.exits).toEqual([])
    expect(closed.deferred).toEqual([expect.objectContaining({ symbol: 'AMD', kind: 'stop' })])
    const open = await jobs._paperManageForTests({ marketOpen: true })
    expect(open.exits[0]).toMatchObject({ symbol: 'AMD', kind: 'stop', ok: true })
  })
})

describe('daily loss limit', () => {
  test('down more than 2% against the day open pauses buys until the next ET midnight; exits still run', () => {
    const now = new Date('2026-11-03T16:00:00Z')
    const book = pb.markDay({ ...pb.emptyPortfolio(10_000), cash: 5_000, positions: { X: { shares: 50, avgCost: 100, bracket: { stop: 50, t2: 200, t1Done: true } } } }, 10_000, now)
    expect(book.dayMark).toEqual({ date: '2026-11-03', equity: 10_000 })
    const lower = pb.protections([], book, now, pb.protectionLimits(), { equityNow: 9_700 })
    expect(lower.global).toMatchObject({ kind: 'daily-loss', until: '2026-11-04T05:00:00.000Z' })
    expect(lower.global.reason).toMatch(/down 3\.0% today \(marked to market/)
    expect(pb.protections([], book, now, pb.protectionLimits(), { equityNow: 9_850 }).global).toBeNull()

    const buy = pb.evaluateOrder({ portfolio: book, symbol: 'Y', side: 'buy', price: 50, priceMap: { X: 94 }, now, bracket: { stop: 45, t2: 60 } })
    expect(buy).toMatchObject({ ok: false, reason: expect.stringMatching(/daily-loss/) })
    expect(pb.evaluateOrder({ portfolio: book, symbol: 'X', side: 'sell', price: 94, priceMap: { X: 94 }, now }).ok).toBe(true)
  })

  test('without a day mark, realized losses booked today count; env may only tighten the limit', () => {
    const now = new Date('2026-11-03T16:00:00Z')
    const trades = [{ status: 'filled', side: 'sell', at: '2026-11-03T15:00:00Z', symbol: 'Z', realized: -300, exitKind: 'manual' }]
    expect(pb.protections(trades, pb.emptyPortfolio(10_000), now).global).toMatchObject({ kind: 'daily-loss' })
    process.env.PAPER_DAILY_LOSS_PCT = '5'
    expect(pb.protectionLimits().dailyLossPct).toBe(2)
    process.env.PAPER_DAILY_LOSS_PCT = '1'
    expect(pb.protectionLimits().dailyLossPct).toBe(1)
  })

  test("the day's opening equity is the last recorded equity of an earlier day, and the curve gives daily P&L", () => {
    let b = pb.emptyPortfolio(10_000)
    b = pb.markDay(b, 10_100, new Date('2026-11-02T20:00:00Z'))
    b = pb.markDay(b, 10_050, new Date('2026-11-03T14:00:00Z'))
    b = pb.markDay(b, 9_900, new Date('2026-11-03T20:00:00Z'))
    expect(b.dayMark).toEqual({ date: '2026-11-03', equity: 10_100 })
    expect(b.equityHistory).toEqual([{ date: '2026-11-02', equity: 10_100 }, { date: '2026-11-03', equity: 9_900 }])
    expect(pb.dailyPnl(b.equityHistory, 10_000)).toEqual([
      { date: '2026-11-02', equity: 10_100, pnl: 100, pnlPct: 1 },
      { date: '2026-11-03', equity: 9_900, pnl: -200, pnlPct: -1.98 },
    ])
  })

  test('the hourly manager records equity every run, even with no positions', async () => {
    global.fetch = jest.fn(async () => quote({}))
    const out = await jobs._paperManageForTests()
    expect(out).toMatchObject({ skipped: true, equity: { equity: 10_000 } })
    expect(pb.snapshot().equityHistory).toHaveLength(1)
  })
})
