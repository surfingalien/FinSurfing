'use strict'
/**
 * Portfolio P&L — single source of truth for position enrichment + summary.
 *
 * Pure functions, no React / DOM / Node built-ins, so they run identically in:
 *   - the browser (imported by src/hooks/usePortfolio.js via Vite)
 *   - Jest (required directly by tests/pnl.test.js)
 *
 * Extracted verbatim from the previous inline logic in usePortfolio.js so the
 * UI behaviour is unchanged. The win: there is now ONE implementation, and the
 * unit tests exercise the real code instead of a hand-copied mirror that could
 * silently drift from it.
 */

// Enrich a holding { symbol, shares, avgCost, ... } with a live/last-known
// quote → adds price, costBasis, mktValue, gainLoss, gainLossPct, todayGL.
// quote may be undefined/null when no price is available yet.
function enrichPosition(pos, quote) {
  const q          = quote || {}
  const price      = q.price ?? null
  const costBasis  = pos.shares * pos.avgCost
  const mktValue   = price !== null ? price * pos.shares : null
  const gainLoss   = mktValue !== null ? mktValue - costBasis : null
  const gainLossPct = gainLoss !== null && costBasis > 0 ? (gainLoss / costBasis) * 100 : null

  const prevClose  = q.prevClose ?? null
  const marketTime = q.marketTime ?? null
  // No timestamp → treat as stale so daily P&L resets at midnight
  const isToday    = marketTime
    ? new Date(marketTime * 1000).toDateString() === new Date().toDateString()
    : false
  const todayGL    = isToday && price !== null && prevClose !== null
    ? (price - prevClose) * pos.shares
    : isToday && q.change != null
      ? q.change * pos.shares
      : 0

  return { ...pos, ...q, price, costBasis, mktValue, gainLoss, gainLossPct, todayGL }
}

// Aggregate enriched positions into the headline portfolio summary. Positions
// with no price at all are counted at cost (break-even); unpricedCount /
// staleCount expose how many holdings have incomplete pricing so the UI can
// flag an understated P&L rather than hide it.
function portfolioSummary(enriched) {
  const totalCost  = enriched.reduce((s, p) => s + p.costBasis, 0)
  const totalValue = enriched.reduce((s, p) => s + (p.mktValue ?? p.costBasis), 0)
  const totalGL    = totalValue - totalCost
  const totalGLPct = totalCost > 0 ? (totalGL / totalCost) * 100 : 0
  const todayTotal = enriched.reduce((s, p) => s + (p.todayGL ?? 0), 0)
  const totalCount    = enriched.length
  const staleCount    = enriched.filter(p => p.price !== null && p.stale).length
  const unpricedCount = enriched.filter(p => p.price === null).length
  const pricedCount   = totalCount - staleCount - unpricedCount
  return { totalCost, totalValue, totalGL, totalGLPct, todayTotal, totalCount, pricedCount, staleCount, unpricedCount }
}

module.exports = { enrichPosition, portfolioSummary }
