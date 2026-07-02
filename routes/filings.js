'use strict'
/**
 * routes/filings.js
 *
 * GET /api/filings/:symbol?form=10-K|10-Q|8-K
 *
 * Fetches the latest 10-K/10-Q/8-K from SEC EDGAR (keyless) and runs the
 * narrative sections (MD&A, Risk Factors) through the AI router to produce a
 * structured research card. Complements:
 *   - fundamentals.js   (the numbers)
 *   - earnings-call.js  (the transcript)
 * by covering the filing narrative itself, which neither of those reads.
 *
 * No API key required for the EDGAR fetch; ANTHROPIC_API_KEY (or Groq fallback)
 * is needed for the summarisation, same as every other AI route.
 */

const express   = require('express')
const rateLimit = require('express-rate-limit')
const { getLatestFiling, NARRATIVE_FORMS } = require('../lib/filings')
const { getRouter } = require('../lib/ai-router')
const { tryParseAiJson } = require('../lib/ai-json')
const { CircuitOpenError } = require('../lib/circuit-breaker')
const { requireAuth } = require('../middleware/auth')

const router   = express.Router()
const aiRouter = getRouter('filings')

const CACHE_TTL = 6 * 60 * 60_000      // filings change infrequently
const _cache    = new Map()

const filingsLimit = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: 'Too many filings requests — wait a minute' },
})

function buildPrompt(f) {
  return `You are a senior equity research analyst. The following is an excerpt of the narrative sections (MD&A and/or Risk Factors) of ${f.company || f.symbol}'s most recent SEC ${f.form} filing (filed ${f.filingDate}).

FILING EXCERPT:
${f.excerpt}

Respond ONLY with valid JSON — no markdown, no text outside the JSON:
{
  "symbol": "${f.symbol}",
  "form": "${f.form}",
  "summary": "3-4 sentence plain-English summary of what this filing says about the business",
  "keyChanges": ["≤15 words each — max 4 notable changes vs prior periods explicitly stated"],
  "riskFactors": ["≤15 words each — max 5 most material risks disclosed"],
  "managementTone": "one of: optimistic | cautious | neutral | defensive",
  "redFlags": ["≤15 words each — max 3 concerning disclosures, or empty array if none"],
  "analystTakeaway": "2-3 sentence investment implication grounded only in the filing text"
}`
}

// ── GET /api/filings/:symbol ──────────────────────────────────────────────────
router.get('/:symbol', requireAuth, filingsLimit, async (req, res) => {
  const symbol = (req.params.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '')
  if (!symbol) return res.status(400).json({ error: 'symbol is required' })

  const formParam = (req.query.form || '').trim().toUpperCase()
  const forms = NARRATIVE_FORMS.includes(formParam) ? [formParam] : NARRATIVE_FORMS

  const cacheKey = `${symbol}:${forms.join(',')}`
  const hit = _cache.get(cacheKey)
  if (hit && Date.now() - hit.at < CACHE_TTL) {
    return res.json({ ...hit.data, cached: true })
  }

  try {
    const filing = await getLatestFiling(symbol, { forms })
    if (!filing.excerpt || filing.excerpt.length < 200) {
      return res.status(404).json({ error: `Filing found for ${symbol} but no readable narrative text could be extracted` })
    }

    const { text, llmUsed } = await aiRouter.call({
      prompt: buildPrompt(filing),
      maxTokens: 2048,
      symbols: [symbol],
    })

    const analysis = tryParseAiJson(text)
    if (!analysis) {
      return res.status(500).json({ error: 'AI analysis returned no parseable JSON — try again' })
    }

    const data = {
      ...analysis,
      company: filing.company,
      form: filing.form,
      filingDate: filing.filingDate,
      reportDate: filing.reportDate,
      source: filing.url,
      llmUsed,
      fetchedAt: new Date().toISOString(),
    }
    _cache.set(cacheKey, { at: Date.now(), data })
    return res.json(data)

  } catch (err) {
    if (err instanceof CircuitOpenError) return res.status(503).json({ error: err.message, circuitOpen: true })
    if (err.status === 404)              return res.status(404).json({ error: err.message })
    if (err.status === 503)              return res.status(503).json({ error: err.message })
    console.error('[filings]', err.message)
    return res.status(500).json({ error: 'Filing analysis failed: ' + err.message })
  }
})

module.exports = router
