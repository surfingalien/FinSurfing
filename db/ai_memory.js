'use strict'
/**
 * ai_memory — store and recall per-user per-symbol AI analyses.
 *
 * Both functions are no-ops (return null / []) when the DB is unavailable
 * so trading-analysis works normally in memory-only / dev mode.
 */
const { query } = require('./db')

const RECALL_LIMIT   = 3   // prior analyses injected into the Claude prompt
const RETENTION_ROWS = 20  // max rows kept per (user_id, symbol)

/**
 * Return the last `limit` analyses for a user+symbol, newest first.
 * Returns [] when DB is unavailable or no history exists.
 */
async function recallMemory(userId, symbol, limit = RECALL_LIMIT) {
  if (!userId || !symbol) return []
  try {
    const { rows } = await query(
      `SELECT signal, confidence, price, summary, created_at
         FROM ai_memory
        WHERE user_id = $1 AND symbol = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, symbol.toUpperCase(), limit]
    )
    return rows
  } catch { return [] }
}

/**
 * Persist an analysis result, then prune rows beyond RETENTION_ROWS.
 * Fire-and-forget — never throws, never blocks the HTTP response.
 */
async function saveMemory(userId, symbol, interval, price, analysis) {
  if (!userId || !symbol || !analysis) return
  try {
    const signal     = analysis.signal     ?? null
    const confidence = analysis.confidence ?? null
    const summary    = analysis.summary    ?? analysis.reasoning ?? null

    await query(
      `INSERT INTO ai_memory (user_id, symbol, interval, signal, confidence, price, summary, analysis)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [userId, symbol.toUpperCase(), interval, signal, confidence, price, summary, JSON.stringify(analysis)]
    )

    // Prune: keep only the most recent RETENTION_ROWS per user+symbol
    await query(
      `DELETE FROM ai_memory
        WHERE user_id = $1 AND symbol = $2
          AND id NOT IN (
            SELECT id FROM ai_memory
             WHERE user_id = $1 AND symbol = $2
             ORDER BY created_at DESC
             LIMIT $3
          )`,
      [userId, symbol.toUpperCase(), RETENTION_ROWS]
    )
  } catch (e) {
    console.warn('[ai_memory] save failed:', e.message)
  }
}

/**
 * Full-text search across a user's analysis history.
 * Returns matching rows ordered by recency.
 */
async function searchMemory(userId, queryText, limit = 10) {
  if (!userId || !queryText) return []
  try {
    const { rows } = await query(
      `SELECT symbol, signal, confidence, price, summary, created_at
         FROM ai_memory
        WHERE user_id = $1
          AND summary_tsv @@ plainto_tsquery('english', $2)
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, queryText, limit]
    )
    return rows
  } catch { return [] }
}

module.exports = { recallMemory, saveMemory, searchMemory }
