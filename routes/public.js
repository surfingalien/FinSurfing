'use strict'
/**
 * Public portfolio discovery routes — no authentication required.
 * All routes are rate-limited to 60 req/min per IP (applied in server.js).
 *
 * GET /api/public/portfolios
 * GET /api/public/portfolios/:id
 * GET /api/public/users/:username/portfolio
 */
const express = require('express')
const { optionalAuth } = require('../middleware/auth')
const { sanitizeHolding, sanitizePortfolio } = require('../middleware/sanitize')
const { query } = require('../db/db')
const { MEM }   = require('../db/memstore')

const router = express.Router()
router.use(optionalAuth)

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

// ── Helpers ────────────────────────────────────────
function clampInt(val, min, max) {
  const n = parseInt(val, 10)
  if (isNaN(n)) return min
  return Math.max(min, Math.min(max, n))
}

// ── GET /api/public/portfolios ─────────────────────
// Discover public portfolios with optional search + sort + pagination
router.get('/portfolios', async (req, res) => {
  const q     = (req.query.q || '').trim()
  const sort  = req.query.sort || 'newest'  // newest | holdings
  const page  = clampInt(req.query.page, 1, 1000)
  const limit = clampInt(req.query.limit, 1, 20)
  const offset = (page - 1) * limit

  if (!DB_MODE) {
    // In-memory: filter MEM portfolios by visibility=public
    let results = []
    for (const [, p] of MEM.portfolios) {
      if (p.visibility !== 'public' || p.is_archived) continue
      const owner = MEM.users.get(p.user_id)
      if (!owner || !owner.isVerified) continue
      const holdings = MEM.holdings.get(p.id) || []
      if (q) {
        const sq = q.toLowerCase()
        const match = p.name?.toLowerCase().includes(sq) ||
                      owner.username?.toLowerCase().includes(sq)
        if (!match) continue
      }
      results.push({
        ...sanitizePortfolio(p),
        holdingCount: holdings.length,
        owner: { username: owner.username, displayName: owner.displayName },
      })
    }

    if (sort === 'holdings') results.sort((a, b) => b.holdingCount - a.holdingCount)
    else results.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))

    const paginated = results.slice(offset, offset + limit)
    return res.json({ portfolios: paginated, total: results.length, page, limit })
  }

  try {
    const conditions = ['p.visibility = \'public\'', 'p.is_archived = FALSE', 'u.is_active = TRUE']
    const params = []

    if (q) {
      params.push(`%${q}%`)
      conditions.push(`(p.name ILIKE $${params.length} OR u.username ILIKE $${params.length})`)
    }

    const where = conditions.join(' AND ')

    let orderBy = 'p.created_at DESC'
    if (sort === 'holdings') orderBy = 'holding_count DESC'

    params.push(limit, offset)
    const dataQuery = `
      SELECT p.id, p.name, p.description, p.visibility, p.copy_trade_enabled,
             p.color, p.is_featured, p.created_at, p.updated_at,
             u.id AS user_id, u.username, u.display_name,
             COUNT(h.id) AS holding_count
      FROM portfolios p
      JOIN  users    u ON u.id = p.user_id
      LEFT JOIN holdings h ON h.portfolio_id = p.id
      WHERE ${where}
      GROUP BY p.id, u.id
      ORDER BY ${orderBy}
      LIMIT $${params.length - 1} OFFSET $${params.length}`

    const countParams = params.slice(0, params.length - 2)
    const countQuery  = `
      SELECT COUNT(DISTINCT p.id) AS total
      FROM portfolios p
      JOIN users u ON u.id = p.user_id
      WHERE ${where}`

    const [dataRes, countRes] = await Promise.all([
      query(dataQuery, params),
      query(countQuery, countParams),
    ])

    return res.json({
      portfolios: dataRes.rows.map(p => ({ ...p, holdingCount: parseInt(p.holding_count) })),
      total: parseInt(countRes.rows[0]?.total || 0),
      page, limit,
    })
  } catch (err) {
    console.error('[public/portfolios]', err.message)
    return res.status(500).json({ error: 'Failed to fetch public portfolios' })
  }
})

// ── GET /api/public/portfolios/:id ─────────────────
// View a specific public portfolio (or one shared with the requester)
router.get('/portfolios/:id', async (req, res) => {
  const viewerId = req.user?.userId || null

  if (!DB_MODE) {
    const p = MEM.portfolios.get(req.params.id)
    if (!p || p.is_archived) return res.status(404).json({ error: 'Portfolio not found' })

    let canView = p.visibility === 'public'
    if (!canView && viewerId) {
      // Check shares
      for (const [, s] of MEM.shares) {
        if (s.portfolio_id === p.id && s.shared_with_user_id === viewerId) {
          if (!s.expires_at || new Date(s.expires_at) > new Date()) { canView = true; break }
        }
      }
    }
    if (!canView) return res.status(403).json({ error: 'This portfolio is private' })

    const owner    = MEM.users.get(p.user_id) || {}
    const holdings = MEM.holdings.get(p.id) || []
    return res.json({
      portfolio: sanitizePortfolio(p),
      holdings:  holdings.map(sanitizeHolding),
      owner:     { username: owner.username, displayName: owner.displayName },
      disclaimer: 'Cost basis and private details are hidden.',
    })
  }

  try {
    const pRes = await query(
      `SELECT p.*, u.username, u.display_name
       FROM portfolios p JOIN users u ON u.id = p.user_id
       WHERE p.id = $1 AND p.is_archived = FALSE AND u.is_active = TRUE`,
      [req.params.id]
    )
    const p = pRes.rows[0]
    if (!p) return res.status(404).json({ error: 'Portfolio not found' })

    // Check access
    let canView = p.visibility === 'public'
    if (!canView && viewerId) {
      const sr = await query(
        `SELECT id FROM portfolio_shares
         WHERE portfolio_id = $1 AND shared_with_user_id = $2
         AND (expires_at IS NULL OR expires_at > NOW())`,
        [p.id, viewerId]
      )
      canView = sr.rows.length > 0
    }
    if (!canView) return res.status(403).json({ error: 'This portfolio is private' })

    const hRes = await query(
      `SELECT id, symbol, name, shares, sector, asset_class, created_at
       FROM holdings WHERE portfolio_id = $1 ORDER BY symbol`,
      [p.id]
    )

    logAccess(viewerId, p.id, 'view_public', req)

    return res.json({
      portfolio: sanitizePortfolio({ ...p, cashBalance: undefined }),
      holdings:  hRes.rows.map(h => sanitizeHolding({
        id: h.id, symbol: h.symbol, name: h.name,
        shares: parseFloat(h.shares), sector: h.sector, assetClass: h.asset_class,
      })),
      owner:     { username: p.username, displayName: p.display_name },
      disclaimer: 'Cost basis and private details are hidden.',
    })
  } catch (err) {
    console.error('[public/portfolios/:id]', err.message)
    return res.status(500).json({ error: 'Failed to fetch portfolio' })
  }
})

// ── GET /api/public/users/:username/portfolio ──────
// Find a user's public portfolio by username
router.get('/users/:username/portfolio', async (req, res) => {
  const { username } = req.params
  const viewerId = req.user?.userId || null

  if (!DB_MODE) {
    const uid = MEM.byUsername.get(username)
    if (!uid) return res.status(404).json({ error: 'User not found' })
    const owner = MEM.users.get(uid)
    if (!owner) return res.status(404).json({ error: 'User not found' })

    // Find their public portfolio
    let publicPortfolio = null
    for (const [, p] of MEM.portfolios) {
      if (p.user_id === uid && p.visibility === 'public' && !p.is_archived) {
        publicPortfolio = p
        break
      }
    }
    if (!publicPortfolio) return res.status(404).json({ error: 'No public portfolio found for this user' })

    const holdings = MEM.holdings.get(publicPortfolio.id) || []
    return res.json({
      portfolio: sanitizePortfolio(publicPortfolio),
      holdings:  holdings.map(sanitizeHolding),
      owner:     { username: owner.username, displayName: owner.displayName },
      disclaimer: 'Cost basis and private details are hidden.',
    })
  }

  try {
    const uRes = await query(
      'SELECT id, username, display_name FROM users WHERE username = $1 AND is_active = TRUE',
      [username]
    )
    const owner = uRes.rows[0]
    if (!owner) return res.status(404).json({ error: 'User not found' })

    const pRes = await query(
      `SELECT * FROM portfolios
       WHERE user_id = $1 AND visibility = 'public' AND is_archived = FALSE
       ORDER BY is_default DESC, created_at DESC
       LIMIT 1`,
      [owner.id]
    )
    const p = pRes.rows[0]
    if (!p) return res.status(404).json({ error: 'No public portfolio found for this user' })

    const hRes = await query(
      `SELECT id, symbol, name, shares, sector, asset_class
       FROM holdings WHERE portfolio_id = $1 ORDER BY symbol`,
      [p.id]
    )

    logAccess(viewerId, p.id, 'view_public', req, { via: 'username' })

    return res.json({
      portfolio: sanitizePortfolio(p),
      holdings:  hRes.rows.map(h => sanitizeHolding({
        id: h.id, symbol: h.symbol, name: h.name,
        shares: parseFloat(h.shares), sector: h.sector, assetClass: h.asset_class,
      })),
      owner:     { username: owner.username, displayName: owner.display_name },
      disclaimer: 'Cost basis and private details are hidden.',
    })
  } catch (err) {
    console.error('[public/users/:username/portfolio]', err.message)
    return res.status(500).json({ error: 'Failed to fetch portfolio' })
  }
})

// ── GET /api/public/trader/:username ───────────────
// Returns AI-Trader public profile: bio, recent signals, follower count
router.get('/trader/:username', async (req, res) => {
  const { username } = req.params

  if (!DB_MODE) return res.status(503).json({ error: 'Trader profiles require database mode' })

  try {
    const uRes = await query(
      `SELECT id, username, display_name, ai_trader_agent_id, ai_trader_registered_at
       FROM users WHERE username = $1 AND is_active = TRUE`,
      [username]
    )
    const owner = uRes.rows[0]
    if (!owner || !owner.ai_trader_agent_id)
      return res.status(404).json({ error: 'Trader not found or not registered on AI-Trader' })

    // Recent signals
    const sigRes = await query(
      `SELECT symbol, direction, timeframe, conviction, analysis,
              entry_price, pnl_1d, pnl_7d, pnl_30d, created_at
       FROM ai_trader_signals
       WHERE user_id = $1
       ORDER BY created_at DESC LIMIT 20`,
      [owner.id]
    )

    // Follower count (how many users follow this trader on our platform)
    const followRes = await query(
      `SELECT COUNT(*) AS cnt FROM ai_trader_following WHERE following_agent_id = $1`,
      [owner.ai_trader_agent_id]
    )

    // Win-rate from signals with pnl_1d data
    const signals = sigRes.rows
    const scored  = signals.filter(s => s.pnl_1d != null)
    const wins    = scored.filter(s => {
      const pnl = parseFloat(s.pnl_1d)
      return s.direction === 'buy' ? pnl > 0 : pnl < 0
    })
    const winRate = scored.length > 0 ? +((wins.length / scored.length) * 100).toFixed(1) : null

    return res.json({
      username:      owner.username,
      displayName:   owner.display_name,
      agentId:       owner.ai_trader_agent_id,
      memberSince:   owner.ai_trader_registered_at,
      followers:     parseInt(followRes.rows[0]?.cnt || 0),
      totalSignals:  signals.length,
      winRate,
      recentSignals: signals.map(s => ({
        symbol:    s.symbol,
        direction: s.direction,
        timeframe: s.timeframe,
        conviction: s.conviction,
        analysis:  s.analysis,
        entryPrice: s.entry_price ? parseFloat(s.entry_price) : null,
        pnl1d:  s.pnl_1d  ? parseFloat(s.pnl_1d)  : null,
        pnl7d:  s.pnl_7d  ? parseFloat(s.pnl_7d)  : null,
        pnl30d: s.pnl_30d ? parseFloat(s.pnl_30d) : null,
        publishedAt: s.created_at,
      })),
    })
  } catch (err) {
    console.error('[public/trader/:username]', err.message)
    return res.status(500).json({ error: 'Failed to fetch trader profile' })
  }
})

module.exports = router
