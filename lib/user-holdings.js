'use strict'

/**
 * lib/user-holdings.js
 *
 * The symbols a user holds, looked up by the email address they sign in
 * with. Scheduled jobs run with no request and so no req.user; the morning
 * holdings-research email (lib/scheduled-jobs.js) uses this to find whose
 * portfolio to research. Postgres when DATABASE_URL is set, else the same
 * in-memory store routes/portfolios.js uses.
 */

const { query } = require('../db/db')
const { MEM }   = require('../db/memstore')

const dbMode = () => !!process.env.DATABASE_URL

async function userIdForEmail(email) {
  const e = String(email || '').trim().toLowerCase()
  if (!e) return null
  if (dbMode()) {
    const r = await query('SELECT id FROM users WHERE LOWER(email) = $1 LIMIT 1', [e])
    return r.rows[0]?.id ?? null
  }
  return MEM.byEmail.get(e) ?? null
}

// Cash lines and option contracts have no bars or filings to research.
const NOT_RESEARCHABLE = new Set(['cash', 'option'])

/** Distinct symbols with shares > 0 across the user's non-archived portfolios, sorted. */
async function holdingSymbols(userId) {
  if (!userId) return []
  let symbols
  if (dbMode()) {
    const r = await query(
      `SELECT DISTINCT UPPER(h.symbol) AS symbol
         FROM holdings h JOIN portfolios p ON p.id = h.portfolio_id
        WHERE p.user_id = $1 AND p.is_archived = FALSE AND h.shares > 0
          AND COALESCE(h.asset_class, 'equity') NOT IN ('cash', 'option')`,
      [userId])
    symbols = r.rows.map(row => row.symbol)
  } else {
    symbols = []
    for (const [, p] of MEM.portfolios) {
      if (p.user_id !== userId || p.is_archived) continue
      for (const h of MEM.holdings.get(p.id) || []) {
        if (NOT_RESEARCHABLE.has(String(h?.assetClass ?? h?.asset_class ?? '').toLowerCase())) continue
        if (h?.symbol && Number(h.shares) > 0) symbols.push(String(h.symbol).toUpperCase())
      }
    }
  }
  return [...new Set(symbols.filter(Boolean))].sort()
}

module.exports = { userIdForEmail, holdingSymbols }
