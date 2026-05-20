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

const express   = require('express')
const Anthropic = require('@anthropic-ai/sdk')
const router    = express.Router()
const rateLimit = require('express-rate-limit')

const recLimit = rateLimit({
  windowMs: 60 * 1000, max: 5,
  message: { error: 'Too many recommendation requests — wait a minute' },
})

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
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) return res.status(503).json({ error: 'AI service not configured (ANTHROPIC_API_KEY missing)' })

  const { holdings = [], focusSymbols = [] } = req.body
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

  const countInstructions = focusStr
    ? `Generate ${Math.min(focusSymbols.length, 20)} recommendations covering the focus symbols above.`
    : `Generate exactly 20 recommendations split across asset classes and time horizons:
- 7 Stocks for 3-month holding
- 5 Stocks for 6-month holding
- 4 ETFs (mix of 3m and 6m)
- 3 Cryptocurrencies (mix of 3m and 6m)
- 1 additional high-conviction pick of any type`

  const prompt = `You are a senior portfolio strategist. Provide specific actionable buy recommendations for a retail investor.

Current portfolio holdings (avoid overlap): ${holdingStr}${focusInstructions}
${livePriceSnippet}

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
      "type": "Stock" | "ETF" | "Crypto",
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
      "technicalSignal": "Brief technical setup note"
    }
  ],
  "marketOutlook": "2-sentence overall market view",
  "keyRisks": "1-sentence macro risk to watch"
}`

  try {
    let raw = ''
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
        console.warn('[recommendations] Claude overloaded, falling back to Groq')
        const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.GROQ_API_KEY}` },
          body:    JSON.stringify({
            model:      'llama-3.3-70b-versatile',
            max_tokens: 8000,
            messages:   [{ role: 'user', content: prompt }],
          }),
          signal: AbortSignal.timeout(60_000),
        })
        if (!r.ok) throw new Error(`Groq API error ${r.status}`)
        const d = await r.json()
        raw = d.choices?.[0]?.message?.content || ''
      } else {
        throw claudeErr
      }
    }

    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) {
      console.error('[recommendations] Non-JSON response:', raw.slice(0, 200))
      return res.status(500).json({ error: 'Failed to parse AI recommendations' })
    }

    const data = JSON.parse(match[0])
    if (!Array.isArray(data.recommendations) || !data.recommendations.length)
      return res.status(500).json({ error: 'Empty recommendations from AI' })

    // ── Step 3: Re-anchor prices to live market data ─────────────────────────
    // Fetch live quotes for every symbol Claude recommended (includes symbols we
    // didn't know ahead of time in the general/non-focus case).
    const recSymbols = data.recommendations.map(r => r.symbol).filter(Boolean)
    const postLivePrices = await fetchLiveQuotes(recSymbols, fwdHeaders)
    const allLivePrices  = { ...preLivePrices, ...postLivePrices }

    let pricesAnchored = 0
    data.recommendations = data.recommendations.map(rec => {
      const lp = allLivePrices[rec.symbol]
      if (!lp || lp <= 0) return rec               // no live price — keep Claude's estimate
      if (Math.abs(lp - rec.entryPrice) / rec.entryPrice < 0.03) return rec  // already accurate

      pricesAnchored++
      const entry  = +lp.toFixed(lp >= 100 ? 2 : 4)
      const tp     = +(entry * (1 + rec.targetReturn / 100)).toFixed(entry >= 100 ? 2 : 4)
      const sl     = +(entry * (1 - rec.stopLoss    / 100)).toFixed(entry >= 100 ? 2 : 4)
      return { ...rec, entryPrice: entry, takeProfitPrice: tp, stopLossPrice: sl, livePriceUsed: true }
    })

    if (pricesAnchored > 0)
      console.log(`[recommendations] re-anchored prices for ${pricesAnchored}/${recSymbols.length} symbols`)

    return res.json({ ...data, generatedAt: new Date().toISOString() })
  } catch (err) {
    console.error('[recommendations]', err.message)
    return res.status(500).json({ error: 'Recommendation service error: ' + err.message })
  }
})

module.exports = router
