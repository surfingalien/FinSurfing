'use strict'

/**
 * routes/trading.js
 *
 * AI-Trader integration — Phase 1 + Phase 2
 *
 * POST /api/trading/register-agent   — create / refresh AI-Trader agent for this user
 * POST /api/trading/publish-signal   — publish a trading signal to AI-Trader network
 * GET  /api/trading/my-signals       — signals this user has published
 * GET  /api/trading/notifications    — unread notifications (also polls heartbeat)
 * POST /api/trading/notifications/read — mark notifications read
 * GET  /api/trading/market-context   — market intel for a symbol (Phase 4)
 */

const express    = require('express')
const crypto     = require('crypto')
const router     = express.Router()
const { requireAuth } = require('../middleware/auth')
const at         = require('../services/aiTraderClient')

// ── DB helpers (gracefully no-op when DATABASE_URL is absent) ─────────────────

function getDB() {
  if (!process.env.DATABASE_URL) return null
  return require('../db/db')
}

async function dbQuery(text, params) {
  const db = getDB()
  if (!db) return { rows: [] }
  return db.query(text, params)
}

// ── Ensure a user has a registered AI-Trader agent ────────────────────────────

async function ensureAgent(userId, email, displayName) {
  // Check if already registered
  const { rows } = await dbQuery(
    'SELECT ai_trader_token, ai_trader_agent_id FROM users WHERE id = $1',
    [userId]
  )

  if (rows[0]?.ai_trader_token) {
    return { token: rows[0].ai_trader_token, agentId: rows[0].ai_trader_agent_id }
  }

  // Generate a deterministic-ish agent name and a secure password
  const agentName = `FinSurf-${(displayName || email.split('@')[0]).replace(/[^a-zA-Z0-9]/g, '').slice(0, 20)}`
  const agentEmail = `finsurf+${userId.replace(/-/g, '').slice(0, 12)}@ai-trader.finsurf.app`
  const agentPass  = crypto.randomBytes(24).toString('base64url')

  let token, agentId

  try {
    const reg = await at.registerAgent({ name: agentName, email: agentEmail, password: agentPass })
    token   = reg.token || reg.access_token || reg.data?.token
    agentId = reg.agent?.id || reg.data?.id || reg.id
  } catch (err) {
    // Agent may already exist — try login
    if (err.status === 409 || err.status === 400) {
      const login = await at.loginAgent({ email: agentEmail, password: agentPass })
      token   = login.token || login.access_token || login.data?.token
      agentId = login.agent?.id || login.data?.id || login.id
    } else {
      throw err
    }
  }

  if (!token) throw new Error('AI-Trader registration did not return a token')

  await dbQuery(
    `UPDATE users
       SET ai_trader_token = $1, ai_trader_agent_id = $2, ai_trader_registered_at = NOW()
     WHERE id = $3`,
    [token, agentId ?? null, userId]
  )

  return { token, agentId }
}

// ── POST /api/trading/register-agent ─────────────────────────────────────────

router.post('/register-agent', requireAuth, async (req, res) => {
  try {
    const { userId, email } = req.user
    const { rows } = await dbQuery('SELECT display_name FROM users WHERE id = $1', [userId])
    const displayName = rows[0]?.display_name || null

    const { token, agentId } = await ensureAgent(userId, email, displayName)
    res.json({ ok: true, agentId, registered: true })
  } catch (err) {
    console.error('[trading] register-agent error:', err.message)
    res.status(502).json({ error: err.message })
  }
})

// ── POST /api/trading/publish-signal ─────────────────────────────────────────

router.post('/publish-signal', requireAuth, async (req, res) => {
  const { symbol, action, price, quantity, analysis } = req.body || {}

  if (!symbol || !action) {
    return res.status(400).json({ error: 'symbol and action are required' })
  }

  const validActions = ['buy', 'sell', 'short', 'cover']
  if (!validActions.includes(action.toLowerCase())) {
    return res.status(400).json({ error: `action must be one of: ${validActions.join(', ')}` })
  }

  try {
    const { userId, email } = req.user
    const { rows } = await dbQuery('SELECT display_name FROM users WHERE id = $1', [userId])
    const { token } = await ensureAgent(userId, email, rows[0]?.display_name)

    const result = await at.publishSignal(token, {
      action: action.toLowerCase(),
      symbol: symbol.toUpperCase(),
      price:  price  ? parseFloat(price)  : undefined,
      quantity: quantity ? parseInt(quantity) : undefined,
      content: analysis || `FinSurf AI analysis for ${symbol.toUpperCase()}: ${action.toUpperCase()} signal`,
    })

    const signalId = result?.signal?.id || result?.data?.id || result?.id || null

    // Persist locally for history
    await dbQuery(
      `INSERT INTO ai_trader_signals
         (user_id, at_signal_id, symbol, action, price, quantity, analysis)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [userId, signalId ? String(signalId) : null, symbol.toUpperCase(), action.toLowerCase(),
       price ? parseFloat(price) : null, quantity ? parseInt(quantity) : null, analysis || null]
    )

    res.json({ ok: true, signalId, result })
  } catch (err) {
    console.error('[trading] publish-signal error:', err.message)
    res.status(502).json({ error: err.message })
  }
})

// ── GET /api/trading/my-signals ───────────────────────────────────────────────

router.get('/my-signals', requireAuth, async (req, res) => {
  try {
    const { rows } = await dbQuery(
      `SELECT id, at_signal_id, symbol, action, price, quantity, analysis, followers, published_at
         FROM ai_trader_signals
        WHERE user_id = $1
        ORDER BY published_at DESC
        LIMIT 50`,
      [req.user.userId]
    )
    res.json({ signals: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/trading/notifications ───────────────────────────────────────────

router.get('/notifications', requireAuth, async (req, res) => {
  const { userId } = req.user

  // Best-effort: poll AI-Trader heartbeat to pick up new messages
  try {
    const { rows: userRow } = await dbQuery(
      'SELECT ai_trader_token FROM users WHERE id = $1',
      [userId]
    )
    const token = userRow[0]?.ai_trader_token
    if (token) {
      const hb = await at.pollHeartbeat(token).catch(() => null)
      if (hb?.messages?.length) {
        for (const msg of hb.messages) {
          await dbQuery(
            `INSERT INTO ai_trader_notifications (user_id, type, data)
             VALUES ($1, $2, $3)
             ON CONFLICT DO NOTHING`,
            [userId, msg.type || 'info', JSON.stringify(msg)]
          ).catch(() => {})
        }
      }
    }
  } catch {}

  try {
    const { rows } = await dbQuery(
      `SELECT id, type, data, is_read, created_at
         FROM ai_trader_notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 30`,
      [userId]
    )
    res.json({ notifications: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/trading/notifications/read ─────────────────────────────────────

router.post('/notifications/read', requireAuth, async (req, res) => {
  const { ids } = req.body || {}
  try {
    if (ids?.length) {
      await dbQuery(
        `UPDATE ai_trader_notifications SET is_read = TRUE
          WHERE user_id = $1 AND id = ANY($2::uuid[])`,
        [req.user.userId, ids]
      )
    } else {
      await dbQuery(
        'UPDATE ai_trader_notifications SET is_read = TRUE WHERE user_id = $1',
        [req.user.userId]
      )
    }
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/trading/status ───────────────────────────────────────────────────

router.get('/status', requireAuth, async (req, res) => {
  try {
    const { rows } = await dbQuery(
      `SELECT ai_trader_agent_id, ai_trader_registered_at,
              (SELECT COUNT(*) FROM ai_trader_signals WHERE user_id = $1) AS signal_count,
              (SELECT COUNT(*) FROM ai_trader_notifications WHERE user_id = $1 AND is_read = FALSE) AS unread_count
         FROM users WHERE id = $1`,
      [req.user.userId]
    )
    const r = rows[0] || {}
    res.json({
      registered:   !!r.ai_trader_agent_id,
      agentId:      r.ai_trader_agent_id,
      registeredAt: r.ai_trader_registered_at,
      signalCount:  parseInt(r.signal_count || 0),
      unreadCount:  parseInt(r.unread_count || 0),
    })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/trading/market-context ──────────────────────────────────────────

router.get('/market-context', async (req, res) => {
  const { symbol } = req.query
  try {
    const [overview, news] = await Promise.allSettled([
      at.getMarketOverview(),
      at.getMarketNews(symbol),
    ])
    res.json({
      symbol: symbol || null,
      overview: overview.status === 'fulfilled' ? overview.value : null,
      news:     news.status     === 'fulfilled' ? news.value     : null,
    })
  } catch (err) {
    res.status(502).json({ error: err.message })
  }
})

module.exports = router
module.exports.ensureAgent = ensureAgent
