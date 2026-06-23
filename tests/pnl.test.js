'use strict'
/**
 * Unit tests for the shared P&L module (lib/portfolio-pnl.js) — the SAME pure
 * functions src/hooks/usePortfolio.js uses in the browser. No HTTP/DB/React.
 *
 * Previously this file tested a hand-copied MIRROR of the hook's inline logic,
 * so the real code could change and these tests would still pass. Now they
 * exercise the actual module, so a P&L regression fails CI.
 */

const { enrichPosition, portfolioSummary, costBasis, unrealizedPct } = require('../lib/portfolio-pnl')

describe('P&L atoms — costBasis() / unrealizedPct()', () => {
  test('costBasis = shares × avgCost', () => {
    expect(costBasis({ shares: 10, avgCost: 150 })).toBe(1500)
  })

  test('unrealizedPct = (price − avgCost) / avgCost × 100', () => {
    expect(unrealizedPct(180, 150)).toBeCloseTo(20)
    expect(unrealizedPct(120, 150)).toBeCloseTo(-20)
  })

  test('unrealizedPct is null for unknown price or non-positive avgCost (no Infinity/NaN)', () => {
    expect(unrealizedPct(null, 150)).toBeNull()
    expect(unrealizedPct(100, 0)).toBeNull()
    expect(unrealizedPct(100, -5)).toBeNull()
  })

  test('enrichPosition delegates to the atoms (consistent results)', () => {
    const e = enrichPosition({ shares: 10, avgCost: 150 }, { price: 180 })
    expect(e.costBasis).toBe(costBasis({ shares: 10, avgCost: 150 }))
    expect(e.gainLossPct).toBeCloseTo(unrealizedPct(180, 150))
  })
})

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

  test('todayGL = (price − prevClose) × shares for a fresh quote', () => {
    const e = enrichPosition(pos, { price: 180, prevClose: 175 })
    expect(e.todayGL).toBeCloseTo(50)   // (180 − 175) × 10
  })

  test('todayGL counts the day move even when marketTime is absent', () => {
    // Most providers omit marketTime; the position must still count toward
    // Today's P/L (the bug that showed +$115 / "1↑ 0↓" for the whole book).
    const e = enrichPosition(pos, { price: 180, prevClose: 175 /* no marketTime */ })
    expect(e.todayGL).toBeCloseTo(50)
  })

  test('todayGL falls back to quote.change × shares when prevClose missing', () => {
    const e = enrichPosition(pos, { price: 180, change: 3 })
    expect(e.todayGL).toBeCloseTo(30)   // 3 × 10
  })

  test('todayGL backs the day move out of changePct when prevClose/change missing', () => {
    const e = enrichPosition(pos, { price: 110, changePct: 10 })
    // prevClose = 110 / 1.10 = 100 → (110 − 100) × 10
    expect(e.todayGL).toBeCloseTo(100)
  })

  test('todayGL = 0 for a stale quote with no change/changePct data', () => {
    // prevClose path requires fresh price; without change data there's nothing to use.
    const e = enrichPosition(pos, { price: 180, prevClose: 175, stale: true })
    expect(e.todayGL).toBe(0)
  })

  test('todayGL uses stored change for stale quotes that have change data', () => {
    // Provider rate-limit during a refresh: client falls back to localStorage with
    // stale: true but still has valid change from the earlier successful fetch.
    const e = enrichPosition(pos, { price: 183, change: 3, stale: true })
    expect(e.todayGL).toBeCloseTo(30)   // 3 × 10 shares
  })

  test('todayGL uses changePct for stale quotes that have changePct but no change', () => {
    const e = enrichPosition(pos, { price: 110, changePct: 10, stale: true })
    expect(e.todayGL).toBeCloseTo(100)  // (110 − 100) × 10 backed out of changePct
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

  test('totalValue counts only priced positions; unpriced is excluded and exposed via unpricedCost', () => {
    const enriched = [
      { costBasis: 1000, mktValue: 1200, todayGL: 0, price: 12 },
      { costBasis: 500,  mktValue: null, todayGL: 0, price: null },  // no live/last price
    ]
    const s = portfolioSummary(enriched)
    expect(s.totalValue).toBe(1200)   // priced only — NOT diluted by counting the unpriced at cost
    expect(s.totalCost).toBe(1000)    // priced cost only, so totalGL = totalValue − totalCost holds
    expect(s.unpricedCount).toBe(1)
    expect(s.unpricedCost).toBe(500)
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
// Now unpriced holdings are EXCLUDED from the headline (not counted at cost) so
// priced losses are never diluted, with the held-but-unpriced amount surfaced
// separately via unpricedCount / unpricedCost.
describe('P&L with missing and stale quotes', () => {
  const yesterdaySec = Math.floor(Date.now() / 1000) - 86400

  test('unpriced holding is excluded from totalGL (not counted at cost) and exposed via unpricedCount/Cost', () => {
    const enriched = [
      enrichPosition({ symbol: 'A', shares: 10, avgCost: 100 }, { price: 60 }),   // −400 priced
      enrichPosition({ symbol: 'B', shares: 10, avgCost: 200 }, null),            // real value unknown → excluded
    ]
    const s = portfolioSummary(enriched)
    expect(s.totalGL).toBe(-400)        // priced A's loss, undiluted by B
    expect(s.unpricedCount).toBe(1)     // B is surfaced, not silently absorbed at cost
    expect(s.unpricedCost).toBe(2000)   // 10 × 200 — shown separately so the user sees it
    expect(s.pricedCount).toBe(1)
  })

  test('stale quote with no change data contributes 0 to todayGL', () => {
    // Server recall from last-quotes with no change/changePct — no day move calculable.
    const e = enrichPosition(
      { symbol: 'C', shares: 10, avgCost: 100 },
      { price: 40, prevClose: 42, marketTime: yesterdaySec, stale: true },
    )
    expect(e.gainLoss).toBe(-600)       // loss measured at last real price
    expect(e.todayGL).toBe(0)           // no change data available
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
