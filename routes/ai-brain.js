'use strict'
/**
 * routes/ai-brain.js
 *
 * POST /api/ai-brain/analyze
 * body: { symbols?, scanMode?, horizon?, holdings? }
 *
 * Council improvements applied (2026-05-31):
 * - Supervisor rebuilt as contradiction engine (surfaces agent disagreements)
 * - Price targets output as confidence zones, not false-precision numbers
 * - Agent reasoning expanded to 20 words with plain-language prose
 * - Thesis assumptions extracted (3 falsifiable conditions) for assumption-based staleness
 * - Prediction logging for future win-rate tracking
 */

const express             = require('express')
const Anthropic           = require('@anthropic-ai/sdk')
const rateLimit           = require('express-rate-limit')
const fs                  = require('fs')
const path                = require('path')
const { getBreaker, CircuitOpenError } = require('../lib/circuit-breaker')
const { logCall }         = require('../lib/ai-audit')

const router  = express.Router()
const breaker = getBreaker('ai-brain', { threshold: 3, resetTimeoutMs: 60_000 })

const PREDICTION_LOG = path.join(__dirname, '../data/ai-brain-predictions.jsonl')

const brainLimit = rateLimit({
  windowMs: 5 * 60 * 1000, max: 4,
  message: { error: 'Too many AI Brain requests — wait a few minutes' },
})

// ── Curated universe per scan mode ───────────────────────────────────────────
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
  mutualfunds: [
    'FXAIX','VFIAX','VTSAX','FSKAX','FSELX','FCNTX','FDGRX',
    'PRGFX','AGTHX','PRWCX','TRBCX','VWUSX','FGRTX','VDADX',
    'DODGX','OAKMX','CGMFX','VGHCX','FBIOX','RPMGX',
  ],
}

function fwdKeys(req) {
  const h = {}
  for (const k of ['x-aisa-key','x-finnhub-key','x-fmp-key','x-td-key','x-av-key']) {
    if (req.headers[k]) h[k] = req.headers[k]
  }
  return h
}

function fmtQuote(q) {
  if (!q?.regularMarketPrice) return null
  const price = q.regularMarketPrice
  const chg   = q.regularMarketChangePercent
  const sign  = (chg ?? 0) >= 0 ? '+' : ''
  const pe    = q.trailingPE
  const hi    = q.fiftyTwoWeekHigh
  const lo    = q.fiftyTwoWeekLow
  const cap   = q.marketCap
  const vol   = q.regularMarketVolume
  const avgVol = q.averageDailyVolume3Month
  const chgStr = chg != null ? ` (${sign}${chg.toFixed(2)}%)` : ''
  const volRatio = (vol && avgVol) ? ` Vol=${(vol/avgVol).toFixed(2)}x avg` : ''
  return (
    `${q.symbol}: $${price.toFixed(price >= 1 ? 2 : 6)}${chgStr}` +
    ` MktCap=${cap ? '$' + (cap / 1e9).toFixed(0) + 'B' : 'N/A'}` +
    ` P/E=${pe ? pe.toFixed(1) : 'N/A'}` +
    ` 52w=$${lo?.toFixed(0) ?? '?'}-$${hi?.toFixed(0) ?? '?'}` +
    volRatio
  )
}

// Write a prediction record for future win-rate tracking
function logPrediction(symbol, agents, zones, generatedAt) {
  try {
    const dir = path.dirname(PREDICTION_LOG)
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
    const record = JSON.stringify({
      symbol, generatedAt,
      fundamentalScore: agents.fundamentalScore,
      technicalScore:   agents.technicalScore,
      sentimentScore:   agents.sentimentScore,
      macroScore:       agents.macroScore,
      riskScore:        agents.riskScore,
      compositeScore:   agents.compositeScore,
      entryZoneMid:     zones?.entryZoneLow != null ? (zones.entryZoneLow + zones.entryZoneHigh) / 2 : null,
      targetZoneMid:    zones?.targetZoneLow != null ? (zones.targetZoneLow + zones.targetZoneHigh) / 2 : null,
      verdict:          agents.agentVerdict,
      // outcome fields filled later by a scheduled job
      price7d: null, price30d: null, price90d: null,
    })
    fs.appendFileSync(PREDICTION_LOG, record + '\n')
  } catch { /* non-fatal */ }
}

router.post('/analyze', brainLimit, async (req, res) => {
  if (process.env.AI_BRAIN_DISABLED === 'true')
    return res.status(503).json({ error: 'AI Brain is temporarily disabled (kill switch active)', killSwitch: true })

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

  const baseList = (symbols?.length && Array.isArray(symbols))
    ? symbols.map(s => String(s).toUpperCase().replace(/[^A-Z0-9.-]/g, '')).filter(Boolean)
    : (SCAN_UNIVERSES[scanMode] || SCAN_UNIVERSES.broad)

  const universe     = [...new Set(baseList)].slice(0, 20)
  const holdingStr   = holdings.length ? holdings.join(', ') : 'none'
  const horizonLabel = { '3m': '3-month', '6m': '6-month', '12m': '12-month' }[horizon]
  const generatedAt  = new Date().toISOString()

  // ── Step 1: fetch live quotes with volume data ─────────────────────────────
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

  const validQuotes = liveQuotes.filter(q => q?.regularMarketPrice != null && q.regularMarketPrice > 0)
  const missingSyms = universe.filter(s => !validQuotes.find(q => q.symbol === s))
  const dataAge     = validQuotes.length ? 'live' : 'knowledge'

  if (validQuotes.length > 0) {
    marketSnippet = '\n\nLIVE SNAPSHOT (prices + volume ratio vs 3-month avg — use as primary source):\n'
      + validQuotes.map(fmtQuote).join('\n')
    if (missingSyms.length)
      marketSnippet += `\n\nNo live data for: ${missingSyms.join(', ')} — use training knowledge.`
  } else {
    marketSnippet = '\n\nNote: No live market data available — use training knowledge for prices.'
  }

  // ── Step 2: prompt — contradiction engine + zones + assumptions ────────────
  const prompt = `You are a 5-agent investment AI with a Supervisor whose job is to SURFACE CONTRADICTIONS, not average scores.

CRITICAL: When two agents disagree by 25+ points, that spread IS the primary signal. Do not smooth it. Surface it.

Analyze this universe for a ${horizonLabel} horizon. Today is late May 2026.
Universe: ${universe.join(', ')}
Avoid holdings: ${holdingStr}
${scanMode === 'mutualfunds' ? `\nNOTE: This universe contains mutual funds. For each fund score on: (1) Fundamental = long-term holdings quality & manager track record, (2) Technical = NAV trend & momentum vs benchmark, (3) Sentiment = fund flows & retail demand, (4) Macro = sector/asset-class fit for current regime, (5) Risk = expense ratio, drawdown history, concentration risk. Price targets refer to NAV levels. Skip stop-loss precision — use risk zones instead.` : ''}
${marketSnippet}

⚠️ STRICT TOKEN BUDGET — respect every word limit or the response will be truncated.

Respond ONLY with valid JSON (no markdown, no text outside the JSON object):
{
  "marketRegime": "≤5 words",
  "macroOutlook": "≤15 words",
  "agentConsensusTheme": "≤12 words",
  "dataSource": "live|knowledge",
  "rankedStocks": [
    {
      "rank": 1,
      "symbol": "TICKER",
      "name": "Company name",
      "sector": "Sector",
      "type": "Stock|ETF|Crypto",
      "currentPrice": 0.0,
      "compositeScore": 0,
      "confidence": "High|Medium|Low",
      "agentVerdict": "Strong Buy|Buy|Moderate Buy",
      "targetReturn": 0,
      "stopLoss": 0,
      "entryZoneLow": 0.0,
      "entryZoneHigh": 0.0,
      "targetZoneLow": 0.0,
      "targetZoneHigh": 0.0,
      "stopZoneLow": 0.0,
      "stopZoneHigh": 0.0,
      "fundamentalScore": 0,
      "technicalScore": 0,
      "sentimentScore": 0,
      "macroScore": 0,
      "riskScore": 0,
      "fundamentalAnalysis": "≤20 words plain prose — specific valuation/earnings reasoning",
      "technicalAnalysis": "≤20 words plain prose — specific price/volume/momentum reasoning",
      "sentimentAnalysis": "≤20 words plain prose — specific news/flow/positioning reasoning",
      "macroAnalysis": "≤20 words plain prose — specific macro/sector tailwind or headwind",
      "riskNote": "≤20 words plain prose — specific downside scenario",
      "supervisorSynthesis": "≤20 words — if agents agree, say so; if they conflict, say which two and why it matters",
      "agentConflict": {
        "exists": true,
        "agents": ["Agent1","Agent2"],
        "spread": 0,
        "meaning": "≤15 words — what this disagreement signals for timing/sizing"
      },
      "thesisAssumptions": [
        "≤10 words — falsifiable assumption 1",
        "≤10 words — falsifiable assumption 2",
        "≤10 words — falsifiable assumption 3"
      ],
      "volumeSignal": "Confirming|Weak|Diverging|Unknown",
      "keyDrivers": ["≤4 words","≤4 words"],
      "bearCase": "≤10 words — primary downside risk",
      "thesisBreaker": "≤8 words — event that invalidates this pick"
    }
  ],
  "agentNotes": {
    "fundamentalAnalyst": "≤15 words",
    "technicalAnalyst": "≤15 words",
    "sentimentAnalyst": "≤15 words",
    "macroEconomist": "≤15 words",
    "riskManager": "≤15 words"
  }
}

Rules:
- Include up to 20 top picks ranked by compositeScore; prefer symbols NOT already in holdings
- compositeScore = weighted avg (fundamental 25%, technical 20%, sentiment 15%, macro 20%, risk 20%)
- All scores 0-100; riskScore: higher = safer
- agentConflict.exists = true when ANY two agent scores differ by ≥25 points
- agentConflict.agents = the two most-divergent agents
- Price zones: entryZoneLow/High = ±2% around ideal entry; targetZoneLow/High = ±3% around target; stopZoneLow/High = ±1.5% around stop
- volumeSignal: "Confirming" if vol > 1.1x avg and price trending up; "Weak" if vol < 0.8x; "Diverging" if vol rising but price falling (or vice versa); "Unknown" if no data
- thesisAssumptions: 3 specific, falsifiable conditions that must hold for the bull case to play out
- dataSource: "live" if snapshot provided, else "knowledge"
- STRICTLY respect all ≤N word limits`

  // ── Groq fallback ─────────────────────────────────────────────────────────
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

  // ── Step 3: run Claude via circuit breaker ─────────────────────────────────
  const AI_MODEL = 'claude-sonnet-4-6'
  let raw     = ''
  let llmUsed = 'claude'
  let tokensIn = null, tokensOut = null

  try {
    const { result: msg, durationMs } = await breaker.call(async () => {
      const client = new Anthropic({ apiKey })
      return client.messages.create({
        model:      AI_MODEL,
        max_tokens: 16000,
        messages:   [{ role: 'user', content: prompt }],
      })
    })
    raw       = msg.content?.[0]?.text || ''
    tokensIn  = msg.usage?.input_tokens
    tokensOut = msg.usage?.output_tokens
    logCall({ route: 'ai-brain', model: AI_MODEL, llm: 'claude', symbols: universe, success: true, tokensIn, tokensOut, durationMs })
  } catch (claudeErr) {
    if (claudeErr instanceof CircuitOpenError) {
      logCall({ route: 'ai-brain', model: AI_MODEL, llm: 'claude', symbols: universe, success: false, error: claudeErr.message, durationMs: 0 })
      return res.status(503).json({ error: claudeErr.message, circuitOpen: true })
    }

    const isOverloaded = claudeErr.status === 529 || claudeErr.message?.includes('overloaded')
    if (isOverloaded && process.env.GROQ_API_KEY) {
      console.warn('[ai-brain] Claude overloaded, falling back to Groq')
      const groqModel = 'llama-3.3-70b-versatile'
      const t0 = Date.now()
      try {
        raw = await callGroq(prompt)
        llmUsed = 'groq'
        logCall({ route: 'ai-brain', model: groqModel, llm: 'groq', symbols: universe, success: true, durationMs: Date.now() - t0 })
      } catch (groqErr) {
        logCall({ route: 'ai-brain', model: groqModel, llm: 'groq', symbols: universe, success: false, error: groqErr.message, durationMs: Date.now() - t0 })
        throw groqErr
      }
    } else {
      logCall({ route: 'ai-brain', model: AI_MODEL, llm: 'claude', symbols: universe, success: false, error: claudeErr.message, durationMs: claudeErr._durationMs || 0 })
      throw claudeErr
    }
  }

  try {
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
      } catch {
        console.error('[ai-brain] JSON parse failed (likely truncated). raw length:', raw.length)
        return res.status(500).json({ error: 'AI Brain response was truncated — reduce symbols or try again' })
      }
    }

    if (!Array.isArray(data.rankedStocks) || !data.rankedStocks.length)
      return res.status(500).json({ error: 'AI Brain returned no ranked stocks — try again' })

    // Log each prediction for win-rate tracking
    for (const stock of data.rankedStocks) {
      logPrediction(stock.symbol, stock, {
        entryZoneLow:   stock.entryZoneLow,
        entryZoneHigh:  stock.entryZoneHigh,
        targetZoneLow:  stock.targetZoneLow,
        targetZoneHigh: stock.targetZoneHigh,
      }, generatedAt)
    }

    return res.json({
      ...data,
      horizon,
      scanMode,
      processedAt:      generatedAt,
      dataAge,
      universeAnalyzed: universe,
      liveDataSymbols:  liveQuotes.map(q => q.symbol),
      llmUsed,
      modelUsed: llmUsed === 'claude' ? AI_MODEL : 'llama-3.3-70b-versatile',
      agentsUsed: ['Fundamental Analyst','Technical Analyst','Sentiment Agent','Macro Economist','Risk Manager','Supervisor'],
    })
  } catch (err) {
    console.error('[ai-brain]', err.message)
    return res.status(500).json({ error: 'AI Brain analysis failed: ' + err.message })
  }
})

module.exports = router
