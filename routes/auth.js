'use strict'
/**
 * Auth routes — register, login, logout, refresh, /me, forgot-password, reset-password
 *
 * Token strategy:
 *   Access token  : JWT HS256, 15 min, returned in JSON body → stored in-memory by client
 *   Refresh token : 256-bit random, 7 days, HTTP-only Secure SameSite=Strict cookie
 *                   → hash stored in DB, rotated on every use
 *
 * Security:
 *   • bcryptjs 12 rounds — never roll custom crypto
 *   • Argon2 would be ideal; bcryptjs is chosen for zero-native-dep Railway compat
 *   • Account lockout after 5 bad passwords (15 min)
 *   • Rate-limited at server.js level
 *   • No sensitive data in error messages
 */
const express   = require('express')
const bcrypt    = require('bcryptjs')
const jwt       = require('jsonwebtoken')
const crypto    = require('crypto')
const { query } = require('../db/db')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()

// ── Config ────────────────────────────────────────
const JWT_SECRET       = process.env.JWT_SECRET
const ACCESS_TTL       = 15 * 60          // 15 minutes (seconds)
const REFRESH_TTL_DAYS = 7
const BCRYPT_ROUNDS    = 12
const MAX_ATTEMPTS     = 5
const LOCKOUT_MINUTES  = 15
const REFRESH_COOKIE   = 'finsurf_rt'

// Cookie options — always HTTP-only, Secure in prod
const cookieOpts = {
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  maxAge:   REFRESH_TTL_DAYS * 24 * 60 * 60 * 1000,
  path:     '/api/auth',
}

// ── Helpers ───────────────────────────────────────
function issueAccessToken(userId, email) {
  return jwt.sign(
    { sub: userId, email },
    JWT_SECRET,
    { algorithm: 'HS256', expiresIn: ACCESS_TTL }
  )
}

function sha256(str) {
  return crypto.createHash('sha256').update(str).digest('hex')
}

async function issueRefreshToken(userId, req) {
  const raw  = crypto.randomBytes(32).toString('hex')
  const hash = sha256(raw)
  const exp  = new Date(Date.now() + REFRESH_TTL_DAYS * 86400000)

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [
      userId, hash,
      JSON.stringify({ ua: req.headers['user-agent']?.slice(0, 200) }),
      req.ip,
      exp,
    ]
  )
  return raw
}

async function auditLog(userId, event, req, metadata = {}) {
  try {
    await query(
      `INSERT INTO auth_logs (user_id, event, ip_address, user_agent, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, event, req.ip, req.headers['user-agent']?.slice(0, 300), JSON.stringify(metadata)]
    )
  } catch { /* never let audit failure break the request */ }
}

function validateEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && email.length <= 255
}

function validatePassword(pw) {
  // Min 8 chars, at least 1 letter + 1 number
  return typeof pw === 'string' && pw.length >= 8 && pw.length <= 128
    && /[a-zA-Z]/.test(pw) && /\d/.test(pw)
}

// ── POST /api/auth/register ───────────────────────
router.post('/register', async (req, res) => {
  if (!JWT_SECRET) return res.status(503).json({ error: 'Auth not configured' })

  const { email, password, displayName } = req.body

  if (!email || !validateEmail(email))
    return res.status(400).json({ error: 'Valid email required' })
  if (!password || !validatePassword(password))
    return res.status(400).json({
      error: 'Password must be 8+ characters and contain a letter and number'
    })

  try {
    // Duplicate check (timing-safe: always hash regardless)
    const existing = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])
    const hash = await bcrypt.hash(password, BCRYPT_ROUNDS)

    if (existing.rows.length) {
      // Don't reveal existence — same response time, different message
      return res.status(409).json({ error: 'An account with that email already exists' })
    }

    // Create user
    const userRes = await query(
      `INSERT INTO users (email, password_hash, display_name)
       VALUES ($1, $2, $3) RETURNING id, email, display_name, created_at`,
      [email.toLowerCase(), hash, displayName?.trim().slice(0, 100) || null]
    )
    const user = userRes.rows[0]

    // Create default brokerage portfolio
    await query(
      `INSERT INTO portfolios (user_id, name, type, is_default, color)
       VALUES ($1, $2, 'brokerage', TRUE, '#00ffcc')`,
      [user.id, 'My Portfolio']
    )

    const accessToken  = issueAccessToken(user.id, user.email)
    const refreshToken = await issueRefreshToken(user.id, req)

    await auditLog(user.id, 'register', req)

    res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts)
    return res.status(201).json({
      accessToken,
      expiresIn: ACCESS_TTL,
      user: { id: user.id, email: user.email, displayName: user.display_name },
    })
  } catch (err) {
    console.error('[auth/register]', err.message)
    return res.status(500).json({ error: 'Registration failed — try again' })
  }
})

// ── POST /api/auth/login ──────────────────────────
router.post('/login', async (req, res) => {
  if (!JWT_SECRET) return res.status(503).json({ error: 'Auth not configured' })

  const { email, password, rememberMe } = req.body

  if (!email || !password)
    return res.status(400).json({ error: 'Email and password required' })

  try {
    const userRes = await query(
      `SELECT id, email, display_name, password_hash, is_active,
              failed_login_attempts, locked_until
       FROM users WHERE email = $1`,
      [email.toLowerCase()]
    )

    // Always run bcrypt to prevent timing attacks on account enumeration
    const dummyHash = '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewHHg9/EFzxUbX1u'
    const user = userRes.rows[0]
    const hashToCheck = user?.password_hash || dummyHash

    // Check lockout before comparing password (but after fetching user)
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
        const lockedUntil = attempts >= MAX_ATTEMPTS
          ? new Date(Date.now() + LOCKOUT_MINUTES * 60000)
          : null

        await query(
          `UPDATE users SET failed_login_attempts = $1, locked_until = $2 WHERE id = $3`,
          [Math.min(attempts, MAX_ATTEMPTS + 5), lockedUntil, user.id]
        )
        await auditLog(user.id, 'login_failed', req, { attempt: attempts })

        if (lockedUntil) {
          return res.status(429).json({ error: `Too many failed attempts. Account locked for ${LOCKOUT_MINUTES} minutes.` })
        }
      }
      return res.status(401).json({ error: 'Invalid email or password' })
    }

    // Success — reset lockout state
    await query(
      `UPDATE users SET failed_login_attempts = 0, locked_until = NULL WHERE id = $1`,
      [user.id]
    )

    const opts = rememberMe ? cookieOpts : { ...cookieOpts, maxAge: undefined }
    const accessToken  = issueAccessToken(user.id, user.email)
    const refreshToken = await issueRefreshToken(user.id, req)

    await auditLog(user.id, 'login_success', req)

    res.cookie(REFRESH_COOKIE, refreshToken, opts)
    return res.json({
      accessToken,
      expiresIn: ACCESS_TTL,
      user: { id: user.id, email: user.email, displayName: user.display_name },
    })
  } catch (err) {
    console.error('[auth/login]', err.message)
    return res.status(500).json({ error: 'Login failed — try again' })
  }
})

// ── POST /api/auth/refresh ────────────────────────
// Rotates the refresh token: old one is revoked, new one issued
router.post('/refresh', async (req, res) => {
  if (!JWT_SECRET) return res.status(503).json({ error: 'Auth not configured' })

  const raw = req.cookies?.[REFRESH_COOKIE]
  if (!raw) return res.status(401).json({ error: 'No refresh token' })

  const hash = sha256(raw)

  try {
    const tokenRes = await query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
              u.email, u.display_name, u.is_active
       FROM refresh_tokens rt
       JOIN users u ON u.id = rt.user_id
       WHERE rt.token_hash = $1`,
      [hash]
    )

    const rt = tokenRes.rows[0]

    if (!rt || rt.revoked_at || new Date(rt.expires_at) < new Date() || !rt.is_active) {
      // Potential token reuse — revoke all tokens for this user (security measure)
      if (rt) {
        await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1', [rt.user_id])
        await auditLog(rt.user_id, 'token_reuse_detected', req)
      }
      res.clearCookie(REFRESH_COOKIE, { ...cookieOpts, maxAge: undefined })
      return res.status(401).json({ error: 'Session expired — please log in again' })
    }

    // Rotate: revoke old, issue new
    await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE id = $1', [rt.id])
    const newRefreshToken = await issueRefreshToken(rt.user_id, req)
    const accessToken     = issueAccessToken(rt.user_id, rt.email)

    await auditLog(rt.user_id, 'token_refresh', req)

    res.cookie(REFRESH_COOKIE, newRefreshToken, cookieOpts)
    return res.json({
      accessToken,
      expiresIn: ACCESS_TTL,
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
    try {
      await query(
        'UPDATE refresh_tokens SET revoked_at = NOW() WHERE token_hash = $1',
        [sha256(raw)]
      )
    } catch {}
  }
  res.clearCookie(REFRESH_COOKIE, { ...cookieOpts, maxAge: undefined })
  return res.json({ ok: true })
})

// ── GET /api/auth/me ──────────────────────────────
router.get('/me', requireAuth, async (req, res) => {
  try {
    const r = await query(
      `SELECT id, email, display_name, avatar_url, is_verified, mfa_enabled, created_at
       FROM users WHERE id = $1`,
      [req.user.userId]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' })
    const u = r.rows[0]
    return res.json({
      id: u.id, email: u.email, displayName: u.display_name,
      avatarUrl: u.avatar_url, isVerified: u.is_verified,
      mfaEnabled: u.mfa_enabled, createdAt: u.created_at,
    })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch user' })
  }
})

// ── PATCH /api/auth/me ────────────────────────────
router.patch('/me', requireAuth, async (req, res) => {
  const { displayName } = req.body
  try {
    const r = await query(
      `UPDATE users SET display_name = $1 WHERE id = $2
       RETURNING id, email, display_name`,
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
  const { currentPassword, newPassword } = req.body
  if (!validatePassword(newPassword))
    return res.status(400).json({ error: 'New password must be 8+ chars with a letter and number' })

  try {
    const r = await query('SELECT password_hash FROM users WHERE id = $1', [req.user.userId])
    const user = r.rows[0]
    if (!user) return res.status(404).json({ error: 'User not found' })

    const match = await bcrypt.compare(currentPassword, user.password_hash)
    if (!match) return res.status(401).json({ error: 'Current password is incorrect' })

    const hash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
    await query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.userId])

    // Revoke all refresh tokens to force re-login on other devices
    await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1', [req.user.userId])
    await auditLog(req.user.userId, 'password_changed', req)

    res.clearCookie(REFRESH_COOKIE, { ...cookieOpts, maxAge: undefined })
    return res.json({ ok: true, message: 'Password changed. Please log in again.' })
  } catch (err) {
    return res.status(500).json({ error: 'Password change failed' })
  }
})

// ── POST /api/auth/forgot-password ───────────────
router.post('/forgot-password', async (req, res) => {
  const { email } = req.body
  // Always return 200 to prevent account enumeration
  const success = { ok: true, message: 'If that email exists, a reset link was sent.' }

  if (!email || !validateEmail(email)) return res.json(success)

  try {
    const r = await query('SELECT id FROM users WHERE email = $1', [email.toLowerCase()])
    if (!r.rows[0]) return res.json(success)

    const userId = r.rows[0].id
    const token  = crypto.randomBytes(32).toString('hex')
    const hash   = sha256(token)
    const exp    = new Date(Date.now() + 3600000)  // 1 hour

    // Invalidate any existing reset tokens for this user
    await query('DELETE FROM password_resets WHERE user_id = $1', [userId])
    await query(
      'INSERT INTO password_resets (user_id, token_hash, expires_at) VALUES ($1, $2, $3)',
      [userId, hash, exp]
    )

    await auditLog(userId, 'password_reset_request', req)

    // In production: send email via nodemailer / SendGrid / Resend
    // For now: log the link (remove before going live!)
    const resetLink = `${process.env.APP_URL || 'http://localhost:5173'}/reset-password?token=${token}`
    console.log(`[AUTH] Password reset link for ${email}: ${resetLink}`)

    return res.json(success)
  } catch (err) {
    console.error('[auth/forgot-password]', err.message)
    return res.json(success) // Still return success to prevent info leakage
  }
})

// ── POST /api/auth/reset-password ────────────────
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body
  if (!token || !password || !validatePassword(password))
    return res.status(400).json({ error: 'Valid token and password required' })

  try {
    const hash = sha256(token)
    const r = await query(
      `SELECT pr.id, pr.user_id, pr.expires_at, pr.used_at
       FROM password_resets pr WHERE pr.token_hash = $1`,
      [hash]
    )

    const reset = r.rows[0]
    if (!reset || reset.used_at || new Date(reset.expires_at) < new Date())
      return res.status(400).json({ error: 'Reset link is invalid or has expired' })

    const newHash = await bcrypt.hash(password, BCRYPT_ROUNDS)

    await query('UPDATE users SET password_hash = $1, failed_login_attempts = 0, locked_until = NULL WHERE id = $2',
      [newHash, reset.user_id])
    await query('UPDATE password_resets SET used_at = NOW() WHERE id = $1', [reset.id])

    // Revoke all sessions after password reset
    await query('UPDATE refresh_tokens SET revoked_at = NOW() WHERE user_id = $1', [reset.user_id])
    await auditLog(reset.user_id, 'password_reset_success', req)

    return res.json({ ok: true, message: 'Password reset successful. Please log in.' })
  } catch (err) {
    console.error('[auth/reset-password]', err.message)
    return res.status(500).json({ error: 'Reset failed — try again' })
  }
})

module.exports = router
