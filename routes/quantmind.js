'use strict'
/**
 * routes/quantmind.js
 *
 * QuantMind — Claude-native knowledge extraction, ported directly into
 * FinSurfing's Express server. No Python sidecar required.
 * Uses the same @anthropic-ai/sdk, circuit-breaker, and ai-audit patterns
 * as the existing ai-brain and recommendations routes.
 *
 * Endpoints:
 *   POST /api/quantmind/paper        { arxiv_id, fetch_abstract? }
 *   POST /api/quantmind/batch        { arxiv_ids[], max_concurrency? }
 *   POST /api/quantmind/ask          { question, arxiv_ids[], persona? }
 *   GET  /api/quantmind/memory       list all cached arxiv IDs
 *   GET  /api/quantmind/memory/:id   retrieve a cached paper
 *   DELETE /api/quantmind/memory/:id remove a cached paper
 */

const express    = require('express')
const Anthropic  = require('@anthropic-ai/sdk')
const rateLimit  = require('express-rate-limit')
const http       = require('http')
const { getBreaker, CircuitOpenError } = require('../lib/circuit-breaker')
const { logCall }                       = require('../lib/ai-audit')

const router  = express.Router()
const breaker = getBreaker('quantmind', { threshold: 4, resetTimeoutMs: 60_000 })

const QM_MODEL = 'claude-sonnet-4-6'

// ── Rate limits ───────────────────────────────────────────────────────────────
const paperLimit = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: 'Too many paper requests — wait a minute' },
})
const batchLimit = rateLimit({
  windowMs: 5 * 60 * 1000, max: 3,
  message: { error: 'Too many batch requests — wait 5 minutes' },
})
const askLimit = rateLimit({
  windowMs: 60 * 1000, max: 8,
  message: { error: 'Too many research questions — wait a minute' },
})
const searchLimit = rateLimit({
  windowMs: 60 * 1000, max: 20,
  message: { error: 'Too many search requests — wait a minute' },
})

// ── In-memory paper cache (survives request, resets on deploy) ────────────────
const PAPER_CACHE = new Map()

// ── arXiv fetch (pure Node https — no extra deps) ─────────────────────────────
function fetchArxivMeta(arxivId) {
  const cleanId = arxivId.replace(/^arxiv:/i, '').trim()
  const apiUrl  = `http://export.arxiv.org/api/query?id_list=${cleanId}&max_results=1`

  return new Promise((resolve, reject) => {
    http.get(apiUrl, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          resolve(_parseArxivAtom(data, cleanId))
        } catch (e) {
          reject(e)
        }
      })
    }).on('error', reject)
  })
}

// ── arXiv search (keyword or category browse) ────────────────────────────────
function searchArxiv({ q = '', category = 'q-fin', max = 15, sortBy = 'submittedDate' } = {}) {
  const searchQuery = [
    q ? `all:${encodeURIComponent(q)}` : '',
    category ? `cat:${category}` : '',
  ].filter(Boolean).join('+AND+')

  const url = `http://export.arxiv.org/api/query?search_query=${searchQuery}&max_results=${max}&sortBy=${sortBy}&sortOrder=descending`

  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try { resolve(_parseArxivFeed(data)) } catch (e) { reject(e) }
      })
    }).on('error', reject)
  })
}

function _parseArxivFeed(xml) {
  // Split into individual <entry> blocks
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => m[1])
  return entries.map(entry => {
    const tag = (t) => {
      const m = entry.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`))
      return m ? m[1].trim() : ''
    }
    const idRaw    = tag('id')
    const arxivId  = idRaw.replace('http://arxiv.org/abs/', '').replace('https://arxiv.org/abs/', '').trim()
    const title    = tag('title').replace(/\s+/g, ' ').trim()
    const abstract = tag('summary').replace(/\s+/g, ' ').trim()
    const authors  = [...entry.matchAll(/<name>(.*?)<\/name>/g)].map(m => m[1])
    const cats     = [...entry.matchAll(/term="([^"]+)"/g)].map(m => m[1]).filter(c => !c.includes('/'))
    const pubRaw   = tag('published')
    return {
      arxiv_id:   arxivId,
      title,
      abstract:   abstract.slice(0, 500),
      authors:    authors.slice(0, 5),
      categories: cats.slice(0, 4),
      published:  pubRaw ? new Date(pubRaw).toISOString() : null,
      source_url: `https://arxiv.org/abs/${arxivId}`,
      pdf_url:    `https://arxiv.org/pdf/${arxivId}`,
    }
  }).filter(e => e.arxiv_id && e.title)
}

function _parseArxivAtom(xml, arxivId) {
  const tag = (t) => {
    const m = xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)<\\/${t}>`))
    return m ? m[1].trim() : ''
  }
  const title    = tag('title').split('\n')[0].replace(/\s+/g, ' ').trim()
  const abstract = tag('summary').replace(/\s+/g, ' ').trim()
  const authors  = [...xml.matchAll(/<name>(.*?)<\/name>/g)].map(m => m[1])
  const cats     = [...xml.matchAll(/term="([^"]+)"/g)]
                     .map(m => m[1]).filter(c => !c.includes('/'))
  const pubRaw   = tag('published')
  const published = pubRaw ? new Date(pubRaw).toISOString() : new Date().toISOString()

  if (!title) throw new Error(`arXiv paper not found: ${arxivId}`)

  return { arxivId, title, authors, abstract, categories: cats.slice(0, 5), published }
}

// ── Claude extraction helpers ─────────────────────────────────────────────────
async function extractPaperCard(client, fetched) {
  const prompt = `You are a quantitative finance research analyst.
Extract structured metadata from this arXiv paper.

Title: ${fetched.title}
Authors: ${fetched.authors.slice(0, 5).join(', ')}
Categories: ${fetched.categories.join(', ')}
Abstract: ${fetched.abstract}

Return ONLY valid JSON (no markdown fences, no preamble):
{
  "key_contributions": ["<string>", "<string>", "<string>"],
  "relevance_score": <float 0.0-1.0>,
  "tags": ["<tag>", "<tag>", "<tag>"],
  "quant_applicability": "<one sentence: how this applies to trading/portfolio management>"
}`

  const { result: resp, durationMs } = await breaker.call(() =>
    client.messages.create({
      model:      QM_MODEL,
      max_tokens: 600,
      messages:   [{ role: 'user', content: prompt }],
    })
  )

  logCall({
    route: 'quantmind/extract', model: QM_MODEL, llm: 'claude',
    symbols: [fetched.arxivId], success: true,
    tokensIn: resp.usage?.input_tokens, tokensOut: resp.usage?.output_tokens, durationMs,
  })

  let raw = resp.content[0].text.trim()
  raw = raw.replace(/^```json\s*/,'').replace(/^```\s*/,'').replace(/\s*```$/,'').trim()

  try {
    return JSON.parse(raw)
  } catch {
    return { key_contributions: [], relevance_score: 0.5, tags: [], quant_applicability: '' }
  }
}

// ── POST /api/quantmind/paper ─────────────────────────────────────────────────
router.post('/paper', paperLimit, async (req, res) => {
  const { arxiv_id } = req.body
  if (!arxiv_id || typeof arxiv_id !== 'string') {
    return res.status(400).json({ error: 'arxiv_id is required' })
  }

  const cleanId = arxiv_id.replace(/^arxiv:/i, '').trim()

  if (PAPER_CACHE.has(cleanId)) {
    return res.json({ cached: true, paper: PAPER_CACHE.get(cleanId) })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' })

  try {
    const fetched = await fetchArxivMeta(cleanId)
    const client  = new Anthropic({ apiKey })
    const card    = await extractPaperCard(client, fetched)

    const paper = {
      arxiv_id:     cleanId,
      title:        fetched.title,
      authors:      fetched.authors,
      abstract:     fetched.abstract,
      categories:   fetched.categories,
      published:    fetched.published,
      source_url:   `https://arxiv.org/abs/${cleanId}`,
      pdf_url:      `https://arxiv.org/pdf/${cleanId}`,
      extracted_at: new Date().toISOString(),
      model:        QM_MODEL,
      ...card,
    }

    PAPER_CACHE.set(cleanId, paper)
    return res.json({ cached: false, paper })

  } catch (err) {
    if (err instanceof CircuitOpenError) {
      return res.status(503).json({ error: err.message, circuitOpen: true })
    }
    console.error('[quantmind/paper]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ── POST /api/quantmind/batch ─────────────────────────────────────────────────
router.post('/batch', batchLimit, async (req, res) => {
  const { arxiv_ids, max_concurrency = 4 } = req.body
  if (!Array.isArray(arxiv_ids) || arxiv_ids.length === 0) {
    return res.status(400).json({ error: 'arxiv_ids must be a non-empty array' })
  }
  if (arxiv_ids.length > 20) {
    return res.status(400).json({ error: 'Maximum 20 papers per batch' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' })

  const client = new Anthropic({ apiKey })
  const concurrency = Math.min(Math.max(1, max_concurrency), 6)
  const ids     = arxiv_ids.map(id => id.replace(/^arxiv:/i, '').trim())
  const results = []

  for (let i = 0; i < ids.length; i += concurrency) {
    const chunk = ids.slice(i, i + concurrency)
    const settled = await Promise.allSettled(
      chunk.map(async (cleanId) => {
        if (PAPER_CACHE.has(cleanId)) {
          return { cached: true, paper: PAPER_CACHE.get(cleanId) }
        }
        const fetched = await fetchArxivMeta(cleanId)
        const card    = await extractPaperCard(client, fetched)
        const paper = {
          arxiv_id: cleanId, title: fetched.title, authors: fetched.authors,
          abstract: fetched.abstract, categories: fetched.categories,
          published: fetched.published,
          source_url: `https://arxiv.org/abs/${cleanId}`,
          pdf_url:    `https://arxiv.org/pdf/${cleanId}`,
          extracted_at: new Date().toISOString(), model: QM_MODEL, ...card,
        }
        PAPER_CACHE.set(cleanId, paper)
        return { cached: false, paper }
      })
    )
    for (const r of settled) {
      if (r.status === 'fulfilled') results.push(r.value)
      else results.push({ error: r.reason?.message || 'unknown error' })
    }
  }

  return res.json({ results, total: results.length })
})

// ── POST /api/quantmind/ask ───────────────────────────────────────────────────
const PERSONAS = {
  quant_analyst:    'You are a quantitative analyst. Focus on factor exposures, statistical significance, model assumptions, and implementation friction.',
  value_investor:   'You are a value investor. Focus on intrinsic value, margin of safety, business quality, and long-term fundamentals.',
  risk_manager:     'You are a risk manager. Identify tail risks, model fragility, correlation breakdown scenarios, and drawdown implications.',
  macro_strategist: 'You are a macro strategist. Connect research findings to macro regimes, rates, cross-asset flows, and positioning.',
  alpha_seeker:     'You are a hedge fund PM hunting alpha. Extract actionable trading signals, entry timing, and position-sizing implications.',
}

router.post('/ask', askLimit, async (req, res) => {
  const { question, arxiv_ids = [], persona = 'quant_analyst' } = req.body
  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question is required' })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'ANTHROPIC_API_KEY not configured' })

  const personaPrompt = PERSONAS[persona] || PERSONAS.quant_analyst

  const contextParts = []
  for (const rawId of arxiv_ids.slice(0, 5)) {
    const cleanId = rawId.replace(/^arxiv:/i, '').trim()
    const p = PAPER_CACHE.get(cleanId)
    if (p) {
      contextParts.push(
        `Paper: ${p.title}\n` +
        `Published: ${p.published?.slice(0, 10)}\n` +
        `Abstract: ${p.abstract?.slice(0, 400)}\n` +
        `Key contributions: ${(p.key_contributions || []).join('; ')}\n` +
        `Quant applicability: ${p.quant_applicability || ''}`
      )
    }
  }

  const contextBlock = contextParts.length
    ? contextParts.join('\n\n---\n\n')
    : 'No paper context loaded — answer from general knowledge.'

  const system = `${personaPrompt}

You have access to the following quantitative finance research:

${contextBlock}

Answer the user's question based on this research. Be specific about which papers support your claims.
If the research doesn't address the question directly, say so and give your best general analysis.`

  const t0 = Date.now()
  try {
    const { result: resp, durationMs } = await breaker.call(() =>
      new Anthropic({ apiKey }).messages.create({
        model:      QM_MODEL,
        max_tokens: 1200,
        system,
        messages:   [{ role: 'user', content: question }],
      })
    )

    logCall({
      route: 'quantmind/ask', model: QM_MODEL, llm: 'claude',
      symbols: arxiv_ids, success: true,
      tokensIn: resp.usage?.input_tokens, tokensOut: resp.usage?.output_tokens, durationMs,
    })

    return res.json({
      persona,
      answer:          resp.content[0].text,
      context_papers:  arxiv_ids,
      usage: {
        input_tokens:  resp.usage?.input_tokens,
        output_tokens: resp.usage?.output_tokens,
      },
    })

  } catch (err) {
    logCall({
      route: 'quantmind/ask', model: QM_MODEL, llm: 'claude',
      symbols: arxiv_ids, success: false,
      error: err.message, durationMs: Date.now() - t0,
    })
    if (err instanceof CircuitOpenError) {
      return res.status(503).json({ error: err.message, circuitOpen: true })
    }
    return res.status(500).json({ error: err.message })
  }
})

// ── GET /api/quantmind/search ─────────────────────────────────────────────────
// Search arXiv for financial papers. No API key required.
// ?q=momentum&category=q-fin.PM&max=15&sort=submittedDate|relevance
const QFIN_CATEGORIES = new Set([
  'q-fin', 'q-fin.PM', 'q-fin.TR', 'q-fin.RM', 'q-fin.ST',
  'q-fin.GN', 'q-fin.MF', 'q-fin.CP', 'q-fin.EC', 'q-fin.PR',
  'econ.GN', 'stat.ML', 'cs.LG',
])

router.get('/search', searchLimit, async (req, res) => {
  const q        = (req.query.q || '').slice(0, 200).trim()
  const category = QFIN_CATEGORIES.has(req.query.category) ? req.query.category : 'q-fin'
  const max      = Math.min(parseInt(req.query.max) || 15, 30)
  const sortBy   = req.query.sort === 'relevance' ? 'relevance' : 'submittedDate'

  if (!q && category === 'q-fin') {
    return res.status(400).json({ error: 'Provide q (keyword) or a specific category' })
  }

  try {
    const results = await searchArxiv({ q, category, max, sortBy })
    // Annotate which papers are already loaded in memory
    const withStatus = results.map(r => ({
      ...r,
      loaded: PAPER_CACHE.has(r.arxiv_id),
    }))
    return res.json({ results: withStatus, total: withStatus.length, query: { q, category, sortBy } })
  } catch (err) {
    console.error('[quantmind/search]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

// ── GET /api/quantmind/memory ─────────────────────────────────────────────────
router.get('/memory', (req, res) => {
  const papers = [...PAPER_CACHE.values()].map(p => ({
    arxiv_id:        p.arxiv_id,
    title:           p.title,
    published:       p.published,
    relevance_score: p.relevance_score,
    tags:            p.tags,
    extracted_at:    p.extracted_at,
  }))
  res.json({ count: papers.length, papers })
})

// ── GET /api/quantmind/memory/:id ─────────────────────────────────────────────
router.get('/memory/:id', (req, res) => {
  const cleanId = req.params.id.replace(/^arxiv:/i, '').trim()
  const paper = PAPER_CACHE.get(cleanId)
  if (!paper) return res.status(404).json({ error: `Paper ${cleanId} not in memory` })
  res.json(paper)
})

// ── DELETE /api/quantmind/memory/:id ─────────────────────────────────────────
router.delete('/memory/:id', (req, res) => {
  const cleanId = req.params.id.replace(/^arxiv:/i, '').trim()
  const existed = PAPER_CACHE.delete(cleanId)
  res.json({ deleted: existed, arxiv_id: cleanId })
})

module.exports = router
