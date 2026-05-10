'use strict'
/**
 * Auth routes — register, login, logout, refresh, /me, forgot-password, reset-password
 *
 * Demo / no-DB mode:
 *   When DATABASE_URL is not set the server runs in demo mode.
 *   A single hardcoded admin account works without any database:
 *     email:    admin@finsurf.app
 *     password: Admin@demo1
 *   Refresh tokens are stored in-memory (lost on restart, fine for demos).
 *   All other routes return 503 "DB not configured" in demo mode.
 *
 * Production mode (DATABASE_URL + JWT_SECRET set):
 *   Full bcrypt, refresh-token rotation, lockout, audit logs, password reset.
 */
const express   = require('express')
const bcrypt    = require('bcryptjs')
const jwt       = require('jsonwebtoken')
const crypto    = require('crypto')
const { query, pool } = require('../db/db')
const { requireAuth, SECRET } = require('../middleware/auth')

const router = express.Router()

// ── Config ────────────────────────────────────────
const ACCESS_TTL       = 15 * 60          // 15 minutes (seconds)
const REFRESH_TTL_DAYS = 7
const BCRYPT_ROUNDS    = 12
const MAX_ATTEMPTS     = 5
const LOCKOUT_MINUTES  = 15
const REFRESH_COOKIE   = 'finsurf_rt'
const DEMO_MODE        = !process.env.DATABASE_URL

// Cookie options
const cookieOpts = (remember = true) => ({
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  ...(remember ? { maxAge: REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000 } : {}),
  path: '/api/auth',
})

// ── Demo mode ─────────────────────────────────────
// In-memory refresh token store for demo/no-DB mode
const demoSessions = new Map() // token_hash → { userId, expiresAt }

// Pre-hashed password for "Admin@demo1" (bcrypt 12 rounds)
// Computed once at startup to avoid delay on first login
let DEMO_HASH = null
;(async () => {
  DEMO_HASH = await bcrypt.hash('Admin@demo1', BCRYPT_ROUNDS)
})()

const DEMO_USER = {
  id:          'demo-admin-001',
  email:       'admin@finsurf.app',
  displayName: 'Admin',
  is_active:   true,
}

// Demo portfolios returned in-memory for the demo user
const DEMO_PORTFOLIOS = [
  {
    id: 'demo-p1', name: 'Main Brokerage', type: 'brokerage',
    is_default: true, is_archived: false, color: '#00ffcc',
    cashBalance: 5000, holdingCount: 4, tax_status: 'taxable',
    custodian: 'Demo Broker', description: 'Primary demo portfolio',
  },
  {
    id: 'demo-p2', name: 'Roth IRA', type: 'roth_ira',
    is_default: false, is_archived: false, color: '#6366f1',
    cashBalance: 1500, holdingCount: 2, tax_status: 'tax_free',
    custodian: 'Demo IRA', description: 'Retirement account',
  },
]

// ── Helpers ───────────────────────────────────────
function issueAccessToken(userId, email) {
  return jwt.sign(
    { sub: userId, email },
    SECRET,
    { algorithm: 'HS256', expiresIn: ACCESS_TTL }
  )
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex')
}

async function issueRefreshTokenDB(userId, req) {
  const raw  = crypto.randomBytes(32).toString('hex')
  const hash = sha256(raw)
  const exp  = new Date(Date.now() + REFRESH_TTL_DAYS * 86400000)
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, hash, JSON.stringify({ ua: req.headers['user-agent']?.slice(0, 200) }), req.ip, exp]
  )
  return raw
}

function issueRefreshTokenDemo(userId) {
  const raw  = crypto.randomBytes(32).toString('hex')
  const hash = sha256(raw)
  demoSessions.set(hash, { userId, expiresAt: Date.now() + REFRESH_TTL_DAYS * 86400000 })
  return raw
}

async function auditLog(userId, event, req, metadata = {}) {
  if (DEMO_MODE) return // no DB
  try {
    await query(
      `INSERT INTO auth_logs (user_id, event, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, event, req.ip, req.headers['user-agent']?.slice(0, 300), JSON.stringify(metadata)]
    )
  } catch { /* never let audit failure break the request */ }
}

function validateEmail(e)  { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 255 }
function validatePassword(p) {
  return typeof p === 'string' && p.length >= 8 && p.length <= 128
    && /[a-zA-Z]/.test(p) && /\d/.test(p)
}

// ── Shared login response builder ─────────────────
async function buildLoginResponse(res, user, req, remember = true, isDemo = false) {
  const accessToken   = issueAccessToken(user.id, user.email)
  const refreshToken  = isDemo
    ? issueRefreshTokenDemo(user.id)
    : await issueRefreshTokenDB(user.id, req)

  res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts(remember))
  return res.json({
    accessToken,
    expiresIn: ACCESS_TTL,
    user: { id: user.id, email: user.email, displayName: user.displayName ?? user.display_name },
  })
}

// ── POST /api/auth/register ───────────────────────
router.post('/register', async (req, res) => {
  if (DEMO_MODE) {
    return res.status(503).json({
      error: 'Registration is disabled in demo mode. Use admin@finsurf.app / Admin@demo1 to log in.',
    })
  }

  const { email, password, displayName } = req.body
  if (!email || !validateEmail(email))
    return res.status(400).json({ error: 'Valid email required' })
  if (!password || !validatePassword(password))
    return res.status(400).json({ error: 'Password must be 8+ characters with a letter and number' })

  try {
    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    if (existing.rows.length)
      return res.status(409).json({ error: 'An account with that email already exists' })

    const userRes = await query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3) RETURNING id, email, display_name`,
      [email.toLowerCase(), hash, displayName?.trim().slice(0, 100) || null]
    )
    const user = userRes.rows[0]

    await query(
      `INSERT INTO portfolios (user_id, name, type, is_default, color)
       VALUES ($1, 'My Portfolio', 'brokerage', TRUE, '#00ffcc')`,
      [user.id]
    )

    await auditLog(user.id, 'register', req)
    return buildLoginResponse(res, { id: user.id, email: user.email, displayName: user.display_name }, req)
  } catch (err) {
    console.error('[auth/register]', err.message)
    return res.status(500).json({ error: 'Registration failed — try again' })
  }
})

// ── POST /api/auth/login ──────────────────────────
router.post('/login', async (req, res) => {
  const { email, password, rememberMe } = req.body
  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' })

  // ── Demo mode fast-path ───────────────────────
  if (DEMO_MODE) {
    if (email.toLowerCase() !== DEMO_USER.email)
      return res.status(401).json({ error: 'Invalid email or password' })

    // DEMO_HASH computed at startup; if still null (very fast start) compute inline
    const hash = DEMO_HASH || await bcrypt.hash('Admin@demo1', BCRYPT_ROUNDS)
    const match = await bcrypt.compare(password, hash)
    if (!match)
      return res.status(401).json({ error: 'Invalid email or password' })

    console.log(`[AUTH] Demo login: ${DEMO_USER.email}`)
    return buildLoginResponse(res, DEMO_USER, req, !!rememberMe, true)
  }

  // ── Full DB path ──────────────────────────────
  try {
    const userRes = await query(
      `SELECT id, email, display_name, password_hash, is_active,
              failed_login_attempts, locked_until
       FROM users WHERE email = $1`,
      [email.toLowerCase()]
    )

    const dummyHash = '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewHHg9/EFzxUbX1u'
    const user = userRes.rows[0]
    const hashToCheck = user?.password_hash || dummyHash

    if (user?.locked_until && new Date(user.locked_until) > new Date()) {
      await auditLog(user.id, 'login_failed', req, { reason: 'account_locked' })
      return res.status(429).json({
        error: `Account locked. Try again after ${new Date(user.locked_until).toLocaleTimeString()}.`
      })
    }

    const match = await bcrypt.compare(password, hashToCheck)

    if (!user || !match || !user.is_active) {
      if (user) {
        const attempts = user.failed_login_attempts + 1
        const lockedUntil = attempts >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60000) : null
        await query(
          'UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3',
          [Math.min(attempts, MAX_ATTEMPTS + 5), lockedUntil, user.id]
        )
        await auditLog(user.id, 'login_failed', req, { attempt: attempts })
        if (lockedUntil)
          return res.status(429).json({ error: `Too many failed attempts. Locked for ${LOCKOUT_MINUTES} min.` })
      }
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    await query('UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1', [user.id])
    await auditLog(user.id, 'login_success', req)
    return buildLoginResponse(
      res, { id: user.id, email: user.email, displayName: user.display_name }, req, !!rememberMe
    )
  } catch (err) {
    console.error('[auth/login]', err.message)
    return res.status(500).json({ error: 'Login failed — try again' })
  }
})

// ── POST /api/auth/refresh ────────────────────────
router.post('/refresh', async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE]
  if (!raw) return res.status(401).json({ error: 'No refresh token' })

  const hash = sha256(raw)

  // ── Demo mode ─────────────────────────────────
  if (DEMO_MODE) {
    const session = demoSessions.get(hash)
    if (!session || session.expiresAt < Date.now()) {
      demoSessions.delete(hash)
      res.clearCookie(REFRESH_COOKIE)
      return res.status(401).json({ error: 'Session expired — please log in again' })
    }
    demoSessions.delete(hash)
    const newRaw = issueRefreshTokenDemo(DEMO_USER.id)
    res.cookie(REFRESH_COOKIE, newRaw, cookieOpts())
    return res.json({
      accessToken: issueAccessToken(DEMO_USER.id, DEMO_USER.email),
      expiresIn:   ACCESS_TTL,
      user:        { id: DEMO_USER.id, email: DEMO_USER.email, displayName: DEMO_USER.displayName },
    })
  }

  // ── Full DB path ──────────────────────────────
  try {
    const tokenRes = await query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
              u.email, u.display_name, u.is_active
       FROM refresh_tokens rt JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [hash]
    )
    const rt = tokenRes.rows[0]

    if (!rt || rt.revoked_at || new Date(rt.expires_at) < new Date() || !rt.is_active) {
      if (rt) {
        await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1', [rt.user_id])
        await auditLog(rt.user_id, 'token_reuse_detected', req)
      }
      res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
      return res.status(401).json({ error: 'Session expired — please log in again' })
    }

    await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [rt.id])
    const newRefreshToken = await issueRefreshTokenDB(rt.user_id, req)
    const accessToken     = issueAccessToken(rt.user_id, rt.email)
    await auditLog(rt.user_id, 'token_refresh', req)

    res.cookie(REFRESH_COOKIE, newRefreshToken, cookieOpts())
    return res.json({
      accessToken, expiresIn: ACCESS_TTL,
      user: { id: rt.user_id, email: rt.email, displayName: rt.display_name },
    })
  } catch (err) {
    console.error('[auth/refresh]', err.message)
    return res.status(500).json({ error: 'Session refresh failed' })
  }
})

// ── POST /api/auth/logout ─────────────────────────
router.post('/logout', async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE]
  if (raw) {
    const hash = sha256(raw)
    if (DEMO_MODE) {
      demoSessions.delete(hash)
    } else {
      try {
        await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1', [hash])
      } catch {}
    }
  }
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
  return res.json({ ok: true })
})

// ── GET /api/auth/me ──────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  if (DEMO_MODE) {
    return res.json({
      id: DEMO_USER.id, email: DEMO_USER.email,
      displayName: DEMO_USER.displayName,
      isVerified: true, mfaEnabled: false,
    })
  }
  try {
    const r = await query(
      'SELECT id, email, display_name, avatar_url, is_verified, mfa_enabled FROM users WHERE id = $1',
      [req.user.userId]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' })
    const u = r.rows[0]
    return res.json({
      id: u.id, email: u.email, displayName: u.display_name,
      avatarUrl: u.avatar_url, isVerified: u.is_verified, mfaEnabled: u.mfa_enabled,
    })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch user' })
  }
})

// ── PATCH /api/auth/me ────────────────────────────
router.patch('/me', requireAuth, async (req, res) => {
  if (DEMO_MODE) return res.json(DEMO_USER)
  const { displayName } = req.body
  try {
    const r = await query(
      'UPDATE users SET display_name = $1 WHERE id = $2 RETURNING id, email, display_name',
      [displayName?.trim().slice(0, 100), req.user.userId]
    )
    const u = r.rows[0]
    return res.json({ id: u.id, email: u.email, displayName: u.display_name })
  } catch (err) {
    return res.status(500).json({ error: 'Update failed' })
  }
})

// ── POST /api/auth/change-password ───────────────
router.post('/change-password', requireAuth, async (req, res) => {
  if (DEMO_MODE) return res.status(503).json({ error: 'Not available in demo mode' })
  const { currentPassword, newPassword } = req.body
  if (!validatePassword(newPassword))
    return res.status(400).json({ error: 'New password must be 8+ chars with a letter and number' })
  try {
    const r = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.userId])
    const user = r.rows[0]
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (!await bcrypt.compare(currentPassword, user.password_hash))
      return res.status(401).json({ error: 'Current password is incorrect' })
    await query('UPDATE users SET password_hash = $1 WHERE id = $2',
      [await bcrypt.hash(newPassword, BCRYPT_ROUNDS), req.user.userId])
    await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1', [req.user.userId])
    await auditLog(req.user.userId, 'password_changed', req)
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
    return res.json({ ok: true, message: 'Password changed. Please log in again.' })
  } catch (err) {
    return res.status(500).json({ error: 'Password change failed' })
  }
})

// ── POST /api/auth/forgot-password ───────────────
router.post('/forgot-password', async (req, res) => {
  const success = { ok: true, message: 'If that email exists, a reset link was sent.' }
  if (DEMO_MODE) return res.json(success)
  const { email } = req.body
  if (!email || !validateEmail(email)) return res.json(success)
  try {
    const r = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])
    if (!r.rows[0]) return res.json(success)
    const userId = r.rows[0].id
    const token  = crypto.randomBytes(32).toString('hex')
    await query('DELETE FROM password_resets WHERE user_id = $1', [userId])
    await query(
      'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [userId, sha256(token), new Date(Date.now() + 3600000)]
    )
    await auditLog(userId, 'password_reset_request', req)
    const link = `${process.env.APP_URL || 'http://localhost:5173'}/reset-password?token=${token}`
    console.log(`[AUTH] Password reset link for ${email}: ${link}`)
    return res.json(success)
  } catch (err) {
    console.error('[auth/forgot]', err.message)
    return res.json(success)
  }
})

// ── POST /api/auth/reset-password ────────────────
router.post('/reset-password', async (req, res) => {
  if (DEMO_MODE) return res.status(503).json({ error: 'Not available in demo mode' })
  const { token, password } = req.body
  if (!token || !password || !validatePassword(password))
    return res.status(400).json({ error: 'Valid token and password required' })
  try {
    const r = await query(
      'SELECT id, user_id, expires_at, used_at FROM password_resets WHERE token_hash = $1',
      [sha256(token)]
    )
    const reset = r.rows[0]
    if (!reset || reset.used_at || new Date(reset.expires_at) < new Date())
      return res.status(400).json({ error: 'Reset link is invalid or has expired' })
    await query('UPDATE users SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL WHERE id = $2',
      [await bcrypt.hash(password, BCRYPT_ROUNDS), reset.user_id])
    await query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [reset.id])
    await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1', [reset.user_id])
    await auditLog(reset.user_id, 'password_reset_success', req)
    return res.json({ ok: true, message: 'Password reset successful. Please log in.' })
  } catch (err) {
    console.error('[auth/reset]', err.message)
    return res.status(500).json({ error: 'Reset failed — try again' })
  }
})

module.exports = router
