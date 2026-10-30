'use strict'

// The hourly bracket manager, end to end against the persisted paper book.

process.env.PAPER_TRADING_ENABLED = 'true'
const pb = require('../lib/paper-broker')
const jobs = require('../lib/scheduled-jobs')
const { tradeLevels } = require('../lib/trade-levels')

const quote = prices => ({ ok: true, status: 200, json: async () => ({ quoteResponse: { result: Object.entries(prices).map(([symbol, regularMarketPrice]) => ({ symbol, regularMarketPrice })) } }) })
let realFetch
beforeEach(() => { realFetch = global.fetch; pb.reset(10_000) })
afterEach(() => { global.fetch = realFetch })
afterAll(() => { delete process.env.PAPER_TRADING_ENABLED })

test("a card's thesis trade plan becomes the bracket; a technical (no-trade) plan opens nothing", () => {
  const plan = tradeLevels({ price: 100, atr: 2, targetReturn: 12, stopLoss: 6 })
  expect(jobs.bracketFromPlan(plan)).toEqual({ stop: 94, t1: 106, t2: 112 })
  expect(jobs.bracketFromPlan(tradeLevels({ price: 100, atr: 2, support: 97 }))).toBeNull()
  expect(pb.execute({ symbol: 'A', side: 'buy', price: 100, bracket: null }).ok).toBe(false)
})

test('a T1 touch books half and moves the stop to breakeven; the next dip exits flat, not at a loss', async () => {
  const opened = pb.execute({ symbol: 'NVDA', side: 'buy', price: 100, bracket: { stop: 94, t1: 106, t2: 112 }, atrPct: 2 })
  expect(opened.ok).toBe(true)
  const shares = opened.trade.shares

  global.fetch = jest.fn(async () => quote({ NVDA: 107 }))
  const first = await jobs._paperManageForTests()
  expect(first.exits).toEqual([expect.objectContaining({ symbol: 'NVDA', kind: 't1', ok: true })])
  expect(pb.loadPortfolio().positions.NVDA).toMatchObject({ bracket: { t1Done: true, stop: 100 } })
  expect(pb.loadPortfolio().positions.NVDA.shares).toBeCloseTo(shares / 2, 4)

  global.fetch = jest.fn(async () => quote({ NVDA: 99 }))
  const second = await jobs._paperManageForTests()
  expect(second.exits[0]).toMatchObject({ kind: 'breakeven-stop', ok: true })
  expect(pb.loadPortfolio().positions.NVDA).toBeUndefined()

  const perf = pb.snapshot().performance
  expect(Object.keys(perf.exitsByKind).sort()).toEqual(['breakeven-stop', 't1'])
  expect(perf.exitsByKind.t1.realized).toBeGreaterThan(0)
})

test('a gap through the stop fills at the worse current price, never at the stop level', async () => {
  pb.execute({ symbol: 'AMD', side: 'buy', price: 100, bracket: { stop: 94, t1: 106, t2: 112 } })
  global.fetch = jest.fn(async () => quote({ AMD: 88 }))
  const out = await jobs._paperManageForTests()
  expect(out.exits[0]).toMatchObject({ kind: 'stop', ok: true })
  const sell = pb.loadTrades().filter(t => t.side === 'sell').at(-1)
  expect(sell).toMatchObject({ price: 88, exitKind: 'stop' })
})

test('off unless the kill switch is on', async () => {
  process.env.PAPER_TRADING_ENABLED = 'false'
  expect(await jobs._paperManageForTests()).toMatchObject({ skipped: true })
  process.env.PAPER_TRADING_ENABLED = 'true'
})

test('a position opened before brackets existed can be given exits; the time limit starts at adoption, not at the old open', async () => {
  pb.savePortfolio({ ...pb.emptyPortfolio(10_000), cash: 9_000, positions: { OLD: { shares: 10, avgCost: 100, openedAt: '2026-01-01T14:00:00Z' } } })
  expect(pb.unmanagedPositions(pb.loadPortfolio())).toEqual(['OLD'])

  // A stop above today's price would exit on the next check — refused, not adopted.
  expect(pb.adoptUnmanaged({ OLD: { price: 90, bracket: { stop: 95, t1: 105, t2: 110 } } }).skipped[0].reason).toMatch(/not below the price/)

  const out = pb.adoptUnmanaged({ OLD: { price: 100, bracket: { stop: 94, t1: 106, t2: 112 } } })
  expect(out.adopted).toEqual([expect.objectContaining({ symbol: 'OLD', bracket: expect.objectContaining({ stop: 94, adopted: true }) })])
  expect(pb.loadTrades().some(t => t.status === 'bracket-adopted' && t.symbol === 'OLD')).toBe(true)

  global.fetch = jest.fn(async () => quote({ OLD: 101 }))
  expect((await jobs._paperManageForTests()).exits).toEqual([])          // no instant time exit despite a January open
  global.fetch = jest.fn(async () => quote({ OLD: 93 }))
  expect((await jobs._paperManageForTests()).exits[0]).toMatchObject({ kind: 'stop', ok: true })

  // adopting twice never replaces a bracket
  pb.savePortfolio({ ...pb.emptyPortfolio(10_000), positions: { NEW: { shares: 1, avgCost: 50, bracket: { stop: 45, t2: 60, t1Done: true } } } })
  expect(pb.adoptUnmanaged({ NEW: { price: 50, bracket: { stop: 40, t2: 70 } } })).toEqual({ adopted: [], skipped: [] })
})

// The 9:45 executor used to buy at the 8:30 pre-market scan's price (the
// opening gap was never paid), only above a fixed score of 70 nothing had
// tested, and every position closed at 30 days whatever the pick's horizon.
describe('paper executor', () => {
  const plan = tradeLevels({ price: 100, atr: 2, targetReturn: 12, stopLoss: 6 })   // entry range $98–$102
  const pick = (symbol, compositeScore, over = {}) => ({ symbol, currentPrice: 100, compositeScore, agentVerdict: 'Buy', actionable: true, tradePlan: plan, ...over })

  test('fills at the live price, skips a price that ran past the entry range, and has no fixed score cutoff', async () => {
    jobs._setBroadScanForTests({ horizon: '3m', rankedStocks: [pick('AAA', 60), pick('BBB', 85), pick('CCC', 90, { agentVerdict: 'Avoid', actionable: false })] })
    global.fetch = jest.fn(async () => quote({ AAA: 100.5, BBB: 108 }))
    const out = await jobs._paperExecuteForTests()
    expect(out.cutoff).toBeNull()                                   // no validated cutoff ⇒ no score filter
    expect(out.executed.map(e => e.symbol)).toEqual(['AAA'])         // a 60 is no longer screened out
    expect(out.rejected).toEqual([expect.objectContaining({ symbol: 'BBB', reason: expect.stringMatching(/above the entry range/) })])
    expect(pb.loadTrades().filter(t => t.side === 'buy').at(-1)).toMatchObject({ symbol: 'AAA', price: 100.5 })
    expect(pb.loadPortfolio().positions.AAA.bracket.holdDays).toBe(91)   // the 3-month scan's horizon
  })

  test('no live quote, no position', async () => {
    jobs._setBroadScanForTests({ horizon: '6m', rankedStocks: [pick('DDD', 80)] })
    global.fetch = jest.fn(async () => quote({}))
    const out = await jobs._paperExecuteForTests()
    expect(out.executed).toEqual([])
    expect(out.rejected[0]).toMatchObject({ symbol: 'DDD', reason: 'no live quote at execution time' })
  })

  test("a position is held for its pick's horizon; one opened before the horizon was carried keeps 30 days", () => {
    const book = bracket => ({ ...pb.emptyPortfolio(10_000), positions: { A: { shares: 10, avgCost: 100, openedAt: '2026-01-01T14:00:00Z', bracket: { stop: 90, t1: 110, t2: 120, t1Done: false, ...bracket } } } })
    const day = d => ({ now: new Date(Date.parse('2026-01-01T14:00:00Z') + d * 86_400_000) })
    expect(pb.bracketExits(book({ holdDays: 91 }), { A: 101 }, day(40)).exits).toEqual([])
    expect(pb.bracketExits(book({ holdDays: 91 }), { A: 101 }, day(92)).exits[0]).toMatchObject({ kind: 'time' })
    expect(pb.bracketExits(book({}), { A: 101 }, day(31)).exits[0]).toMatchObject({ kind: 'time' })
    expect(pb.validBracket({ stop: 90, t1: 110, t2: 120, holdDays: 182 }, 100).bracket.holdDays).toBe(182)
  })
})
