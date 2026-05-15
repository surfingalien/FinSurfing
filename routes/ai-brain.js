'use strict'
/**
 * routes/ai-brain.js
 *
 * POST /api/ai-brain/analyze
 * body: { symbols?, scanMode?, horizon?, holdings? }
 *
 * scanMode selects from SCAN_UNIVERSES; custom symbols override it entirely.
 * All per-stock analysis fields are hard-capped at 15 words to keep output
 * well inside the 8 192-token limit and prevent JSON truncation.
 */

const express   = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const rateLimit = require('express-rate-limit')

const router = express.Router()

const brainLimit = rateLimit({
  windowMs: 5 * 60 * 1000, max: 4,
  message: { error: 'Too many AI Brain requests — wait a few minutes' },
})

// ── Curated universe per scan mode (20 symbols each) ──────────────────────────
const SCAN_UNIVERSES = {
  broad: [
    'NVDA','MSFT','AAPL','AMZN','GOOGL','META','TSLA','JPM','LLY','CRWD',
    'PLTR','AVGO','SPY','QQQ','GLD','ARKK','BTC-USD','ETH-USD','SOL-USD','BNB-USD',
  ],
  tech: [
    'NVDA','MSFT','AAPL','GOOGL','META','AMZN','AMD','AVGO','CRM','ADBE',
    'SNOW','PLTR','CRWD','ANET','TSLA','SMCI','ARM','INTC','QCOM','MU',
  ],
  finance: [
    'JPM','BAC','WFC','GS','MS','V','MA','BRK-B','SCHW','AXP',
    'C','BLK','KKR','APO','SPGI','ICE','CME','PGR','CB','MET',
  ],
  healthcare: [
    'LLY','UNH','JNJ','ABBV','MRK','PFE','AMGN','ISRG','VRTX','REGN',
    'BMY','MRNA','CVS','CI','HUM','MDT','ABT','TMO','DHR','BSX',
  ],
  energy: [
    'XOM','CVX','COP','SLB','CAT','DE','HON','RTX','GE','BA',
    'UPS','LMT','NEE','DUK','AMT','WM','PLD','WELL','O','PSA',
  ],
  etfs: [
    'SPY','QQQ','GLD','TLT','IWM','VTI','ARKK','XLK','XLE','XLF',
    'XLV','XLI','XLY','AGG','HYG','EEM','EFA','VNQ','XLP','IBIT',
  ],
  crypto: [
    'BTC-USD','ETH-USD','SOL-USD','BNB-USD','ADA-USD','DOGE-USD','XRP-USD',
    'AVAX-USD','DOT-USD','LINK-USD','MATIC-USD','UNI-USD',
  ],
}

// Extract AISA/Finnhub/FMP headers forwarded from the browser
function fwdKeys(req) {
  const h = {}
  for (const k of ['x-aisa-key','x-finnhub-key','x-fmp-key','x-td-key','x-av-key']) {
    if (req.headers[k]) h[k] = req.headers[k]
  }
  return h
}

// Format a quote into a compact one-liner (kept short to save prompt tokens)
function fmtQuote(q) {
  const chg  = q.regularMarketChangePercent
  const sign = chg >= 0 ? '+' : ''
  const pe   = q.trailingPE
  const hi   = q.fiftyTwoWeekHigh
  const lo   = q.fiftyTwoWeekLow
  const cap  = q.marketCap
  return (
    `${q.symbol}: $${q.regularMarketPrice?.toFixed(2)} (${sign}${chg?.toFixed(2)}%)` +
    ` MktCap=${cap ? '$' + (cap / 1e9).toFixed(0) + 'B' : 'N/A'}` +
    ` P/E=${pe ? pe.toFixed(1) : 'N/A'}` +
    ` 52w ${lo?.toFixed(0)}-${hi?.toFixed(0)}`
  )
}

router.post('/analyze', brainLimit, async (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'AI service not configured (ANTHROPIC_API_KEY missing)' })

  const {
    symbols,
    scanMode = 'broad',
    horizon  = '6m',
    holdings = [],
  } = req.body

  if (!['3m','6m','12m'].includes(horizon))
    return res.status(400).json({ error: 'horizon must be 3m, 6m, or 12m' })

  // Custom symbols override scan mode; otherwise use the named universe
  const baseList = (symbols?.length && Array.isArray(symbols))
    ? symbols.map(s => String(s).toUpperCase().replace(/[^A-Z0-9.-]/g, '')).filter(Boolean)
    : (SCAN_UNIVERSES[scanMode] || SCAN_UNIVERSES.broad)

  const universe    = [...new Set(baseList)].slice(0, 20)
  const holdingStr  = holdings.length ? holdings.join(', ') : 'none'
  const horizonLabel = { '3m': '3-month', '6m': '6-month', '12m': '12-month' }[horizon]

  // ── Step 1: fetch live quotes ──────────────────────────────────────────────
  let marketSnippet = ''
  let liveQuotes    = []
  try {
    const port = process.env.PORT || 3001
    const r    = await fetch(
      `http://127.0.0.1:${port}/api/quote?symbols=${universe.join(',')}`,
      { headers: fwdKeys(req), signal: AbortSignal.timeout(30_000) }
    )
    const qd = await r.json()
    liveQuotes = qd?.quoteResponse?.result ?? []
  } catch (e) {
    console.warn('[ai-brain] Quote fetch failed, knowledge-only mode:', e.message)
  }

  marketSnippet = liveQuotes.length > 0
    ? '\n\nLIVE SNAPSHOT (use as primary data):\n' + liveQuotes.map(fmtQuote).join('\n')
    : '\n\nNote: No live data available — use training knowledge.'

  // ── Step 2: build prompt with STRICT length limits to avoid truncation ─────
  const prompt = `You are a 5-agent investment AI (Fundamental, Technical, Sentiment, Macro, Risk + Supervisor).
Analyze this universe for a ${horizonLabel} horizon. Today is mid-May 2026.

Universe: ${universe.join(', ')}
Avoid holdings: ${holdingStr}
${marketSnippet}

⚠️ STRICT TOKEN BUDGET — every text field must stay within the word limit shown or the response will be truncated and fail.

Respond ONLY with valid JSON (no markdown, no text outside the JSON object):
{
  "marketRegime": "≤6 words",
  "macroOutlook": "≤25 words",
  "agentConsensusTheme": "≤20 words",
  "dataSource": "live|knowledge",
  "rankedStocks": [
    {
      "rank": 1,
      "symbol": "TICKER",
      "name": "Full company name",
      "sector": "Sector",
      "type": "Stock|ETF|Crypto",
      "currentPrice": 0.0,
      "compositeScore": 0,
      "confidence": "High|Medium|Low",
      "agentVerdict": "Strong Buy|Buy|Moderate Buy",
      "targetReturn": 0,
      "stopLoss": 0,
      "entryPrice": 0.0,
      "takeProfitPrice": 0.0,
      "stopLossPrice": 0.0,
      "fundamentalScore": 0,
      "technicalScore": 0,
      "sentimentScore": 0,
      "macroScore": 0,
      "riskScore": 0,
      "fundamentalAnalysis": "≤15 words on valuation/earnings",
      "technicalAnalysis": "≤15 words on price/momentum",
      "sentimentAnalysis": "≤15 words on news/flow",
      "macroAnalysis": "≤15 words on sector/macro",
      "riskNote": "≤15 words on downside/risk",
      "supervisorSynthesis": "≤25 words summary",
      "keyDrivers": ["≤5 words","≤5 words","≤5 words"],
      "dissentingView": "≤12 words or null"
    }
  ],
  "agentNotes": {
    "fundamentalAnalyst": "≤20 words market-wide fundamental view",
    "technicalAnalyst": "≤20 words market-wide technical view",
    "sentimentAnalyst": "≤20 words market-wide sentiment view",
    "macroEconomist": "≤20 words macro outlook",
    "riskManager": "≤20 words key risks"
  }
}

Rules:
- Include exactly 5 top picks; prefer symbols NOT already in holdings
- compositeScore = weighted avg (fundamental 25%, technical 20%, sentiment 15%, macro 20%, risk 20%)
- All scores 0-100; riskScore: higher = safer
- entryPrice: limit order price at or slightly below current price
- takeProfitPrice: entryPrice × (1 + targetReturn/100)
- stopLossPrice: entryPrice × (1 - stopLoss/100)
- currentPrice: from live snapshot if available, else estimate
- dataSource: "live" if snapshot provided, else "knowledge"
- STRICTLY respect the ≤N word limits — exceeding them causes JSON truncation`

  // ── Groq fallback helper ───────────────────────────────────────────────────
  async function callGroq(text) {
    const groqKey = process.env.GROQ_API_KEY
    if (!groqKey) throw new Error('GROQ_API_KEY not configured')
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${groqKey}` },
      body:    JSON.stringify({
        model:      'llama-3.3-70b-versatile',
        max_tokens: 8192,
        messages:   [{ role: 'user', content: text }],
      }),
      signal: AbortSignal.timeout(60_000),
    })
    if (!r.ok) {
      const e = await r.text()
      throw new Error(`Groq API error ${r.status}: ${e.slice(0, 200)}`)
    }
    const d = await r.json()
    return d.choices?.[0]?.message?.content || ''
  }

  // ── Step 3: run Claude (Groq fallback on overloaded) ──────────────────────
  try {
    let raw     = ''
    let llmUsed = 'claude'
    try {
      const client = new Anthropic({ apiKey })
      const msg = await client.messages.create({
        model:      'claude-sonnet-4-6',
        max_tokens: 8192,
        messages:   [{ role: 'user', content: prompt }],
      })
      raw = msg.content?.[0]?.text || ''
    } catch (claudeErr) {
      const isOverloaded = claudeErr.status === 529 || claudeErr.message?.includes('overloaded')
      if (isOverloaded && process.env.GROQ_API_KEY) {
        console.warn('[ai-brain] Claude overloaded, falling back to Groq')
        raw = await callGroq(prompt)
        llmUsed = 'groq'
      } else {
        throw claudeErr
      }
    }

    // Robust JSON extraction: try direct parse first, then regex match
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      const m = raw.match(/\{[\s\S]*\}/)
      if (!m) {
        console.error('[ai-brain] No JSON found in response. First 300 chars:', raw.slice(0, 300))
        return res.status(500).json({ error: 'AI Brain returned no parseable JSON — try again' })
      }
      try {
        data = JSON.parse(m[0])
      } catch (parseErr) {
        console.error('[ai-brain] JSON parse failed (likely truncated). raw length:', raw.length)
        return res.status(500).json({ error: 'AI Brain response was truncated — reduce symbols or try again' })
      }
    }

    if (!Array.isArray(data.rankedStocks) || !data.rankedStocks.length)
      return res.status(500).json({ error: 'AI Brain returned no ranked stocks — try again' })

    return res.json({
      ...data,
      horizon,
      scanMode,
      processedAt:      new Date().toISOString(),
      universeAnalyzed: universe,
      liveDataSymbols:  liveQuotes.map(q => q.symbol),
      llmUsed,
      agentsUsed: ['Fundamental Analyst','Technical Analyst','Sentiment Agent','Macro Economist','Risk Manager','Supervisor'],
    })
  } catch (err) {
    console.error('[ai-brain]', err.message)
    return res.status(500).json({ error: 'AI Brain analysis failed: ' + err.message })
  }
})

module.exports = router
