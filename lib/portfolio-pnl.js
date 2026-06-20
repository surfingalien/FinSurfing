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

// Cost basis for a holding: shares × average cost.
function costBasis(pos) {
  return pos.shares * pos.avgCost
}

// Unrealized return %, current price vs average cost. null when the price is
// unknown or avgCost is non-positive, so Infinity/NaN never leak to callers.
function unrealizedPct(price, avgCost) {
  return price != null && avgCost > 0 ? ((price - avgCost) / avgCost) * 100 : null
}

// Enrich a holding { symbol, shares, avgCost, ... } with a live/last-known
// quote → adds price, costBasis, mktValue, gainLoss, gainLossPct, todayGL.
// quote may be undefined/null when no price is available yet.
function enrichPosition(pos, quote) {
  const q          = quote || {}
  const price      = q.price ?? null
  const cost       = costBasis(pos)
  const mktValue   = price !== null ? price * pos.shares : null
  const gainLoss   = mktValue !== null ? mktValue - cost : null
  // shares>0 guard reproduces the prior `costBasis > 0` guard exactly
  const gainLossPct = pos.shares > 0 ? unrealizedPct(price, pos.avgCost) : null

  const prevClose  = q.prevClose ?? null
  // Today's $ P&L. Prefer (price − prevClose) × shares, which requires a FRESH
  // quote so we know price is current. For stale last-known fallbacks the stored
  // `change` / `changePct` still reflects the most recent successful fetch
  // (same trading session in practice), so we use those rather than zeroing out:
  // a failed refresh cycle (provider rate-limit, brief outage) was dropping
  // positions to $0 todayGL even though their cached change data was still valid.
  // Only (price − prevClose) is gated on freshness; change/changePct are used
  // unconditionally when price is available.
  const fresh = price !== null && !q.stale
  let todayGL = 0
  if (price !== null) {
    if (fresh && prevClose != null)     todayGL = (price - prevClose) * pos.shares
    else if (q.change != null)          todayGL = q.change * pos.shares
    else if (q.changePct != null && 1 + q.changePct / 100 > 0)
                                        todayGL = (price - price / (1 + q.changePct / 100)) * pos.shares
  }

  return { ...pos, ...q, price, costBasis: cost, mktValue, gainLoss, gainLossPct, todayGL }
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

module.exports = { enrichPosition, portfolioSummary, costBasis, unrealizedPct }
