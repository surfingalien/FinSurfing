'use strict'
/**
 * Portfolio scope middleware.
 *
 * portfolioOwnerOnly — portfolio.user_id must equal req.user.userId, OR user is admin.
 * portfolioAccessCheck(permission) — ownership OR an active portfolio_shares record with given permission.
 *
 * Both attach req.portfolio (the portfolio row) on success.
 */
const { query } = require('../db/db')
const { MEM }   = require('../db/memstore')

const DB_MODE = !!process.env.DATABASE_URL

/**
 * Ensure the requesting user owns the portfolio (or is admin).
 * Looks up the portfolio by req.params.id and attaches it to req.portfolio.
 */
async function portfolioOwnerOnly(req, res, next) {
  const portfolioId = req.params.id
  if (!portfolioId) return res.status(400).json({ error: 'Portfolio ID required' })

  if (!DB_MODE) {
    const p = MEM.portfolios.get(portfolioId)
    if (!p || p.is_archived) return res.status(404).json({ error: 'Portfolio not found' })
    if (req.user.role !== 'admin' && p.user_id !== req.user.userId)
      return res.status(403).json({ error: 'You do not have access to this portfolio' })
    req.portfolio = p
    return next()
  }

  try {
    const r = await query(
      'SELECT * FROM portfolios WHERE id = $1 AND is_archived = FALSE',
      [portfolioId]
    )
    const p = r.rows[0]
    if (!p) return res.status(404).json({ error: 'Portfolio not found' })
    if (req.user.role !== 'admin' && p.user_id !== req.user.userId)
      return res.status(403).json({ error: 'You do not have access to this portfolio' })
    req.portfolio = p
    next()
  } catch (err) {
    console.error('[portfolioOwnerOnly]', err.message)
    return res.status(500).json({ error: 'Failed to verify portfolio access' })
  }
}

/**
 * Check ownership OR a portfolio_shares record with the required permission.
 * permission: 'view' | 'copy_trade'
 */
function portfolioAccessCheck(permission) {
  return async function(req, res, next) {
    const portfolioId = req.params.id
    if (!portfolioId) return res.status(400).json({ error: 'Portfolio ID required' })

    if (!DB_MODE) {
      const p = MEM.portfolios.get(portfolioId)
      if (!p || p.is_archived) return res.status(404).json({ error: 'Portfolio not found' })

      // Admin can access any portfolio
      if (req.user.role === 'admin') { req.portfolio = p; return next() }

      // Owner always has access
      if (p.user_id === req.user.userId) { req.portfolio = p; return next() }

      // Check shares in memory
      const shareKey = `${portfolioId}:${req.user.userId}`
      let hasAccess = false
      for (const [, share] of MEM.shares) {
        if (share.portfolio_id === portfolioId &&
            share.shared_with_user_id === req.user.userId) {
          if (!share.expires_at || new Date(share.expires_at) > new Date()) {
            if (permission === 'view' || share.permission === permission) {
              hasAccess = true
              break
            }
          }
        }
      }
      if (!hasAccess) return res.status(403).json({ error: 'You do not have access to this portfolio' })
      req.portfolio = p
      return next()
    }

    try {
      const r = await query(
        'SELECT * FROM portfolios WHERE id = $1 AND is_archived = FALSE',
        [portfolioId]
      )
      const p = r.rows[0]
      if (!p) return res.status(404).json({ error: 'Portfolio not found' })

      // Admin can access any portfolio
      if (req.user.role === 'admin') { req.portfolio = p; return next() }

      // Owner always has access
      if (p.user_id === req.user.userId) { req.portfolio = p; return next() }

      // Check shares table
      const permissionClause = permission === 'view'
        ? `permission IN ('view','copy_trade')`
        : `permission = 'copy_trade'`

      const sr = await query(
        `SELECT id FROM portfolio_shares
         WHERE portfolio_id = $1 AND shared_with_user_id = $2
         AND (expires_at IS NULL OR expires_at > NOW())
         AND ${permissionClause}`,
        [portfolioId, req.user.userId]
      )
      if (!sr.rows.length)
        return res.status(403).json({ error: 'You do not have access to this portfolio' })

      req.portfolio = p
      next()
    } catch (err) {
      console.error('[portfolioAccessCheck]', err.message)
      return res.status(500).json({ error: 'Failed to verify portfolio access' })
    }
  }
}

module.exports = { portfolioOwnerOnly, portfolioAccessCheck }
