'use strict'
/**
 * Portfolio routes — full CRUD for portfolios + holdings + sharing.
 * All routes require a valid access token (requireAuth middleware).
 * Row-level security enforced by always filtering on user_id = req.user.userId.
 *
 * Demo mode (no DATABASE_URL): uses shared MEM store from db/memstore.js
 */
const express   = require('express')
const crypto    = require('crypto')
const { query } = require('../db/db')
const { requireAuth } = require('../middleware/auth')
const { MEM }   = require('../db/memstore')

const router = express.Router()
router.use(requireAuth)

const DB_MODE = !!process.env.DATABASE_URL

const DEMO_PORTFOLIOS = [
  {
    id: 'demo-p1', name: 'Main Brokerage', type: 'brokerage',
    description: 'Primary demo portfolio', currency: 'USD',
    tax_status: 'taxable', custodian: 'Demo Broker',
    cash_balance: 5000, color: '#00ffcc', icon: null,
    is_default: true, is_archived: false,
    visibility: 'private', is_system: false, copy_trade_enabled: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    cashBalance: 5000, holdingCount: 4,
  },
  {
    id: 'demo-p2', name: 'Roth IRA', type: 'roth_ira',
    description: 'Retirement demo account', currency: 'USD',
    tax_status: 'tax_free', custodian: 'Demo IRA',
    cash_balance: 1500, color: '#6366f1', icon: null,
    is_default: false, is_archived: false,
    visibility: 'private', is_system: false, copy_trade_enabled: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    cashBalance: 1500, holdingCount: 2,
  },
]
const DEMO_HOLDINGS = {
  'demo-p1': [
    { id: 'h1', symbol: 'AAPL', name: 'Apple Inc.', shares: 10, avgCost: 150, sector: 'Technology', assetClass: 'equity' },
    { id: 'h2', symbol: 'MSFT', name: 'Microsoft Corp.', shares: 5, avgCost: 290, sector: 'Technology', assetClass: 'equity' },
    { id: 'h3', symbol: 'NVDA', name: 'NVIDIA Corp.', shares: 8, avgCost: 420, sector: 'Technology', assetClass: 'equity' },
    { id: 'h4', symbol: 'SPY',  name: 'SPDR S&P 500 ETF', shares: 20, avgCost: 440, sector: 'Index', assetClass: 'etf' },
  ],
  'demo-p2': [
    { id: 'h5', symbol: 'QQQ', name: 'Invesco QQQ Trust', shares: 5, avgCost: 380, sector: 'Index', assetClass: 'etf' },
    { id: 'h6', symbol: 'BRK-B', name: 'Berkshire Hathaway B', shares: 3, avgCost: 340, sector: 'Financials', assetClass: 'equity' },
  ],
}

// Allowed portfolio types (sync with schema enum)
const VALID_TYPES = [
  'brokerage', 'roth_ira', 'traditional_ira', '401k', '403b',
  'mutual_fund', 'crypto', 'hsa', 'paper', 'cash', 'other',
]

const VALID_VISIBILITY = ['private', 'public', 'followers_only']

// ── Async access logger (fire-and-forget) ─────────
function logAccess(actorUserId, portfolioId, action, req, meta = {}) {
  if (!DB_MODE) return // skip in memory mode for simplicity
  query(
    `INSERT INTO access_logs (actor_user_id, target_portfolio_id, action, ip_address, metadata)
     VALUES ($1, $2, $3, $4, $5)`,
    [actorUserId || null, portfolioId || null, action, req.ip, JSON.stringify(meta)]
  ).catch(() => {})  // never block
}

// ── Ownership check helper ─────────────────────────
function ownsPortfolio(portfolio, userId, role) {
  if (role === 'admin') return true
  return portfolio.user_id === userId
}

// ── GET /api/portfolios (alias: /api/portfolios/mine) ───────────────────
// List all portfolios for the authenticated user
router.get('/', async (req, res) => {
  if (DB_MODE) {
    try {
      const r = await query(
        `SELECT p.id, p.name, p.type, p.description, p.currency, p.tax_status,
                p.custodian, p.cash_balance, p.color, p.icon,
                p.is_default, p.is_archived, p.visibility, p.is_system,
                p.copy_trade_enabled, p.is_featured,
                p.created_at, p.updated_at,
                COUNT(h.id) AS holding_count
         FROM portfolios p
         LEFT JOIN holdings h ON h.portfolio_id = p.id
         WHERE p.user_id = $1 AND p.is_archived = FALSE
         GROUP BY p.id
         ORDER BY p.is_default DESC, p.created_at ASC`,
        [req.user.userId]
      )
      return res.json(r.rows.map(row => ({
        ...row,
        cashBalance:  parseFloat(row.cash_balance),
        holdingCount: parseInt(row.holding_count),
      })))
    } catch (err) {
      console.error('[portfolios/list]', err.message)
      return res.status(500).json({ error: 'Failed to load portfolios' })
    }
  }

  // In-memory mode
  const userPortfolios = []
  for (const [, p] of MEM.portfolios) {
    if (p.user_id === req.user.userId && !p.is_archived) {
      const holdings = MEM.holdings.get(p.id) || []
      userPortfolios.push({ ...p, holdingCount: holdings.length })
    }
  }
  userPortfolios.sort((a, b) =>
    (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) ||
    new Date(a.created_at) - new Date(b.created_at)
  )
  return res.json(userPortfolios)
})

// Alias: GET /api/portfolios/mine — same as GET /
router.get('/mine', async (req, res) => {
  if (DB_MODE) {
    try {
      const r = await query(
        `SELECT p.id, p.name, p.type, p.description, p.currency, p.tax_status,
                p.custodian, p.cash_balance, p.color, p.icon,
                p.is_default, p.is_archived, p.visibility, p.is_system,
                p.copy_trade_enabled, p.is_featured,
                p.created_at, p.updated_at,
                COUNT(h.id) AS holding_count
         FROM portfolios p
         LEFT JOIN holdings h ON h.portfolio_id = p.id
         WHERE p.user_id = $1 AND p.is_archived = FALSE
         GROUP BY p.id
         ORDER BY p.is_default DESC, p.created_at ASC`,
        [req.user.userId]
      )
      return res.json(r.rows.map(row => ({
        ...row,
        cashBalance:  parseFloat(row.cash_balance),
        holdingCount: parseInt(row.holding_count),
      })))
    } catch (err) {
      console.error('[portfolios/mine]', err.message)
      return res.status(500).json({ error: 'Failed to load portfolios' })
    }
  }
  // In-memory
  const userPortfolios = []
  for (const [, p] of MEM.portfolios) {
    if (p.user_id === req.user.userId && !p.is_archived) {
      const holdings = MEM.holdings.get(p.id) || []
      userPortfolios.push({ ...p, holdingCount: holdings.length })
    }
  }
  userPortfolios.sort((a, b) =>
    (b.is_default ? 1 : 0) - (a.is_default ? 1 : 0) ||
    new Date(a.created_at) - new Date(b.created_at)
  )
  return res.json(userPortfolios)
})

// ── POST /api/portfolios ──────────────────────────
router.post('/', async (req, res) => {
  const { name, type = 'brokerage', description, currency = 'USD',
          taxStatus = 'taxable', custodian, cashBalance = 0, color = '#6366f1', icon } = req.body

  if (!name?.trim()) return res.status(400).json({ error: 'Portfolio name is required' })
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid portfolio type' })

  if (!DB_MODE) {
    const pid = 'port-' + crypto.randomBytes(8).toString('hex')
    const p = {
      id: pid, user_id: req.user.userId,
      name: name.trim().slice(0, 100), type, description: description || null,
      currency, tax_status: taxStatus, custodian: custodian || null,
      cash_balance: parseFloat(cashBalance) || 0, color: color || '#6366f1', icon: icon || null,
      is_default: false, is_archived: false,
      visibility: 'private', is_system: false, is_featured: false, copy_trade_enabled: false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    }
    MEM.portfolios.set(pid, p)
    MEM.holdings.set(pid, [])
    return res.status(201).json(p)
  }

  try {
    const r = await query(
      `INSERT INTO portfolios
         (user_id, name, type, description, currency, tax_status, custodian, cash_balance, color, icon)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.user.userId, name.trim().slice(0, 100), type, description?.slice(0, 500),
       currency, taxStatus, custodian?.slice(0, 100), cashBalance, color, icon]
    )
    return res.status(201).json(r.rows[0])
  } catch (err) {
    console.error('[portfolios/create]', err.message)
    return res.status(500).json({ error: 'Failed to create portfolio' })
  }
})

// ── GET /api/portfolios/:id ───────────────────────
router.get('/:id', async (req, res) => {
  if (!DB_MODE) {
    const p = MEM.portfolios.get(req.params.id)
    if (!p || p.is_archived) return res.status(404).json({ error: 'Portfolio not found' })
    if (!ownsPortfolio(p, req.user.userId, req.user.role))
      return res.status(403).json({ error: 'Access denied' })
    const rawHoldings = MEM.holdings.get(p.id) || []
    // Normalize to same shape as DB mode
    const holdings = rawHoldings.map(h => ({
      id:         h.id,
      symbol:     h.symbol,
      name:       h.name,
      shares:     parseFloat(h.shares),
      avgCost:    parseFloat(h.avgCost ?? h.avg_cost_basis ?? h.avg_cost ?? 0),
      sector:     h.sector || null,
      assetClass: h.assetClass || h.asset_class || 'equity',
      createdAt:  h.created_at,
    }))
    return res.json({ ...p, holdings })
  }

  try {
    const pRes = await query(
      `SELECT * FROM portfolios WHERE id = $1 AND user_id = $2`,
      [req.params.id, req.user.userId]
    )
    if (!pRes.rows[0]) return res.status(404).json({ error: 'Portfolio not found' })

    const hRes = await query(
      `SELECT id, symbol, name, shares, avg_cost_basis, sector, asset_class, created_at
       FROM holdings WHERE portfolio_id = $1 ORDER BY symbol`,
      [req.params.id]
    )

    const p = pRes.rows[0]
    logAccess(req.user.userId, p.id, 'view_private', req)
    return res.json({
      ...p,
      cashBalance: parseFloat(p.cash_balance),
      holdings: hRes.rows.map(h => ({
        id: h.id, symbol: h.symbol, name: h.name,
        shares:    parseFloat(h.shares),
        avgCost:   parseFloat(h.avg_cost_basis),
        sector:    h.sector, assetClass: h.asset_class,
        createdAt: h.created_at,
      })),
    })
  } catch (err) {
    console.error('[portfolios/get]', err.message)
    return res.status(500).json({ error: 'Failed to load portfolio' })
  }
})

// ── PATCH /api/portfolios/:id ─────────────────────
router.patch('/:id', async (req, res) => {
  const { name, description, custodian, cashBalance, color, icon, taxStatus } = req.body

  if (!DB_MODE) {
    const p = MEM.portfolios.get(req.params.id)
    if (!p || p.is_archived) return res.status(404).json({ error: 'Portfolio not found' })
    if (!ownsPortfolio(p, req.user.userId, req.user.role))
      return res.status(403).json({ error: 'You can only edit your own portfolio' })
    if (req.user.role !== 'admin' && p.user_id !== req.user.userId)
      return res.status(403).json({ error: 'You can only edit your own portfolio' })
    if (name !== undefined)        p.name         = name.trim().slice(0, 100)
    if (description !== undefined) p.description  = description
    if (custodian !== undefined)   p.custodian    = custodian
    if (cashBalance !== undefined) p.cash_balance = parseFloat(cashBalance)
    if (color !== undefined)       p.color        = color
    if (icon !== undefined)        p.icon         = icon
    if (taxStatus !== undefined)   p.tax_status   = taxStatus
    p.updated_at = new Date().toISOString()
    return res.json(p)
  }

  try {
    const check = await query(
      'SELECT id, user_id FROM portfolios WHERE id = $1',
      [req.params.id]
    )
    if (!check.rows[0]) return res.status(404).json({ error: 'Portfolio not found' })
    if (req.user.role !== 'admin' && check.rows[0].user_id !== req.user.userId)
      return res.status(403).json({ error: 'You can only edit your own portfolio' })

    const r = await query(
      `UPDATE portfolios SET
         name         = COALESCE($1, name),
         description  = COALESCE($2, description),
         custodian    = COALESCE($3, custodian),
         cash_balance = COALESCE($4, cash_balance),
         color        = COALESCE($5, color),
         icon         = COALESCE($6, icon),
         tax_status   = COALESCE($7::tax_status, tax_status)
       WHERE id = $8 AND user_id = $9
       RETURNING *`,
      [name?.trim().slice(0, 100), description?.slice(0, 500),
       custodian?.slice(0, 100), cashBalance, color, icon,
       taxStatus, req.params.id, req.user.userId]
    )
    return res.json(r.rows[0])
  } catch (err) {
    console.error('[portfolios/update]', err.message)
    return res.status(500).json({ error: 'Failed to update portfolio' })
  }
})

// ── PATCH /api/portfolios/:id/visibility ──────────
router.patch('/:id/visibility', async (req, res) => {
  const { visibility, copyTradeEnabled } = req.body

  if (visibility && !VALID_VISIBILITY.includes(visibility))
    return res.status(400).json({ error: `visibility must be one of: ${VALID_VISIBILITY.join(', ')}` })

  if (!DB_MODE) {
    const p = MEM.portfolios.get(req.params.id)
    if (!p || p.is_archived) return res.status(404).json({ error: 'Portfolio not found' })
    if (p.user_id !== req.user.userId)
      return res.status(403).json({ error: 'You can only change visibility of your own portfolio' })
    if (visibility !== undefined)        p.visibility         = visibility
    if (copyTradeEnabled !== undefined)  p.copy_trade_enabled = !!copyTradeEnabled
    p.updated_at = new Date().toISOString()
    return res.json({ ok: true, portfolio: p })
  }

  try {
    const check = await query(
      'SELECT id, user_id FROM portfolios WHERE id = $1 AND is_archived = FALSE',
      [req.params.id]
    )
    if (!check.rows[0]) return res.status(404).json({ error: 'Portfolio not found' })
    if (check.rows[0].user_id !== req.user.userId)
      return res.status(403).json({ error: 'You can only change visibility of your own portfolio' })

    const r = await query(
      `UPDATE portfolios SET
         visibility          = COALESCE($1, visibility),
         copy_trade_enabled  = COALESCE($2, copy_trade_enabled)
       WHERE id = $3
       RETURNING id, name, visibility, copy_trade_enabled`,
      [visibility || null, copyTradeEnabled !== undefined ? !!copyTradeEnabled : null, req.params.id]
    )
    return res.json({ ok: true, portfolio: r.rows[0] })
  } catch (err) {
    console.error('[portfolios/visibility]', err.message)
    return res.status(500).json({ error: 'Failed to update visibility' })
  }
})

// ── POST /api/portfolios/:id/set-default ─────────
router.post('/:id/set-default', async (req, res) => {
  if (!DB_MODE) {
    const p = MEM.portfolios.get(req.params.id)
    if (!p || p.user_id !== req.user.userId) return res.status(404).json({ error: 'Portfolio not found' })
    for (const [, port] of MEM.portfolios) {
      if (port.user_id === req.user.userId) port.is_default = false
    }
    p.is_default = true
    return res.json({ ok: true })
  }
  try {
    const check = await query(
      'SELECT id FROM portfolios WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    )
    if (!check.rows[0]) return res.status(404).json({ error: 'Portfolio not found' })

    await query('UPDATE portfolios SET is_default = FALSE WHERE user_id = $1', [req.user.userId])
    await query('UPDATE portfolios SET is_default = TRUE  WHERE id = $1',      [req.params.id])

    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to set default' })
  }
})

// ── DELETE /api/portfolios/:id ────────────────────
router.delete('/:id', async (req, res) => {
  if (!DB_MODE) {
    const p = MEM.portfolios.get(req.params.id)
    if (!p || p.user_id !== req.user.userId) return res.status(404).json({ error: 'Portfolio not found' })
    if (p.is_default) return res.status(400).json({ error: 'Cannot delete the default portfolio.' })
    p.is_archived = true
    return res.json({ ok: true })
  }
  try {
    const check = await query(
      'SELECT id, is_default FROM portfolios WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    )
    if (!check.rows[0]) return res.status(404).json({ error: 'Portfolio not found' })
    if (check.rows[0].is_default) return res.status(400).json({ error: 'Cannot delete the default portfolio. Set another as default first.' })

    await query('UPDATE portfolios SET is_archived = TRUE WHERE id = $1', [req.params.id])
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete portfolio' })
  }
})

// ── GET /api/portfolios/:id/shares ────────────────
router.get('/:id/shares', async (req, res) => {
  if (!DB_MODE) {
    const p = MEM.portfolios.get(req.params.id)
    if (!p || p.user_id !== req.user.userId) return res.status(403).json({ error: 'Not your portfolio' })
    const result = []
    for (const [, s] of MEM.shares) {
      if (s.portfolio_id === req.params.id) {
        const target = MEM.users.get(s.shared_with_user_id)
        result.push({ ...s, sharedWith: target ? { id: target.id, username: target.username, email: target.email } : null })
      }
    }
    return res.json(result)
  }

  try {
    const check = await query(
      'SELECT id FROM portfolios WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    )
    if (!check.rows[0]) return res.status(403).json({ error: 'Not your portfolio' })

    const r = await query(
      `SELECT ps.id, ps.portfolio_id, ps.permission, ps.expires_at, ps.created_at,
              u.id AS shared_with_id, u.username, u.display_name, u.email
       FROM portfolio_shares ps
       JOIN users u ON u.id = ps.shared_with_user_id
       WHERE ps.portfolio_id = $1
       ORDER BY ps.created_at DESC`,
      [req.params.id]
    )
    return res.json(r.rows)
  } catch (err) {
    console.error('[portfolios/shares/list]', err.message)
    return res.status(500).json({ error: 'Failed to list shares' })
  }
})

// ── POST /api/portfolios/:id/shares ──────────────
router.post('/:id/shares', async (req, res) => {
  const { username, email, permission = 'view', expiresAt } = req.body

  if (!username && !email)
    return res.status(400).json({ error: 'username or email required' })
  if (!['view', 'copy_trade'].includes(permission))
    return res.status(400).json({ error: 'permission must be view or copy_trade' })

  if (!DB_MODE) {
    const p = MEM.portfolios.get(req.params.id)
    if (!p || p.user_id !== req.user.userId) return res.status(403).json({ error: 'Not your portfolio' })

    // Find target user
    let targetId = null
    if (username) targetId = MEM.byUsername.get(username)
    else if (email) targetId = MEM.byEmail.get(email.toLowerCase())
    if (!targetId) return res.status(404).json({ error: 'User not found' })
    if (targetId === req.user.userId) return res.status(400).json({ error: 'Cannot share with yourself' })

    // Check for existing share
    for (const [, s] of MEM.shares) {
      if (s.portfolio_id === req.params.id && s.shared_with_user_id === targetId)
        return res.status(409).json({ error: 'Share already exists for this user' })
    }

    const shareId = 'share-' + crypto.randomBytes(6).toString('hex')
    const share = {
      id: shareId, portfolio_id: req.params.id,
      shared_with_user_id: targetId, permission,
      expires_at: expiresAt || null,
      created_at: new Date().toISOString(),
    }
    MEM.shares.set(shareId, share)
    return res.status(201).json(share)
  }

  try {
    // Verify ownership
    const check = await query('SELECT id FROM portfolios WHERE id = $1 AND user_id = $2', [req.params.id, req.user.userId])
    if (!check.rows[0]) return res.status(403).json({ error: 'Not your portfolio' })

    // Find target user
    let userQuery, userParams
    if (username) {
      userQuery = 'SELECT id FROM users WHERE username = $1 AND is_active = TRUE'
      userParams = [username]
    } else {
      userQuery = 'SELECT id FROM users WHERE email = $1 AND is_active = TRUE'
      userParams = [email.toLowerCase()]
    }
    const uRes = await query(userQuery, userParams)
    if (!uRes.rows[0]) return res.status(404).json({ error: 'User not found' })
    const targetId = uRes.rows[0].id
    if (targetId === req.user.userId) return res.status(400).json({ error: 'Cannot share with yourself' })

    const r = await query(
      `INSERT INTO portfolio_shares (portfolio_id, shared_with_user_id, permission, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (portfolio_id, shared_with_user_id)
       DO UPDATE SET permission = EXCLUDED.permission, expires_at = EXCLUDED.expires_at
       RETURNING *`,
      [req.params.id, targetId, permission, expiresAt || null]
    )
    return res.status(201).json(r.rows[0])
  } catch (err) {
    console.error('[portfolios/shares/create]', err.message)
    return res.status(500).json({ error: 'Failed to create share' })
  }
})

// ── DELETE /api/portfolios/:id/shares/:shareId ────
router.delete('/:id/shares/:shareId', async (req, res) => {
  if (!DB_MODE) {
    const p = MEM.portfolios.get(req.params.id)
    if (!p || p.user_id !== req.user.userId) return res.status(403).json({ error: 'Not your portfolio' })
    const share = MEM.shares.get(req.params.shareId)
    if (!share || share.portfolio_id !== req.params.id) return res.status(404).json({ error: 'Share not found' })
    MEM.shares.delete(req.params.shareId)
    return res.json({ ok: true })
  }

  try {
    const check = await query('SELECT id FROM portfolios WHERE id = $1 AND user_id = $2', [req.params.id, req.user.userId])
    if (!check.rows[0]) return res.status(403).json({ error: 'Not your portfolio' })

    const r = await query(
      'DELETE FROM portfolio_shares WHERE id = $1 AND portfolio_id = $2 RETURNING id',
      [req.params.shareId, req.params.id]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'Share not found' })
    return res.json({ ok: true })
  } catch (err) {
    console.error('[portfolios/shares/delete]', err.message)
    return res.status(500).json({ error: 'Failed to revoke share' })
  }
})

// ── POST /api/portfolios/:id/holdings ────────────
router.post('/:id/holdings', async (req, res) => {
  const { symbol, name, shares, avgCost, sector, assetClass = 'equity' } = req.body
  if (!symbol?.trim()) return res.status(400).json({ error: 'Symbol required' })
  if (isNaN(shares) || shares <= 0) return res.status(400).json({ error: 'Valid shares required' })
  if (isNaN(avgCost) || avgCost < 0) return res.status(400).json({ error: 'Valid avg cost required' })

  if (!DB_MODE) {
    const p = MEM.portfolios.get(req.params.id)
    if (!p || p.user_id !== req.user.userId) return res.status(404).json({ error: 'Portfolio not found' })
    const holdings = MEM.holdings.get(req.params.id) || []
    const sym = symbol.toUpperCase().trim()
    const idx = holdings.findIndex(h => h.symbol === sym)
    const holding = {
      id: idx >= 0 ? holdings[idx].id : 'h-' + crypto.randomBytes(6).toString('hex'),
      symbol: sym, name: name || sym,
      shares: parseFloat(shares), avg_cost_basis: parseFloat(avgCost),
      sector: sector || null, asset_class: assetClass,
      created_at: idx >= 0 ? holdings[idx].created_at : new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }
    if (idx >= 0) holdings[idx] = holding
    else holdings.push(holding)
    MEM.holdings.set(req.params.id, holdings)
    return res.status(201).json({ id: holding.id, symbol: holding.symbol, shares: holding.shares, avgCost: holding.avg_cost_basis, sector: holding.sector })
  }

  try {
    const check = await query(
      'SELECT id FROM portfolios WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    )
    if (!check.rows[0]) return res.status(404).json({ error: 'Portfolio not found' })

    const r = await query(
      `INSERT INTO holdings (portfolio_id, symbol, name, shares, avg_cost_basis, sector, asset_class)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (portfolio_id, symbol)
       DO UPDATE SET
         shares         = EXCLUDED.shares,
         avg_cost_basis = EXCLUDED.avg_cost_basis,
         name           = COALESCE(EXCLUDED.name, holdings.name),
         sector         = COALESCE(EXCLUDED.sector, holdings.sector),
         asset_class    = EXCLUDED.asset_class,
         updated_at     = NOW()
       RETURNING *`,
      [req.params.id, symbol.toUpperCase().trim(), name, shares, avgCost, sector, assetClass]
    )
    const h = r.rows[0]
    return res.status(201).json({
      id: h.id, symbol: h.symbol, shares: parseFloat(h.shares),
      avgCost: parseFloat(h.avg_cost_basis), sector: h.sector,
    })
  } catch (err) {
    console.error('[holdings/upsert]', err.message)
    return res.status(500).json({ error: 'Failed to save holding' })
  }
})

// ── DELETE /api/portfolios/:id/holdings/:hid ─────
router.delete('/:id/holdings/:hid', async (req, res) => {
  if (!DB_MODE) {
    const p = MEM.portfolios.get(req.params.id)
    if (!p || p.user_id !== req.user.userId) return res.status(404).json({ error: 'Portfolio not found' })
    const holdings = MEM.holdings.get(req.params.id) || []
    const idx = holdings.findIndex(h => h.id === req.params.hid)
    if (idx < 0) return res.status(404).json({ error: 'Holding not found' })
    holdings.splice(idx, 1)
    return res.json({ ok: true })
  }

  try {
    const r = await query(
      `DELETE FROM holdings h
       USING portfolios p
       WHERE h.id = $1 AND h.portfolio_id = p.id AND p.user_id = $2
       RETURNING h.id`,
      [req.params.hid, req.user.userId]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'Holding not found' })
    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to delete holding' })
  }
})

// ── POST /api/portfolios/:id/import ──────────────
router.post('/:id/import', async (req, res) => {
  const { holdings } = req.body
  if (!Array.isArray(holdings) || !holdings.length)
    return res.status(400).json({ error: 'holdings array required' })

  if (!DB_MODE) {
    const p = MEM.portfolios.get(req.params.id)
    if (!p || p.user_id !== req.user.userId) return res.status(404).json({ error: 'Portfolio not found' })
    const existing = MEM.holdings.get(req.params.id) || []
    let imported = 0
    for (const h of holdings) {
      if (!h.symbol || isNaN(h.shares) || isNaN(h.avgCost ?? h.avg_cost_basis)) continue
      const sym = h.symbol.toUpperCase()
      const found = existing.findIndex(e => e.symbol === sym)
      if (found >= 0) continue  // DO NOTHING on conflict
      existing.push({
        id: 'h-' + crypto.randomBytes(6).toString('hex'),
        symbol: sym, name: h.name || sym,
        shares: parseFloat(h.shares),
        avg_cost_basis: parseFloat(h.avgCost ?? h.avg_cost_basis ?? 0),
        sector: h.sector || null, asset_class: h.assetClass || 'equity',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      })
      imported++
    }
    MEM.holdings.set(req.params.id, existing)
    return res.json({ ok: true, imported })
  }

  try {
    const check = await query(
      'SELECT id FROM portfolios WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    )
    if (!check.rows[0]) return res.status(404).json({ error: 'Portfolio not found' })

    let imported = 0
    for (const h of holdings) {
      if (!h.symbol || isNaN(h.shares) || isNaN(h.avgCost ?? h.avg_cost_basis)) continue
      await query(
        `INSERT INTO holdings (portfolio_id, symbol, name, shares, avg_cost_basis, sector)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (portfolio_id, symbol) DO NOTHING`,
        [req.params.id, h.symbol.toUpperCase(), h.name || null,
         h.shares, h.avgCost ?? h.avg_cost_basis ?? 0, h.sector || null]
      )
      imported++
    }
    return res.json({ ok: true, imported })
  } catch (err) {
    console.error('[holdings/import]', err.message)
    return res.status(500).json({ error: 'Import failed' })
  }
})

module.exports = router
