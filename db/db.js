'use strict'
/**
 * PostgreSQL connection pool
 * Gracefully returns null when DATABASE_URL is not set (local dev / no DB mode).
 */
const { Pool } = require('pg')

let pool = null

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
    })
    pool.on('error', err => console.error('[DB] Unexpected pool error:', err.message))
  }
  return pool
}

/**
 * Execute a parameterised query.
 * Throws if DATABASE_URL is not configured.
 */
async function query(text, params) {
  const db = getPool()
  if (!db) throw new Error('Database not configured (DATABASE_URL missing)')
  const client = await db.connect()
  try {
    return await client.query(text, params)
  } finally {
    client.release()
  }
}

/** Quick connectivity test — returns true/false */
async function ping() {
  try { await query('SELECT 1'); return true } catch { return false }
}

module.exports = { query, getPool, ping }
