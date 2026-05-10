'use strict'
/**
 * Data sanitization utilities for public portfolio exposure.
 * Strip sensitive fields before sending to unauthenticated or foreign users.
 */

const PORTFOLIO_PRIVATE_FIELDS = [
  'cash_balance', 'custodian', 'personal_notes', 'tax_status',
  'mfa_secret', 'password_hash',
]

const HOLDING_PRIVATE_FIELDS = [
  'avg_cost_basis',  // never reveal cost basis publicly
]

/**
 * Remove cost-basis and other private fields from a holding object.
 * Returns a new object (does not mutate input).
 */
function sanitizeHolding(h) {
  if (!h || typeof h !== 'object') return h
  const out = { ...h }
  for (const f of HOLDING_PRIVATE_FIELDS) delete out[f]
  // Also strip camelCase variants
  delete out.avgCost
  delete out.avg_cost
  return out
}

/**
 * Remove private financial/internal fields from a portfolio object.
 * Returns a new object (does not mutate input).
 */
function sanitizePortfolio(p) {
  if (!p || typeof p !== 'object') return p
  const out = { ...p }
  for (const f of PORTFOLIO_PRIVATE_FIELDS) delete out[f]
  // camelCase aliases
  delete out.cashBalance
  delete out.personalNotes
  return out
}

/**
 * Full public sanitization — strips sensitive portfolio + holding fields.
 * Returns { portfolio, holdings, disclaimer }.
 */
function sanitizeForPublic(portfolio, holdings) {
  return {
    portfolio: sanitizePortfolio(portfolio),
    holdings:  Array.isArray(holdings) ? holdings.map(sanitizeHolding) : [],
    disclaimer: 'This portfolio is shared publicly. Cost basis and personal financial details are hidden.',
  }
}

module.exports = { sanitizeHolding, sanitizePortfolio, sanitizeForPublic }
