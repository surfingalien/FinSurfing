/**
 * routes/agent.js
 *
 * Multi-Specialist Stock Analyst Agent
 * ─────────────────────────────────────
 * Inspired by TradingAgents (Tauri Research) multi-agent pattern:
 *   • Technical Analyst  — OHLCV + RSI/MACD/BB/SMA/ATR from the /api/chart provider chain
 *   • Fundamental Analyst — P/E, margins, growth, DCF from FMP
 *   • Sentiment Analyst  — News sentiment from Alpha Vantage + FMP
 *   • Insider Tracker    — Insider buy/sell from FMP
 *   • Risk Manager       — Claude synthesises all reports into a trade plan
 *
 * Data sources (each optional — degrades gracefully):
 *   /api/chart     → the app's market-data provider chain (some providers are delayed)
 *   Alpha Vantage  → ALPHA_VANTAGE_API_KEY env var
 *   FMP            → FMP_API_KEY env var
 *
 * AI backends:
 *   Anthropic Claude → ANTHROPIC_API_KEY
 *   Google Gemini    → GEMINI_API_KEY (streaming REST)
 *
 * POST /api/agent/analyze   — SSE streaming chat
 * GET  /api/agent/health    — credential status check
 */

'use strict'

const express  = require('express')
const router   = express.Router()
const { computeAll }           = require('../utils/technicals')
const { fetchAllFundamentals } = require('../utils/dataProviders')
const { getChatHistory, saveChatSummary } = require('../db/ai_memory')
const { GROQ_MODEL }           = require('../lib/ai-router')
const { cachedSystem, markConversationTail } = require('../lib/prompt-cache')
const { requireAuth }          = require('../middleware/auth')
const { wrapUntrusted, UNTRUSTED_POLICY } = require('../lib/untrusted')
const planCheck                = require('../lib/plan-check')
const { settleMemories, memoryBlock } = require('../lib/settled-memory')
const { isCryptoSymbol }       = require('../lib/crypto-classify')

// The models the UI offers. The route used to pass any body `model` straight
// to the API, so an anonymous caller could pick the dearest one.
const ALLOWED_MODELS = new Set([
  'claude-opus-4-5', 'claude-sonnet-4-5', 'claude-haiku-4-5',
  'gemini-2.0-flash', 'gemini-1.5-pro',
])

// ── Lazy-load Anthropic SDK ───────────────────────────────────────────────────
let _client = null
function getClient() {
  if (require('../lib/ai-pause').claudePaused()) throw require('../lib/ai-pause').pausedError()
  if (_client) return _client
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY is not set')
  const Anthropic = require('@anthropic-ai/sdk')
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

// ── OHLCV via internal /api/chart proxy (Finnhub → FMP, no Yahoo) ────────────
async function chartFetch(symbol, range = '1y') {
  const port = process.env.PORT || 3001
  const r    = await fetch(
    `http://127.0.0.1:${port}/api/chart?symbol=${encodeURIComponent(symbol)}&interval=1d&range=${range}`,
    { signal: AbortSignal.timeout(12000) }
  )
  if (!r.ok) throw new Error(`Chart proxy HTTP ${r.status}`)
  return r.json()
}

// ── Gemini streaming helper ───────────────────────────────────────────────────
async function* streamGemini(model, systemPrompt, messages, signal) {
  const key = process.env.GEMINI_API_KEY
  if (!key) throw new Error('GEMINI_API_KEY is not set')
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?key=${key}&alt=sse`

  const contents = messages.map(m => ({
    role:  m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }))

  const body = {
    system_instruction: { parts: [{ text: systemPrompt }] },
    contents,
    generationConfig: { maxOutputTokens: 4096, temperature: 0.7 },
  }

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Gemini API error ${res.status}: ${err.slice(0, 200)}`)
  }

  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const obj = JSON.parse(payload)
        const text = obj?.candidates?.[0]?.content?.parts?.[0]?.text
        if (text) yield text
      } catch {}
    }
  }
}

// ── Groq streaming helper (OpenAI-compatible SSE) ────────────────────────────
async function* streamGroq(systemPrompt, messages, signal) {
  const key = process.env.GROQ_API_KEY
  if (!key) throw new Error('GROQ_API_KEY is not set')

  const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify({
      model:      GROQ_MODEL,
      max_tokens: 4096,
      temperature: 0.7,
      stream:     true,
      messages: [
        { role: 'system', content: systemPrompt },
        ...messages,
      ],
    }),
    signal,
  })
  if (!res.ok) {
    const err = await res.text()
    throw new Error(`Groq API error ${res.status}: ${err.slice(0, 200)}`)
  }

  const reader  = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    const lines = buf.split('\n')
    buf = lines.pop()
    for (const line of lines) {
      if (!line.startsWith('data:')) continue
      const payload = line.slice(5).trim()
      if (!payload || payload === '[DONE]') continue
      try {
        const obj  = JSON.parse(payload)
        const text = obj?.choices?.[0]?.delta?.content
        if (text) yield text
      } catch {}
    }
  }
}

// ── Tool definitions ──────────────────────────────────────────────────────────

const TOOLS = [
  {
    name: 'get_technical_analysis',
    description: `TECHNICAL ANALYST role.
Fetches OHLCV price history and computes all technical indicators server-side:
• RSI(14) with overbought/oversold signal
• MACD(12,26,9) — macd line, signal line, histogram, trend label
• Bollinger Bands(20,2) — upper/middle/lower, %B, bandwidth, squeeze signal
• SMA50, SMA200, EMA20 — with golden/death cross zone detection
• ATR(14) — average true range for stop sizing
• Support & Resistance — nearest levels above/below from pivot analysis
• Volume analysis — relative volume vs 20-day average, trend
• Price action — trend direction, candle body ratio, short/long trend

Data source: the app's market-data providers (some are delayed, not real-time).
Use this first for any technical or price-action question.`,
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Stock ticker, e.g. AAPL' },
        range:  { type: 'string', enum: ['3mo','6mo','1y','2y'], description: 'History range (default 1y; use 2y for SMA200)' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'get_fundamentals',
    description: `FUNDAMENTAL ANALYST + SENTIMENT ANALYST + INSIDER TRACKER roles combined.
Fetches from FMP (Financial Modeling Prep) and Alpha Vantage:
• Company profile, sector, employees, CEO
• Valuation: P/E, P/B, P/S, EV/EBITDA, DCF fair value vs current price
• Profitability: gross/operating/net margins, ROE, ROIC
• Growth: revenue & net income year-over-year
• Debt: D/E ratio, current ratio, interest coverage
• Dividends: yield, last dividend amount
• Last 4 quarters of earnings trend (revenue, net income, EPS)
• Analyst revenue & EPS estimates for next quarter
• Peer companies list
• Last 10 insider transactions (buys vs sells) with insider sentiment
• Last 8–10 news articles with sentiment scoring (bullish/bearish/neutral)

Requires FMP_API_KEY and/or ALPHA_VANTAGE_API_KEY env vars (degrades gracefully if absent).
Use for value/growth analysis, earnings context, and news sentiment.`,
    input_schema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'Stock ticker, e.g. MSFT' },
      },
      required: ['symbol'],
    },
  },
  {
    name: 'compare_stocks',
    description: `Compare 2–4 stocks side-by-side: fetch technical analysis for each and return all results.
Use for relative strength, sector rotation, or head-to-head comparison questions.`,
    input_schema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          minItems: 2,
          maxItems: 4,
          description: 'Array of 2–4 ticker symbols',
        },
        range: { type: 'string', enum: ['3mo','6mo','1y'], description: 'History range (default 1y)' },
      },
      required: ['symbols'],
    },
  },
]

async function fetchOHLCV(symbol, range = '1y') {
  const data   = await chartFetch(symbol, range)
  const result = data?.chart?.result?.[0]
  if (!result) throw new Error(`No chart data for ${symbol}`)

  const ts        = result.timestamp || []
  const q         = result.indicators?.quote?.[0] || {}
  const adjClose  = result.indicators?.adjclose?.[0]?.adjclose

  const valid = ts.reduce((acc, t, i) => {
    const c = (adjClose || q.close)?.[i]
    if (c != null) {
      acc.ts.push(t); acc.o.push(q.open?.[i] || c); acc.h.push(q.high?.[i] || c)
      acc.l.push(q.low?.[i] || c); acc.c.push(c); acc.v.push(q.volume?.[i] || 0)
    }
    return acc
  }, { ts: [], o: [], h: [], l: [], c: [], v: [] })

  return {
    symbol:   result.meta?.symbol || symbol,
    currency: result.meta?.currency || 'USD',
    timestamps: valid.ts,
    opens: valid.o, highs: valid.h, lows: valid.l, closes: valid.c, volumes: valid.v,
    meta: {
      regularMarketPrice: result.meta?.regularMarketPrice,
      previousClose:      result.meta?.chartPreviousClose || result.meta?.previousClose,
      exchange:           result.meta?.exchangeName,
      instrumentType:     result.meta?.instrumentType,
    },
  }
}

// ── Tool executors ────────────────────────────────────────────────────────────

async function executeTechnicalAnalysis({ symbol, range = '1y' }) {
  const ticker = symbol.toUpperCase().trim()
  const ohlcv  = await fetchOHLCV(ticker, range)
  const ta     = computeAll({ opens: ohlcv.opens, highs: ohlcv.highs, lows: ohlcv.lows, closes: ohlcv.closes, volumes: ohlcv.volumes })

  const p   = ta.priceAction
  const ind = ta.indicators

  // Build plain-English interpretation for Claude to use in its report
  const interpretation = []
  if (ind?.rsi?.value != null) {
    interpretation.push(`RSI(14) = ${ind.rsi.value} → ${ind.rsi.signal}`)
  }
  if (ind?.macd?.macdLine != null) {
    interpretation.push(`MACD histogram ${ind.macd.histogram > 0 ? 'positive' : 'negative'} (${ind.macd.histogram}) → ${ind.macd.trend}`)
  }
  if (ind?.bb?.percentB != null) {
    interpretation.push(`Price at ${ind.bb.percentB}% of Bollinger Band width (${ind.bb.signal})`)
  }
  if (ta.maSignals?.length) {
    interpretation.push(`Moving averages: ${ta.maSignals.join(', ')}`)
  }
  if (ind?.sma50 && p?.price) {
    const pct = ((p.price - ind.sma50) / ind.sma50 * 100).toFixed(1)
    interpretation.push(`Price ${pct > 0 ? '+' : ''}${pct}% vs SMA50`)
  }
  if (ind?.sma200 && p?.price) {
    const pct = ((p.price - ind.sma200) / ind.sma200 * 100).toFixed(1)
    interpretation.push(`Price ${pct > 0 ? '+' : ''}${pct}% vs SMA200`)
  }

  return {
    symbol: ticker,
    timestamp: new Date().toISOString(),
    quote: {
      price:     p?.price ?? ohlcv.meta.regularMarketPrice,
      change:    p?.dayChange,
      changePct: p?.dayChangePct,
      open: p?.open, high: p?.high, low: p?.low,
      prevClose: ohlcv.meta.previousClose,
    },
    indicators: {
      rsi:  ind?.rsi,
      macd: ind?.macd,
      bollingerBands: ind?.bb,
      sma50: ind?.sma50, sma200: ind?.sma200, ema20: ind?.ema20,
      atr:  ind?.atr,
      maSignals: ta.maSignals,
    },
    supportResistance: ta.supportResistance,
    volume:      ta.volume,
    priceAction: p,
    interpretation,
    dataPoints:  ta.dataPoints,
    source:      'market-data provider chain (/api/chart; may be delayed)',
  }
}

async function executeGetFundamentals({ symbol }) {
  return fetchAllFundamentals(symbol.toUpperCase().trim())
}

async function executeCompareStocks({ symbols, range = '1y' }) {
  const results = await Promise.all(
    symbols.map(async s => {
      try { return await executeTechnicalAnalysis({ symbol: s, range }) }
      catch (e) { return { symbol: s.toUpperCase(), error: e.message } }
    })
  )

  // Build comparison matrix
  const validResults = results.filter(r => !r.error)
  const comparison = {
    symbols: symbols.map(s => s.toUpperCase()),
    bySymbol: Object.fromEntries(results.map(r => [r.symbol, r])),
    relativeStrength: validResults
      .map(r => ({
        symbol: r.symbol,
        changePct:     r.quote?.changePct,
        rsi:           r.indicators?.rsi?.value,
        macdTrend:     r.indicators?.macd?.trend,
        aboveSMA200:   r.indicators?.maSignals?.includes('above_sma200'),
        goldenCross:   r.indicators?.maSignals?.includes('golden_cross_zone'),
        relVol:        r.volume?.relativeVolume,
      }))
      .sort((a, b) => (b.changePct || 0) - (a.changePct || 0)),
  }

  return { timestamp: new Date().toISOString(), comparison }
}

// ── System prompt (multi-specialist TradingAgents pattern) ────────────────────

const SYSTEM_PROMPT = `You are FinSurf AI — a multi-specialist stock analyst team embodied in one model.
You have access to three tools and adopt different analyst personas depending on which tool results you're interpreting:

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔬 TECHNICAL ANALYST (get_technical_analysis)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Focus: price action, trend, momentum, chart structure.
- Interpret RSI, MACD histogram, Bollinger Band position precisely
- Identify trend using SMA50/200 alignment and price location
- Quote ATR for stop-loss sizing (e.g. "1.5× ATR = $X stop from entry")
- Identify the nearest support and resistance levels with significance
- Comment on volume confirmation or divergence

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 FUNDAMENTAL ANALYST (get_fundamentals)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Focus: valuation, profitability, growth, balance sheet.
- Compare P/E, EV/EBITDA, P/B vs sector norms
- Flag DCF discount/premium to current price
- Highlight margin trends (expanding/contracting)
- Note debt risk (D/E > 2× is elevated; interest coverage < 3× is risky)
- Summarise analyst estimate vs recent earnings trend

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📰 SENTIMENT ANALYST (get_fundamentals — news/insider data)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Focus: news flow, insider activity, market narrative.
- Summarise bullish vs bearish article ratio with key headlines
- Flag insider buys > sells (bullish signal) or sells > buys (bearish)
- Note sentiment divergence from price (e.g. bearish news but stock rising = strength)

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
⚖️ RISK MANAGER (final synthesis after all tool results)
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
After gathering all analyst reports, always produce a structured briefing:

**Executive Summary** — 2-3 sentences: overall signal (Bullish/Bearish/Neutral), conviction level, and the single most important factor.

**Technical Picture** — trend, key levels, indicator signals in bullets

**Fundamental Context** — valuation verdict, growth quality, any red flags

**Sentiment & Catalysts** — news tone, insider activity, upcoming events

**Trade Hypothesis**
- Bias: [Bullish / Bearish / Neutral]
- Entry zone: $X – $Y
- Target 1: $Z (R/R: X:1)  |  Target 2: $W
- Stop loss: $V (based on ATR or key support)
- Risk/Reward: X:1

**Key Risks** — 3 bullet points of specific risks to the thesis

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
RULES:
- ALWAYS call get_technical_analysis before forming any view on a stock
- For value/growth questions, ALSO call get_fundamentals
- For comparisons, call compare_stocks (it fetches all symbols at once)
- Never guess prices or indicator values — use the tools
- If a data source is unavailable, note it clearly and work with what you have
- In the Trade Hypothesis write ONE dollar figure per level line exactly as labelled (Bias / Entry zone / Target 1 / Stop loss). A long needs stop < entry < target; a bearish view is a short (target below entry, stop above). Bias Neutral means no trade: give no levels. Code checks the plan after you answer and shows the user its verdict, so state no win probability or expected value yourself
- Price data comes from the app's market-data providers and may be delayed; never call it real-time
- End every analysis with: "⚠️ Not financial advice — do your own research."

${UNTRUSTED_POLICY} The get_fundamentals result (news headlines, insider filings, company text) arrives fenced this way.

Current data sources: the app's market-data providers (may be delayed) · FMP · Alpha Vantage`

// ── Prior calls, settled in code ──────────────────────────────────────────────
// Each saved summary starts with a tag naming the call and the price it was
// made at, so the next analysis of the symbol is shown what HAPPENED (settled
// against today's price, lib/settled-memory.js) rather than only what was
// said — raw past text invites the model to repeat itself.
const CALL_TAG = /^\[\[call (BULLISH|BEARISH|NEUTRAL) @ ([\d.]+)\]\]\s*/
const SIGNAL_OF = { BULLISH: 'BUY', BEARISH: 'SELL', NEUTRAL: 'HOLD' }

async function currentPrice(sym) {
  try {
    const port = process.env.PORT || 3001
    const r = await fetch(`http://127.0.0.1:${port}/api/quote?symbols=${encodeURIComponent(sym)}`, { signal: AbortSignal.timeout(5000) })
    const p = (await r.json())?.quoteResponse?.result?.[0]?.regularMarketPrice
    return p > 0 ? p : null
  } catch { return null }
}

async function priorCallsBlock(userId, sym) {
  const chats = await getChatHistory(userId, sym)
  const calls = chats.map(c => {
    const m = String(c.summary || '').match(CALL_TAG)
    return m && { signal: SIGNAL_OF[m[1]], price: Number(m[2]), created_at: c.created_at, summary: c.summary.replace(CALL_TAG, '') }
  }).filter(Boolean)
  if (!calls.length) return ''
  const px = await currentPrice(sym)
  if (!px) return ''
  const block = memoryBlock(sym, settleMemories(calls, px), null, px)
  return block ? `\n\n${block}` : ''
}

// ── The answer's trade plan, checked by code ─────────────────────────────────
// The symbol is the request's, else the one symbol the agent looked up. The
// check is sent to the UI before 'done', and a directional plan is recorded
// so the AI Agent's calls are scored like every other surface's.
function checkAnswer(text, { sym, prices, userId }) {
  const plan = planCheck.parseTradeHypothesis(text)
  const planSym = sym || (prices.size === 1 ? [...prices.keys()][0] : null)
  if (!plan || !planSym) return null
  // A bias with no levels at all (a quick signal) is an opinion, not a plan.
  if (plan.side && !plan.entry && !plan.target && !plan.stop) return null
  const price = prices.get(planSym) ?? null
  const assetType = isCryptoSymbol(planSym) ? 'crypto' : 'stock'
  const check = planCheck.checkPlan({ side: plan.side, entry: plan.entry, target: plan.target, stop: plan.stop, price, assetType, winProb: planCheck.winProbFor(assetType) })
  planCheck.recordPlan({ surface: 'ai-agent', symbol: planSym, check, price, meta: { userId: userId ?? null, bias: plan.bias } })
  return { symbol: planSym, price, bias: plan.bias, ...check, line: planCheck.describeCheck(check) }
}

function callTag(check) {
  return check?.price > 0 && check.bias ? `[[call ${check.bias.toUpperCase()} @ ${check.price}]] ` : ''
}

// ── POST /api/agent/analyze ───────────────────────────────────────────────────

// Signed-in only: each question can run Claude for up to six rounds, and
// without a user the prior-analysis memory below never loaded or saved.
router.post('/analyze', requireAuth, async (req, res) => {
  const { prompt, symbol, history = [], model: reqModel } = req.body || {}
  if (!prompt) return res.status(400).json({ error: 'prompt is required' })

  const model    = reqModel || 'claude-opus-4-5'
  if (!ALLOWED_MODELS.has(model)) return res.status(400).json({ error: `Unsupported model: ${model}` })
  const isGemini = model.startsWith('gemini')

  // SSE headers
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')

  const send = (event, data) => res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`)

  const userId = req.user?.userId
  const sym    = symbol?.toUpperCase().trim() || null
  const prices = new Map()   // symbol → price the tools served, for the plan check

  // ── Gemini path ─────────────────────────────────────────────────────────────
  if (isGemini) {
    try {
      let contextData = ''
      if (symbol) {
        const sym = symbol.toUpperCase().trim()
        send('tool_start', { name: 'get_technical_analysis', input: { symbol: sym } })
        try {
          const ta = await executeTechnicalAnalysis({ symbol: sym })
          if (ta?.quote?.price > 0) prices.set(sym, ta.quote.price)
          contextData = `\n\nTechnical data for ${sym} (from the market-data providers; may be delayed):\n${JSON.stringify(ta, null, 2)}`
          send('tool_end', { name: 'get_technical_analysis', symbol: sym })
        } catch (e) {
          send('tool_error', { name: 'get_technical_analysis', error: e.message })
        }
      }

      const abortCtrl = new AbortController()
      req.on('close', () => abortCtrl.abort())

      const msgs = [
        ...history.slice(-10).map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: symbol ? `Analyze ${symbol.toUpperCase()}. ${prompt}` : prompt },
      ]

      let fullText = ''
      for await (const text of streamGemini(model, SYSTEM_PROMPT + contextData, msgs, abortCtrl.signal)) {
        fullText += text
        send('delta', { text })
      }
      const check = checkAnswer(fullText, { sym, prices, userId })
      if (check) send('plan_check', { check })
      if (userId && sym && fullText) saveChatSummary(userId, sym, callTag(check) + fullText.slice(0, 900))
      send('done', {})
      res.end()
    } catch (err) {
      console.error('[Agent/Gemini] Error:', err.message)
      if (!res.headersSent) return res.status(500).json({ error: err.message })
      send('error', { message: err.message })
      res.end()
    }
    return
  }

  // ── Anthropic path (all non-Gemini models) ─────────────────────────────────
  let client
  try { client = getClient() }
  catch (err) { return res.status(503).json({ error: err.message, code: 'NO_API_KEY' }) }

  // SYSTEM_PROMPT (with TOOLS ahead of it) is the cached prefix; the user's
  // prior calls on the symbol are per-user, so they follow the cache mark.
  const priorBlock = userId && sym ? await priorCallsBlock(userId, sym) : ''

  const userContent = symbol ? `Analyze ${symbol.toUpperCase()}. ${prompt}` : prompt

  const messages = [
    ...history.slice(-10).map(m => ({ role: m.role, content: m.content })),
    { role: 'user', content: userContent },
  ]

  let iteration = 0
  const MAX_ITERATIONS = 6

  try {
    while (iteration < MAX_ITERATIONS) {
      iteration++

      const stream = client.messages.stream({
        model,
        max_tokens: 8192,
        system:     cachedSystem(SYSTEM_PROMPT, priorBlock),
        tools:      TOOLS,
        messages:   markConversationTail(messages),
      })

      let fullText = ''
      stream.on('text', text => { fullText += text; send('delta', { text }) })

      const message = await stream.finalMessage()

      if (message.stop_reason === 'end_turn') {
        const check = checkAnswer(fullText, { sym, prices, userId })
        if (check) send('plan_check', { check })
        if (userId && sym && fullText) saveChatSummary(userId, sym, callTag(check) + fullText.slice(0, 900))
        send('done', { usage: { input_tokens: message.usage?.input_tokens, output_tokens: message.usage?.output_tokens } })
        res.end()
        return
      }

      if (message.stop_reason === 'tool_use') {
        const toolUses = message.content.filter(b => b.type === 'tool_use')
        if (!toolUses.length) { send('done', {}); res.end(); return }

        messages.push({ role: 'assistant', content: message.content })

        const toolResults = await Promise.all(
          toolUses.map(async tu => {
            send('tool_start', { name: tu.name, input: tu.input })
            try {
              let result
              switch (tu.name) {
                case 'get_technical_analysis':
                  result = await executeTechnicalAnalysis(tu.input)
                  if (result?.quote?.price > 0) prices.set(result.symbol, result.quote.price)
                  send('tool_end', { name: tu.name, symbol: tu.input.symbol })
                  break
                case 'get_fundamentals':
                  result = await executeGetFundamentals(tu.input)
                  send('tool_end', { name: tu.name, symbol: tu.input.symbol })
                  break
                case 'compare_stocks':
                  result = await executeCompareStocks(tu.input)
                  for (const r of Object.values(result?.comparison?.bySymbol ?? {}))
                    if (r?.quote?.price > 0) prices.set(r.symbol, r.quote.price)
                  send('tool_end', { name: tu.name, symbols: tu.input.symbols })
                  break
                default:
                  result = { error: `Unknown tool: ${tu.name}` }
              }
              // Fundamentals carry news headlines, insider names and company
              // text written by third parties: fenced as data, never instructions.
              const content = tu.name === 'get_fundamentals'
                ? wrapUntrusted(JSON.stringify(result), 'FMP / Alpha Vantage', { label: 'fundamentals, news and insider filings' }) || '{}'
                : JSON.stringify(result)
              return { type: 'tool_result', tool_use_id: tu.id, content }
            } catch (err) {
              send('tool_error', { name: tu.name, error: err.message })
              return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify({ error: err.message }), is_error: true }
            }
          })
        )

        messages.push({ role: 'user', content: toolResults })
        continue
      }

      send('done', {})
      res.end()
      return
    }

    send('error', { message: 'Agent reached maximum iterations.' })
    res.end()
  } catch (err) {
    const isOverloaded = err.status === 529 || err.message?.includes('overloaded')
    if (isOverloaded && process.env.GROQ_API_KEY) {
      console.warn('[Agent] Claude overloaded, falling back to Groq')
      try {
        send('delta', { text: `\n\n*[Claude is busy — switching to Groq (${GROQ_MODEL})...]*\n\n` })
        const abortCtrl = new AbortController()
        req.on('close', () => abortCtrl.abort())
        const msgs = [
          ...history.slice(-10).map(m => ({ role: m.role, content: m.content })),
          { role: 'user', content: symbol ? `Analyze ${symbol.toUpperCase()}. ${prompt}` : prompt },
        ]
        let fullText = ''
        for await (const text of streamGroq(SYSTEM_PROMPT, msgs, abortCtrl.signal)) {
          fullText += text
          send('delta', { text })
        }
        const check = checkAnswer(fullText, { sym, prices, userId })
        if (check) send('plan_check', { check })
        send('done', {})
        res.end()
        return
      } catch (groqErr) {
        console.error('[Agent/Groq] Error:', groqErr.message)
        send('error', { message: groqErr.message })
        res.end()
        return
      }
    }
    console.error('[Agent] Error:', err.message)
    if (!res.headersSent) return res.status(500).json({ error: err.message })
    send('error', { message: err.message })
    res.end()
  }
})

// ── GET /api/agent/health ─────────────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.json({
    ok:         true,
    hasKey:     !!process.env.ANTHROPIC_API_KEY,
    hasFMP:     !!process.env.FMP_API_KEY,
    hasAV:      !!process.env.ALPHA_VANTAGE_API_KEY,
    hasFinnhub: !!process.env.FINNHUB_API_KEY,
    hasGemini:  !!process.env.GEMINI_API_KEY,
    hasGroq:    !!process.env.GROQ_API_KEY,
    tools:      TOOLS.map(t => t.name),
  })
})

module.exports = router
