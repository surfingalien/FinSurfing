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
const { requireAuth, effectiveUserId } = require('../middleware/auth')
const { mountJobRoutes, skipLoopback } = require('../lib/ai-job-routes')
const { getUserPrefs, saveUserPref } = require('../db/ai_memory')
const { PERSONAS }        = require('../lib/investor-personas')
const learningStore       = require('../lib/learning-store')
const { getIndicators }   = require('./macro')
const { getSocialSentiment } = require('../lib/social-sentiment')
const { getAltDataSnippet }  = require('../lib/alt-data')
const { getOptionsFlowCompact } = require('../lib/options-flow-cache')
const kelly = require('../lib/kelly')
const expectedValue = require('../lib/expected-value')
const { computeStats, readPredictions } = require('../lib/brain-learnings')
const { extractArrayObjects } = require('../lib/ai-json')
const { startJsonHeartbeat } = require('../lib/http-heartbeat')
const recJournal = require('../lib/rec-journal')

// skipLoopback: the background worker calls POST / over loopback, so every
// user's queued run arrives from the same address. Without the skip they'd
// share one 5/min budget and a queued run could be rejected for someone else's
// traffic; the real per-user limit is the queue's own cap.
const recLimit = rateLimit({
  windowMs: 60 * 1000, max: 5,
  skip: skipLoopback,
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

// Compact one-line filing summary for a symbol, pulled from the internal
// /api/filings route (SEC EDGAR 10-K/10-Q/8-K narrative, AI-summarised, 6h
// cached). Returns null on any failure — filings are supplementary context.
async function getFilingCompact(symbol, port, fwdHeaders) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/api/filings/${encodeURIComponent(symbol)}`,
      { headers: fwdHeaders, signal: AbortSignal.timeout(30_000) })
    if (!r.ok) return null
    const d = await r.json()
    if (!d?.form) return null
    const parts = [`${symbol} [${d.form} ${d.filingDate || ''}]`]
    if (d.managementTone) parts.push(`tone: ${d.managementTone}`)
    if (Array.isArray(d.riskFactors) && d.riskFactors.length) parts.push(`risks: ${d.riskFactors.slice(0, 2).join('; ')}`)
    if (Array.isArray(d.redFlags) && d.redFlags.length) parts.push(`🚩 ${d.redFlags.slice(0, 2).join('; ')}`)
    return parts.join(' — ')
  } catch {
    return null
  }
}

// Fetch live quotes from the internal /api/quote endpoint
async function fetchLiveQuotes(symbols, fwdHeaders) {
  if (!symbols.length) return { priceMap: {}, analystMap: {} }
  const port = process.env.PORT || 3001
  try {
    const r = await fetch(
      `http://127.0.0.1:${port}/api/quote?symbols=${symbols.map(encodeURIComponent).join(',')}`,
      { headers: fwdHeaders, signal: AbortSignal.timeout(15000) }
    )
    const d = await r.json()
    const priceMap = {}, analystMap = {}
    for (const q of (d?.quoteResponse?.result ?? [])) {
      if (!q?.symbol) continue
      if (q.regularMarketPrice != null) priceMap[q.symbol] = q.regularMarketPrice
      const target  = q.targetMedianPrice
      const recMean = q.recommendationMean
      const count   = q.numberOfAnalystOpinions
      const fwdPE   = q.forwardPE
      if (target != null || recMean != null || fwdPE != null) {
        analystMap[q.symbol] = { target, recMean, count, fwdPE }
      }
    }
    return { priceMap, analystMap }
  } catch (e) {
    console.warn('[recommendations] live quote fetch failed:', e.message)
    return { priceMap: {}, analystMap: {} }
  }
}

router.post('/', requireAuth, recLimit, async (req, res) => {
  // Same mobile idle-timeout exposure as the AI Brain scan: a 16k-token
  // generation holds the connection for a long time writing nothing, and the
  // browser reports the dropped connection as a bare "Load failed".
  // Failures after the first heartbeat arrive as 200 + `error` in the body.
  startJsonHeartbeat(res)

  if (process.env.AI_RECOMMENDATIONS_DISABLED === 'true')
    return res.status(503).json({ error: 'AI Buy Signals are temporarily disabled (kill switch active)', killSwitch: true })

  const { holdings = [], focusSymbols = [], persona: personaId = 'default', includeMacro = true, includeFunds = false, includeFilings = false } = req.body
  const persona    = PERSONAS[personaId] ?? PERSONAS.default
  const holdingStr = holdings.length    ? holdings.join(', ') : 'none'
  const focusStr   = focusSymbols.length ? focusSymbols.join(', ') : ''
  const fwdHeaders = fwdKeys(req)
  const port       = process.env.PORT || 3001
  // Not req.user.userId: the background queue drives this route over loopback,
  // where requireAuth is satisfied by the internal secret and never sets
  // req.user. Without this the run would be journalled under nobody.
  const userId     = effectiveUserId(req)

  // Load prior rec history to avoid repeating recently recommended symbols
  const recHistory = userId ? await getUserPrefs(userId, 'rec_history', 5) : []
  const historySnippet = recHistory.length > 0
    ? '\nUSER\'S RECENT RECOMMENDATION HISTORY (avoid repeating these symbols/sectors):\n' +
      recHistory.map(p => p.content).join('\n')
    : ''

  // ── Step 1: Pre-fetch live prices + catalyst context + macro in parallel ─────
  const symbolsForContext = focusSymbols.length ? focusSymbols : []
  // Insider + options flow for focusSymbols (stock/ETF only); fall back to top holdings if no focus
  const stocksForAltData = (focusSymbols.length
    ? focusSymbols
    : holdings
  ).filter(s => !s.includes('-') && !s.includes('=')).slice(0, 5)

  const [quoteData, { earningsSnippet, sentimentSnippet }, macroData, socialSentimentSnippet, insiderResults, optionsResults, filingsResults] = await Promise.all([
    focusSymbols.length ? fetchLiveQuotes(focusSymbols, fwdHeaders) : Promise.resolve({ priceMap: {}, analystMap: {} }),
    fetchCatalystContext(symbolsForContext, fwdHeaders, port),
    includeMacro ? getIndicators().catch(() => null) : Promise.resolve(null),
    getSocialSentiment(focusSymbols.length ? focusSymbols.slice(0, 5) : holdings.slice(0, 5)),
    stocksForAltData.length
      ? Promise.all(stocksForAltData.map(s => getAltDataSnippet(s).catch(() => null)))
      : Promise.resolve([]),
    stocksForAltData.length
      ? Promise.all(stocksForAltData.map(s => getOptionsFlowCompact(s, port, fwdHeaders).catch(() => null)))
      : Promise.resolve([]),
    includeFilings && stocksForAltData.length
      ? Promise.all(stocksForAltData.map(s => getFilingCompact(s, port, fwdHeaders)))
      : Promise.resolve([]),
  ])

  const { priceMap: preLivePrices, analystMap } = quoteData
  const macroSnippet = macroData?.macroSummary ?? ''

  // Insider + options flow compact snippets
  const insiderSnippet = insiderResults.filter(Boolean).length
    ? '\nINSIDER ACTIVITY & SHORT INTEREST (OpenInsider 90d + FINRA — use to adjust sentimentScore):\n' +
      insiderResults.filter(Boolean).join('\n')
    : ''
  const optionsSnippet = optionsResults.filter(Boolean).length
    ? '\nOPTIONS FLOW (P/C ratio + unusual activity — bullish signal when P/C<0.70🟢):\n  ' +
      optionsResults.filter(Boolean).join('\n  ')
    : ''
  const filingsSnippet = filingsResults.filter(Boolean).length
    ? '\nSEC FILING NARRATIVE (latest 10-K/10-Q/8-K — tone, risk factors, red flags):\n  ' +
      filingsResults.filter(Boolean).join('\n  ')
    : ''

  const livePriceSnippet = Object.keys(preLivePrices).length
    ? '\nLIVE PRICES (use these exact values for entryPrice — do not guess):\n' +
      Object.entries(preLivePrices).map(([s, p]) => `  ${s}: $${p}`).join('\n')
    : ''

  const analystRows = Object.entries(analystMap).map(([s, a]) => {
    const parts = []
    if (a.target != null) parts.push(`target $${a.target.toFixed(2)}${a.count ? ` (${a.count}×)` : ''}`)
    if (a.recMean != null) parts.push(`consensus ${a.recMean.toFixed(1)}/5`)
    if (a.fwdPE  != null) parts.push(`fwdP/E ${a.fwdPE.toFixed(1)}`)
    return `  ${s}: ${parts.join(' | ')}`
  })
  const analystConsensusSnippet = analystRows.length
    ? '\nANALYST CONSENSUS (validate your picks — flag divergences in thesis):\n' + analystRows.join('\n')
    : ''

  const focusInstructions = focusStr
    ? `\nFOCUS MODE: Analyze ONLY these specific symbols: ${focusStr}. All recommendations must come from this list.`
    : ''

  const countInstructions = focusStr
    ? `Generate ${Math.min(focusSymbols.length, 20)} recommendations covering the focus symbols above.`
    : includeFunds
      ? `Generate exactly 22 recommendations split across asset classes and time horizons:
- 6 Stocks for 3-month holding
- 4 Stocks for 6-month holding
- 4 ETFs (mix of 3m and 6m)
- 3 Cryptocurrencies (mix of 3m and 6m)
- 3 Mutual Funds (use common tickers like FXAIX, VFIAX, FCNTX, FDGRX, PRGFX, PRWCX — type must be "Fund")
- 2 additional high-conviction picks of any type`
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
${livePriceSnippet}${analystConsensusSnippet}${macroSnippet}${earningsSnippet}${sentimentSnippet}${socialSentimentSnippet}${insiderSnippet}${optionsSnippet}${filingsSnippet}${historySnippet}

${countInstructions}
${persona.constraints ? '\n' + persona.constraints : ''}

Rules:
- Use standard tickers (BTC-USD for Bitcoin, ETH-USD for Ethereum, SOL-USD for Solana, etc.)
- Be realistic: target returns 5–40%, stop-loss 5–15%${includeFunds ? '\n- For type "Fund": use the NAV as entryPrice, sector = fund category (e.g. "Large-Cap Growth"), stopLoss = max acceptable NAV drawdown %' : ''}
- Diversify unless the persona specifies concentration
- Each thesis must be specific, not generic, and reflect the persona's investment style
- entryPrice: use the LIVE PRICE above if provided, otherwise your best estimate of current market price
- takeProfitPrice: entryPrice × (1 + targetReturn/100)
- stopLossPrice: entryPrice × (1 - stopLoss/100)
- sources: ground each pick in the SPECIFIC evidence shown above — live prices, analyst consensus, macro, earnings, sentiment, insider/options flow, SEC filings, technicals. Cite only data actually present above; NEVER invent figures or sources. Use [] when no specific data supports the pick.

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
      "thesisBreaker": "Specific event that invalidates this pick in ≤8 words",
      "sources": ["≤12 words each — specific evidence from the data above (e.g. 'RSI 28 — oversold', 'analyst target $210 (12×)', '10-K risk factors eased'); max 4; [] if none"]
    }
  ],
  "marketOutlook": "2-sentence overall market view",
  "keyRisks": "1-sentence macro risk to watch"
}`

  const allSymbols = [...new Set([...holdings, ...focusSymbols])]
  let raw     = ''
  let llmUsed = 'claude'

  try {
    // 16k output budget: a full 20–22 pick set with per-item thesis/catalyst/
    // sources runs well past 8k and was truncating mid-JSON → the parser saw a
    // broken object and failed with "Unexpected end of JSON input". Matches the
    // ai-brain budget for a comparable ranked-list response.
    const result = await aiRouter.call({ prompt, maxTokens: 16000, symbols: allSymbols })
    raw     = result.text
    llmUsed = result.llmUsed
  } catch (err) {
    if (err instanceof CircuitOpenError) return res.status(503).json({ error: err.message, circuitOpen: true })
    if (err.status === 503)             return res.status(503).json({ error: err.message })
    console.error('[recommendations]', err.message)
    return res.status(500).json({ error: 'Recommendation service error: ' + err.message })
  }

  try {
    let data = null
    let truncated = false

    // Preferred path: parse the whole payload.
    const match = raw.match(/\{[\s\S]*\}/)
    if (match) {
      try { data = JSON.parse(match[0]) } catch { /* fall through to salvage */ }
    }

    // Salvage path: if the response was cut off at the token ceiling the full
    // payload won't parse, but the picks that finished before the cut are
    // intact. Recover them rather than failing the whole request.
    if (!data || !Array.isArray(data.recommendations) || !data.recommendations.length) {
      const salvaged = extractArrayObjects(raw, 'recommendations')
      if (salvaged.length) {
        data = { recommendations: salvaged, marketOutlook: data?.marketOutlook || '', keyRisks: data?.keyRisks || '' }
        truncated = true
        console.warn(`[recommendations] response incomplete — salvaged ${salvaged.length} complete picks`)
      }
    }

    if (!data) {
      console.error('[recommendations] Non-JSON response:', raw.slice(0, 200))
      return res.status(502).json({ error: 'AI response was incomplete — please try again' })
    }

    try { validateRecommendations(data) } catch (valErr) {
      // On a truncated set, drop the malformed picks instead of failing outright.
      if (truncated && Array.isArray(data.recommendations)) {
        data.recommendations = data.recommendations.filter(r =>
          r && r.symbol && typeof r.entryPrice === 'number' && r.entryPrice > 0 &&
          typeof r.targetReturn === 'number' && r.targetReturn > 0 && r.targetReturn <= 500 &&
          r.stopLoss != null && r.thesis != null)
      }
      if (!truncated || !data.recommendations.length) {
        console.error('[recommendations] Schema validation failed:', valErr.message)
        return res.status(500).json({ error: 'AI response did not match expected format — please try again' })
      }
    }

    // ── Re-anchor prices to live market data ─────────────────────────────────
    const recSymbols     = data.recommendations.map(r => r.symbol).filter(Boolean)
    const { priceMap: postLivePrices } = await fetchLiveQuotes(recSymbols, fwdHeaders)
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

    // ── Expected-value gate + Kelly position sizing (advisory) ───────────────
    // The prompt asks for a fixed slate (20–22), so the model always returns a
    // full one. This is where the system earns the right to hand back fewer:
    // each pick is scored on its own reward/risk against an EMPIRICAL win
    // probability for ITS ASSET CLASS and a realistic round-trip cost, and
    // anything without a positive net edge over the floor is dropped. The model
    // is never told a gate exists, so it can't pad toward it.
    //
    // Sizing then uses the SAME cost-adjusted payoffs (netWinFrac/netLossFrac)
    // that produced the verdict — a pick can't be judged on net edge and sized
    // on gross. Win probability falls back to a conservative default until
    // enough predictions have resolved, which leaves the gate inert rather than
    // arbitrary on a cold start.
    let kellyStats = null
    try { kellyStats = computeStats(readPredictions()) } catch { /* calibration optional */ }

    const minNetEdge = Number(process.env.ADVISORY_MIN_NET_EDGE) > 0
      ? Number(process.env.ADVISORY_MIN_NET_EDGE)
      : expectedValue.MIN_NET_EDGE

    const winProbSources = new Set()
    const rejected = []

    const scored = data.recommendations.map(rec => {
      // Citations: keep only non-empty string sources, max 4 (defensive against
      // the model omitting/malforming the field). Always present as an array.
      const sources = Array.isArray(rec.sources) ? rec.sources.filter(s => typeof s === 'string' && s.trim()).slice(0, 4) : []

      const { p: winProb, source: winProbSource } = kelly.winProbFromStats(kellyStats, {
        assetType: expectedValue.normalizeAssetType(rec.type),
        fallback:  0.5,
      })
      winProbSources.add(winProbSource)

      const ev = expectedValue.evaluateTrade({
        winProb,
        targetReturn: rec.targetReturn,
        stopLoss:     rec.stopLoss,
        assetType:    rec.type,
        minNetEdge,
      })

      // Unscoreable (no usable target/stop) — can't measure an edge, so don't
      // claim one. Kept rather than dropped: silence about a pick is not
      // evidence against it, and schema validation already bounds the field.
      if (!ev) return { ...rec, sources, expectedValue: null }

      const sizing = kelly.suggestedSize({
        winProb,
        winFrac:     ev.netWinFrac,
        lossFrac:    ev.netLossFrac,
        fraction:    0.5,
        maxFraction: 0.2,
      })
      return { ...rec, sources, expectedValue: ev, sizing: { ...sizing, winProbSource, netOfCosts: true } }
    })

    data.recommendations = scored.filter(rec => {
      if (!rec.expectedValue || rec.expectedValue.actionable) return true
      const { verdict, reason, netEdge, breakEvenWinProb } = rec.expectedValue
      rejected.push({ symbol: rec.symbol, type: rec.type ?? null, verdict, reason, netEdge, breakEvenWinProb })
      return false
    })

    if (rejected.length)
      console.log(`[recommendations] edge gate dropped ${rejected.length}/${scored.length}: ` +
        rejected.map(r => `${r.symbol} (${r.verdict})`).join(', '))

    // Strip any holdings the AI recommended despite the instruction — last-resort guard
    if (holdings.length) {
      const heldSet = new Set(holdings.map(s => String(s).toUpperCase()))
      data.recommendations = data.recommendations.filter(r => !heldSet.has(String(r.symbol).toUpperCase()))
    }

    // Built AFTER the holdings strip so `kept` always equals what the caller
    // actually receives — otherwise a gate-passing pick that is then stripped
    // as an existing holding would leave `kept` contradicting `abstained`.
    const edgeGate = {
      minNetEdge,
      evaluated:       scored.length,
      kept:            data.recommendations.length,
      rejected,
      winProbSources:  [...winProbSources],
      costModelBps:    expectedValue.ROUND_TRIP_BPS,
    }

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

    // Record every surviving pick in the SHARED cross-surface learning store,
    // stamped with the PERSONA that produced it.
    //
    // The journal already stored the persona, but nothing carried it into
    // calibration — so "does Buffett actually beat Wood on this system, or does
    // it just sound different?" had no answer, and the personas were a styling
    // choice rather than a measured one. Best-effort: never fails the run.
    try {
      learningStore.recordDecisions((data.recommendations || [])
        .filter(r => r?.symbol && r.entryPrice > 0)
        .map(r => ({
          surface:    'advisory',
          symbol:     r.symbol,
          action:     'buy',
          price:      r.entryPrice,
          confidence: r.confidence ?? null,
          meta: {
            persona:      persona.id,
            sector:       r.sector ?? null,
            assetType:    r.type ?? null,
            targetReturn: r.targetReturn ?? null,
            stopLoss:     r.stopLoss ?? null,
            regime:       macroData?.regime?.regime ?? null,
            modelVersion: llmUsed === 'claude' ? 'claude-sonnet-4-6' : 'llama-3.3-70b-versatile',
          },
        })))
    } catch (e) { console.warn('[recommendations] learning-store record failed:', e.message) }

    // Journal this run as a versioned, diffable "commit" (rationale = market
    // outlook). Best-effort; appendEntry never throws to the caller.
    recJournal.appendEntry(recJournal.buildEntry({
      recommendations: data.recommendations,
      rationale: data.marketOutlook || '',
      persona:   persona.id,
      params:    { includeMacro, includeFilings, includeFunds, focus: focusStr || null },
      userId,
    }))

    return res.json({
      ...data,
      generatedAt: new Date().toISOString(),
      llmUsed,
      truncated,
      // True when every candidate failed the edge gate. An empty slate is a
      // real answer, not an error — the alternative is padding the list with
      // picks the math says are not worth the friction.
      abstained: data.recommendations.length === 0,
      edgeGate,
      persona: { id: persona.id, name: persona.name, emoji: persona.emoji, style: persona.style },
      macroRegime: macroData?.regime ?? null,
    })
  } catch (err) {
    console.error('[recommendations]', err.message)
    return res.status(500).json({ error: 'Recommendation service error: ' + err.message })
  }
})

// ── Background generation ────────────────────────────────────────────────────
// A 16k-token generation is long enough that holding the connection open ties
// the result to a live tab — and on mobile the connection frequently died
// outright, surfacing as a bare "Load failed". POST /job runs the same
// generation on the server and persists the result, so closing the page no
// longer throws away a run that was already paid for.
mountJobRoutes(router, {
  kind: 'recommendations',
  requireAuth,
  noun: 'recommendation',
  disabledEnv: 'AI_RECOMMENDATIONS_DISABLED',
  label: (p) => (p.focusSymbols.length ? p.focusSymbols.join(',') : p.persona),
  buildParams: (req) => {
    const {
      holdings = [], focusSymbols = [], persona = 'default',
      includeMacro = true, includeFunds = false, includeFilings = false,
    } = req.body || {}

    if (!PERSONAS[persona]) return { error: `Unknown persona: ${persona}` }

    const clean = arr => (Array.isArray(arr) ? arr : [])
      .map(s => String(s).toUpperCase().replace(/[^A-Z0-9.-]/g, '')).filter(Boolean).slice(0, 20)

    return {
      holdings:       clean(holdings),
      focusSymbols:   clean(focusSymbols),
      persona,
      includeMacro:   !!includeMacro,
      includeFunds:   !!includeFunds,
      includeFilings: !!includeFilings,
    }
  },
})

// GET /api/recommendations/journal — versioned, diffable history of this user's
// recommendation runs ("decisions as commits"). Each entry carries a diff vs the
// previous run (added / removed / changed picks). requireAuth — user-scoped.
router.get('/journal', requireAuth, (req, res) => {
  const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 20, 1), 100)
  const entries = recJournal.readJournalWithDiffs({ userId: req.user?.userId, limit })
  res.json({ count: entries.length, entries })
})

// GET /api/recommendations/journal/verify — recompute the journal's hash chain.
// valid=true proves no chained entry was altered, deleted, or reordered since
// it was written; on a break, firstBreak pinpoints the earliest bad link.
// Entries from before chaining existed are reported as `legacy`.
router.get('/journal/verify', requireAuth, (req, res) => {
  res.json(recJournal.verifyChain())
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
