'use strict'
/**
 * routes/recommendations.js
 *
 * POST /api/recommendations
 * body: { holdings?, focusSymbols? }
 *
 * Returns AI-generated buy ideas with live-price-anchored entry/stop/target.
 * Flow:
 *   1. If focusSymbols provided → fetch live quotes before the Claude call so
 *      Claude sees real prices in the prompt.
 *   2. Call Claude for picks + thesis/catalyst (prices estimated by Claude).
 *   3. After getting Claude's picks → batch-fetch live quotes for every
 *      recommended symbol and re-anchor entryPrice/takeProfitPrice/stopLossPrice
 *      to actual market prices (percentages stay as Claude intended).
 */

const express             = require('express')
const Anthropic           = require('@anthropic-ai/sdk')
const router              = express.Router()
const rateLimit           = require('express-rate-limit')
const { getBreaker, CircuitOpenError } = require('../lib/circuit-breaker')
const { logCall }         = require('../lib/ai-audit')

const recLimit = rateLimit({
  windowMs: 60 * 1000, max: 5,
  message: { error: 'Too many recommendation requests — wait a minute' },
})

const breaker = getBreaker('recommendations', { threshold: 3, resetTimeoutMs: 60_000 })

// Extract user API key headers to forward to the internal quote endpoint
function fwdKeys(req) {
  const h = {}
  for (const k of ['x-aisa-key','x-finnhub-key','x-fmp-key','x-td-key','x-av-key']) {
    if (req.headers[k]) h[k] = req.headers[k]
  }
  return h
}

// Fetch live quotes from the internal /api/quote endpoint
async function fetchLiveQuotes(symbols, fwdHeaders) {
  if (!symbols.length) return {}
  const port = process.env.PORT || 3001
  try {
    const r = await fetch(
      `http://127.0.0.1:${port}/api/quote?symbols=${symbols.map(encodeURIComponent).join(',')}`,
      { headers: fwdHeaders, signal: AbortSignal.timeout(15000) }
    )
    const d = await r.json()
    const map = {}
    for (const q of (d?.quoteResponse?.result ?? [])) {
      if (q?.symbol && q.regularMarketPrice != null) map[q.symbol] = q.regularMarketPrice
    }
    return map
  } catch (e) {
    console.warn('[recommendations] live quote fetch failed:', e.message)
    return {}
  }
}

router.post('/', recLimit, async (req, res) => {
  if (process.env.AI_RECOMMENDATIONS_DISABLED === 'true')
    return res.status(503).json({ error: 'AI Buy Signals are temporarily disabled (kill switch active)', killSwitch: true })

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'AI service not configured (ANTHROPIC_API_KEY missing)' })

  const { holdings = [], focusSymbols = [], includeFunds = false } = req.body
  const holdingStr = holdings.length    ? holdings.join(', ') : 'none'
  const focusStr   = focusSymbols.length ? focusSymbols.join(', ') : ''
  const fwdHeaders = fwdKeys(req)

  // ── Step 1: Pre-fetch live prices for focus symbols ──────────────────────────
  let preLivePrices = {}
  if (focusSymbols.length) {
    preLivePrices = await fetchLiveQuotes(focusSymbols, fwdHeaders)
  }

  const livePriceSnippet = Object.keys(preLivePrices).length
    ? '\nLIVE PRICES (use these exact values for entryPrice — do not guess):\n' +
      Object.entries(preLivePrices).map(([s, p]) => `  ${s}: $${p}`).join('\n')
    : ''

  const focusInstructions = focusStr
    ? `\nFOCUS MODE: Analyze ONLY these specific symbols: ${focusStr}. All recommendations must come from this list.`
    : ''

  const fundInstructions = includeFunds && !focusStr
    ? `\nMUTUAL FUNDS: Include 2 mutual fund recommendations (type "Fund") from top retail funds such as FXAIX, VFIAX, VTSAX, FSKAX, FSELX, FCNTX, FDGRX, PRGFX, AGTHX, PRWCX. For funds: targetReturn 3–15%, stopLoss 8–20%, sector = fund category (e.g. "Large-Cap Growth", "Index Fund", "Sector Fund").`
    : ''

  const countInstructions = focusStr
    ? `Generate ${Math.min(focusSymbols.length, 20)} recommendations covering the focus symbols above.`
    : `Generate exactly ${includeFunds ? 22 : 20} recommendations split across asset classes and time horizons:
- 7 Stocks for 3-month holding
- 5 Stocks for 6-month holding
- 4 ETFs (mix of 3m and 6m)
- 3 Cryptocurrencies (mix of 3m and 6m)
- 1 additional high-conviction pick of any type${includeFunds ? '\n- 2 Mutual Funds (type "Fund", use fund ticker symbols)' : ''}`

  const prompt = `You are a senior portfolio strategist. Provide specific actionable buy recommendations for a retail investor.

Current portfolio holdings (avoid overlap): ${holdingStr}${focusInstructions}
${livePriceSnippet}${fundInstructions}

${countInstructions}

Rules:
- Use standard tickers (BTC-USD for Bitcoin, ETH-USD for Ethereum, SOL-USD for Solana, etc.)
- Be realistic: target returns 5–40%, stop-loss 5–15%
- Diversify across sectors for stocks; include both ETFs and crypto unless focus symbols override
- Each thesis must be specific, not generic
- entryPrice: use the LIVE PRICE above if provided, otherwise your best estimate of current market price
- takeProfitPrice: entryPrice × (1 + targetReturn/100)
- stopLossPrice: entryPrice × (1 - stopLoss/100)

Respond ONLY with a JSON object — no markdown, no explanation, just the JSON:
{
  "recommendations": [
    {
      "symbol": "string",
      "name": "string",
      "type": "Stock" | "ETF" | "Crypto" | "Fund",
      "period": "3m" | "6m",
      "sector": "string (for stocks/ETFs) or 'Digital Asset' for crypto",
      "targetReturn": number,
      "stopLoss": number,
      "entryPrice": number,
      "takeProfitPrice": number,
      "stopLossPrice": number,
      "risk": "Low" | "Medium" | "High",
      "thesis": "2-3 sentence specific investment thesis",
      "catalyst": "Primary near-term catalyst",
      "technicalSignal": "Brief technical setup note",
      "bearCase": "Primary downside risk in ≤10 words",
      "thesisBreaker": "Specific event that invalidates this pick in ≤8 words"
    }
  ],
  "marketOutlook": "2-sentence overall market view",
  "keyRisks": "1-sentence macro risk to watch"
}`

  const REC_MODEL = 'claude-sonnet-4-6'
  let raw     = ''
  let llmUsed = 'claude'
  let tokensIn = null, tokensOut = null
  const allSymbols = [...new Set([...holdings, ...focusSymbols])]

  try {
    const { result: msg, durationMs } = await breaker.call(async () => {
      const client = new Anthropic({ apiKey })
      return client.messages.create({
        model:      REC_MODEL,
        max_tokens: 8192,
        messages:   [{ role: 'user', content: prompt }],
      })
    })
    raw       = msg.content?.[0]?.text || ''
    tokensIn  = msg.usage?.input_tokens
    tokensOut = msg.usage?.output_tokens
    logCall({ route: 'recommendations', model: REC_MODEL, llm: 'claude', symbols: allSymbols, success: true, tokensIn, tokensOut, durationMs })
  } catch (claudeErr) {
    if (claudeErr instanceof CircuitOpenError) {
      logCall({ route: 'recommendations', model: REC_MODEL, llm: 'claude', symbols: allSymbols, success: false, error: claudeErr.message, durationMs: 0 })
      return res.status(503).json({ error: claudeErr.message, circuitOpen: true })
    }

    const isOverloaded = claudeErr.status === 529 || claudeErr.message?.includes('overloaded')
    if (isOverloaded && process.env.GROQ_API_KEY) {
      console.warn('[recommendations] Claude overloaded, falling back to Groq')
      const groqModel = 'llama-3.3-70b-versatile'
      const t0 = Date.now()
      try {
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
          body:    JSON.stringify({ model: groqModel, max_tokens: 8000, messages: [{ role: 'user', content: prompt }] }),
          signal:  AbortSignal.timeout(60_000),
        })
        if (!r.ok) throw new Error(`Groq API error ${r.status}`)
        const d = await r.json()
        raw     = d.choices?.[0]?.message?.content || ''
        llmUsed = 'groq'
        logCall({ route: 'recommendations', model: groqModel, llm: 'groq', symbols: allSymbols, success: true, durationMs: Date.now() - t0 })
      } catch (groqErr) {
        logCall({ route: 'recommendations', model: groqModel, llm: 'groq', symbols: allSymbols, success: false, error: groqErr.message, durationMs: Date.now() - t0 })
        console.error('[recommendations]', groqErr.message)
        return res.status(500).json({ error: 'Recommendation service error: ' + groqErr.message })
      }
    } else {
      logCall({ route: 'recommendations', model: REC_MODEL, llm: 'claude', symbols: allSymbols, success: false, error: claudeErr.message, durationMs: claudeErr._durationMs || 0 })
      console.error('[recommendations]', claudeErr.message)
      return res.status(500).json({ error: 'Recommendation service error: ' + claudeErr.message })
    }
  }

  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) {
      console.error('[recommendations] Non-JSON response:', raw.slice(0, 200))
      return res.status(500).json({ error: 'Failed to parse AI recommendations' })
    }

    const data = JSON.parse(match[0])
    if (!Array.isArray(data.recommendations) || !data.recommendations.length)
      return res.status(500).json({ error: 'Empty recommendations from AI' })

    // ── Re-anchor prices to live market data ─────────────────────────────────
    const recSymbols     = data.recommendations.map(r => r.symbol).filter(Boolean)
    const postLivePrices = await fetchLiveQuotes(recSymbols, fwdHeaders)
    const allLivePrices  = { ...preLivePrices, ...postLivePrices }

    let pricesAnchored = 0
    data.recommendations = data.recommendations.map(rec => {
      const lp = allLivePrices[rec.symbol]
      if (!lp || lp <= 0) return rec
      if (Math.abs(lp - rec.entryPrice) / rec.entryPrice < 0.03) return rec

      pricesAnchored++
      const entry = +lp.toFixed(lp >= 100 ? 2 : 4)
      const tp    = +(entry * (1 + rec.targetReturn / 100)).toFixed(entry >= 100 ? 2 : 4)
      const sl    = +(entry * (1 - rec.stopLoss    / 100)).toFixed(entry >= 100 ? 2 : 4)
      return { ...rec, entryPrice: entry, takeProfitPrice: tp, stopLossPrice: sl, livePriceUsed: true }
    })

    if (pricesAnchored > 0)
      console.log(`[recommendations] re-anchored prices for ${pricesAnchored}/${recSymbols.length} symbols`)

    return res.json({ ...data, generatedAt: new Date().toISOString(), llmUsed })
  } catch (err) {
    console.error('[recommendations]', err.message)
    return res.status(500).json({ error: 'Recommendation service error: ' + err.message })
  }
})

module.exports = router
