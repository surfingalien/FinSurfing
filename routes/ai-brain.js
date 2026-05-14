'use strict'
/**
 * routes/ai-brain.js
 *
 * POST /api/ai-brain/analyze
 * body: { symbols?, horizon?, holdings? }
 *
 * 1. Fetches live market data (price, change, volume, P/E, 52-week range)
 *    for the universe via AISA → Finnhub → FMP cascade using the user's
 *    x-aisa-key / x-finnhub-key headers.
 * 2. Passes that real snapshot to Claude claude-sonnet-4-6 which runs as
 *    5 specialized agents (Fundamental, Technical, Sentiment, Macro, Risk)
 *    + a Supervisor, producing ranked buy recommendations.
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

// Extract AISA/Finnhub/FMP headers forwarded from the browser
function fwdKeys(req) {
  const h = {}
  for (const k of ['x-aisa-key', 'x-finnhub-key', 'x-fmp-key', 'x-td-key', 'x-av-key']) {
    if (req.headers[k]) h[k] = req.headers[k]
  }
  return h
}

// Format a quote object into a compact one-liner for the prompt
function fmtQuote(q) {
  const chg  = q.regularMarketChangePercent
  const sign = chg >= 0 ? '+' : ''
  const vol  = q.regularMarketVolume
  const cap  = q.marketCap
  const pe   = q.trailingPE
  const hi   = q.fiftyTwoWeekHigh
  const lo   = q.fiftyTwoWeekLow
  const eps  = q.epsTrailingTwelveMonths
  return (
    `${q.symbol}: $${q.regularMarketPrice?.toFixed(2)} (${sign}${chg?.toFixed(2)}% today)` +
    ` | Vol=${vol ? (vol / 1e6).toFixed(1) + 'M' : 'N/A'}` +
    ` | MktCap=${cap ? '$' + (cap / 1e9).toFixed(1) + 'B' : 'N/A'}` +
    ` | P/E=${pe ? pe.toFixed(1) : 'N/A'}` +
    ` | EPS TTM=${eps ? '$' + eps.toFixed(2) : 'N/A'}` +
    ` | 52w ${lo?.toFixed(0)}–${hi?.toFixed(0)}`
  )
}

router.post('/analyze', brainLimit, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'AI service not configured (ANTHROPIC_API_KEY missing)' })

  const {
    symbols  = DEFAULT_UNIVERSE,
    horizon  = '6m',
    holdings = [],
  } = req.body

  if (!Array.isArray(symbols) || !symbols.length)
    return res.status(400).json({ error: 'symbols must be a non-empty array' })
  if (!['3m', '6m', '12m'].includes(horizon))
    return res.status(400).json({ error: 'horizon must be 3m, 6m, or 12m' })

  const universe = symbols.slice(0, 20)
  const holdingStr  = holdings.length ? holdings.join(', ') : 'none'
  const horizonLabel = { '3m': '3-month', '6m': '6-month', '12m': '12-month' }[horizon]

  // ── Step 1: fetch live market data via AISA / Finnhub ──────────────────────
  let marketSnippet = ''
  let liveQuotes    = []
  try {
    const port   = process.env.PORT || 3001
    const r      = await fetch(
      `http://localhost:${port}/api/quote?symbols=${universe.join(',')}`,
      { headers: fwdKeys(req), signal: AbortSignal.timeout(30_000) }
    )
    const qd     = await r.json()
    liveQuotes   = qd?.quoteResponse?.result ?? []
  } catch (e) {
    console.warn('[ai-brain] Quote fetch failed, falling back to knowledge-only:', e.message)
  }

  if (liveQuotes.length > 0) {
    marketSnippet =
      '\n\nLIVE MARKET SNAPSHOT — use this real data as primary input for each agent:\n' +
      liveQuotes.map(fmtQuote).join('\n')
  } else {
    marketSnippet =
      '\n\nNote: Live market data unavailable (AISA/Finnhub keys not configured). ' +
      'Base your analysis on your training knowledge of these stocks as of today.'
  }

  // ── Step 2: build multi-agent Claude prompt ────────────────────────────────
  const prompt = `You are a collaborative AI investment analysis system composed of 5 specialized agents and a supervisor. Analyze the following stock universe and produce ranked buy recommendations for a ${horizonLabel} holding period. Today is mid-May 2026.

Universe: ${universe.join(', ')}
Portfolio holdings to avoid: ${holdingStr}
${marketSnippet}

Each agent analyzes through their specialized lens:

AGENT 1 — FUNDAMENTAL ANALYST
Use the live P/E, EPS, and market cap data above. Evaluate earnings growth trajectory, revenue quality, free cash flow, competitive moat, margin expansion, and balance sheet strength. Flag if any stock looks overvalued vs peers.

AGENT 2 — TECHNICAL ANALYST
Use today's price change, volume, and 52-week range. Assess where each stock sits relative to its 52w high/low, momentum, trend strength, breakout setups, and volume confirmation. Stocks near 52w lows with high volume may be oversold; near 52w highs with strong volume may show momentum.

AGENT 3 — SENTIMENT & NEWS ANALYST
Use recent earnings catalysts, analyst upgrades/downgrades, institutional flows, and short interest. Factor in how today's price movement compares to recent patterns for sentiment signals.

AGENT 4 — MACRO ECONOMIST
Assess sector macro tailwinds/headwinds, interest rate sensitivity, AI/tech cycle positioning, geopolitical exposure, and regulatory landscape for each stock's sector.

AGENT 5 — RISK MANAGER
Evaluate downside risk using the 52w range (proximity to lows = potential support), market cap (liquidity), P/E vs sector (valuation risk), and beta. Recommend stop-loss levels relative to current price.

SUPERVISOR synthesizes all agents into final ranked picks with realistic return targets.

Respond ONLY with this JSON (no markdown, no prose outside JSON):
{
  "marketRegime": "string",
  "macroOutlook": "2-3 sentence macro outlook for this horizon",
  "agentConsensusTheme": "1 sentence — what all 5 agents agree on",
  "dataSource": "live" or "knowledge",
  "rankedStocks": [
    {
      "rank": 1,
      "symbol": "string",
      "name": "string",
      "sector": "string",
      "type": "Stock",
      "currentPrice": 0,
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
- targetReturn and stopLoss: realistic positive numbers (percent); base stop-loss on current price proximity to 52w low
- agentVerdict: "Strong Buy" | "Buy" | "Moderate Buy"
- confidence: "High" | "Medium" | "Low"
- currentPrice: fill from live snapshot if available, else 0
- dataSource: set "live" if live snapshot was provided, else "knowledge"`

  // ── Step 3: run Claude ─────────────────────────────────────────────────────
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
      processedAt:      new Date().toISOString(),
      universeAnalyzed: universe,
      liveDataSymbols:  liveQuotes.map(q => q.symbol),
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
