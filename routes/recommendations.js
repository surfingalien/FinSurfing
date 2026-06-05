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
const router              = express.Router()
const rateLimit           = require('express-rate-limit')
const { getRouter }       = require('../lib/ai-router')
const { CircuitOpenError } = require('../lib/circuit-breaker')
const { getUserPrefs, saveUserPref } = require('../db/ai_memory')
const { PERSONAS }        = require('../lib/investor-personas')
const { getIndicators }   = require('./macro')

const recLimit = rateLimit({
  windowMs: 60 * 1000, max: 5,
  message: { error: 'Too many recommendation requests — wait a minute' },
})

const aiRouter = getRouter('recommendations')

// Extract user API key headers to forward to the internal quote endpoint
function fwdKeys(req) {
  const h = {}
  for (const k of ['x-aisa-key','x-finnhub-key','x-fmp-key','x-td-key','x-av-key']) {
    if (req.headers[k]) h[k] = req.headers[k]
  }
  return h
}

// Validate recommendation response schema (guards against malformed Groq output)
function validateRecommendations(data) {
  if (!Array.isArray(data?.recommendations) || !data.recommendations.length)
    throw new Error('Missing or empty recommendations array')
  for (const [i, rec] of data.recommendations.entries()) {
    for (const f of ['symbol', 'entryPrice', 'targetReturn', 'stopLoss', 'thesis']) {
      if (rec[f] == null) throw new Error(`rec[${i}] missing field: ${f}`)
    }
    if (typeof rec.entryPrice !== 'number' || rec.entryPrice <= 0)
      throw new Error(`rec[${i}] invalid entryPrice: ${rec.entryPrice}`)
    if (typeof rec.targetReturn !== 'number' || rec.targetReturn <= 0 || rec.targetReturn > 500)
      throw new Error(`rec[${i}] targetReturn out of range: ${rec.targetReturn}`)
  }
}

// Fetch upcoming earnings dates and recent news sentiment for context
async function fetchCatalystContext(symbols, fwdHeaders, port) {
  if (!symbols.length) return { earningsSnippet: '', sentimentSnippet: '' }
  const syms = symbols.slice(0, 20).join(',')
  const [earningsRes, sentimentRes] = await Promise.allSettled([
    fetch(`http://127.0.0.1:${port}/api/earnings/calendar?symbols=${encodeURIComponent(syms)}`,
      { headers: fwdHeaders, signal: AbortSignal.timeout(8000) }).then(r => r.json()),
    fetch(`http://127.0.0.1:${port}/api/sentiment/portfolio?symbols=${encodeURIComponent(syms)}`,
      { headers: fwdHeaders, signal: AbortSignal.timeout(8000) }).then(r => r.json()),
  ])

  let earningsSnippet = ''
  if (earningsRes.status === 'fulfilled') {
    const items = Array.isArray(earningsRes.value) ? earningsRes.value : (earningsRes.value?.calendar ?? [])
    const upcoming = items
      .filter(e => e?.symbol && e?.nextEarningsDate)
      .map(e => `${e.symbol}: ${e.nextEarningsDate}${e.epsEstimate != null ? ` (EPS est. $${e.epsEstimate})` : ''}`)
    if (upcoming.length) earningsSnippet = '\nUPCOMING EARNINGS (avoid entries 48h before report):\n' + upcoming.join(', ')
  }

  let sentimentSnippet = ''
  if (sentimentRes.status === 'fulfilled') {
    const items = Array.isArray(sentimentRes.value) ? sentimentRes.value : (sentimentRes.value?.results ?? [])
    const scored = items
      .filter(s => s?.symbol && s?.sentiment)
      .map(s => `${s.symbol}: ${s.sentiment}${s.score != null ? ` (${s.score}/10)` : ''}`)
    if (scored.length) sentimentSnippet = '\nNEWS SENTIMENT (last 5 days):\n' + scored.join(', ')
  }

  return { earningsSnippet, sentimentSnippet }
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

  const { holdings = [], focusSymbols = [], persona: personaId = 'default', includeMacro = true } = req.body
  const persona    = PERSONAS[personaId] ?? PERSONAS.default
  const holdingStr = holdings.length    ? holdings.join(', ') : 'none'
  const focusStr   = focusSymbols.length ? focusSymbols.join(', ') : ''
  const fwdHeaders = fwdKeys(req)
  const port       = process.env.PORT || 3001
  const userId     = req.user?.userId

  // Load prior rec history to avoid repeating recently recommended symbols
  const recHistory = userId ? await getUserPrefs(userId, 'rec_history', 5) : []
  const historySnippet = recHistory.length > 0
    ? '\nUSER\'S RECENT RECOMMENDATION HISTORY (avoid repeating these symbols/sectors):\n' +
      recHistory.map(p => p.content).join('\n')
    : ''

  // ── Step 1: Pre-fetch live prices + catalyst context + macro in parallel ─────
  const symbolsForContext = focusSymbols.length ? focusSymbols : []
  const [preLivePrices, { earningsSnippet, sentimentSnippet }, macroData] = await Promise.all([
    focusSymbols.length ? fetchLiveQuotes(focusSymbols, fwdHeaders) : Promise.resolve({}),
    fetchCatalystContext(symbolsForContext, fwdHeaders, port),
    includeMacro ? getIndicators().catch(() => null) : Promise.resolve(null),
  ])

  const macroSnippet = macroData?.macroSummary ?? ''

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

  const personaBlock = persona.id !== 'default'
    ? `\nINVESTOR PERSONA: ${persona.name} (${persona.style})\n${persona.systemPrompt}\n`
    : ''

  const prompt = `${personaBlock}You are a senior portfolio strategist channeling the investment philosophy above. Provide specific actionable buy recommendations for a retail investor.

Current portfolio holdings (avoid overlap): ${holdingStr}${focusInstructions}
${livePriceSnippet}${macroSnippet}${earningsSnippet}${sentimentSnippet}${historySnippet}

${countInstructions}
${persona.constraints ? '\n' + persona.constraints : ''}

Rules:
- Use standard tickers (BTC-USD for Bitcoin, ETH-USD for Ethereum, SOL-USD for Solana, etc.)
- Be realistic: target returns 5–40%, stop-loss 5–15%
- Diversify unless the persona specifies concentration
- Each thesis must be specific, not generic, and reflect the persona's investment style
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
      "technicalSignal": "Brief technical setup note",
      "bearCase": "Primary downside risk in ≤10 words",
      "thesisBreaker": "Specific event that invalidates this pick in ≤8 words"
    }
  ],
  "marketOutlook": "2-sentence overall market view",
  "keyRisks": "1-sentence macro risk to watch"
}`

  const allSymbols = [...new Set([...holdings, ...focusSymbols])]
  let raw     = ''
  let llmUsed = 'claude'

  try {
    const result = await aiRouter.call({ prompt, maxTokens: 8192, symbols: allSymbols })
    raw     = result.text
    llmUsed = result.llmUsed
  } catch (err) {
    if (err instanceof CircuitOpenError) return res.status(503).json({ error: err.message, circuitOpen: true })
    if (err.status === 503)             return res.status(503).json({ error: err.message })
    console.error('[recommendations]', err.message)
    return res.status(500).json({ error: 'Recommendation service error: ' + err.message })
  }

  try {
    const match = raw.match(/\{[\s\S]*\}/)
    if (!match) {
      console.error('[recommendations] Non-JSON response:', raw.slice(0, 200))
      return res.status(500).json({ error: 'Failed to parse AI recommendations' })
    }

    const data = JSON.parse(match[0])
    try { validateRecommendations(data) } catch (valErr) {
      console.error('[recommendations] Schema validation failed:', valErr.message)
      return res.status(500).json({ error: 'AI response did not match expected format — please try again' })
    }

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

    // Save what was recommended so future calls avoid repeating symbols/sectors
    if (userId) {
      const sectors = [...new Set(data.recommendations.map(r => r.sector).filter(Boolean))].slice(0, 5)
      const top = data.recommendations[0]
      saveUserPref(
        userId, 'rec_history',
        `${new Date().toISOString().split('T')[0]}: Got ${data.recommendations.length} recs. ` +
        `Top: ${top?.symbol} ${top?.type} (${top?.targetReturn}% target). Sectors: ${sectors.join(', ')}.`,
        sectors, 'recommendations'
      )
    }

    return res.json({
      ...data,
      generatedAt: new Date().toISOString(),
      llmUsed,
      persona: { id: persona.id, name: persona.name, emoji: persona.emoji, style: persona.style },
      macroRegime: macroData?.regime ?? null,
    })
  } catch (err) {
    console.error('[recommendations]', err.message)
    return res.status(500).json({ error: 'Recommendation service error: ' + err.message })
  }
})

// GET /api/recommendations/personas — list available personas for the UI
router.get('/personas', (req, res) => {
  const list = Object.values(PERSONAS).map(p => ({
    id:         p.id,
    name:       p.name,
    emoji:      p.emoji,
    tagline:    p.tagline,
    style:      p.style,
    styleColor: p.styleColor,
    assetBias:  p.assetBias,
  }))
  res.json({ personas: list })
})

module.exports = router
