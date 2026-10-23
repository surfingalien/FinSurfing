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
