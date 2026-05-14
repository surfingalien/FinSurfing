'use strict'
/**
 * routes/ai-brain.js
 *
 * POST /api/ai-brain/analyze
 * body: { symbols?, horizon?, holdings? }
 *
 * Runs a 5-agent Claude analysis (Fundamental, Technical, Sentiment, Macro, Risk)
 * and returns ranked buy recommendations with per-agent scores and supervisor synthesis.
 */

const express   = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const rateLimit = require('express-rate-limit')

const router = express.Router()

const brainLimit = rateLimit({
  windowMs: 5 * 60 * 1000, max: 4,
  message: { error: 'Too many AI Brain requests — wait a few minutes' },
})

const DEFAULT_UNIVERSE = [
  'NVDA', 'MSFT', 'AAPL', 'AMZN', 'GOOGL', 'META', 'AVGO',
  'TSLA', 'JPM', 'V', 'LLY', 'UNH', 'COST', 'NFLX',
  'MELI', 'CRWD', 'ANET', 'AMD', 'PLTR', 'ORCL',
]

// Lightweight key test — used by the settings modal
router.get('/ping', async (req, res) => {
  const apiKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.json({ ok: false, error: 'No key provided' })
  try {
    const client = new Anthropic({ apiKey })
    await client.messages.create({
      model: 'claude-haiku-4-5-20251001', max_tokens: 5,
      messages: [{ role: 'user', content: 'Hi' }],
    })
    return res.json({ ok: true })
  } catch (err) {
    return res.json({ ok: false, error: err.message })
  }
})

router.post('/analyze', brainLimit, async (req, res) => {
  const apiKey = req.headers['x-anthropic-key'] || process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({
    error: 'Claude API key required. Add yours in Settings → API Keys (Anthropic), or set ANTHROPIC_API_KEY on the server.',
  })

  const {
    symbols   = DEFAULT_UNIVERSE,
    horizon   = '6m',
    holdings  = [],
  } = req.body

  if (!Array.isArray(symbols) || !symbols.length)
    return res.status(400).json({ error: 'symbols must be a non-empty array' })
  if (!['3m', '6m', '12m'].includes(horizon))
    return res.status(400).json({ error: 'horizon must be 3m, 6m, or 12m' })

  const symbolList  = symbols.slice(0, 25).join(', ')
  const holdingStr  = holdings.length ? holdings.join(', ') : 'none'
  const horizonMap  = { '3m': '3-month', '6m': '6-month', '12m': '12-month' }
  const horizonLabel = horizonMap[horizon]

  const prompt = `You are a collaborative AI investment analysis system composed of 5 specialized agents and a supervisor. Analyze the following stock universe and produce ranked buy recommendations for a ${horizonLabel} holding period. Today is mid-May 2026.

Universe: ${symbolList}
Portfolio holdings to avoid: ${holdingStr}

Each agent analyzes from their specialized lens:

AGENT 1 — FUNDAMENTAL ANALYST
Evaluate: earnings growth trajectory, revenue quality, PEG ratio, free cash flow, balance sheet, competitive moat, margin expansion.

AGENT 2 — TECHNICAL ANALYST
Evaluate: price momentum, trend strength, RS vs market, moving average structure, breakout setups, volume confirmation.

AGENT 3 — SENTIMENT & NEWS ANALYST
Evaluate: recent catalysts, earnings beats/misses, analyst revisions, institutional flows, retail/social sentiment, management credibility.

AGENT 4 — MACRO ECONOMIST
Evaluate: sector macro tailwinds/headwinds, interest rate sensitivity, AI/tech cycle positioning, geopolitical exposure, regulatory landscape.

AGENT 5 — RISK MANAGER
Evaluate: downside scenarios, valuation risk, correlation to market, liquidity, beta, black swan exposures.

SUPERVISOR synthesizes all agents into final ranked picks.

Respond ONLY with this JSON (no markdown, no prose outside JSON):
{
  "marketRegime": "string",
  "macroOutlook": "2-3 sentence macro outlook for this horizon",
  "agentConsensusTheme": "1 sentence — what all 5 agents agree on",
  "rankedStocks": [
    {
      "rank": 1,
      "symbol": "string",
      "name": "string",
      "sector": "string",
      "type": "Stock",
      "compositeScore": 0,
      "confidence": "High",
      "agentVerdict": "Strong Buy",
      "targetReturn": 0,
      "stopLoss": 0,
      "fundamentalScore": 0,
      "technicalScore": 0,
      "sentimentScore": 0,
      "macroScore": 0,
      "riskScore": 0,
      "fundamentalAnalysis": "string",
      "technicalAnalysis": "string",
      "sentimentAnalysis": "string",
      "macroAnalysis": "string",
      "riskNote": "string",
      "supervisorSynthesis": "string",
      "keyDrivers": ["string", "string", "string"],
      "dissentingView": "string or null"
    }
  ],
  "agentNotes": {
    "fundamentalAnalyst": "string",
    "technicalAnalyst": "string",
    "sentimentAnalyst": "string",
    "macroEconomist": "string",
    "riskManager": "string"
  }
}

Rules:
- Include 8 to 10 top picks; prefer symbols NOT already in holdings
- compositeScore: weighted average (fundamental 25%, technical 20%, sentiment 15%, macro 20%, risk 20%)
- All scores 0-100; riskScore: higher = safer (inverse of risk)
- targetReturn and stopLoss: realistic positive numbers (percent)
- agentVerdict: "Strong Buy" | "Buy" | "Moderate Buy"
- confidence: "High" | "Medium" | "Low"
- Be specific and data-aware`

  try {
    const client = new Anthropic({ apiKey })
    const msg = await client.messages.create({
      model:      'claude-sonnet-4-6',
      max_tokens: 5000,
      messages:   [{ role: 'user', content: prompt }],
    })

    const raw   = msg.content?.[0]?.text || ''
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) {
      console.error('[ai-brain] Non-JSON response:', raw.slice(0, 200))
      return res.status(500).json({ error: 'Failed to parse AI Brain analysis' })
    }

    const data = JSON.parse(match[0])
    if (!Array.isArray(data.rankedStocks) || !data.rankedStocks.length)
      return res.status(500).json({ error: 'Empty analysis from AI Brain' })

    return res.json({
      ...data,
      horizon,
      processedAt:       new Date().toISOString(),
      universeAnalyzed:  symbols.slice(0, 25),
      agentsUsed: [
        'Fundamental Analyst', 'Technical Analyst',
        'Sentiment Agent', 'Macro Economist',
        'Risk Manager', 'Supervisor',
      ],
    })
  } catch (err) {
    console.error('[ai-brain]', err.message)
    return res.status(500).json({ error: 'AI Brain analysis failed: ' + err.message })
  }
})

module.exports = router
