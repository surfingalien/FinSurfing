'use strict'
/**
 * routes/earnings-call.js
 *
 * GET /api/earnings-call?symbol=AAPL
 *
 * Fetches the most recent earnings call transcript from FMP and passes it
 * to Claude to generate a structured analyst card with sentiment, key metrics,
 * guidance, and bull/bear points.
 *
 * Requires an FMP API key — provided via x-fmp-key header or FMP_API_KEY env var.
 */

const express   = require('express')
const rateLimit = require('express-rate-limit')
const { getRouter } = require('../lib/ai-router')
const { CircuitOpenError } = require('../lib/circuit-breaker')
const { compactProse } = require('../lib/compress')
const { requireAuth } = require('../middleware/auth')

const router    = express.Router()
const aiRouter  = getRouter('earnings-call')

const earningsLimit = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: 'Too many earnings call requests — wait a minute' },
})

function fmpKey(req) {
  return (req.headers['x-fmp-key'] || '').trim() || process.env.FMP_API_KEY || null
}

// ── Sub-agent: fetch transcript from FMP ──────────────────────────────────────
async function transcriptSubAgent(symbol, key) {
  const url = `https://financialmodelingprep.com/api/v3/earning_call_transcript/${encodeURIComponent(symbol)}?limit=3&apikey=${key}`
  const r   = await fetch(url, { signal: AbortSignal.timeout(12000) })
  if (!r.ok) throw new Error(`FMP transcript API error ${r.status}`)
  const data = await r.json()
  if (!Array.isArray(data)) return []
  return data
}

// ── Sub-agent: analyze transcript with Claude ─────────────────────────────────
function buildAnalystPrompt(symbol, quarter, year, date, excerpt) {
  return `You are a senior equity research analyst at a top-tier investment bank. Analyze this earnings call transcript for ${symbol} (${quarter} ${year}, ${date}) and produce a concise structured analyst card.

TRANSCRIPT (excerpt):
${excerpt}

Respond ONLY with valid JSON — no markdown, no text outside the JSON:
{
  "symbol": "${symbol}",
  "quarter": "${quarter} ${year}",
  "date": "${date}",
  "overallSentiment": "Bullish|Neutral|Bearish",
  "sentimentScore": 0-100,
  "managementTone": "Confident|Cautious|Defensive|Mixed",
  "keyMetrics": [
    { "name": "metric name ≤4 words", "value": "reported value or trend", "beat": true|false|null }
  ],
  "guidance": "1-2 sentence forward guidance summary",
  "bullPoints": ["≤12 words each — max 4 bull points"],
  "bearPoints": ["≤12 words each — max 4 bear points"],
  "keyQuote": "Most impactful verbatim management quote ≤40 words",
  "catalysts": ["≤10 words each — max 3 upcoming catalysts explicitly mentioned"],
  "risks": ["≤10 words each — max 3 risks explicitly mentioned"],
  "analystCard": "2-3 sentence synthesis: call quality, tone vs expectations, key investment implication"
}`
}

// ── GET /api/earnings-call ────────────────────────────────────────────────────
router.get('/', requireAuth, earningsLimit, async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '')
  if (!symbol) return res.status(400).json({ error: 'symbol is required' })

  const key = fmpKey(req)
  if (!key) {
    return res.status(503).json({
      error: 'FMP API key required for earnings call transcripts. Add it in Settings → API Keys.',
    })
  }

  try {
    // Sub-agent 1: fetch transcripts
    const transcripts = await transcriptSubAgent(symbol, key)
    if (!transcripts.length) {
      return res.status(404).json({ error: `No earnings call transcripts found for ${symbol}. FMP covers US-listed companies.` })
    }

    const latest   = transcripts[0]
    const content  = latest.content || ''
    const excerpt  = compactProse(content).slice(0, 6000)  // compacted → more signal per token

    if (!excerpt.trim().length) {
      return res.status(404).json({ error: `Transcript found but content is empty for ${symbol}` })
    }

    const quarter = latest.quarter ? `Q${latest.quarter}` : 'Q?'
    const year    = latest.year    ?? ''
    const date    = latest.date    ?? ''

    // Sub-agent 2: Claude analysis
    const prompt = buildAnalystPrompt(symbol, quarter, year, date, excerpt)
    const { text, llmUsed } = await aiRouter.call({ prompt, maxTokens: 2048, symbols: [symbol] })

    const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    let analysis
    try {
      analysis = JSON.parse(cleaned)
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/)
      if (!m) return res.status(500).json({ error: 'AI analysis returned no parseable JSON — try again' })
      analysis = JSON.parse(m[0])
    }

    // Available quarters for potential future multi-quarter view
    const available = transcripts.map(t => ({
      quarter: t.quarter ? `Q${t.quarter}` : '?',
      year:    t.year,
      date:    t.date,
    }))

    return res.json({
      ...analysis,
      available,
      transcriptLength: content.length,
      llmUsed,
      fetchedAt: new Date().toISOString(),
    })
  } catch (err) {
    if (err instanceof CircuitOpenError) return res.status(503).json({ error: err.message, circuitOpen: true })
    if (err.status === 503)             return res.status(503).json({ error: err.message })
    console.error('[earnings-call]', err.message)
    return res.status(500).json({ error: 'Earnings call analysis failed: ' + err.message })
  }
})

module.exports = router
