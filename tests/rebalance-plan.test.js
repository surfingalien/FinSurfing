'use strict'

// lib/rebalance-plan.js: the AI Rebalancer asked the model for share counts,
// dollar amounts and post-trade weights. Code computes them now.

const { planRebalance } = require('../lib/rebalance-plan')

const holdings = [
  { symbol: 'MSFT', shares: 20, price: 400, sector: 'Technology' },
  { symbol: 'AAPL', shares: 30, price: 200, sector: 'Technology' },
  { symbol: 'JNJ',  shares: 10, price: 150, sector: 'Healthcare' },
  { symbol: 'XOM',  shares: 5,  price: 100, sector: 'Energy' },
]

test('sector gaps become whole-share trades split pro rata, and the weights land near target', () => {
  const p = planRebalance({ holdings, targetAllocation: { Technology: 60, Healthcare: 30, Energy: 10 } })
  expect(p.total).toBe(16000)
  const t = Object.fromEntries(p.trades.map(x => [x.symbol, `${x.side} ${x.shares}`]))
  expect(t).toEqual({ MSFT: 'sell 6', AAPL: 'sell 9', JNJ: 'buy 21', XOM: 'buy 10' })
  for (const s of p.sectors) expect(Math.abs(s.afterPct - s.targetPct)).toBeLessThan(2)
})

test('buys never spend more than the sales raise', () => {
  const p = planRebalance({ holdings, targetAllocation: { Technology: 60, Healthcare: 30, Energy: 10 } })
  const sold = p.trades.filter(t => t.side === 'sell').reduce((s, t) => s + t.value, 0)
  const bought = p.trades.filter(t => t.side === 'buy').reduce((s, t) => s + t.value, 0)
  expect(bought).toBeLessThanOrEqual(sold)
  expect(p.cashResidual).toBeCloseTo(sold - bought, 2)
})

test('never sells more than is held', () => {
  const p = planRebalance({ holdings, targetAllocation: { Technology: 0, Healthcare: 70, Energy: 30 } })
  const msft = p.trades.find(t => t.symbol === 'MSFT')
  expect(msft).toMatchObject({ side: 'sell', shares: 20 })
})

test('targets that do not add up to 100% are scaled and the plan says so', () => {
  const p = planRebalance({ holdings, targetAllocation: { Technology: 30, Healthcare: 15, Energy: 5 } })
  expect(p.notes.join(' ')).toMatch(/add up to 50%, so they were scaled to 100%/)
  expect(p.sectors.find(s => s.sector === 'Technology').targetPct).toBe(60)
})

test('a sector with a target and no holding is reported, not invented', () => {
  const p = planRebalance({ holdings, targetAllocation: { Technology: 50, Healthcare: 20, Energy: 10, Utilities: 20 } })
  expect(p.notes.join(' ')).toMatch(/Utilities has a 20% target but no holding to add to/)
  expect(p.trades.some(t => t.sector === 'Utilities')).toBe(false)
})

test('fractional holdings trade in fractions; unpriced holdings are ignored', () => {
  const p = planRebalance({
    holdings: [{ symbol: 'BTC-USD', shares: 0.5, price: 60000, sector: 'Crypto' }, { symbol: 'SPY', shares: 10, price: 500, sector: 'Index' }, { symbol: 'X', shares: 5, price: null }],
    targetAllocation: { Crypto: 50, Index: 50 },
  })
  expect(p.total).toBe(35000)
  const btc = p.trades.find(t => t.symbol === 'BTC-USD')
  expect(btc.side).toBe('sell')
  expect(btc.shares).toBeCloseTo(0.2083, 3)
})

test('nothing priced is an empty plan with a reason', () => {
  expect(planRebalance({ holdings: [{ symbol: 'A', shares: 1, price: 0 }] })).toMatchObject({ total: 0, trades: [], notes: ['No priced holdings to rebalance.'] })
})
