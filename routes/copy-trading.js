'use strict'

/**
 * routes/copy-trading.js
 *
 * AI-Trader Copy Trading — Phase 3
 *
 * GET  /api/copy-trading/leaderboard        — top traders from AI-Trader
 * GET  /api/copy-trading/following          — traders this user follows
 * POST /api/copy-trading/follow/:leaderId   — follow a trader
 * POST /api/copy-trading/unfollow/:leaderId — unfollow a trader
 * GET  /api/copy-trading/signals/:leaderId  — recent signals from a leader
 */

const express    = require('express')
const router     = express.Router()
const { requireAuth, optionalAuth } = require('../middleware/auth')
const at         = require('../services/aiTraderClient')

async function dbQuery(text, params) {
  if (!process.env.DATABASE_URL) return { rows: [] }
  const db = require('../db/db')
  return db.query(text, params)
}

// ── GET /api/copy-trading/leaderboard ─────────────────────────────────────────

router.get('/leaderboard', optionalAuth, async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit || '20'), 50)
    const data  = await at.getTopTraders({ limit })

    // Normalise whatever shape AI-Trader returns
    const traders = (data?.traders || data?.data || data?.result || data || [])
    res.json({ traders: Array.isArray(traders) ? traders : [] })
  } catch (err) {
    console.error('[copy-trading] leaderboard error:', err.message)
    // Return empty list rather than 502 so UI degrades gracefully
    res.json({ traders: [], error: err.message })
  }
})

// ── GET /api/copy-trading/following ──────────────────────────────────────────

router.get('/following', requireAuth, async (req, res) => {
  try {
    const { rows } = await dbQuery(
      `SELECT leader_id, leader_name, followed_at
         FROM ai_trader_following
        WHERE user_id = $1
        ORDER BY followed_at DESC`,
      [req.user.userId]
    )
    res.json({ following: rows })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── POST /api/copy-trading/follow/:leaderId ───────────────────────────────────

router.post('/follow/:leaderId', requireAuth, async (req, res) => {
  const { leaderId } = req.params
  const { leaderName } = req.body || {}

  if (!leaderId) return res.status(400).json({ error: 'leaderId required' })

  try {
    const { userId, email } = req.user
    const { rows: userRow } = await dbQuery('SELECT display_name, ai_trader_token FROM users WHERE id = $1', [userId])
    const token = userRow[0]?.ai_trader_token

    // Best-effort notify AI-Trader (some versions expose a follow endpoint)
    if (token) {
      await at.followTrader(token, leaderId).catch(() => {})
    }

    // Store locally
    await dbQuery(
      `INSERT INTO ai_trader_following (user_id, leader_id, leader_name)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, leader_id) DO NOTHING`,
      [userId, leaderId, leaderName || null]
    )

    res.json({ ok: true, following: true })
  } catch (err) {
    console.error('[copy-trading] follow error:', err.message)
    res.status(502).json({ error: err.message })
  }
})

// ── POST /api/copy-trading/unfollow/:leaderId ─────────────────────────────────

router.post('/unfollow/:leaderId', requireAuth, async (req, res) => {
  const { leaderId } = req.params
  try {
    const { userId } = req.user
    const { rows: userRow } = await dbQuery('SELECT ai_trader_token FROM users WHERE id = $1', [userId])
    const token = userRow[0]?.ai_trader_token

    if (token) {
      await at.unfollowTrader(token, leaderId).catch(() => {})
    }

    await dbQuery(
      'DELETE FROM ai_trader_following WHERE user_id = $1 AND leader_id = $2',
      [userId, leaderId]
    )

    res.json({ ok: true, following: false })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/copy-trading/signals/:leaderId ───────────────────────────────────

router.get('/signals/:leaderId', optionalAuth, async (req, res) => {
  const { leaderId } = req.params
  try {
    const data = await at.getSignalsBySymbol(leaderId, { limit: 20 })
    const signals = data?.signals || data?.data || data?.result || data || []
    res.json({ signals: Array.isArray(signals) ? signals : [] })
  } catch (err) {
    res.json({ signals: [], error: err.message })
  }
})

module.exports = router
