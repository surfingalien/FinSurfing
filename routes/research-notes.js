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

// SSRF guard: reject private/loopback/link-local IPs
const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|fc00:|fe80:)/i
function isSafeHost(hostname) {
  if (!hostname || hostname === 'localhost') return false
  if (PRIVATE_IP_RE.test(hostname)) return false
  return true
}

// Fetch URL content, follow redirects, strip HTML tags
function fetchUrlContent(targetUrl, maxRedirects = 3) {
  return new Promise((resolve, reject) => {
    let parsed
    try { parsed = new URL(targetUrl) } catch { return reject(new Error('Invalid URL')) }

    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:')
      return reject(new Error('Only http/https URLs are supported'))
    if (!isSafeHost(parsed.hostname))
      return reject(new Error('URL resolves to a disallowed address'))

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
        // Follow redirects — re-validate host on each hop
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && maxRedirects > 0) {
          const next = res.headers.location.startsWith('http')
            ? res.headers.location
            : `${parsed.protocol}//${parsed.host}${res.headers.location}`
          res.destroy()
          try {
            const nextParsed = new URL(next)
            if (!isSafeHost(nextParsed.hostname)) return reject(new Error('Redirect to disallowed address'))
          } catch { return reject(new Error('Invalid redirect URL')) }
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

function isStaleNote(updatedAt) {
  if (!updatedAt) return false
  return (Date.now() - new Date(updatedAt)) > 30 * 86400000
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

  const userId = req.user.userId
  const { symbols: symbolsStr = '', portfolioValue = '0' } = req.query

  const symbols = symbolsStr.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 25)
  if (symbols.length === 0) return res.status(400).json({ error: 'symbols query param is required' })

  try {
    // Fetch quotes via the internal cascade (AISA → Finnhub → FMP) instead of
    // direct Finnhub calls — avoids the free-tier c:0 trap and uses cached prices
    const BASE = `http://127.0.0.1:${process.env.PORT || 3001}`
    const fwdH = {}
    for (const h of ['x-aisa-key','x-finnhub-key','x-fmp-key','x-td-key','x-av-key'])
      if (req.headers[h]) fwdH[h] = req.headers[h]

    let quoteLookup = {}
    try {
      const qRes  = await fetch(
        `${BASE}/api/quote?symbols=${symbols.map(encodeURIComponent).join(',')}`,
        { headers: fwdH, signal: AbortSignal.timeout(15_000) }
      )
      const qJson = qRes.ok ? await qRes.json() : null
      for (const q of (qJson?.quoteResponse?.result ?? []))
        if (q?.symbol) quoteLookup[q.symbol] = q
    } catch (e) { console.warn('[daily-brief] quote fetch failed:', e.message) }

    // Fetch news for top 5 holdings
    const today      = new Date()
    const threeDays  = new Date(today - 3 * 86400000)
    const fmt        = d => d.toISOString().slice(0, 10)
    const top5    = symbols.slice(0, 5)
    const newsAll = fKey
      ? await Promise.all(
          top5.map(sym =>
            finnhubGet(`/company-news?symbol=${sym}&from=${fmt(threeDays)}&to=${fmt(today)}`, fKey)
              .then(n => ({ sym, news: Array.isArray(n) ? n.slice(0, 3) : [] }))
          )
        )
      : top5.map(sym => ({ sym, news: [] }))

    const quoteTable = symbols.map(sym => {
      const q = quoteLookup[sym]
      if (!q?.regularMarketPrice) return `| ${sym} | N/A | N/A |`
      const pct = q.regularMarketChangePercent
      const chg = pct != null ? (pct >= 0 ? `+${pct.toFixed(2)}%` : `${pct.toFixed(2)}%`) : 'N/A'
      return `| ${sym} | $${q.regularMarketPrice.toFixed(2)} | ${chg} |`
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

// ── POST /api/research-notes/think ───────────────────────────────────────────
// 10-principle investment thinking framework (inspired by claude-obsidian /think)
router.post('/think', async (req, res) => {
  const { problem, symbol, contextNotes } = req.body
  if (!problem?.trim()) return res.status(400).json({ error: 'problem is required' })

  const sym = symbol ? symbol.toUpperCase() : null
  const ctxBlock = contextNotes ? `\nContext from your research notes:\n${String(contextNotes).slice(0, 2000)}` : ''

  const prompt = `You are applying a 10-principle investment thinking framework.

DECISION / PROBLEM:
${problem}${sym ? `\nTicker: ${sym}` : ''}${ctxBlock}

Apply EXACTLY these 10 lenses — be specific to THIS investment, not generic:
1. **First Principles** — What is fundamentally true? Strip away assumptions.
2. **Inversion** — What would make this investment fail? Work backwards from disaster.
3. **Second-Order Effects** — What happens next? And after that?
4. **Base Rates** — Historical success rate of similar situations/setups?
5. **Mental Models** — Which applies: optionality, mean reversion, network effects, moats, reflexivity?
6. **Pre-Mortem** — Imagine it's 12 months from now and this failed. Why?
7. **Bayesian Update** — What new evidence would change your mind, and by how much?
8. **Outside View** — What would a disinterested analyst or short-seller say?
9. **Opportunity Cost** — Best alternative use of this capital right now?
10. **Reversibility** — One-way or two-way door? What's the exit?

Respond ONLY with a valid JSON object:
{
  "title": "Think: [concise 50-char decision title]",
  "content": "full markdown analysis using all 10 lenses",
  "tags": ["think", "framework"${sym ? `, "${sym.toLowerCase()}"` : ''}],
  "note_type": "think",
  "recommendation": "BUY or SELL or HOLD or WAIT or INVESTIGATE",
  "confidence": 65,
  "top_risk": "single most critical risk in one sentence",
  "key_question": "the one question that must be answered before deciding"
}`

  try {
    const client = aiClient()
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })
    return res.json(parseAiJson(msg.content?.[0]?.text || ''))
  } catch (err) {
    console.error('[research-notes/think]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/research-notes/thinking-partner ─────────────────────────────────
// Socratic dialogue — probing questions that deepen a thesis (claudesidian pattern)
router.post('/thinking-partner', async (req, res) => {
  const { thesis, symbol, previousQuestions = [], previousAnswers = [] } = req.body
  if (!thesis?.trim()) return res.status(400).json({ error: 'thesis is required' })

  const sym = symbol ? symbol.toUpperCase() : null
  const history = previousQuestions.length > 0
    ? '\n\nPrevious Q&A:\n' + previousQuestions.map((q, i) =>
        `Q: ${q}\nA: ${previousAnswers[i] || '(unanswered)'}`).join('\n\n')
    : ''

  const prompt = `You are a Socratic thinking partner helping an investor stress-test their thesis.

THESIS${sym ? ` (${sym})` : ''}:
${thesis}${history}

Ask 4 probing questions that:
- Challenge specific assumptions in THIS thesis (not generic questions)
- Surface hidden risks the investor may have missed
- Probe the reasoning quality and evidence base
- Test reversibility and exit conditions

Then provide a brief synthesis.

Respond ONLY with valid JSON:
{
  "questions": [
    "Specific probing question 1",
    "Specific probing question 2",
    "Specific probing question 3",
    "Specific probing question 4"
  ],
  "synthesis": "2-3 sentence honest assessment of this thesis",
  "strongest_point": "the most compelling part",
  "blind_spot": "the most likely overlooked risk or assumption"
}`

  try {
    const client = aiClient()
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1024,
      messages: [{ role: 'user', content: prompt }],
    })
    return res.json(parseAiJson(msg.content?.[0]?.text || ''))
  } catch (err) {
    console.error('[research-notes/thinking-partner]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/research-notes/lint ─────────────────────────────────────────────
// Vault health check: stale theses, empty notes, orphans, coverage gaps, contradictions
router.post('/lint', async (req, res) => {
  const userId = req.user.userId
  const { portfolioSymbols = [] } = req.body

  try {
    let notes
    if (DB_MODE) {
      const { rows } = await query(
        `SELECT id, symbol, title, note_type, tags, content, updated_at FROM research_notes WHERE user_id = $1 ORDER BY updated_at DESC`,
        [userId]
      )
      notes = rows
    } else {
      notes = [...MEM.notes.values()].filter(n => n.user_id === userId)
    }

    const issues = []

    // Stale theses
    notes.filter(n => n.note_type === 'thesis' && isStaleNote(n.updated_at)).forEach(n =>
      issues.push({ type: 'stale_thesis', severity: 'warning', noteId: n.id, title: n.title,
        message: `Thesis is over 30 days old — market conditions may have changed` })
    )

    // Empty / stub notes
    notes.filter(n => !n.content?.trim() || n.content.trim().length < 50).forEach(n =>
      issues.push({ type: 'empty_note', severity: 'info', noteId: n.id, title: n.title,
        message: 'Note is empty or too short to be useful' })
    )

    // Orphan notes (no symbol AND no tags)
    notes.filter(n => !n.symbol && (!n.tags || n.tags.length === 0)).forEach(n =>
      issues.push({ type: 'orphan', severity: 'info', noteId: n.id, title: n.title,
        message: 'No symbol or tags — will be hard to find later' })
    )

    // Portfolio coverage gaps
    const coveredSymbols = new Set(notes.map(n => n.symbol).filter(Boolean))
    const pSyms = Array.isArray(portfolioSymbols) ? portfolioSymbols : []
    pSyms.forEach(sym => {
      if (!coveredSymbols.has(sym))
        issues.push({ type: 'no_coverage', severity: 'warning', noteId: null, title: sym,
          message: `${sym} is in your portfolio but has no research notes` })
    })

    // AI contradiction detection across multi-thesis symbols
    const thesesBySym = {}
    notes.filter(n => n.symbol && n.note_type === 'thesis').forEach(n => {
      if (!thesesBySym[n.symbol]) thesesBySym[n.symbol] = []
      thesesBySym[n.symbol].push(n)
    })
    const multiSym = Object.entries(thesesBySym).filter(([, ns]) => ns.length >= 2).slice(0, 4)

    if (multiSym.length > 0) {
      try {
        const ctx = multiSym.map(([sym, ns]) =>
          `**${sym}:**\n${ns.map((n, i) => `Note${i+1} "${n.title}" (${new Date(n.updated_at).toLocaleDateString()}):\n${n.content.slice(0, 400)}`).join('\n---\n')}`
        ).join('\n\n===\n\n')

        const client = aiClient()
        const msg = await client.messages.create({
          model: 'claude-haiku-4-5-20251001', max_tokens: 1024,
          messages: [{ role: 'user', content: `Find genuine contradictions (not just evolution of views) in these investment notes.

${ctx}

Respond ONLY with a JSON array — if none, return []:
[{"symbol":"AAPL","contradiction":"Note1 bullish on margin expansion, Note2 says margins will compress due to Vision Pro costs — which view is current?"}]` }],
        })
        const raw = msg.content?.[0]?.text || ''
        const arr = JSON.parse(raw.match(/\[[\s\S]*\]/)?.[0] || '[]')
        arr.forEach(c =>
          issues.push({ type: 'contradiction', severity: 'error', noteId: null, title: c.symbol,
            message: c.contradiction })
        )
      } catch { /* skip if AI fails */ }
    }

    const score = Math.max(0, 100 - (
      issues.filter(i => i.severity === 'error').length   * 15 +
      issues.filter(i => i.severity === 'warning').length *  8 +
      issues.filter(i => i.severity === 'info').length    *  3
    ))

    return res.json({ issues, score, noteCount: notes.length, coveredSymbols: [...coveredSymbols] })
  } catch (err) {
    console.error('[research-notes/lint]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/research-notes/weekly-synthesis ─────────────────────────────────
// Identify patterns & themes across last 7 days of notes (claudesidian weekly-synthesis)
router.post('/weekly-synthesis', async (req, res) => {
  const userId = req.user.userId

  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString()
    let recentNotes

    if (DB_MODE) {
      const { rows } = await query(
        `SELECT * FROM research_notes WHERE user_id = $1 AND updated_at > $2 ORDER BY updated_at DESC LIMIT 30`,
        [userId, sevenDaysAgo]
      )
      recentNotes = rows
    } else {
      recentNotes = [...MEM.notes.values()]
        .filter(n => n.user_id === userId && n.updated_at > sevenDaysAgo)
        .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
        .slice(0, 30)
    }

    if (recentNotes.length === 0)
      return res.status(400).json({ error: 'No notes created or updated in the last 7 days' })

    const notesSummary = recentNotes.map((n, i) =>
      `Note ${i+1}: "${n.title}" [${n.note_type}${n.symbol ? ` · ${n.symbol}` : ''}] (${new Date(n.updated_at).toLocaleDateString()})\n${n.content.slice(0, 500)}`
    ).join('\n\n---\n\n')

    const today     = new Date()
    const weekStart = new Date(Date.now() - 7 * 86400000)
    const dateLabel = today.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    const weekStr   = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })

    const prompt = `You are a senior investment analyst reviewing a week of research activity.

NOTES FROM THE PAST 7 DAYS (${recentNotes.length} notes):
${notesSummary}

Synthesize this week's research into patterns and actionable insights. Respond ONLY with valid JSON:
{
  "title": "Weekly Synthesis — ${weekStr} to ${dateLabel}",
  "content": "full markdown weekly synthesis",
  "tags": ["weekly-synthesis", "synthesis"],
  "note_type": "synthesis"
}

Content structure:
# Weekly Synthesis — ${weekStr} to ${dateLabel}
*${recentNotes.length} notes reviewed*

## Emerging Themes
[2-4 dominant narratives across your research this week]

## Conviction Changes
[Which positions/theses strengthened? Which weakened? Be specific.]

## Patterns & Cross-Stock Connections
[What macro or sector connections did you notice across notes?]

## Sharpest Insight This Week
[The single best insight from this week — what you didn't know last week]

## Open Questions
[3-5 unresolved questions this week's notes raised]

## Watch Next Week
[3-5 specific tickers or topics to investigate further]`

    const client = aiClient()
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    })
    const structured = parseAiJson(msg.content?.[0]?.text || '')

    if (DB_MODE) {
      const { rows: [note] } = await query(`
        INSERT INTO research_notes (user_id, symbol, title, content, note_type, tags)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [userId, null, structured.title, structured.content, 'synthesis', structured.tags])
      return res.json(note)
    }

    const note = {
      id: newId(), user_id: userId, symbol: null,
      title: structured.title, content: structured.content,
      note_type: 'synthesis', source_url: null, tags: structured.tags,
      created_at: now(), updated_at: now(),
    }
    MEM.notes.set(note.id, note)
    return res.json(note)
  } catch (err) {
    console.error('[research-notes/weekly-synthesis]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/research-notes/deep-research ────────────────────────────────────
// 3-round autonomous research (claude-obsidian /autoresearch pattern)
// Round 1: gather data + identify gaps
// Round 2: fill gaps with first-principles analysis
// Round 3: synthesize into final research note
router.post('/deep-research', async (req, res) => {
  const { symbol } = req.body
  if (!symbol?.trim()) return res.status(400).json({ error: 'symbol is required' })

  const sym  = symbol.toUpperCase()
  const fKey = getFinnhubKey(req)

  try {
    const client  = aiClient()
    const today   = new Date()
    const twoWeeks = new Date(today - 14 * 86400000)
    const fmt     = d => d.toISOString().slice(0, 10)

    const [quote, news, profile] = await Promise.all([
      fKey ? finnhubGet(`/quote?symbol=${sym}`, fKey) : null,
      fKey ? finnhubGet(`/company-news?symbol=${sym}&from=${fmt(twoWeeks)}&to=${fmt(today)}`, fKey) : null,
      fKey ? finnhubGet(`/stock/profile2?symbol=${sym}`, fKey) : null,
    ])

    const newsItems = Array.isArray(news) ? news.slice(0, 12) : []
    const quoteCtx  = quote?.c
      ? `Price: $${quote.c.toFixed(2)} | Day: ${quote.dp >= 0 ? '+' : ''}${quote.dp?.toFixed(2)}% | High: $${quote.h} | Low: $${quote.l} | Prev Close: $${quote.pc}`
      : 'Quote unavailable'
    const profileCtx = profile?.name
      ? `Company: ${profile.name} | Sector: ${profile.finnhubIndustry} | Market Cap: $${(profile.marketCapitalization / 1000).toFixed(1)}B | Exchange: ${profile.exchange}`
      : `Ticker: ${sym}`
    const newsSummary = newsItems.length
      ? newsItems.map(n => `- [${new Date(n.datetime * 1000).toLocaleDateString()}] ${n.headline}`).join('\n')
      : 'No recent news available.'

    // Round 1 — initial analysis, identify gaps
    const r1 = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1024,
      messages: [{ role: 'user', content: `Analyzing ${sym} for investment research.

DATA:
${profileCtx}
${quoteCtx}

NEWS (14 days):
${newsSummary}

Round 1: Write initial thesis. Be explicit about what is MISSING or UNCERTAIN.
Respond ONLY with JSON:
{"initial_thesis":"paragraph","knowledge_gaps":["gap1","gap2","gap3","gap4"],"key_questions":["q1","q2","q3"]}` }],
    })
    const round1 = parseAiJson(r1.content?.[0]?.text || '')

    // Round 2 — fill gaps with first-principles reasoning
    const r2 = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 1536,
      messages: [{ role: 'user', content: `Analyzing ${sym}. Initial analysis done.

INITIAL THESIS: ${round1.initial_thesis}
GAPS: ${(round1.knowledge_gaps || []).join(' | ')}
QUESTIONS: ${(round1.key_questions || []).join(' | ')}

Round 2: Address each gap using financial first principles, industry knowledge, and market context.
Respond ONLY with JSON:
{"bull_case":"detailed","bear_case":"detailed","catalysts":["c1","c2","c3"],"risks":["r1","r2","r3"],"gap_answers":["answer to gap1","gap2","gap3","gap4"],"remaining_unknowns":["what still can't be resolved"]}` }],
    })
    const round2 = parseAiJson(r2.content?.[0]?.text || '')

    // Round 3 — final synthesis
    const r3 = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 4096,
      messages: [{ role: 'user', content: `Final synthesis for ${sym}.

R1 Initial: ${round1.initial_thesis}
R2 Bull: ${round2.bull_case}
R2 Bear: ${round2.bear_case}
Catalysts: ${(round2.catalysts || []).join(', ')}
Risks: ${(round2.risks || []).join(', ')}
Unknowns: ${(round2.remaining_unknowns || []).join(', ')}
Market: ${quoteCtx}

Round 3: Write the final comprehensive research note. Respond ONLY with JSON:
{
  "title": "${sym} — Deep Research · ${fmt(today)}",
  "content": "full detailed markdown note",
  "tags": ["deep-research", "${sym.toLowerCase()}", "thesis"],
  "note_type": "thesis",
  "signal": "BUY or SELL or HOLD or INVESTIGATE",
  "confidence": 70
}

Structure:
# ${sym} — Deep Research Note
*3-round analysis · ${fmt(today)}*
## Company Overview
## Bull Case
## Bear Case
## Key Catalysts (12-Month)
## Knowledge Gaps & Open Questions
## Price Action Context
## Thesis Breaker
- single event that invalidates this thesis
## Action Items
- [ ] specific next step` }],
    })
    const round3 = parseAiJson(r3.content?.[0]?.text || '')
    round3.symbol = sym
    round3.rounds = { round1, round2 }

    return res.json({ note: round3, saved: false })
  } catch (err) {
    console.error('[research-notes/deep-research]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/research-notes/daily-checklist ─────────────────────────────────
// Pre-market investment checklist tailored to portfolio + stated goals (obsidian-claude-pkm /daily)
router.post('/daily-checklist', async (req, res) => {
  const { portfolioSymbols = [], goals = {}, portfolioValue } = req.body

  const today   = new Date()
  const dateStr = today.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })
  const dateShort = today.toISOString().slice(0, 10)

  const goalsCtx = [
    goals.vision?.text   && `3-Year Vision: ${goals.vision.text}`,
    ...(goals.yearly || []).map(g => `Yearly Goal: ${g.text}${g.target ? ` (target: ${g.target})` : ''}`),
    goals.weekly?.priority && `This Week's Priority: ${goals.weekly.priority}`,
  ].filter(Boolean).join('\n')

  const syms = Array.isArray(portfolioSymbols) ? portfolioSymbols : []

  const prompt = `You are a disciplined investment coach generating a pre-market checklist for ${dateStr}.

INVESTOR GOALS:
${goalsCtx || 'No goals set yet.'}

PORTFOLIO: ${syms.length > 0 ? syms.join(', ') : 'Not specified'}
${portfolioValue ? `Portfolio Value: ~$${Number(portfolioValue).toLocaleString()}` : ''}

Generate a focused, actionable pre-market checklist. Respond ONLY with valid JSON:
{
  "title": "Daily Checklist — ${dateShort}",
  "content": "full markdown checklist",
  "tags": ["daily-checklist", "${dateShort}"],
  "note_type": "braindump"
}

Structure (be specific to their holdings and goals, not generic):
# Pre-Market Checklist — ${dateStr}

## Morning Focus (5 min)
- [ ] specific action tied to their goals or holdings

## Portfolio Review
${syms.slice(0, 4).map(s => `- [ ] Check ${s} for overnight moves or news`).join('\n')}

## Research Queue
- [ ] [specific research task aligned with goals]

## Risk Check
- [ ] [specific risk check for their positions]

## Goal Pulse
- [ ] [one concrete check tied to their stated yearly goal or weekly priority]

## Evening Reflection
- [ ] Log any trades or position changes in research notes
- [ ] Update thesis if any key developments occurred`

  try {
    const client = aiClient()
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    })
    return res.json(parseAiJson(msg.content?.[0]?.text || ''))
  } catch (err) {
    console.error('[research-notes/daily-checklist]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/research-notes/goal-align ───────────────────────────────────────
// Audit recent notes + portfolio activity against stated investment goals
router.post('/goal-align', async (req, res) => {
  const userId = req.user.userId
  const { goals = {} } = req.body

  const goalsCtx = [
    goals.vision?.text   && `Vision: ${goals.vision.text}`,
    ...(goals.yearly || []).map(g => `Yearly: ${g.text}`),
    ...(goals.projects || []).map(p => `Project: ${p.name}`),
    goals.weekly?.priority && `Weekly Priority: ${goals.weekly.priority}`,
  ].filter(Boolean).join('\n')

  if (!goalsCtx) return res.status(400).json({ error: 'No goals configured — set your goals first' })

  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString()
  let recentNotes
  if (DB_MODE) {
    const { rows } = await query(
      `SELECT title, note_type, symbol, content, updated_at FROM research_notes WHERE user_id=$1 AND updated_at>$2 ORDER BY updated_at DESC LIMIT 20`,
      [userId, sevenDaysAgo]
    )
    recentNotes = rows
  } else {
    recentNotes = [...MEM.notes.values()]
      .filter(n => n.user_id === userId && n.updated_at > sevenDaysAgo)
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at))
      .slice(0, 20)
  }

  const notesCtx = recentNotes.length > 0
    ? recentNotes.map(n => `- "${n.title}" [${n.note_type}${n.symbol ? ` · ${n.symbol}` : ''}]: ${n.content.slice(0, 200)}`).join('\n')
    : 'No research activity in the last 7 days.'

  const dateLabel = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })

  const prompt = `You are a goal-alignment coach for an investor.

STATED GOALS:
${goalsCtx}

LAST 7 DAYS OF RESEARCH ACTIVITY:
${notesCtx}

Assess alignment between goals and recent activity. Respond ONLY with valid JSON:
{
  "title": "Goal Alignment Audit — ${new Date().toISOString().slice(0, 10)}",
  "content": "full markdown audit",
  "tags": ["goal-align", "accountability"],
  "note_type": "think",
  "score": 72,
  "aligned": ["specific activity supporting goal 1", "activity 2"],
  "misaligned": ["gap or activity working against goals"],
  "recommendation": "single most important action to improve alignment this week"
}

Structure:
# Goal Alignment Audit — ${dateLabel}

## Alignment Score: X/100
*[One sentence explaining the score]*

## Well Aligned This Week
[Activities that serve stated goals — be specific]

## Gaps & Misalignments
[Activities or omissions that work against or don't serve goals]

## Recommendation
**[One concrete, specific action to do this week to improve alignment]**

## Reflection Questions
- [question 1 tailored to their goals]
- [question 2]`

  try {
    const client = aiClient()
    const msg = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    })
    const result = parseAiJson(msg.content?.[0]?.text || '')

    if (DB_MODE) {
      const { rows: [note] } = await query(`
        INSERT INTO research_notes (user_id, symbol, title, content, note_type, tags)
        VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
      `, [userId, null, result.title, result.content, 'think', result.tags])
      return res.json({ note, score: result.score, aligned: result.aligned, misaligned: result.misaligned, recommendation: result.recommendation })
    }

    const note = {
      id: newId(), user_id: userId, symbol: null,
      title: result.title, content: result.content,
      note_type: 'think', source_url: null, tags: result.tags,
      created_at: now(), updated_at: now(),
    }
    MEM.notes.set(note.id, note)
    return res.json({ note, score: result.score, aligned: result.aligned, misaligned: result.misaligned, recommendation: result.recommendation })
  } catch (err) {
    console.error('[research-notes/goal-align]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router
