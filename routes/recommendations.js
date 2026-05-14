'use strict'
/**
 * routes/recommendations.js
 *
 * POST /api/recommendations
 * body: { holdings?, watchlist? }
 *
 * Returns AI-generated buy ideas for 3-month and 6-month holding periods
 * covering stocks, ETFs, and cryptocurrencies. Uses Claude claude-sonnet-4-6.
 */

const express   = require('express')
const Anthropic = require('@anthropic-ai/sdk')

const router = express.Router()

const rateLimit = require('express-rate-limit')
const recLimit  = rateLimit({
  windowMs: 60 * 1000, max: 5,
  message: { error: 'Too many recommendation requests — wait a minute' },
})

router.post('/', recLimit, async (req, res) => {
  const apiKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({
    error: 'Claude API key required. Add yours in Settings → API Keys (Anthropic), or set ANTHROPIC_API_KEY on the server.',
  })

  const { holdings = [], watchlist = [] } = req.body
  const holdingStr  = holdings.length  ? holdings.join(', ')  : 'none'
  const watchStr    = watchlist.length ? watchlist.join(', ') : 'none'

  const prompt = `You are a senior portfolio strategist. Provide specific actionable buy recommendations for a retail investor.

Current portfolio holdings: ${holdingStr}
Watchlist symbols: ${watchStr}

Generate exactly 10 recommendations split across asset classes and time horizons:
- 3 Stocks for 3-month holding
- 2 Stocks for 6-month holding
- 2 ETFs (any time horizon — mix of 3m and 6m)
- 2 Cryptocurrencies (any time horizon — mix of 3m and 6m)
- 1 additional pick of any type you think is compelling

Rules:
- Prefer symbols NOT already in the portfolio holdings
- Use standard tickers (BTC-USD for Bitcoin, ETH-USD for Ethereum, SOL-USD for Solana, etc.)
- Be realistic: target returns 5–40%, stop-loss 5–15%
- Diversify across sectors for stocks
- Each thesis must be specific, not generic

Respond ONLY with a JSON object — no markdown, no explanation, just the JSON:
{
  "recommendations": [
    {
      "symbol": "string",
      "name": "string",
      "type": "Stock" | "ETF" | "Crypto",
      "period": "3m" | "6m",
      "sector": "string (for stocks/ETFs) or 'Digital Asset' for crypto",
      "targetReturn": number,
      "stopLoss": number,
      "risk": "Low" | "Medium" | "High",
      "thesis": "2-3 sentence specific investment thesis",
      "catalyst": "Primary near-term catalyst",
      "technicalSignal": "Brief technical setup note"
    }
  ],
  "marketOutlook": "2-sentence overall market view",
  "keyRisks": "1-sentence macro risk to watch"
}`

  try {
    const client = new Anthropic({ apiKey })
    const msg = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 2500,
      messages:   [{ role: 'user', content: prompt }],
    })

    const raw = msg.content?.[0]?.text || ''
    // Extract JSON even if Claude wraps it in markdown fences
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) {
      console.error('[recommendations] Claude non-JSON response:', raw.slice(0, 200))
      return res.status(500).json({ error: 'Failed to parse AI recommendations' })
    }

    const data = JSON.parse(match[0])
    if (!Array.isArray(data.recommendations) || !data.recommendations.length)
      return res.status(500).json({ error: 'Empty recommendations from AI' })

    return res.json({ ...data, generatedAt: new Date().toISOString() })
  } catch (err) {
    console.error('[recommendations]', err.message)
    return res.status(500).json({ error: 'Recommendation service error: ' + err.message })
  }
})

module.exports = router
