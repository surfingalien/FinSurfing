'use strict'
/**
 * Unit tests for the shared P&L module (lib/portfolio-pnl.js) — the SAME pure
 * functions src/hooks/usePortfolio.js uses in the browser. No HTTP/DB/React.
 *
 * Previously this file tested a hand-copied MIRROR of the hook's inline logic,
 * so the real code could change and these tests would still pass. Now they
 * exercise the actual module, so a P&L regression fails CI.
 */

const { enrichPosition, portfolioSummary } = require('../lib/portfolio-pnl')

describe('P&L calculation — enrichPosition()', () => {
  const pos = { symbol: 'AAPL', shares: 10, avgCost: 150 }

  test('mktValue = shares × price', () => {
    const e = enrichPosition(pos, { price: 180 })
    expect(e.mktValue).toBe(1800)   // 10 × 180
  })

  test('costBasis = shares × avgCost', () => {
    const e = enrichPosition(pos, { price: 180 })
    expect(e.costBasis).toBe(1500)  // 10 × 150
  })

  test('gainLoss = mktValue − costBasis', () => {
    const e = enrichPosition(pos, { price: 180 })
    expect(e.gainLoss).toBe(300)    // 1800 − 1500
  })

  test('gainLossPct = (gainLoss / costBasis) × 100', () => {
    const e = enrichPosition(pos, { price: 180 })
    expect(e.gainLossPct).toBeCloseTo(20)  // 300/1500 × 100
  })

  test('loss case: price below cost basis', () => {
    const e = enrichPosition(pos, { price: 120 })
    expect(e.mktValue).toBe(1200)
    expect(e.gainLoss).toBe(-300)
    expect(e.gainLossPct).toBeCloseTo(-20)
  })

  test('no quote → mktValue and gainLoss are null', () => {
    const e = enrichPosition(pos, null)
    expect(e.mktValue).toBeNull()
    expect(e.gainLoss).toBeNull()
    expect(e.gainLossPct).toBeNull()
  })

  test('zero avgCost → gainLossPct is null (no division by zero)', () => {
    const e = enrichPosition({ ...pos, avgCost: 0 }, { price: 100 })
    expect(e.gainLossPct).toBeNull()
  })

  test('todayGL = (price − prevClose) × shares when marketTime is today', () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const e = enrichPosition(pos, { price: 180, prevClose: 175, marketTime: nowSec })
    expect(e.todayGL).toBeCloseTo(50)   // (180 − 175) × 10
  })

  test('todayGL = 0 when marketTime is a past date (stale quote)', () => {
    const yesterdaySec = Math.floor(Date.now() / 1000) - 86400
    const e = enrichPosition(pos, { price: 180, prevClose: 175, marketTime: yesterdaySec })
    expect(e.todayGL).toBe(0)
  })

  test('todayGL falls back to quote.change × shares when prevClose missing', () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const e = enrichPosition(pos, { price: 180, change: 3, marketTime: nowSec })
    expect(e.todayGL).toBeCloseTo(30)   // 3 × 10
  })
})

describe('P&L calculation — portfolioSummary()', () => {
  test('totalCost sums all costBasis values', () => {
    const enriched = [
      { costBasis: 1000, mktValue: 1200, todayGL: 20 },
      { costBasis: 2000, mktValue: 2400, todayGL: -10 },
    ]
    const s = portfolioSummary(enriched)
    expect(s.totalCost).toBe(3000)
  })

  test('totalValue sums mktValue, falling back to costBasis when null', () => {
    const enriched = [
      { costBasis: 1000, mktValue: 1200, todayGL: 0 },
      { costBasis: 500,  mktValue: null,  todayGL: 0 },  // no live price
    ]
    const s = portfolioSummary(enriched)
    expect(s.totalValue).toBe(1700)  // 1200 + 500
  })

  test('totalGL = totalValue − totalCost', () => {
    const enriched = [
      { costBasis: 1000, mktValue: 1500, todayGL: 0 },
    ]
    const s = portfolioSummary(enriched)
    expect(s.totalGL).toBe(500)
  })

  test('totalGLPct is 0 when totalCost is 0 (no division by zero)', () => {
    const s = portfolioSummary([])
    expect(s.totalGLPct).toBe(0)
  })

  test('todayTotal sums all todayGL values', () => {
    const enriched = [
      { costBasis: 1000, mktValue: 1000, todayGL: 50 },
      { costBasis: 1000, mktValue: 1000, todayGL: -20 },
    ]
    const s = portfolioSummary(enriched)
    expect(s.todayTotal).toBe(30)
  })
})

// ── Regression: missing/stale quotes must not silently hide losses ───────────
// Bug: holdings with no quote were counted at cost basis (break-even), so the
// headline Total P&L understated losses (reported $-399 vs actual $-2060).
describe('P&L with missing and stale quotes', () => {
  const yesterdaySec = Math.floor(Date.now() / 1000) - 86400

  test('unpriced holding hides its loss in totalGL but is exposed via unpricedCount', () => {
    const enriched = [
      enrichPosition({ symbol: 'A', shares: 10, avgCost: 100 }, { price: 60 }),   // −400 priced
      enrichPosition({ symbol: 'B', shares: 10, avgCost: 200 }, null),            // real loss unknown
    ]
    const s = portfolioSummary(enriched)
    expect(s.totalGL).toBe(-400)        // unpriced B counted at break-even...
    expect(s.unpricedCount).toBe(1)     // ...but the gap is now visible
    expect(s.pricedCount).toBe(1)
  })

  test('stale last-known quote keeps the real gainLoss but contributes 0 to todayGL', () => {
    // Last-known fallback: old marketTime, stale flag set by the hook
    const e = enrichPosition(
      { symbol: 'C', shares: 10, avgCost: 100 },
      { price: 40, prevClose: 42, marketTime: yesterdaySec, stale: true },
    )
    expect(e.gainLoss).toBe(-600)       // loss measured at last real price
    expect(e.todayGL).toBe(0)           // no fake "today" move from stale data
    const s = portfolioSummary([e])
    expect(s.totalGL).toBe(-600)        // the -2060-style loss is no longer hidden
    expect(s.staleCount).toBe(1)
    expect(s.unpricedCount).toBe(0)
  })

  test('live quote arriving after a stale one clears the stale count', () => {
    const nowSec = Math.floor(Date.now() / 1000)
    const e = enrichPosition(
      { symbol: 'D', shares: 5, avgCost: 50 },
      { price: 45, prevClose: 44, marketTime: nowSec, stale: false },
    )
    const s = portfolioSummary([e])
    expect(s.staleCount).toBe(0)
    expect(s.pricedCount).toBe(1)
    expect(e.todayGL).toBeCloseTo(5)    // (45−44) × 5
  })
})
