'use strict'
/**
 * PostgreSQL connection pool
 * Gracefully returns null when DATABASE_URL is not set (local dev / no DB mode).
 */
const { Pool } = require('pg')

let pool = null

// TLS config for the Postgres connection.
// Set DATABASE_CA_CERT to the provider's CA certificate (PEM — literal
// newlines or \n-escaped both work) to pin the cert chain and reject
// anything else (defeats MITM on the DB hop). Without it, production
// falls back to encrypted-but-unverified TLS, with a startup warning.
function buildSsl() {
  const ca = (process.env.DATABASE_CA_CERT || '').replace(/\\n/g, '\n').trim()
  if (ca) return { ca, rejectUnauthorized: true }
  if (process.env.NODE_ENV === 'production') {
    console.warn('[DB] WARNING: DATABASE_CA_CERT not set — TLS is encrypted but the server certificate is NOT verified. Set it to the Postgres provider\'s CA bundle to pin the connection.')
    return { rejectUnauthorized: false }
  }
  return false
}

function getPool() {
  if (!pool && process.env.DATABASE_URL) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: buildSsl(),
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
