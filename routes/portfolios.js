'use strict'
/**
 * Portfolio routes — full CRUD for portfolios + holdings.
 * All routes require a valid access token (requireAuth middleware).
 * Row-level security enforced by always filtering on user_id = req.user.userId.
 *
 * Demo mode (no DATABASE_URL): returns hardcoded demo portfolios; write ops are no-ops.
 */
const express   = require('express')
const { query } = require('../db/db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

const DEMO_MODE = !process.env.DATABASE_URL
const DEMO_PORTFOLIOS = [
  {
    id: 'demo-p1', name: 'Main Brokerage', type: 'brokerage',
    description: 'Primary demo portfolio', currency: 'USD',
    tax_status: 'taxable', custodian: 'Demo Broker',
    cash_balance: 5000, color: '#00ffcc', icon: null,
    is_default: true, is_archived: false,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    cashBalance: 5000, holdingCount: 4,
  },
  {
    id: 'demo-p2', name: 'Roth IRA', type: 'roth_ira',
    description: 'Retirement demo account', currency: 'USD',
    tax_status: 'tax_free', custodian: 'Demo IRA',
    cash_balance: 1500, color: '#6366f1', icon: null,
    is_default: false, is_archived: false,
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

// ── GET /api/portfolios ───────────────────────────
// List all portfolios for the authenticated user
router.get('/', async (req, res) => {
  if (DEMO_MODE) return res.json(DEMO_PORTFOLIOS)
  try {
    const r = await query(
      `SELECT p.id, p.name, p.type, p.description, p.currency, p.tax_status,
              p.custodian, p.cash_balance, p.color, p.icon,
              p.is_default, p.is_archived, p.created_at, p.updated_at,
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
})

// ── POST /api/portfolios ──────────────────────────
// Create a new portfolio
router.post('/', async (req, res) => {
  if (DEMO_MODE) return res.status(201).json({ ...DEMO_PORTFOLIOS[0], id: 'demo-new-' + Date.now(), name: req.body.name || 'New Portfolio', is_default: false })
  const { name, type = 'brokerage', description, currency = 'USD',
          taxStatus = 'taxable', custodian, cashBalance = 0, color = '#6366f1', icon } = req.body

  if (!name?.trim()) return res.status(400).json({ error: 'Portfolio name is required' })
  if (!VALID_TYPES.includes(type)) return res.status(400).json({ error: 'Invalid portfolio type' })

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
// Get single portfolio with holdings
router.get('/:id', async (req, res) => {
  if (DEMO_MODE) {
    const p = DEMO_PORTFOLIOS.find(p => p.id === req.params.id)
    if (!p) return res.status(404).json({ error: 'Portfolio not found' })
    return res.json({ ...p, holdings: DEMO_HOLDINGS[p.id] || [] })
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
// Update portfolio metadata
router.patch('/:id', async (req, res) => {
  if (DEMO_MODE) {
    const p = DEMO_PORTFOLIOS.find(p => p.id === req.params.id)
    return res.json(p || DEMO_PORTFOLIOS[0])
  }
  const { name, description, custodian, cashBalance, color, icon, taxStatus } = req.body

  try {
    // Verify ownership before updating
    const check = await query(
      'SELECT id FROM portfolios WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    )
    if (!check.rows[0]) return res.status(404).json({ error: 'Portfolio not found' })

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

// ── POST /api/portfolios/:id/set-default ─────────
router.post('/:id/set-default', async (req, res) => {
  if (DEMO_MODE) return res.json({ ok: true })
  try {
    // Verify ownership
    const check = await query(
      'SELECT id FROM portfolios WHERE id = $1 AND user_id = $2',
      [req.params.id, req.user.userId]
    )
    if (!check.rows[0]) return res.status(404).json({ error: 'Portfolio not found' })

    // Unset existing default, set new one
    await query('UPDATE portfolios SET is_default = FALSE WHERE user_id = $1', [req.user.userId])
    await query('UPDATE portfolios SET is_default = TRUE  WHERE id = $1',      [req.params.id])

    return res.json({ ok: true })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to set default' })
  }
})

// ── DELETE /api/portfolios/:id ────────────────────
// Soft-delete (archive). Cannot delete the default portfolio.
router.delete('/:id', async (req, res) => {
  if (DEMO_MODE) return res.json({ ok: true })
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

// ── POST /api/portfolios/:id/holdings ────────────
// Add or update a holding (upsert by symbol)
router.post('/:id/holdings', async (req, res) => {
  if (DEMO_MODE) return res.status(201).json({ id: 'demo-h-' + Date.now(), symbol: req.body.symbol, shares: req.body.shares, avgCost: req.body.avgCost })
  const { symbol, name, shares, avgCost, sector, assetClass = 'equity' } = req.body
  if (!symbol?.trim()) return res.status(400).json({ error: 'Symbol required' })
  if (isNaN(shares) || shares <= 0) return res.status(400).json({ error: 'Valid shares required' })
  if (isNaN(avgCost) || avgCost < 0) return res.status(400).json({ error: 'Valid avg cost required' })

  // Verify portfolio ownership
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
  if (DEMO_MODE) return res.json({ ok: true })
  try {
    // JOIN ensures user owns the portfolio
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
// Bulk import holdings (e.g. from existing localStorage data)
router.post('/:id/import', async (req, res) => {
  if (DEMO_MODE) return res.json({ ok: true, imported: req.body.holdings?.length ?? 0 })
  const { holdings } = req.body
  if (!Array.isArray(holdings) || !holdings.length)
    return res.status(400).json({ error: 'holdings array required' })

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
