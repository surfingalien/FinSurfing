'use strict'
/**
 * Unit tests for P&L calculation logic extracted from usePortfolio.js.
 * These are pure functions — no HTTP, no DB, no React hooks.
 */

// Mirror of the enrichment logic in src/hooks/usePortfolio.js:283-310
function enrichPosition(pos, quote) {
  const q          = quote || {}
  const price      = q.price ?? null
  const costBasis  = pos.shares * pos.avgCost
  const mktValue   = price !== null ? price * pos.shares : null
  const gainLoss   = mktValue !== null ? mktValue - costBasis : null
  const gainLossPct = gainLoss !== null && costBasis > 0 ? (gainLoss / costBasis) * 100 : null

  const prevClose  = q.prevClose ?? null
  const marketTime = q.marketTime ?? null
  const isToday    = marketTime
    ? new Date(marketTime * 1000).toDateString() === new Date().toDateString()
    : false
  const todayGL    = isToday && price !== null && prevClose !== null
    ? (price - prevClose) * pos.shares
    : isToday && q.change != null
      ? q.change * pos.shares
      : 0

  return { ...pos, price, costBasis, mktValue, gainLoss, gainLossPct, todayGL }
}

function portfolioSummary(enriched) {
  const totalCost  = enriched.reduce((s, p) => s + p.costBasis, 0)
  const totalValue = enriched.reduce((s, p) => s + (p.mktValue ?? p.costBasis), 0)
  const totalGL    = totalValue - totalCost
  const totalGLPct = totalCost > 0 ? (totalGL / totalCost) * 100 : 0
  const todayTotal = enriched.reduce((s, p) => s + (p.todayGL ?? 0), 0)
  return { totalCost, totalValue, totalGL, totalGLPct, todayTotal }
}

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
