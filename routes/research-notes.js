'use strict'
/**
 * routes/research-notes.js
 *
 * Second Brain — per-user research notes with markdown content.
 * Note types: note | thesis | braindump | url
 *
 * GET    /api/research-notes           — list user's notes (filter: ?symbol=&type=&limit=)
 * POST   /api/research-notes           — create note
 * PUT    /api/research-notes/:id       — update note
 * DELETE /api/research-notes/:id       — delete note
 * POST   /api/research-notes/braindump — AI: structure raw thoughts into investment thesis
 */

const express        = require('express')
const crypto         = require('crypto')
const Anthropic      = require('@anthropic-ai/sdk')
const { query }      = require('../db/db')
const { requireAuth } = require('../middleware/auth')
const { MEM }        = require('../db/memstore')

const router  = express.Router()
router.use(requireAuth)

const DB_MODE = !!process.env.DATABASE_URL

// ── helpers ───────────────────────────────────────────────────────────────────

function newId() { return crypto.randomUUID() }
function now()   { return new Date().toISOString() }

// ── GET /api/research-notes ──────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const userId = req.user.userId
  const { symbol, type, limit = 50 } = req.query
  const lim = Math.min(200, parseInt(limit) || 50)

  if (DB_MODE) {
    let sql = `SELECT * FROM research_notes WHERE user_id = $1`
    const params = [userId]
    if (symbol) { params.push(symbol.toUpperCase()); sql += ` AND symbol = $${params.length}` }
    if (type)   { params.push(type);                  sql += ` AND note_type = $${params.length}` }
    sql += ` ORDER BY updated_at DESC LIMIT $${params.push(lim)}`
    const { rows } = await query(sql, params)
    return res.json(rows)
  }

  let notes = [...MEM.notes.values()].filter(n => n.user_id === userId)
  if (symbol) notes = notes.filter(n => n.symbol === symbol.toUpperCase())
  if (type)   notes = notes.filter(n => n.note_type === type)
  notes.sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  return res.json(notes.slice(0, lim))
})

// ── POST /api/research-notes ─────────────────────────────────────────────────
router.post('/', async (req, res) => {
  const userId = req.user.userId
  const { title, content = '', symbol, note_type = 'note', source_url, tags = [] } = req.body
  if (!title?.trim()) return res.status(400).json({ error: 'title is required' })

  const sym = symbol ? symbol.toUpperCase() : null

  if (DB_MODE) {
    const { rows: [note] } = await query(`
      INSERT INTO research_notes (user_id, symbol, title, content, note_type, source_url, tags)
      VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
    `, [userId, sym, title.trim(), content, note_type, source_url || null, tags])
    return res.status(201).json(note)
  }

  const note = {
    id: newId(), user_id: userId, symbol: sym,
    title: title.trim(), content, note_type,
    source_url: source_url || null, tags,
    created_at: now(), updated_at: now(),
  }
  MEM.notes.set(note.id, note)
  return res.status(201).json(note)
})

// ── PUT /api/research-notes/:id ──────────────────────────────────────────────
router.put('/:id', async (req, res) => {
  const userId = req.user.userId
  const { id }  = req.params
  const { title, content, symbol, note_type, source_url, tags } = req.body

  if (DB_MODE) {
    const sets = [], params = []
    if (title      != null) { params.push(title.trim());           sets.push(`title      = $${params.length}`) }
    if (content    != null) { params.push(content);                sets.push(`content    = $${params.length}`) }
    if (symbol     != null) { params.push(symbol.toUpperCase());   sets.push(`symbol     = $${params.length}`) }
    if (note_type  != null) { params.push(note_type);              sets.push(`note_type  = $${params.length}`) }
    if (source_url != null) { params.push(source_url);             sets.push(`source_url = $${params.length}`) }
    if (tags       != null) { params.push(tags);                   sets.push(`tags       = $${params.length}`) }
    if (!sets.length) return res.status(400).json({ error: 'nothing to update' })
    params.push(id, userId)
    const { rows: [note] } = await query(
      `UPDATE research_notes SET ${sets.join(', ')}, updated_at = NOW()
       WHERE id = $${params.length - 1} AND user_id = $${params.length} RETURNING *`,
      params
    )
    if (!note) return res.status(404).json({ error: 'not found' })
    return res.json(note)
  }

  const note = MEM.notes.get(id)
  if (!note || note.user_id !== userId) return res.status(404).json({ error: 'not found' })
  if (title      != null) note.title      = title.trim()
  if (content    != null) note.content    = content
  if (symbol     != null) note.symbol     = symbol.toUpperCase()
  if (note_type  != null) note.note_type  = note_type
  if (source_url != null) note.source_url = source_url
  if (tags       != null) note.tags       = tags
  note.updated_at = now()
  MEM.notes.set(id, note)
  return res.json(note)
})

// ── DELETE /api/research-notes/:id ──────────────────────────────────────────
router.delete('/:id', async (req, res) => {
  const userId = req.user.userId
  const { id }  = req.params

  if (DB_MODE) {
    await query('DELETE FROM research_notes WHERE id=$1 AND user_id=$2', [id, userId])
    return res.json({ ok: true })
  }

  const note = MEM.notes.get(id)
  if (!note || note.user_id !== userId) return res.status(404).json({ error: 'not found' })
  MEM.notes.delete(id)
  return res.json({ ok: true })
})

// ── POST /api/research-notes/braindump ───────────────────────────────────────
// COG braindump pattern: raw thoughts → structured investment thesis in markdown
router.post('/braindump', async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'AI service not configured' })

  const { raw, symbol } = req.body
  if (!raw?.trim()) return res.status(400).json({ error: 'raw text is required' })

  const symbolCtx = symbol ? ` about ${symbol.toUpperCase()}` : ''

  const prompt = `You are a senior investment analyst. The user has a raw braindump of investment thoughts${symbolCtx}.
Structure it into a clean investment research note in Markdown.

RAW THOUGHTS:
${raw.trim()}

Respond ONLY with a valid JSON object:
{
  "title": "concise note title (max 60 chars)",
  "content": "full markdown note content",
  "tags": ["array", "of", "relevant", "tags"],
  "note_type": "thesis" or "note" or "braindump"
}

Markdown structure to use where appropriate:
# [Symbol or Topic]
## Bull Case
- key point
## Bear Case
- key point
## Catalysts
- near-term catalyst
## Thesis Breaker
- event that invalidates this
## Action Items
- [ ] specific next step`

  try {
    const client = new Anthropic({ apiKey })
    const msg = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2048,
      messages:   [{ role: 'user', content: prompt }],
    })
    const text  = msg.content?.[0]?.text || ''
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) return res.status(500).json({ error: 'Failed to parse AI response' })
    const structured = JSON.parse(match[0])
    return res.json(structured)
  } catch (err) {
    console.error('[research-notes/braindump]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router
