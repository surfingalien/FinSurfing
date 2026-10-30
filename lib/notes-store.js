'use strict'

/**
 * lib/notes-store.js
 *
 * Second Brain notes outside a request: the one place that creates a note and
 * reads a user's latest notes on a symbol, in Postgres (DATABASE_URL) or the
 * in-memory store. routes/research-notes.js creates notes through it; the
 * morning holdings-research job saves each Research Desk thesis as a note,
 * and the Research Desk reads the user's own latest note on a symbol.
 */

const crypto = require('crypto')
const { query } = require('../db/db')
const { MEM, persistMem } = require('../db/memstore')

const dbMode = () => !!process.env.DATABASE_URL

// Notes the morning job writes carry this tag, so "your own note" can leave
// them out and the job can find its own previous verdict on a symbol.
const RESEARCH_DESK_TAG = 'research-desk'

async function createNote(userId, { title, content = '', symbol = null, note_type = 'note', source_url = null, tags = [] }) {
  const sym = symbol ? String(symbol).toUpperCase() : null
  if (dbMode()) {
    const { rows: [note] } = await query(`
      INSERT INTO research_notes (user_id, symbol, title, content, note_type, source_url, tags)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [userId, sym, String(title).trim(), content, note_type, source_url || null, tags])
    return note
  }
  const at = new Date().toISOString()
  const note = {
    id: crypto.randomUUID(), user_id: userId, symbol: sym,
    title: String(title).trim(), content, note_type,
    source_url: source_url || null, tags,
    created_at: at, updated_at: at,
  }
  MEM.notes.set(note.id, note)
  persistMem()
  return note
}

/**
 * The user's most recently updated notes on a symbol, newest first.
 * `withTag` keeps only notes carrying the tag; `withoutTag` drops them.
 */
async function latestNotes(userId, symbol, { limit = 1, withTag = null, withoutTag = null } = {}) {
  if (!userId || !symbol) return []
  const sym = String(symbol).toUpperCase()
  if (dbMode()) {
    const params = [userId, sym]
    let sql = 'SELECT * FROM research_notes WHERE user_id = $1 AND symbol = $2'
    if (withTag)    { params.push(withTag);    sql += ` AND $${params.length} = ANY(tags)` }
    if (withoutTag) { params.push(withoutTag); sql += ` AND NOT ($${params.length} = ANY(tags))` }
    params.push(limit)
    sql += ` ORDER BY updated_at DESC LIMIT $${params.length}`
    return (await query(sql, params)).rows
  }
  return [...MEM.notes.values()]
    .filter(n => n.user_id === userId && n.symbol === sym)
    .filter(n => !withTag || (n.tags || []).includes(withTag))
    .filter(n => !withoutTag || !(n.tags || []).includes(withoutTag))
    .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)))
    .slice(0, limit)
}

module.exports = { createNote, latestNotes, RESEARCH_DESK_TAG }
