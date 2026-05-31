'use strict'
/**
 * routes/research-notes.js
 *
 * Second Brain — per-user research notes with markdown content.
 * Note types: note | thesis | braindump | url
 *
 * GET    /api/research-notes                — list notes (filter: ?symbol=&type=&limit=)
 * POST   /api/research-notes                — create note
 * PUT    /api/research-notes/:id            — update note
 * DELETE /api/research-notes/:id            — delete note
 * POST   /api/research-notes/braindump      — AI: raw thoughts → investment thesis
 * POST   /api/research-notes/auto-research  — AI: Finnhub data → research note
 * POST   /api/research-notes/scout          — AI: URL content → structured note
 * POST   /api/research-notes/consolidate    — AI: merge notes → master thesis
 * GET    /api/research-notes/daily-brief    — AI: morning portfolio brief + opportunities
 */

const express         = require('express')
const crypto          = require('crypto')
const https           = require('https')
const http            = require('http')
const Anthropic       = require('@anthropic-ai/sdk')
const { query }       = require('../db/db')
const { requireAuth } = require('../middleware/auth')
const { MEM }         = require('../db/memstore')

const router  = express.Router()
router.use(requireAuth)

const DB_MODE = !!process.env.DATABASE_URL

// ── helpers ───────────────────────────────────────────────────────────────────

function newId() { return crypto.randomUUID() }
function now()   { return new Date().toISOString() }

// Fetch JSON from Finnhub API
function finnhubGet(path, key) {
  const sep = path.includes('?') ? '&' : '?'
  return new Promise((resolve) => {
    https.get(
      `https://finnhub.io/api/v1${path}${sep}token=${key}`,
      { headers: { 'User-Agent': 'FinSurf/1.0' } },
      (res) => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => { try { resolve(JSON.parse(data)) } catch { resolve(null) } })
      }
    ).on('error', () => resolve(null))
  })
}

// Fetch URL content, follow redirects, strip HTML tags
function fetchUrlContent(targetUrl, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    let parsed
    try { parsed = new URL(targetUrl) } catch { return reject(new Error('Invalid URL')) }

    const client = parsed.protocol === 'https:' ? https : http
    const req = client.request(
      {
        hostname: parsed.hostname,
        port:     parsed.port || undefined,
        path:     parsed.pathname + parsed.search,
        method:   'GET',
        headers:  { 'User-Agent': 'FinSurf-Scout/1.0', Accept: 'text/html,text/plain' },
        timeout:  12000,
      },
      (res) => {
        // Follow redirects
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${parsed.protocol}//${parsed.host}${res.headers.location}`
          res.destroy()
          return resolve(fetchUrlContent(next, maxRedirects - 1))
        }
        let data = ''
        res.setEncoding('utf8')
        res.on('data', c => { data += c; if (data.length > 300000) res.destroy() })
        res.on('end', () => {
          const text = data
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 8000)
          resolve(text)
        })
      }
    )
    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timed out')) })
    req.end()
  })
}

function aiClient() {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('AI service not configured')
  return new Anthropic({ apiKey })
}

function getFinnhubKey(req) {
  return req.headers['x-finnhub-key'] || process.env.FINNHUB_API_KEY || process.env.FINNHUB_KEY || ''
}

// Parse JSON from Claude's text response
function parseAiJson(text) {
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('Failed to parse AI response')
  return JSON.parse(match[0])
}

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
router.post('/braindump', async (req, res) => {
  const { raw, symbol } = req.body
  if (!raw?.trim()) return res.status(400).json({ error: 'raw text is required' })

  const symbolCtx = symbol ? ` about ${symbol.toUpperCase()}` : ''
  const prompt = `You are a senior investment analyst. The user has a raw braindump of investment thoughts${symbolCtx}.

Do THREE things:
1. Structure the thoughts into a clean investment research note.
2. Play devil's advocate — list 3–5 specific reasons this thesis could be WRONG. Don't be generic.
3. Extract 3 falsifiable assumptions — specific conditions that MUST hold for the bull case to play out.

RAW THOUGHTS:
${raw.trim()}

Respond ONLY with a valid JSON object (no markdown wrapper):
{
  "title": "concise note title (max 60 chars)",
  "content": "full markdown note content",
  "tags": ["array", "of", "relevant", "tags"],
  "note_type": "thesis" or "note" or "braindump",
  "counterarguments": [
    "Specific reason the thesis could fail #1",
    "Specific reason #2",
    "Specific reason #3"
  ],
  "assumptions": [
    "Specific falsifiable condition that must hold #1",
    "Specific falsifiable condition #2",
    "Specific falsifiable condition #3"
  ]
}

Markdown structure for content:
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
- [ ] specific next step

For counterarguments: be specific to the user's thesis, not generic. "Valuation is stretched" is not specific. "NVDA's P/E of 45x requires 40% YoY revenue growth to be sustained — any deceleration invalidates the thesis" is specific.
For assumptions: make them falsifiable with real observable data (earnings calls, macro reports, price levels).`

  try {
    const client = aiClient()
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    })
    return res.json(parseAiJson(msg.content?.[0]?.text || ''))
  } catch (err) {
    console.error('[research-notes/braindump]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/research-notes/auto-research ───────────────────────────────────
// Fetch Finnhub quote + news → Claude → structured investment thesis
router.post('/auto-research', async (req, res) => {
  const { symbol, save: doSave = false } = req.body
  if (!symbol?.trim()) return res.status(400).json({ error: 'symbol is required' })

  const fKey = getFinnhubKey(req)
  if (!fKey) return res.status(503).json({ error: 'Finnhub API key not configured. Add it in API Keys settings.' })

  const sym = symbol.toUpperCase()

  try {
    const today   = new Date()
    const twoWeeks = new Date(today - 14 * 86400000)
    const fmt      = d => d.toISOString().slice(0, 10)

    const [quote, news] = await Promise.all([
      finnhubGet(`/quote?symbol=${sym}`, fKey),
      finnhubGet(`/company-news?symbol=${sym}&from=${fmt(twoWeeks)}&to=${fmt(today)}`, fKey),
    ])

    const newsItems = Array.isArray(news) ? news.slice(0, 10) : []
    const newsSummary = newsItems.length
      ? newsItems.map(n => `- ${n.headline} (${new Date(n.datetime * 1000).toLocaleDateString()})`).join('\n')
      : 'No recent news found.'

    const quoteCtx = quote?.c
      ? `Price: $${quote.c.toFixed(2)} | Day change: ${quote.dp >= 0 ? '+' : ''}${quote.dp?.toFixed(2)}% | High: $${quote.h} | Low: $${quote.l} | Prev close: $${quote.pc}`
      : 'Quote unavailable'

    const prompt = `You are a senior investment analyst. Generate a structured investment research note for ${sym}.

CURRENT MARKET DATA:
${quoteCtx}

RECENT NEWS (last 14 days):
${newsSummary}

Respond ONLY with a valid JSON object:
{
  "title": "${sym} — Research Note · ${fmt(today)}",
  "content": "full markdown research note",
  "tags": ["auto-research", "${sym.toLowerCase()}", "thesis"],
  "note_type": "thesis"
}

Use EXACTLY this markdown structure:
# ${sym} — Research Note
## Bull Case
-
## Bear Case
-
## Recent Catalysts
-
## Price Context
- Current: $${quote?.c || '?'} | Key levels to watch
## Thesis Breaker
- what would invalidate this thesis
## Action Items
- [ ] `

    const client = aiClient()
    const msg    = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })
    const structured = parseAiJson(msg.content?.[0]?.text || '')
    structured.symbol = sym

    if (doSave) {
      const userId = req.user.userId
      if (DB_MODE) {
        const { rows: [note] } = await query(`
          INSERT INTO research_notes (user_id, symbol, title, content, note_type, tags)
          VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
        `, [userId, sym, structured.title, structured.content, 'thesis', structured.tags])
        return res.json({ note, saved: true })
      }
      const note = {
        id: newId(), user_id: userId, symbol: sym,
        title: structured.title, content: structured.content,
        note_type: 'thesis', source_url: null, tags: structured.tags,
        created_at: now(), updated_at: now(),
      }
      MEM.notes.set(note.id, note)
      return res.json({ note, saved: true })
    }

    return res.json({ note: structured, saved: false })
  } catch (err) {
    console.error('[research-notes/auto-research]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/research-notes/scout ───────────────────────────────────────────
// Fetch URL content → Claude evaluates investment relevance → structured note
router.post('/scout', async (req, res) => {
  const { url, symbol, save: doSave = false } = req.body
  if (!url?.trim()) return res.status(400).json({ error: 'url is required' })

  const sym = symbol ? symbol.toUpperCase() : null

  try {
    const pageText = await fetchUrlContent(url)
    if (!pageText) return res.status(422).json({ error: 'Could not extract content from URL' })

    const prompt = `You are a senior investment analyst. Evaluate this web content for investment research relevance${sym ? ` regarding ${sym}` : ''}.

URL: ${url}

PAGE CONTENT (truncated):
${pageText}

Extract key investment insights and structure them. Respond ONLY with a valid JSON object:
{
  "title": "concise title under 60 chars",
  "content": "structured markdown note with key insights",
  "tags": ["url-scout", "relevant-tag"],
  "note_type": "url",
  "relevant": true
}

If not investment-relevant, set relevant: false with a brief explanation in content.
If relevant, use this structure:
## Key Takeaways
-
## Investment Implications
-
## Questions Raised
- `

    const client = aiClient()
    const msg    = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })
    const structured = parseAiJson(msg.content?.[0]?.text || '')
    if (sym) structured.symbol = sym
    structured.source_url = url

    if (doSave) {
      const userId = req.user.userId
      if (DB_MODE) {
        const { rows: [note] } = await query(`
          INSERT INTO research_notes (user_id, symbol, title, content, note_type, source_url, tags)
          VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *
        `, [userId, sym, structured.title, structured.content, 'url', url, structured.tags])
        return res.json({ note, saved: true })
      }
      const note = {
        id: newId(), user_id: userId, symbol: sym,
        title: structured.title, content: structured.content,
        note_type: 'url', source_url: url, tags: structured.tags,
        created_at: now(), updated_at: now(),
      }
      MEM.notes.set(note.id, note)
      return res.json({ note, saved: true })
    }

    return res.json({ note: structured, saved: false })
  } catch (err) {
    console.error('[research-notes/scout]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/research-notes/consolidate ─────────────────────────────────────
// Merge up to 20 user notes into a synthesised master thesis
router.post('/consolidate', async (req, res) => {
  const userId = req.user.userId
  const { symbol } = req.body
  const sym = symbol ? symbol.toUpperCase() : null

  try {
    let existingNotes
    if (DB_MODE) {
      let sql = `SELECT * FROM research_notes WHERE user_id = $1`
      const params = [userId]
      if (sym) { params.push(sym); sql += ` AND symbol = $${params.length}` }
      sql += ` ORDER BY updated_at DESC LIMIT 20`
      const { rows } = await query(sql, params)
      existingNotes = rows
    } else {
      existingNotes = [...MEM.notes.values()]
        .filter(n => n.user_id === userId && (!sym || n.symbol === sym))
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 20)
    }

    if (existingNotes.length === 0) {
      return res.status(400).json({ error: `No notes found${sym ? ` for ${sym}` : ''}` })
    }

    const notesSummary = existingNotes.map((n, i) =>
      `--- Note ${i + 1}: "${n.title}" [${n.note_type}${n.symbol ? ` · ${n.symbol}` : ''}] (${new Date(n.updated_at).toLocaleDateString()}) ---\n${n.content.slice(0, 600)}`
    ).join('\n\n')

    const dateLabel = new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const titleStr  = sym ? `${sym} — Master Thesis · ${dateLabel}` : `Knowledge Consolidation · ${dateLabel}`

    const prompt = `You are a senior investment analyst. Review these ${existingNotes.length} research notes${sym ? ` about ${sym}` : ''} and synthesise them into a single master thesis document.

EXISTING NOTES:
${notesSummary}

Respond ONLY with a valid JSON object:
{
  "title": "${titleStr}",
  "content": "full master thesis in markdown",
  "tags": ["consolidated", "master-thesis"${sym ? `, "${sym.toLowerCase()}"` : ''}],
  "note_type": "thesis"
}

Use EXACTLY this structure:
# ${sym || 'Portfolio'} — Master Investment Thesis
*Synthesised from ${existingNotes.length} notes · ${dateLabel}*

## Consolidated Bull Case
## Consolidated Bear Case
## Key Near-Term Catalysts
## Knowledge Gaps
- Gap 1
- Gap 2
- Gap 3
## Contradictions Identified
*(flag any notes where the thesis has changed or conflict with each other)*
## Recommended Action Items
- [ ] `

    const client = aiClient()
    const msg    = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })
    const structured = parseAiJson(msg.content?.[0]?.text || '')

    if (DB_MODE) {
      const { rows: [note] } = await query(`
        INSERT INTO research_notes (user_id, symbol, title, content, note_type, tags)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [userId, sym, structured.title, structured.content, 'thesis', structured.tags])
      return res.json(note)
    }

    const note = {
      id: newId(), user_id: userId, symbol: sym,
      title: structured.title, content: structured.content,
      note_type: 'thesis', source_url: null, tags: structured.tags,
      created_at: now(), updated_at: now(),
    }
    MEM.notes.set(note.id, note)
    return res.json(note)
  } catch (err) {
    console.error('[research-notes/consolidate]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ── GET /api/research-notes/daily-brief ──────────────────────────────────────
// Morning portfolio intelligence brief + 3–6 month opportunity watchlist
router.get('/daily-brief', async (req, res) => {
  const fKey = getFinnhubKey(req)
  if (!fKey) return res.status(503).json({ error: 'Finnhub API key not configured. Add it in API Keys settings.' })

  const userId = req.user.userId
  const { symbols: symbolsStr = '', portfolioValue = '0' } = req.query

  const symbols = symbolsStr.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 25)
  if (symbols.length === 0) return res.status(400).json({ error: 'symbols query param is required' })

  try {
    // Fetch quotes for all holdings
    const quotes = await Promise.all(
      symbols.map(sym => finnhubGet(`/quote?symbol=${sym}`, fKey).then(q => ({ sym, q })))
    )

    // Fetch news for top 5 holdings
    const today      = new Date()
    const threeDays  = new Date(today - 3 * 86400000)
    const fmt        = d => d.toISOString().slice(0, 10)
    const top5       = symbols.slice(0, 5)
    const newsAll    = await Promise.all(
      top5.map(sym =>
        finnhubGet(`/company-news?symbol=${sym}&from=${fmt(threeDays)}&to=${fmt(today)}`, fKey)
          .then(n => ({ sym, news: Array.isArray(n) ? n.slice(0, 3) : [] }))
      )
    )

    const quoteTable = quotes.map(({ sym, q }) => {
      if (!q?.c) return `| ${sym} | N/A | N/A |`
      const chg = q.dp >= 0 ? `+${q.dp?.toFixed(2)}%` : `${q.dp?.toFixed(2)}%`
      return `| ${sym} | $${q.c.toFixed(2)} | ${chg} |`
    }).join('\n')

    const newsContext = newsAll.map(({ sym, news }) =>
      news.length ? `**${sym}:**\n${news.map(n => `  - ${n.headline}`).join('\n')}` : `**${sym}:** No recent news`
    ).join('\n')

    const dateStr    = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
    const dateShort  = fmt(today)
    const portVal    = Number(portfolioValue) > 0 ? `Portfolio value: ~$${Number(portfolioValue).toLocaleString()}` : ''

    const prompt = `You are a senior portfolio manager providing a morning briefing for ${dateStr}.

PORTFOLIO HOLDINGS:
${portVal}
Symbols: ${symbols.join(', ')}

LIVE PRICES:
| Symbol | Price | Day Change |
|--------|-------|------------|
${quoteTable}

RECENT NEWS (last 3 days, top holdings):
${newsContext}

Generate a comprehensive morning brief. Respond ONLY with a valid JSON object:
{
  "title": "Morning Brief — ${dateShort}",
  "content": "full markdown morning brief (detailed, 600-900 words)",
  "tags": ["daily-brief", "${dateShort}", "morning-brief"]
}

Use EXACTLY this structure — be specific, not generic:
# Morning Brief — ${dateStr}

## Portfolio Pulse
| Symbol | Price | Day % | Assessment |
|--------|-------|--------|-----------|
[one row per holding, Assessment = Strong/Hold/Watch/Weak based on momentum]

## Key Catalysts This Week
[2-4 bullet points per symbol that has notable news; skip if no news]

## 3–6 Month Outlook
[concise 2-3 bullet thesis for each major holding based on current price action and news]

## Opportunities to Watch (3–6 Month Growth)
[5 specific tickers NOT already in the portfolio. Mix: sector ETFs (XLK, SOXX, QQQ, VGT, SCHG, ARKK, IBB) AND individual quality growth names. For each: **TICKER** — 1-sentence rationale tied to the existing portfolio's sector gaps or momentum themes]

## Action Items
- [ ] [specific, actionable step — not generic advice]
- [ ] [specific, actionable step]
- [ ] [specific, actionable step]`

    const client = aiClient()
    const msg    = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 6000,
      messages: [{ role: 'user', content: prompt }],
    })
    const structured = parseAiJson(msg.content?.[0]?.text || '')

    if (DB_MODE) {
      const { rows: [note] } = await query(`
        INSERT INTO research_notes (user_id, symbol, title, content, note_type, tags)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [userId, null, structured.title, structured.content, 'braindump', structured.tags])
      return res.json(note)
    }

    const note = {
      id: newId(), user_id: userId, symbol: null,
      title: structured.title, content: structured.content,
      note_type: 'braindump', source_url: null, tags: structured.tags,
      created_at: now(), updated_at: now(),
    }
    MEM.notes.set(note.id, note)
    return res.json(note)
  } catch (err) {
    console.error('[research-notes/daily-brief]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router
