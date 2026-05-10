'use strict'
/**
 * Admin portfolio holdings — sourced from Portfolio_Positions_Apr-21-2026.numbers
 * (Fidelity Individual TOD account, exact quantities and average cost bases).
 *
 * Used by:
 *   - routes/auth.js  → in-memory (no-DB) admin seeding
 *   - server.js       → DB-mode startup seeding
 *
 * The portfolio is marked visibility='private' + is_system=true so it is
 * NEVER shown to any other user, regardless of public-discovery routes.
 */

const crypto = require('crypto')
const bcrypt  = require('bcryptjs')

// ── Holdings from the Numbers file ───────────────────────────────────────────
const ADMIN_HOLDINGS = [
  { symbol: 'AAPL',  name: 'Apple Inc.',                      shares: 10,  avgCost: 150.46, sector: 'Technology',            assetClass: 'equity' },
  { symbol: 'ADSK',  name: 'Autodesk Inc.',                   shares: 10,  avgCost: 256.17, sector: 'Technology',            assetClass: 'equity' },
  { symbol: 'AMD',   name: 'Advanced Micro Devices Inc.',     shares: 10,  avgCost: 131.19, sector: 'Technology',            assetClass: 'equity' },
  { symbol: 'AMZN',  name: 'Amazon.com Inc.',                 shares: 10,  avgCost: 166.61, sector: 'Consumer Cyclical',     assetClass: 'equity' },
  { symbol: 'AVGO',  name: 'Broadcom Inc.',                   shares: 10,  avgCost: 177.54, sector: 'Technology',            assetClass: 'equity' },
  { symbol: 'BABA',  name: 'Alibaba Group Holding Ltd.',      shares: 10,  avgCost: 188.38, sector: 'Consumer Cyclical',     assetClass: 'equity' },
  { symbol: 'BROS',  name: 'Dutch Bros Inc.',                 shares: 15,  avgCost: 63.48,  sector: 'Consumer Cyclical',     assetClass: 'equity' },
  { symbol: 'CL',    name: 'Colgate-Palmolive Co.',           shares: 15,  avgCost: 94.64,  sector: 'Consumer Defensive',    assetClass: 'equity' },
  { symbol: 'COIN',  name: 'Coinbase Global Inc. Class A',    shares: 15,  avgCost: 257.11, sector: 'Financial Services',    assetClass: 'equity' },
  { symbol: 'GOOG',  name: 'Alphabet Inc. Class C',           shares: 10,  avgCost: 165.77, sector: 'Communication Services',assetClass: 'equity' },
  { symbol: 'INTC',  name: 'Intel Corp.',                     shares: 25,  avgCost: 19.54,  sector: 'Technology',            assetClass: 'equity' },
  { symbol: 'MSFT',  name: 'Microsoft Corp.',                 shares: 10,  avgCost: 400.57, sector: 'Technology',            assetClass: 'equity' },
  { symbol: 'NVDA',  name: 'NVIDIA Corp.',                    shares: 50,  avgCost: 112.07, sector: 'Technology',            assetClass: 'equity' },
  { symbol: 'ORCL',  name: 'Oracle Corp.',                    shares: 15,  avgCost: 265.80, sector: 'Technology',            assetClass: 'equity' },
  { symbol: 'PG',    name: 'Procter & Gamble Co.',            shares: 10,  avgCost: 157.15, sector: 'Consumer Defensive',    assetClass: 'equity' },
  { symbol: 'QCOM',  name: 'Qualcomm Inc.',                   shares: 10,  avgCost: 163.21, sector: 'Technology',            assetClass: 'equity' },
  { symbol: 'SOUN',  name: 'SoundHound AI Inc.',              shares: 150, avgCost: 15.45,  sector: 'Technology',            assetClass: 'equity' },
  { symbol: 'TSLA',  name: 'Tesla Inc.',                      shares: 15,  avgCost: 216.75, sector: 'Consumer Cyclical',     assetClass: 'equity' },
  { symbol: 'TSM',   name: 'Taiwan Semiconductor Mfg. Co.',  shares: 20,  avgCost: 180.51, sector: 'Technology',            assetClass: 'equity' },
  { symbol: 'TXN',   name: 'Texas Instruments Inc.',          shares: 10,  avgCost: 207.26, sector: 'Technology',            assetClass: 'equity' },
  { symbol: 'XOM',   name: 'Exxon Mobil Corp.',               shares: 10,  avgCost: 147.72, sector: 'Energy',                assetClass: 'equity' },
]

// ── DB-mode: seed admin user + portfolio + holdings at startup ────────────────
async function seedAdminDB(query) {
  const ADMIN_EMAIL    = (process.env.ADMIN_EMAIL || '').toLowerCase()
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''
  if (!ADMIN_EMAIL || !ADMIN_PASSWORD) return

  try {
    // 1. Upsert admin user
    const hash = await bcrypt.hash(ADMIN_PASSWORD, 12)
    const username = ADMIN_EMAIL.split('@')[0].replace(/[^a-z0-9_]/gi, '_').toLowerCase()

    await query(`
      INSERT INTO users (email, username, display_name, password_hash, role, email_verified, created_at, updated_at)
      VALUES ($1, $2, 'Admin', $3, 'admin', TRUE, NOW(), NOW())
      ON CONFLICT (email) DO UPDATE
        SET role = 'admin', email_verified = TRUE, updated_at = NOW()
    `, [ADMIN_EMAIL, username, hash])

    // 2. Get admin user id
    const { rows: [adminUser] } = await query(
      'SELECT id FROM users WHERE email = $1', [ADMIN_EMAIL]
    )
    if (!adminUser) return

    // 3. Ensure admin portfolio exists
    const { rows: existingPortfolios } = await query(
      `SELECT id FROM portfolios WHERE user_id = $1 AND is_system = TRUE LIMIT 1`,
      [adminUser.id]
    )

    let portfolioId
    if (existingPortfolios.length > 0) {
      portfolioId = existingPortfolios[0].id
    } else {
      const { rows: [newPort] } = await query(`
        INSERT INTO portfolios
          (user_id, name, type, description, currency, color,
           is_default, is_archived, visibility, is_system, copy_trade_enabled, created_at, updated_at)
        VALUES ($1, 'My Portfolio', 'brokerage', 'Fidelity Individual TOD Account',
                'USD', '#ff6b6b', TRUE, FALSE, 'private', TRUE, FALSE, NOW(), NOW())
        RETURNING id
      `, [adminUser.id])
      portfolioId = newPort.id
    }

    // 4. Seed holdings only if portfolio is empty
    const { rows: [{ count }] } = await query(
      'SELECT COUNT(*) FROM holdings WHERE portfolio_id = $1', [portfolioId]
    )
    if (parseInt(count) > 0) {
      console.log('[ADMIN SEED] Holdings already present — skipping')
      return
    }

    for (const h of ADMIN_HOLDINGS) {
      await query(`
        INSERT INTO holdings
          (portfolio_id, symbol, name, shares, avg_cost, sector, asset_class, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        ON CONFLICT DO NOTHING
      `, [portfolioId, h.symbol, h.name, h.shares, h.avgCost, h.sector, h.assetClass])
    }

    console.log(`[ADMIN SEED] Seeded ${ADMIN_HOLDINGS.length} holdings into admin portfolio (DB)`)
  } catch (err) {
    console.error('[ADMIN SEED] DB seed failed:', err.message)
  }
}

// ── Memory-mode: returns ready-to-use holdings array ─────────────────────────
function makeAdminHoldings(portfolioId) {
  return ADMIN_HOLDINGS.map(h => ({
    id:          'ah-' + crypto.randomBytes(6).toString('hex'),
    portfolio_id: portfolioId,
    symbol:      h.symbol,
    name:        h.name,
    shares:      h.shares,
    avgCost:     h.avgCost,
    avg_cost:    h.avgCost,
    sector:      h.sector,
    assetClass:  h.assetClass,
    asset_class: h.assetClass,
    created_at:  new Date().toISOString(),
    updated_at:  new Date().toISOString(),
  }))
}

module.exports = { ADMIN_HOLDINGS, seedAdminDB, makeAdminHoldings }
