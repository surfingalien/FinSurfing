'use strict'
/**
 * routes/sentiment.js
 *
 * GET /api/sentiment/portfolio?symbols=AAPL,MSFT,NVDA
 *
 * Fetches recent news headlines from Finnhub for each symbol,
 * then asks Claude to score sentiment: bullish | neutral | bearish (1-10).
 * Results are cached in-process for 25 minutes.
 */

const express         = require('express')
const https           = require('https')
const Anthropic       = require('@anthropic-ai/sdk')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

// 25-minute in-process sentiment cache (key = sorted symbols string)
const sentimentCache = new Map()
const CACHE_TTL = 25 * 60 * 1000

function finnhubGet(path, key) {
  const sep = path.includes('?') ? '&' : '?'
  return new Promise((resolve) => {
    https.get(
      `https://finnhub.io/api/v1${path}${sep}token=${key}`,
      { headers: { 'User-Agent': 'FinSurf/1.0' } },
      (res) => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            // Detect Finnhub API error responses (rate limit, access denied, etc.)
            if (parsed?.error) {
              console.warn('[sentiment] Finnhub error:', parsed.error)
              resolve(null)
            } else {
              resolve(parsed)
            }
          } catch { resolve(null) }
        })
      }
    ).on('error', () => resolve(null))
  })
}

// Fetch news in small batches with a short pause to avoid Finnhub rate limits
async function fetchNewsInBatches(symbols, fKey, from, to) {
  const results = []
  const BATCH  = 4
  const DELAY  = 400 // ms between batches

  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH)
    const batchResults = await Promise.all(
      batch.map(sym =>
        finnhubGet(`/company-news?symbol=${sym}&from=${from}&to=${to}`, fKey)
          .then(n => ({
            sym,
            headlines: Array.isArray(n) ? n.slice(0, 5).map(h => h.headline).filter(Boolean) : [],
          }))
      )
    )
    results.push(...batchResults)
    if (i + BATCH < symbols.length) {
      await new Promise(r => setTimeout(r, DELAY))
    }
  }
  return results
}

// GET /api/sentiment/portfolio
router.get('/portfolio', async (req, res) => {
  const fKey = req.headers['x-finnhub-key'] || process.env.FINNHUB_API_KEY || process.env.FINNHUB_KEY
  if (!fKey) return res.status(503).json({ error: 'Finnhub API key not configured. Add it in API Keys settings.' })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'AI service not configured' })

  const { symbols: symbolsStr = '', bust } = req.query
  const symbols = symbolsStr.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 15)
  if (!symbols.length) return res.status(400).json({ error: 'symbols query param required' })

  const cacheKey = [...symbols].sort().join(',')
  const cached   = sentimentCache.get(cacheKey)
  if (cached && !bust && (Date.now() - cached.ts) < CACHE_TTL) {
    return res.json({ results: cached.results, cached: true, updatedAt: cached.ts })
  }

  try {
    const today      = new Date()
    const sevenDaysAgo = new Date(today - 7 * 86400000)
    const fmt         = d => d.toISOString().slice(0, 10)

    const newsData = await fetchNewsInBatches(symbols, fKey, fmt(sevenDaysAgo), fmt(today))

    const withNewsCount = newsData.filter(d => d.headlines.length > 0).length
    const noNewsRatio   = 1 - withNewsCount / newsData.length

    // If Finnhub returned no news for any symbol, propagate a warning
    const newsWarning = noNewsRatio === 1
      ? 'No company news available — Finnhub company news may require a Premium plan or higher rate limit.'
      : null

    const newsContext = newsData.map(({ sym, headlines }) =>
      headlines.length
        ? `${sym}:\n${headlines.map(h => `  - ${h}`).join('\n')}`
        : `${sym}: no recent news`
    ).join('\n\n')

    const prompt = `You are a financial analyst. Assess the investment sentiment for each stock based on these recent news headlines.

NEWS HEADLINES (last 7 days):
${newsContext}

Respond ONLY with a valid JSON array — one object per ticker, in the same order:
[
  {
    "symbol": "TICKER",
    "sentiment": "bullish" | "neutral" | "bearish",
    "score": 1-10,
    "summary": "one concise sentence max 80 chars",
    "headline_count": N
  }
]

Scoring guide:
- 8-10 = strongly bullish (beat earnings, upgrade, strong guidance, major catalyst)
- 6-7  = mildly bullish
- 5    = neutral or no news
- 3-4  = mildly bearish
- 1-2  = strongly bearish (miss, guidance cut, regulatory issue, lawsuit)

If a symbol has no news, return score 5 and sentiment "neutral".`

    const client = new Anthropic({ apiKey })
    const msg    = await client.messages.create({
      model: 'claude-sonnet-4-6', max_tokens: 2048,
      messages: [{ role: 'user', content: prompt }],
    })

    const text  = msg.content?.[0]?.text || '[]'
    const match = text.match(/\[[\s\S]*\]/)
    if (!match) return res.status(500).json({ error: 'Failed to parse AI response' })
    const results = JSON.parse(match[0])

    const ts = Date.now()
    sentimentCache.set(cacheKey, { results, ts })
    return res.json({ results, cached: false, updatedAt: ts, warning: newsWarning })
  } catch (err) {
    console.error('[sentiment/portfolio]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router
