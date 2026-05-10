'use strict'
const jwt = require('jsonwebtoken')

// Fallback secret for demo/dev mode — replaced by env var in production
const FALLBACK_SECRET = 'finsurf-demo-secret-DO-NOT-USE-IN-PRODUCTION-32ch'
const SECRET = process.env.JWT_SECRET || FALLBACK_SECRET

/**
 * Verify the Bearer access token and attach `req.user = { userId, email, role }`.
 * Returns 401 on any failure — never leaks token details.
 */
function requireAuth(req, res, next) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing access token' })
  }

  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, SECRET, { algorithms: ['HS256'] })
    req.user = { userId: payload.sub, email: payload.email, role: payload.role || 'user' }
    next()
  } catch (err) {
    const msg = err.name === 'TokenExpiredError' ? 'Token expired' : 'Invalid token'
    return res.status(401).json({ error: msg })
  }
}

/**
 * Optional auth — attaches req.user if token present and valid, never rejects.
 */
function optionalAuth(req, res, next) {
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) return next()
  try {
    const payload = jwt.verify(header.slice(7), SECRET, { algorithms: ['HS256'] })
    req.user = { userId: payload.sub, email: payload.email, role: payload.role || 'user' }
  } catch {}
  next()
}

/**
 * Require admin role — must be used after requireAuth.
 * Returns 403 if user is not an admin.
 */
function requireAdmin(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' })
  if (req.user.role !== 'admin') return res.status(403).json({ error: 'Admin access required' })
  next()
}

module.exports = { requireAuth, optionalAuth, requireAdmin, SECRET }
