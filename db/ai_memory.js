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

// ── Chat history (Stock Agent) ────────────────────────────────────────────────

async function saveChatSummary(userId, symbol, summary) {
  if (!userId || !summary) return
  try {
    const sym = symbol ? symbol.toUpperCase() : null
    await query(
      `INSERT INTO ai_chat_history (user_id, symbol, summary)
       VALUES ($1, $2, $3)`,
      [userId, sym, summary.slice(0, 1000)]
    )
    if (sym) {
      await query(
        `DELETE FROM ai_chat_history
          WHERE user_id = $1 AND symbol = $2
            AND id NOT IN (
              SELECT id FROM ai_chat_history
               WHERE user_id = $1 AND symbol = $2
               ORDER BY created_at DESC LIMIT 5
            )`,
        [userId, sym]
      )
    }
  } catch (e) { console.warn('[ai_memory] saveChatSummary failed:', e.message) }
}

async function getChatHistory(userId, symbol, limit = 3) {
  if (!userId || !symbol) return []
  try {
    const { rows } = await query(
      `SELECT summary, created_at
         FROM ai_chat_history
        WHERE user_id = $1 AND symbol = $2
        ORDER BY created_at DESC
        LIMIT $3`,
      [userId, symbol.toUpperCase(), limit]
    )
    return rows
  } catch { return [] }
}

// ── User preferences (learned from interactions) ──────────────────────────────

async function saveUserPref(userId, type, content, concepts = [], source = null) {
  if (!userId || !content) return
  try {
    await query(
      `INSERT INTO ai_user_prefs (user_id, type, content, concepts, source)
       VALUES ($1, $2, $3, $4, $5)`,
      [userId, type, content, concepts, source]
    )
    await query(
      `DELETE FROM ai_user_prefs
        WHERE user_id = $1 AND type = $2
          AND id NOT IN (
            SELECT id FROM ai_user_prefs
             WHERE user_id = $1 AND type = $2
             ORDER BY created_at DESC LIMIT 20
          )`,
      [userId, type]
    )
  } catch (e) { console.warn('[ai_memory] saveUserPref failed:', e.message) }
}

async function getUserPrefs(userId, type = null, limit = 10) {
  if (!userId) return []
  try {
    const { rows } = type
      ? await query(
          `SELECT type, content, concepts, source, created_at
             FROM ai_user_prefs
            WHERE user_id = $1 AND type = $2
            ORDER BY created_at DESC LIMIT $3`,
          [userId, type, limit]
        )
      : await query(
          `SELECT type, content, concepts, source, created_at
             FROM ai_user_prefs
            WHERE user_id = $1
            ORDER BY created_at DESC LIMIT $2`,
          [userId, limit]
        )
    return rows
  } catch { return [] }
}

// ── QuantMind paper cache (survives deploys) ──────────────────────────────────

async function saveQuantmindPaper(userId, paper) {
  if (!userId || !paper?.arxiv_id) return
  try {
    await query(
      `INSERT INTO quantmind_papers
         (arxiv_id, user_id, title, abstract, authors, categories,
          key_contributions, relevance_score, tags, quant_applicability, published, source_url)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
       ON CONFLICT (arxiv_id, user_id) DO UPDATE SET
         key_contributions   = EXCLUDED.key_contributions,
         relevance_score     = EXCLUDED.relevance_score,
         tags                = EXCLUDED.tags,
         quant_applicability = EXCLUDED.quant_applicability,
         extracted_at        = NOW()`,
      [
        paper.arxiv_id, userId,
        paper.title || null, paper.abstract || null,
        paper.authors || [], paper.categories || [],
        JSON.stringify(paper.key_contributions || []),
        paper.relevance_score || 0.5,
        paper.tags || [], paper.quant_applicability || null,
        paper.published || null, paper.source_url || null,
      ]
    )
  } catch (e) { console.warn('[ai_memory] saveQuantmindPaper failed:', e.message) }
}

async function getQuantmindPapers(userId) {
  if (!userId) return []
  try {
    const { rows } = await query(
      `SELECT arxiv_id, title, abstract, authors, categories,
              key_contributions, relevance_score, tags, quant_applicability,
              published, source_url, extracted_at
         FROM quantmind_papers
        WHERE user_id = $1
        ORDER BY extracted_at DESC`,
      [userId]
    )
    return rows.map(r => ({
      ...r,
      key_contributions: Array.isArray(r.key_contributions) ? r.key_contributions : [],
    }))
  } catch { return [] }
}

async function getQuantmindPaper(userId, arxivId) {
  if (!userId || !arxivId) return null
  try {
    const { rows } = await query(
      `SELECT arxiv_id, title, abstract, authors, categories,
              key_contributions, relevance_score, tags, quant_applicability,
              published, source_url, extracted_at
         FROM quantmind_papers
        WHERE user_id = $1 AND arxiv_id = $2
        LIMIT 1`,
      [userId, arxivId]
    )
    if (!rows.length) return null
    const r = rows[0]
    return { ...r, key_contributions: Array.isArray(r.key_contributions) ? r.key_contributions : [] }
  } catch { return null }
}

async function deleteQuantmindPaper(userId, arxivId) {
  if (!userId || !arxivId) return
  try {
    await query(
      `DELETE FROM quantmind_papers WHERE user_id = $1 AND arxiv_id = $2`,
      [userId, arxivId]
    )
  } catch (e) { console.warn('[ai_memory] deleteQuantmindPaper failed:', e.message) }
}

module.exports = {
  recallMemory, saveMemory, searchMemory,
  saveChatSummary, getChatHistory,
  saveUserPref, getUserPrefs,
  saveQuantmindPaper, getQuantmindPapers, getQuantmindPaper, deleteQuantmindPaper,
}
