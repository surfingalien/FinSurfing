'use strict'
/**
 * Minimal Express app for testing — mounts route modules without starting the
 * HTTP server or connecting to a real database.  DATABASE_URL is intentionally
 * unset so routes fall back to the in-memory store.
 */

const express     = require('express')
const cookieParser = require('cookie-parser')

// Force in-memory mode (no real DB) and non-production env for tests
delete process.env.DATABASE_URL
process.env.NODE_ENV = 'test'
process.env.JWT_SECRET = 'test-secret-for-jest-only-32chars!!'

function createApp() {
  const app = express()
  app.use(express.json())
  app.use(express.urlencoded({ extended: false }))
  app.use(cookieParser())

  app.use('/api/auth',      require('../../routes/auth'))
  app.use('/api/portfolios', require('../../routes/portfolios'))
  app.use('/api/scheduler', require('../../routes/scheduler'))
  app.use('/api/trading-analysis', require('../../routes/trading-analysis'))
  app.use('/api/research-notes', require('../../routes/research-notes'))
  app.use('/api/mcp',       require('../../routes/mcp'))
  app.use('/api/fundamentals', require('../../routes/fundamentals'))

  return app
}

module.exports = { createApp }
