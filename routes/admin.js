'use strict'
/**
 * Admin routes — all require requireAdmin middleware.
 * Works in both DB mode and in-memory mode.
 *
 * GET    /api/admin/portfolios
 * GET    /api/admin/portfolios/:id
 * POST   /api/admin/portfolios/:id/feature
 * GET    /api/admin/users
 * GET    /api/admin/access-logs
 * DELETE /api/admin/users/:id/lock
 */
const express = require('express')
const { requireAuth, requireAdmin } = require('../middleware/auth')
const { query } = require('../db/db')
const { MEM }   = require('../db/memstore')

const router = express.Router()
router.use(requireAuth)
router.use(requireAdmin)

const DB_MODE = !!process.env.DATABASE_URL

// ── Async access logger ────────────────────────────
function logAccess(actorUserId, portfolioId, action, req, meta = {}) {
  if (!DB_MODE) return
  query(
    `INSERT INTO access_logs (actor_user_id, target_portfolio_id, action, ip_address, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorUserId || null, portfolioId || null, action, req.ip, JSON.stringify(meta)]
  ).catch(() => {})
}

// ── GET /api/admin/portfolios ──────────────────────
// List ALL portfolios with metadata
router.get('/portfolios', async (req, res) => {
  if (!DB_MODE) {
    const result = []
    for (const [, p] of MEM.portfolios) {
      const owner    = MEM.users.get(p.user_id)
      const holdings = MEM.holdings.get(p.id) || []
      result.push({
        id: p.id, name: p.name, visibility: p.visibility,
        is_system: p.is_system, is_featured: p.is_featured,
        is_archived: p.is_archived,
        holdingCount: holdings.length,
        user: owner ? { id: owner.id, username: owner.username, email: owner.email } : null,
        created_at: p.created_at,
      })
    }
    result.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
    return res.json(result)
  }

  try {
    const r = await query(
      `SELECT p.id, p.name, p.visibility, p.is_system, p.is_featured, p.is_archived,
              p.created_at, p.updated_at,
              u.id AS user_id, u.username, u.email, u.display_name,
              COUNT(h.id) AS holding_count
       FROM portfolios p
       JOIN users u ON u.id = p.user_id
       LEFT JOIN holdings h ON h.portfolio_id = p.id
       GROUP BY p.id, u.id
       ORDER BY p.created_at DESC`
    )
    return res.json(r.rows.map(row => ({
      ...row,
      holdingCount: parseInt(row.holding_count),
    })))
  } catch (err) {
    console.error('[admin/portfolios]', err.message)
    return res.status(500).json({ error: 'Failed to fetch portfolios' })
  }
})

// ── GET /api/admin/portfolios/:id ──────────────────
// Full portfolio including holdings
router.get('/portfolios/:id', async (req, res) => {
  const portfolioId = req.params.id

  if (!DB_MODE) {
    const p = MEM.portfolios.get(portfolioId)
    if (!p) return res.status(404).json({ error: 'Portfolio not found' })
    const owner    = MEM.users.get(p.user_id)
    const holdings = MEM.holdings.get(portfolioId) || []
    return res.json({
      ...p,
      holdings,
      owner: owner ? { id: owner.id, username: owner.username, email: owner.email } : null,
    })
  }

  try {
    const pRes = await query(
      `SELECT p.*, u.username, u.email, u.display_name
       FROM portfolios p JOIN users u ON u.id = p.user_id
       WHERE p.id = $1`,
      [portfolioId]
    )
    if (!pRes.rows[0]) return res.status(404).json({ error: 'Portfolio not found' })

    const hRes = await query(
      'SELECT * FROM holdings WHERE portfolio_id = $1 ORDER BY symbol',
      [portfolioId]
    )

    logAccess(req.user.userId, portfolioId, 'admin_view', req)

    const p = pRes.rows[0]
    return res.json({
      ...p,
      cashBalance: parseFloat(p.cash_balance),
      holdings: hRes.rows,
    })
  } catch (err) {
    console.error('[admin/portfolios/:id]', err.message)
    return res.status(500).json({ error: 'Failed to fetch portfolio' })
  }
})

// ── POST /api/admin/portfolios/:id/feature ─────────
// Set visibility=public and is_featured=true
router.post('/portfolios/:id/feature', async (req, res) => {
  const portfolioId = req.params.id
  const { feature = true } = req.body  // allows unfeature with { feature: false }

  if (!DB_MODE) {
    const p = MEM.portfolios.get(portfolioId)
    if (!p) return res.status(404).json({ error: 'Portfolio not found' })
    if (feature) {
      p.visibility  = 'public'
      p.is_featured = true
    } else {
      p.is_featured = false
    }
    p.updated_at = new Date().toISOString()
    return res.json({ ok: true, portfolio: p })
  }

  try {
    let r
    if (feature) {
      r = await query(
        `UPDATE portfolios SET visibility = 'public', is_featured = TRUE
         WHERE id = $1
         RETURNING id, name, visibility, is_featured`,
        [portfolioId]
      )
    } else {
      r = await query(
        `UPDATE portfolios SET is_featured = FALSE
         WHERE id = $1
         RETURNING id, name, visibility, is_featured`,
        [portfolioId]
      )
    }
    if (!r.rows[0]) return res.status(404).json({ error: 'Portfolio not found' })
    logAccess(req.user.userId, portfolioId, 'admin_feature', req, { feature })
    return res.json({ ok: true, portfolio: r.rows[0] })
  } catch (err) {
    console.error('[admin/portfolios/feature]', err.message)
    return res.status(500).json({ error: 'Failed to feature portfolio' })
  }
})

// ── GET /api/admin/users ───────────────────────────
// List all users with portfolio count
router.get('/users', async (req, res) => {
  if (!DB_MODE) {
    const result = []
    for (const [, u] of MEM.users) {
      let portfolioCount = 0
      for (const [, p] of MEM.portfolios) {
        if (p.user_id === u.id && !p.is_archived) portfolioCount++
      }
      result.push({
        id: u.id, username: u.username, email: u.email,
        displayName: u.displayName, role: u.role || 'user',
        isVerified: u.isVerified, isActive: u.isActive !== false,
        createdAt: u.createdAt, portfolioCount,
      })
    }
    result.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    return res.json(result)
  }

  try {
    const r = await query(
      `SELECT u.id, u.username, u.email, u.display_name, u.role,
              u.is_verified, u.is_active, u.created_at,
              COUNT(p.id) FILTER (WHERE p.is_archived = FALSE) AS portfolio_count
       FROM users u
       LEFT JOIN portfolios p ON p.user_id = u.id
       GROUP BY u.id
       ORDER BY u.created_at DESC`
    )
    return res.json(r.rows.map(u => ({
      ...u,
      portfolioCount: parseInt(u.portfolio_count || 0),
    })))
  } catch (err) {
    console.error('[admin/users]', err.message)
    return res.status(500).json({ error: 'Failed to fetch users' })
  }
})

// ── GET /api/admin/access-logs ─────────────────────
// Recent access logs with pagination
router.get('/access-logs', async (req, res) => {
  const page   = Math.max(1, parseInt(req.query.page || '1', 10))
  const limit  = Math.min(100, Math.max(1, parseInt(req.query.limit || '50', 10)))
  const offset = (page - 1) * limit

  if (!DB_MODE) {
    // In-memory: no access logs stored
    return res.json({ logs: [], total: 0, page, limit, note: 'Access logs not available in demo mode' })
  }

  try {
    const [dataRes, countRes] = await Promise.all([
      query(
        `SELECT al.id, al.action, al.ip_address, al.metadata, al.created_at,
                u.id AS actor_id, u.username AS actor_username, u.email AS actor_email,
                p.id AS portfolio_id, p.name AS portfolio_name
         FROM access_logs al
         LEFT JOIN users      u ON u.id = al.actor_user_id
         LEFT JOIN portfolios p ON p.id = al.target_portfolio_id
         ORDER BY al.created_at DESC
         LIMIT $1 OFFSET $2`,
        [limit, offset]
      ),
      query('SELECT COUNT(*) AS total FROM access_logs'),
    ])
    return res.json({
      logs:  dataRes.rows,
      total: parseInt(countRes.rows[0]?.total || 0),
      page, limit,
    })
  } catch (err) {
    console.error('[admin/access-logs]', err.message)
    return res.status(500).json({ error: 'Failed to fetch access logs' })
  }
})

// ── DELETE /api/admin/users/:id/lock ───────────────
// Lock (deactivate) a user account
router.delete('/users/:id/lock', async (req, res) => {
  const targetId = req.params.id

  // Prevent locking self
  if (targetId === req.user.userId)
    return res.status(400).json({ error: 'Cannot lock your own account' })

  if (!DB_MODE) {
    const user = MEM.users.get(targetId)
    if (!user) return res.status(404).json({ error: 'User not found' })
    user.isActive = false
    // Revoke all their sessions
    for (const [k, v] of MEM.tokens) {
      if (v.userId === targetId) MEM.tokens.delete(k)
    }
    return res.json({ ok: true, message: `User ${user.email} has been locked` })
  }

  try {
    const r = await query(
      `UPDATE users SET is_active = FALSE WHERE id = $1
       RETURNING id, email, username`,
      [targetId]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' })

    // Revoke all their refresh tokens
    await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1 AND revoked_at IS NULL', [targetId])
    logAccess(req.user.userId, null, 'admin_lock_user', req, { lockedUserId: targetId })

    return res.json({ ok: true, message: `User ${r.rows[0].email} has been locked` })
  } catch (err) {
    console.error('[admin/users/lock]', err.message)
    return res.status(500).json({ error: 'Failed to lock user' })
  }
})

module.exports = router
