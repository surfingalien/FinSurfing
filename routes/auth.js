'use strict'
/**
 * Auth routes — full authentication system
 *
 * Modes:
 *   Production  : DATABASE_URL set → PostgreSQL for all storage
 *   Demo / eval : No DATABASE_URL  → in-memory store (lost on restart)
 *
 * Private admin:
 *   Set ADMIN_EMAIL + ADMIN_PASSWORD in Railway env vars.
 *   Never shown in UI or code. Admin skips email verification.
 *
 * Email verification:
 *   SMTP configured (SMTP_HOST + SMTP_USER + SMTP_PASS):
 *     → 6-digit OTP sent to user's email
 *   No SMTP (demo mode):
 *     → Code returned in API response so frontend can display it
 *
 * Endpoints:
 *   POST /api/auth/register
 *   POST /api/auth/verify-email
 *   POST /api/auth/resend-verification
 *   POST /api/auth/login
 *   POST /api/auth/refresh
 *   POST /api/auth/logout
 *   GET  /api/auth/me
 *   PATCH /api/auth/me
 *   POST /api/auth/change-password
 *   POST /api/auth/forgot-password
 *   POST /api/auth/reset-password
 */
const express       = require('express')
const bcrypt        = require('bcryptjs')
const jwt           = require('jsonwebtoken')
const crypto        = require('crypto')
const nodemailer    = require('nodemailer')
const { query }     = require('../db/db')
const { requireAuth, SECRET } = require('../middleware/auth')
const { MEM }       = require('../db/memstore')

const router = express.Router()

// ── Config ─────────────────────────────────────────
const ACCESS_TTL       = 15 * 60
const REFRESH_TTL_DAYS = 7
const BCRYPT_ROUNDS    = 12
const MAX_ATTEMPTS     = 5
const LOCKOUT_MINUTES  = 15
const REFRESH_COOKIE   = 'finsurf_rt'

const DB_MODE        = !!process.env.DATABASE_URL
const HAS_SMTP       = !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)
const HAS_RESEND     = !!process.env.RESEND_API_KEY
const ADMIN_EMAIL    = (process.env.ADMIN_EMAIL || '').toLowerCase()
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || ''

// Cookie options
const cookieOpts = (remember = true) => ({
  httpOnly: true,
  secure:   process.env.NODE_ENV === 'production',
  sameSite: 'strict',
  ...(remember ? { maxAge: REFRESH_TTL_DAYS * 86400000 } : {}),
  path: '/api/auth',
})

// ── Email transport ────────────────────────────────
// Priority: Resend API → SMTP (nodemailer) → console log (demo)
let mailer = null
if (!HAS_RESEND && HAS_SMTP) {
  mailer = nodemailer.createTransport({
    host:   process.env.SMTP_HOST,
    port:   parseInt(process.env.SMTP_PORT || '587'),
    secure: process.env.SMTP_SECURE === 'true',
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  })
}

async function sendEmail({ to, subject, html }) {
  // ── Resend (recommended on Railway — no SMTP needed) ──
  if (HAS_RESEND) {
    const from = process.env.RESEND_FROM || 'FinSurf <noreply@finsurf.app>'
    const res = await fetch('https://api.resend.com/emails', {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({ from, to, subject, html }),
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.message || `Resend error ${res.status}`)
    }
    return true
  }

  // ── Nodemailer / SMTP ──────────────────────────────
  if (mailer) {
    const from = process.env.SMTP_FROM || `FinSurf <${process.env.SMTP_USER}>`
    await mailer.sendMail({ from, to, subject, html })
    return true
  }

  // ── Demo / no email configured ─────────────────────
  console.log(`[EMAIL] To: ${to} | Subject: ${subject}`)
  return false
}

// ── Pre-seed admin account in memory (env-var based, private) ─────────
;(async () => {
  if (!DB_MODE && ADMIN_EMAIL && ADMIN_PASSWORD) {
    const id       = 'admin-' + crypto.randomBytes(4).toString('hex')
    const hash     = await bcrypt.hash(ADMIN_PASSWORD, BCRYPT_ROUNDS)
    const username = generateUsername(ADMIN_EMAIL)
    const user = {
      id, email: ADMIN_EMAIL, username, role: 'admin',
      displayName: 'Admin',
      passwordHash: hash, isVerified: true,
      failedAttempts: 0, lockedUntil: null,
      createdAt: new Date().toISOString(),
    }
    MEM.users.set(id, user)
    MEM.byEmail.set(ADMIN_EMAIL, id)
    MEM.byUsername.set(username, id)

    // Create admin system portfolio in memory
    const pid = 'port-admin-' + crypto.randomBytes(4).toString('hex')
    MEM.portfolios.set(pid, {
      id: pid, user_id: id, name: 'Admin Portfolio',
      type: 'brokerage', description: 'System admin portfolio',
      currency: 'USD', color: '#ff6b6b',
      is_default: true, is_archived: false,
      visibility: 'private', is_system: true, is_featured: false,
      copy_trade_enabled: false,
      created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    })
    MEM.holdings.set(pid, [])

    console.log('[AUTH] Admin account ready (in-memory)')
  }
})()

// ── Helpers ────────────────────────────────────────
function sha256(s)        { return crypto.createHash('sha256').update(s).digest('hex') }
function otp6()           { return String(Math.floor(100000 + Math.random() * 900000)) }
function validateEmail(e) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length <= 255 }
function validatePassword(p) {
  return typeof p === 'string' && p.length >= 8 && p.length <= 128
    && /[a-zA-Z]/.test(p) && /\d/.test(p)
}

/**
 * Generate a URL-safe username from email prefix.
 * e.g. "john.doe+tag@example.com" → "john_doe_tag"
 */
function generateUsername(email) {
  const prefix = email.split('@')[0] || 'user'
  return prefix.toLowerCase().replace(/[^a-z0-9]/g, '_').slice(0, 30)
}

function issueAccessToken(userId, email, role) {
  return jwt.sign(
    { sub: userId, email, role: role || 'user' },
    SECRET,
    { algorithm: 'HS256', expiresIn: ACCESS_TTL }
  )
}

// ── DB helpers ─────────────────────────────────────
async function dbIssueRefresh(userId, req) {
  const raw  = crypto.randomBytes(32).toString('hex')
  const exp  = new Date(Date.now() + REFRESH_TTL_DAYS * 86400000)
  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, device_info, ip_address, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, sha256(raw), JSON.stringify({ ua: req.headers['user-agent']?.slice(0, 200) }), req.ip, exp]
  )
  return raw
}

async function auditLog(userId, event, req, meta = {}) {
  if (!DB_MODE) return
  try {
    await query(
      `INSERT INTO auth_logs (user_id, event, ip_address, user_agent, metadata)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId, event, req.ip, req.headers['user-agent']?.slice(0, 300), JSON.stringify(meta)]
    )
  } catch {}
}

/**
 * Generate a unique username in DB mode, appending 4 random digits on collision.
 */
async function dbGenerateUsername(base) {
  const check = await query('SELECT id FROM users WHERE username = $1', [base])
  if (!check.rows.length) return base
  // Try up to 5 times with random suffix
  for (let i = 0; i < 5; i++) {
    const candidate = base.slice(0, 26) + '_' + String(Math.floor(1000 + Math.random() * 9000))
    const c2 = await query('SELECT id FROM users WHERE username = $1', [candidate])
    if (!c2.rows.length) return candidate
  }
  // last resort: use timestamp
  return base.slice(0, 20) + '_' + Date.now().toString().slice(-6)
}

/**
 * Generate a unique username in memory mode.
 */
function memGenerateUsername(base) {
  if (!MEM.byUsername.has(base)) return base
  for (let i = 0; i < 5; i++) {
    const candidate = base.slice(0, 26) + '_' + String(Math.floor(1000 + Math.random() * 9000))
    if (!MEM.byUsername.has(candidate)) return candidate
  }
  return base.slice(0, 20) + '_' + Date.now().toString().slice(-6)
}

// ── Mem helpers ─────────────────────────────────────
function memIssueRefresh(userId) {
  const raw = crypto.randomBytes(32).toString('hex')
  MEM.tokens.set(sha256(raw), { userId, expiresAt: Date.now() + REFRESH_TTL_DAYS * 86400000 })
  return raw
}

// ── Shared login response ──────────────────────────
async function respondWithTokens(res, user, req, remember) {
  const userId = user.id || user.userId
  const email  = user.email
  const name   = user.displayName || user.display_name || null
  const role   = user.role || 'user'
  const username = user.username || null

  const accessToken  = issueAccessToken(userId, email, role)
  const refreshToken = DB_MODE
    ? await dbIssueRefresh(userId, req)
    : memIssueRefresh(userId)

  res.cookie(REFRESH_COOKIE, refreshToken, cookieOpts(remember))
  return res.json({
    accessToken, expiresIn: ACCESS_TTL,
    user: { id: userId, email, displayName: name, role, username },
  })
}

// ── OTP email ──────────────────────────────────────
async function sendVerificationEmail(email, code, demo) {
  const html = `
    <div style="font-family:sans-serif;max-width:480px;margin:0 auto;padding:32px;background:#0a0e1a;color:#fff;border-radius:16px">
      <h2 style="color:#00ffcc;margin:0 0 8px">FinSurf — Verify your email</h2>
      <p style="color:#94a3b8;margin:0 0 24px">Enter this code to complete your registration:</p>
      <div style="font-size:36px;font-weight:900;letter-spacing:12px;color:#fff;background:#ffffff10;
                  padding:20px;border-radius:12px;text-align:center;font-family:monospace">
        ${code}
      </div>
      <p style="color:#64748b;font-size:12px;margin:24px 0 0">
        This code expires in 10 minutes. If you didn't request this, ignore this email.
      </p>
    </div>`

  const sent = await sendEmail({ to: email, subject: 'FinSurf — Your verification code', html })
  return sent
}

// ═══════════════════════════════════════════════════
// ── POST /api/auth/register ────────────────────────
// ═══════════════════════════════════════════════════
router.post('/register', async (req, res) => {
  const { email, password, displayName } = req.body
  if (!email || !validateEmail(email))
    return res.status(400).json({ error: 'Valid email address required' })
  if (!password || !validatePassword(password))
    return res.status(400).json({ error: 'Password must be 8+ characters with a letter and number' })

  const lEmail = email.toLowerCase()
  const isAdmin = ADMIN_EMAIL && lEmail === ADMIN_EMAIL
  const role    = isAdmin ? 'admin' : 'user'

  // ── DB mode ───────────────────────────────────
  if (DB_MODE) {
    try {
      const existing = await query('SELECT id FROM users WHERE email = $1', [lEmail])
      const hash = await bcrypt.hash(password, BCRYPT_ROUNDS)
      if (existing.rows.length)
        return res.status(409).json({ error: 'An account with that email already exists' })

      const usernameBase = generateUsername(lEmail)
      const username     = await dbGenerateUsername(usernameBase)

      const r = await query(
        `INSERT INTO users (email, password_hash, display_name, username, role, is_verified)
         VALUES ($1,$2,$3,$4,$5,FALSE) RETURNING id, email, display_name, username, role`,
        [lEmail, hash, displayName?.trim().slice(0, 100) || null, username, role]
      )
      const user = r.rows[0]
      const code = otp6()
      const exp  = new Date(Date.now() + 10 * 60000)

      // Store OTP in DB
      await query('DELETE FROM email_verifications WHERE user_id = $1', [user.id])
      await query(
        'INSERT INTO email_verifications (user_id, code_hash, expires_at) VALUES ($1,$2,$3)',
        [user.id, sha256(code), exp]
      )
      await auditLog(user.id, 'register', req)

      const sent = await sendVerificationEmail(lEmail, code, false)
      const resp = { ok: true, requiresVerification: true, email: lEmail }
      if (!sent) resp.demoCode = code  // no SMTP → show on screen
      return res.status(201).json(resp)
    } catch (err) {
      console.error('[auth/register]', err.message)
      return res.status(500).json({ error: 'Registration failed — please try again' })
    }
  }

  // ── In-memory mode ────────────────────────────
  if (MEM.byEmail.has(lEmail))
    return res.status(409).json({ error: 'An account with that email already exists' })

  const hash         = await bcrypt.hash(password, BCRYPT_ROUNDS)
  const id           = 'u-' + crypto.randomBytes(8).toString('hex')
  const usernameBase = generateUsername(lEmail)
  const username     = memGenerateUsername(usernameBase)

  const user = {
    id, email: lEmail, username, role,
    displayName: displayName?.trim().slice(0, 100) || null,
    passwordHash: hash, isVerified: false,
    failedAttempts: 0, lockedUntil: null,
    createdAt: new Date().toISOString(),
  }
  MEM.users.set(id, user)
  MEM.byEmail.set(lEmail, id)
  MEM.byUsername.set(username, id)

  // Create default portfolio for new user
  const pid = 'port-' + crypto.randomBytes(8).toString('hex')
  MEM.portfolios.set(pid, {
    id: pid, user_id: id, name: 'My Portfolio',
    type: 'brokerage', description: null,
    currency: 'USD', color: '#00ffcc',
    is_default: true, is_archived: false,
    visibility: 'private',
    is_system: isAdmin,
    is_featured: false,
    copy_trade_enabled: false,
    cash_balance: 0,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
  })
  MEM.holdings.set(pid, [])

  const code = otp6()
  MEM.otp.set(lEmail, { code, expiresAt: Date.now() + 10 * 60000, attempts: 0 })

  const sent = await sendVerificationEmail(lEmail, code, true)
  const resp = { ok: true, requiresVerification: true, email: lEmail }
  if (!sent) resp.demoCode = code
  return res.status(201).json(resp)
})

// ═══════════════════════════════════════════════════
// ── POST /api/auth/verify-email ────────────────────
// ═══════════════════════════════════════════════════
router.post('/verify-email', async (req, res) => {
  const { email, code } = req.body
  if (!email || !code) return res.status(400).json({ error: 'Email and code required' })
  const lEmail = email.toLowerCase()

  // ── DB mode ───────────────────────────────────
  if (DB_MODE) {
    try {
      const userRes = await query('SELECT id, role FROM users WHERE email = $1', [lEmail])
      if (!userRes.rows[0]) return res.status(404).json({ error: 'Account not found' })
      const userId = userRes.rows[0].id
      const role   = userRes.rows[0].role || 'user'

      const otpRes = await query(
        `SELECT id, expires_at FROM email_verifications
         WHERE user_id = $1 AND code_hash = $2`,
        [userId, sha256(code)]
      )
      const otp = otpRes.rows[0]
      if (!otp || new Date(otp.expires_at) < new Date())
        return res.status(400).json({ error: 'Invalid or expired code. Request a new one.' })

      // Mark verified
      await query('UPDATE users SET is_verified = TRUE WHERE id = $1', [userId])
      await query('DELETE FROM email_verifications WHERE user_id = $1', [userId])

      // Determine if this is the admin email
      const isAdminUser = ADMIN_EMAIL && lEmail === ADMIN_EMAIL

      // Create default portfolio
      await query(
        `INSERT INTO portfolios (user_id, name, type, is_default, color, visibility, is_system)
         VALUES ($1,'My Portfolio','brokerage',TRUE,'#00ffcc','private',$2)
         ON CONFLICT DO NOTHING`,
        [userId, isAdminUser]
      )
      await auditLog(userId, 'email_verified', req)

      const uRes = await query(
        'SELECT id, email, display_name, username, role FROM users WHERE id = $1',
        [userId]
      )
      const u = uRes.rows[0]
      return respondWithTokens(res, {
        id: u.id, email: u.email,
        displayName: u.display_name,
        role: u.role, username: u.username
      }, req, true)
    } catch (err) {
      console.error('[auth/verify-email]', err.message)
      return res.status(500).json({ error: 'Verification failed' })
    }
  }

  // ── In-memory mode ────────────────────────────
  const uid  = MEM.byEmail.get(lEmail)
  const user = uid ? MEM.users.get(uid) : null
  if (!user) return res.status(404).json({ error: 'Account not found' })

  const otp = MEM.otp.get(lEmail)
  if (!otp || otp.expiresAt < Date.now())
    return res.status(400).json({ error: 'Code expired — request a new one' })
  if (otp.code !== code) {
    otp.attempts = (otp.attempts || 0) + 1
    if (otp.attempts >= 5) MEM.otp.delete(lEmail)
    return res.status(400).json({ error: 'Incorrect code' })
  }

  MEM.otp.delete(lEmail)
  user.isVerified = true
  return respondWithTokens(res, user, req, true)
})

// ═══════════════════════════════════════════════════
// ── POST /api/auth/resend-verification ─────────────
// ═══════════════════════════════════════════════════
router.post('/resend-verification', async (req, res) => {
  const { email } = req.body
  if (!email || !validateEmail(email)) return res.status(400).json({ error: 'Email required' })
  const lEmail = email.toLowerCase()

  const code = otp6()

  if (DB_MODE) {
    try {
      const r = await query('SELECT id FROM users WHERE email = $1 AND is_verified = FALSE', [lEmail])
      if (!r.rows[0]) return res.json({ ok: true }) // silent
      await query('DELETE FROM email_verifications WHERE user_id = $1', [r.rows[0].id])
      await query(
        'INSERT INTO email_verifications (user_id, code_hash, expires_at) VALUES ($1,$2,$3)',
        [r.rows[0].id, sha256(code), new Date(Date.now() + 10 * 60000)]
      )
    } catch {}
  } else {
    if (!MEM.byEmail.has(lEmail)) return res.json({ ok: true })
    MEM.otp.set(lEmail, { code, expiresAt: Date.now() + 10 * 60000, attempts: 0 })
  }

  const sent = await sendVerificationEmail(lEmail, code, !DB_MODE)
  const resp = { ok: true }
  if (!sent) resp.demoCode = code
  return res.json(resp)
})

// ═══════════════════════════════════════════════════
// ── POST /api/auth/login ───────────────────────────
// ═══════════════════════════════════════════════════
router.post('/login', async (req, res) => {
  const { email, password, rememberMe } = req.body
  if (!email || !password) return res.status(400).json({ error: 'Email and password required' })
  const lEmail = email.toLowerCase()

  // ── DB mode ───────────────────────────────────
  if (DB_MODE) {
    try {
      const r = await query(
        `SELECT id, email, display_name, username, role, password_hash, is_active, is_verified,
                failed_login_attempts, locked_until
         FROM users WHERE email = $1`,
        [lEmail]
      )
      const dummy = '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewHHg9/EFzxUbX1u'
      const user  = r.rows[0]

      if (user?.locked_until && new Date(user.locked_until) > new Date())
        return res.status(429).json({ error: `Account locked until ${new Date(user.locked_until).toLocaleTimeString()}` })

      const match = await bcrypt.compare(password, user?.password_hash || dummy)

      if (!user || !match || !user.is_active) {
        if (user) {
          const att = user.failed_login_attempts + 1
          const lock = att >= MAX_ATTEMPTS ? new Date(Date.now() + LOCKOUT_MINUTES * 60000) : null
          await query('UPDATE users SET failed_login_attempts=$1,locked_until=$2 WHERE id=$3',
            [Math.min(att, MAX_ATTEMPTS + 5), lock, user.id])
          await auditLog(user.id, 'login_failed', req, { attempt: att })
          if (lock) return res.status(429).json({ error: `Too many attempts. Locked ${LOCKOUT_MINUTES} min.` })
        }
        return res.status(401).json({ error: 'Invalid email or password' })
      }

      if (!user.is_verified)
        return res.status(403).json({ error: 'Please verify your email first', requiresVerification: true, email: lEmail })

      await query('UPDATE users SET failed_login_attempts=0,locked_until=NULL WHERE id=$1', [user.id])
      await auditLog(user.id, 'login_success', req)
      return respondWithTokens(res, {
        id: user.id, email: user.email,
        displayName: user.display_name,
        role: user.role, username: user.username
      }, req, !!rememberMe)
    } catch (err) {
      console.error('[auth/login]', err.message)
      return res.status(500).json({ error: 'Login failed — try again' })
    }
  }

  // ── In-memory mode ────────────────────────────
  const uid  = MEM.byEmail.get(lEmail)
  const user = uid ? MEM.users.get(uid) : null
  const dummy = '$2a$12$LQv3c1yqBWVHxkd0LHAkCOYz6TtxMQJqhN8/LewHHg9/EFzxUbX1u'

  if (user?.lockedUntil && new Date(user.lockedUntil) > new Date())
    return res.status(429).json({ error: 'Account locked. Try again later.' })

  const match = await bcrypt.compare(password, user?.passwordHash || dummy)

  if (!user || !match) {
    if (user) {
      user.failedAttempts = (user.failedAttempts || 0) + 1
      if (user.failedAttempts >= MAX_ATTEMPTS)
        user.lockedUntil = new Date(Date.now() + LOCKOUT_MINUTES * 60000)
    }
    return res.status(401).json({ error: 'Invalid email or password' })
  }

  if (!user.isVerified)
    return res.status(403).json({ error: 'Please verify your email first', requiresVerification: true, email: lEmail })

  user.failedAttempts = 0
  user.lockedUntil    = null
  return respondWithTokens(res, user, req, !!rememberMe)
})

// ═══════════════════════════════════════════════════
// ── POST /api/auth/refresh ─────────────────────────
// ═══════════════════════════════════════════════════
router.post('/refresh', async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE]
  if (!raw) return res.status(401).json({ error: 'No refresh token' })
  const hash = sha256(raw)

  // ── In-memory mode ────────────────────────────
  if (!DB_MODE) {
    const sess = MEM.tokens.get(hash)
    if (!sess || sess.expiresAt < Date.now()) {
      MEM.tokens.delete(hash)
      res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
      return res.status(401).json({ error: 'Session expired — please log in again' })
    }
    MEM.tokens.delete(hash)
    const user = MEM.users.get(sess.userId)
    if (!user) return res.status(401).json({ error: 'User not found' })
    const newRaw = memIssueRefresh(sess.userId)
    res.cookie(REFRESH_COOKIE, newRaw, cookieOpts())
    return res.json({
      accessToken: issueAccessToken(user.id, user.email, user.role || 'user'),
      expiresIn:   ACCESS_TTL,
      user: { id: user.id, email: user.email, displayName: user.displayName, role: user.role || 'user', username: user.username || null },
    })
  }

  // ── DB mode ───────────────────────────────────
  try {
    const r = await query(
      `SELECT rt.id, rt.user_id, rt.expires_at, rt.revoked_at,
              u.email, u.display_name, u.username, u.role, u.is_active
       FROM refresh_tokens rt JOIN users u ON u.id=rt.user_id
       WHERE rt.token_hash=$1`,
      [hash]
    )
    const rt = r.rows[0]
    if (!rt || rt.revoked_at || new Date(rt.expires_at) < new Date() || !rt.is_active) {
      if (rt) {
        await query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=$1', [rt.user_id])
        await auditLog(rt.user_id, 'token_reuse_detected', req)
      }
      res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
      return res.status(401).json({ error: 'Session expired — please log in again' })
    }
    await query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE id=$1', [rt.id])
    const newRaw = await dbIssueRefresh(rt.user_id, req)
    res.cookie(REFRESH_COOKIE, newRaw, cookieOpts())
    return res.json({
      accessToken: issueAccessToken(rt.user_id, rt.email, rt.role || 'user'),
      expiresIn:   ACCESS_TTL,
      user: { id: rt.user_id, email: rt.email, displayName: rt.display_name, role: rt.role || 'user', username: rt.username || null },
    })
  } catch (err) {
    console.error('[auth/refresh]', err.message)
    return res.status(500).json({ error: 'Session refresh failed' })
  }
})

// ═══════════════════════════════════════════════════
// ── POST /api/auth/logout ──────────────────────────
// ═══════════════════════════════════════════════════
router.post('/logout', async (req, res) => {
  const raw = req.cookies?.[REFRESH_COOKIE]
  if (raw) {
    const hash = sha256(raw)
    if (DB_MODE) {
      try { await query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE token_hash=$1', [hash]) } catch {}
    } else {
      MEM.tokens.delete(hash)
    }
  }
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
  return res.json({ ok: true })
})

// ═══════════════════════════════════════════════════
// ── GET /api/auth/me ───────────────────────────────
// ═══════════════════════════════════════════════════
router.get('/me', requireAuth, async (req, res) => {
  if (!DB_MODE) {
    const user = MEM.users.get(req.user.userId)
    if (!user) return res.status(404).json({ error: 'User not found' })
    return res.json({
      id: user.id, email: user.email, displayName: user.displayName,
      isVerified: user.isVerified, role: user.role || 'user', username: user.username || null,
    })
  }
  try {
    const r = await query(
      'SELECT id,email,display_name,username,role,avatar_url,is_verified,mfa_enabled FROM users WHERE id=$1',
      [req.user.userId]
    )
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' })
    const u = r.rows[0]
    return res.json({
      id: u.id, email: u.email, displayName: u.display_name,
      username: u.username, role: u.role || 'user',
      avatarUrl: u.avatar_url, isVerified: u.is_verified, mfaEnabled: u.mfa_enabled,
    })
  } catch (err) {
    return res.status(500).json({ error: 'Failed to fetch profile' })
  }
})

// ── PATCH /api/auth/me ─────────────────────────────
router.patch('/me', requireAuth, async (req, res) => {
  const { displayName } = req.body
  if (!DB_MODE) {
    const user = MEM.users.get(req.user.userId)
    if (user) user.displayName = displayName?.trim().slice(0, 100) || user.displayName
    return res.json({
      id: user?.id, email: user?.email, displayName: user?.displayName,
      role: user?.role || 'user', username: user?.username || null,
    })
  }
  try {
    const r = await query(
      'UPDATE users SET display_name=$1 WHERE id=$2 RETURNING id,email,display_name,username,role',
      [displayName?.trim().slice(0, 100), req.user.userId]
    )
    const u = r.rows[0]
    return res.json({ id: u.id, email: u.email, displayName: u.display_name, username: u.username, role: u.role })
  } catch { return res.status(500).json({ error: 'Update failed' }) }
})

// ═══════════════════════════════════════════════════
// ── POST /api/auth/change-password ────────────────
// ═══════════════════════════════════════════════════
router.post('/change-password', requireAuth, async (req, res) => {
  const { currentPassword, newPassword } = req.body
  if (!newPassword || !validatePassword(newPassword))
    return res.status(400).json({ error: 'New password must be 8+ chars with a letter and number' })

  if (!DB_MODE) {
    const user = MEM.users.get(req.user.userId)
    if (!user) return res.status(404).json({ error: 'User not found' })
    if (!await bcrypt.compare(currentPassword, user.passwordHash))
      return res.status(401).json({ error: 'Current password is incorrect' })
    user.passwordHash = await bcrypt.hash(newPassword, BCRYPT_ROUNDS)
    // Revoke all in-memory sessions for this user
    for (const [k, v] of MEM.tokens) {
      if (v.userId === req.user.userId) MEM.tokens.delete(k)
    }
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
    return res.json({ ok: true, message: 'Password changed. Please log in again.' })
  }

  try {
    const r = await query('SELECT password_hash FROM users WHERE id=$1', [req.user.userId])
    if (!r.rows[0]) return res.status(404).json({ error: 'User not found' })
    if (!await bcrypt.compare(currentPassword, r.rows[0].password_hash))
      return res.status(401).json({ error: 'Current password is incorrect' })
    await query('UPDATE users SET password_hash=$1 WHERE id=$2',
      [await bcrypt.hash(newPassword, BCRYPT_ROUNDS), req.user.userId])
    await query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=$1', [req.user.userId])
    await auditLog(req.user.userId, 'password_changed', req)
    res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' })
    return res.json({ ok: true, message: 'Password changed. Please log in again.' })
  } catch { return res.status(500).json({ error: 'Password change failed' }) }
})

// ═══════════════════════════════════════════════════
// ── POST /api/auth/forgot-password ────────────────
// ═══════════════════════════════════════════════════
router.post('/forgot-password', async (req, res) => {
  const ok = { ok: true, message: 'If that email exists, a reset link was sent.' }
  const { email } = req.body
  if (!email || !validateEmail(email)) return res.json(ok)
  const lEmail = email.toLowerCase()

  if (!DB_MODE) {
    const uid  = MEM.byEmail.get(lEmail)
    const user = uid ? MEM.users.get(uid) : null
    if (!user) return res.json(ok)
    const token = crypto.randomBytes(32).toString('hex')
    MEM.resets.set(sha256(token), { userId: uid, expiresAt: Date.now() + 3600000, used: false })
    const link = `${process.env.APP_URL || 'http://localhost:5173'}/reset-password?token=${token}`
    const html = `<p>Reset your FinSurf password: <a href="${link}">${link}</a></p><p>Expires in 1 hour.</p>`
    const sent = await sendEmail({ to: lEmail, subject: 'FinSurf — Password reset', html })
    if (!sent) console.log(`[AUTH] Password reset link: ${link}`)
    return res.json(ok)
  }

  try {
    const r = await query('SELECT id FROM users WHERE email=$1', [lEmail])
    if (!r.rows[0]) return res.json(ok)
    const userId = r.rows[0].id
    const token  = crypto.randomBytes(32).toString('hex')
    await query('DELETE FROM password_resets WHERE user_id=$1', [userId])
    await query('INSERT INTO password_resets (user_id,token_hash,expires_at) VALUES($1,$2,$3)',
      [userId, sha256(token), new Date(Date.now() + 3600000)])
    await auditLog(userId, 'password_reset_request', req)
    const link = `${process.env.APP_URL || 'http://localhost:5173'}/reset-password?token=${token}`
    const html = `<p>Reset your FinSurf password: <a href="${link}">${link}</a></p><p>Expires in 1 hour.</p>`
    const sent = await sendEmail({ to: lEmail, subject: 'FinSurf — Password reset', html })
    if (!sent) console.log(`[AUTH] Password reset link for ${email}: ${link}`)
    return res.json(ok)
  } catch (err) { return res.json(ok) }
})

// ── POST /api/auth/reset-password ─────────────────
router.post('/reset-password', async (req, res) => {
  const { token, password } = req.body
  if (!token || !password || !validatePassword(password))
    return res.status(400).json({ error: 'Valid token and password required' })

  if (!DB_MODE) {
    const data = MEM.resets.get(sha256(token))
    if (!data || data.used || data.expiresAt < Date.now())
      return res.status(400).json({ error: 'Reset link is invalid or has expired' })
    const user = MEM.users.get(data.userId)
    if (!user) return res.status(404).json({ error: 'User not found' })
    user.passwordHash = await bcrypt.hash(password, BCRYPT_ROUNDS)
    user.failedAttempts = 0
    data.used = true
    for (const [k, v] of MEM.tokens) { if (v.userId === data.userId) MEM.tokens.delete(k) }
    return res.json({ ok: true, message: 'Password reset. Please log in.' })
  }

  try {
    const r = await query('SELECT id,user_id,expires_at,used_at FROM password_resets WHERE token_hash=$1', [sha256(token)])
    const reset = r.rows[0]
    if (!reset || reset.used_at || new Date(reset.expires_at) < new Date())
      return res.status(400).json({ error: 'Reset link is invalid or has expired' })
    await query('UPDATE users SET password_hash=$1,failed_login_attempts=0,locked_until=NULL WHERE id=$2',
      [await bcrypt.hash(password, BCRYPT_ROUNDS), reset.user_id])
    await query('UPDATE password_resets SET used_at=NOW() WHERE id=$1', [reset.id])
    await query('UPDATE refresh_tokens SET revoked_at=NOW() WHERE user_id=$1', [reset.user_id])
    await auditLog(reset.user_id, 'password_reset_success', req)
    return res.json({ ok: true, message: 'Password reset. Please log in.' })
  } catch (err) {
    console.error('[auth/reset]', err.message)
    return res.status(500).json({ error: 'Reset failed' })
  }
})

module.exports = router
