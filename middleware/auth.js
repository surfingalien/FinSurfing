'use strict'
const jwt = require('jsonwebtoken')

const SECRET = process.env.JWT_SECRET

/**
 * Verify the Bearer access token and attach `req.user = { userId, email }`.
 * Returns 401 on any failure — never leaks token details.
 */
function requireAuth(req, res, next) {
  if (!SECRET) return res.status(503).json({ error: 'Auth not configured' })

  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Missing access token' })
  }

  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, SECRET, { algorithms: ['HS256'] })
    req.user = { userId: payload.sub, email: payload.email }
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
  if (!SECRET) return next()
  const header = req.headers.authorization || ''
  if (!header.startsWith('Bearer ')) return next()
  try {
    const payload = jwt.verify(header.slice(7), SECRET, { algorithms: ['HS256'] })
    req.user = { userId: payload.sub, email: payload.email }
  } catch {}
  next()
}

module.exports = { requireAuth, optionalAuth }
