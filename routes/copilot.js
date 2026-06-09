'use strict'
/**
 * routes/copilot.js
 *
 * POST /api/copilot/chat  — streaming agentic copilot chat (SSE)
 *
 * Multi-provider agentic copilot inspired by claudian (YishenTu/claudian)
 * Conversation.providerId + providerState architecture — one conversation
 * model that routes to the right LLM backend cleanly.
 *
 * Supported providers:
 *   claude  — Anthropic claude-sonnet-4-6 (tool_use, native streaming)
 *   groq    — Groq llama-3.3-70b (OpenAI-compat function calling)
 *   codex   — OpenAI GPT-4o (OpenAI-compat function calling)
 *
 * Body: { messages, portfolio, watchlist, providerId?, providerState? }
 *   providerId:   'claude' | 'groq' | 'codex'  (default: 'claude')
 *   providerState: { model?, baseUrl? }         (optional overrides)
 *
 * Streams back SSE events:
 *   data: { type: "text", delta: "..." }
 *   data: { type: "tool_start", tools: [{name, input}] }
 *   data: { type: "tool_results", results: [{tool, preview}] }
 *   data: { type: "done" }
 *   data: { type: "error", message: "..." }
 */

const express = require('express')
const rateLimit = require('express-rate-limit')
const Anthropic = require('@anthropic-ai/sdk')
const { getSocialSentiment } = require('../lib/social-sentiment')
const { getAltDataSnippet }  = require('../lib/alt-data')

// Use warm cache from scheduled-jobs if available, fall back to live fetch
async function getAltData(symbol) {
  try {
    const jobs = require('../lib/scheduled-jobs')
    const cached = jobs.getCachedAltData(symbol)
    if (cached) return cached
  } catch {}
  return getAltDataSnippet(symbol).catch(() => null)
}

const router = express.Router()
const anthropic = new Anthropic()

const chatLimit = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { error: 'Too many copilot requests — wait a minute' },
})

const COPILOT_SYSTEM = `You are MarketPulse, an autonomous financial intelligence agent embedded in FinSurfing — a real-time US equity and crypto trading platform.

Your mission: deliver timely, verified, and structured financial intelligence that helps users understand market dynamics, identify opportunities, and make informed decisions. Prioritize accuracy over speed, transparency over hype, and education over speculation.

## Live Tools Available
- scan_market: Run the 5-agent AI Brain to rank investment opportunities across stocks, ETFs, crypto (30+ scan universes, 3/6/12m horizons)
- get_earnings_catalyst: Upcoming earnings date, EPS estimate, analyst consensus, and last 4 quarters of EPS surprise history
- get_options_flow: Real-time options put/call ratio, implied volatility, and unusual activity (smart-money positioning signal)
- get_recommendations: Get personalized buy signals using a named investor persona (Buffett, Dalio, Lynch, Burry, Wood, Marks, Soros, Greenblatt, Munger)
- analyze_symbol: Deep technical + AI analysis — RSI, MACD, EMA9/21/50/200, Bollinger, VWAP, OBV, patterns, entry/stop/target zones
- get_social_sentiment: Real-time Reddit sentiment (r/wallstreetbets, r/stocks, r/investing) for up to 5 tickers
- get_macro: Current macroeconomic indicators (14 FRED series), regime assessment, rates/inflation/VIX/credit spreads

## Tool Routing Rules
- User asks about a specific ticker → call analyze_symbol first; ALWAYS add get_earnings_catalyst to check for imminent catalysts; add get_options_flow for directional conviction; add get_social_sentiment if sentiment is relevant
- User asks "top picks", "what to buy", "scan the market" → call scan_market
- User asks for strategy recommendations by persona → call get_recommendations
- User asks about macro, rates, inflation, VIX, regime → call get_macro
- User asks about sentiment on a ticker → call get_social_sentiment
- Combine tools when the query warrants it (e.g. analyze_symbol + get_social_sentiment for a full picture)

## Output Formats — Use These Templates

**Breaking News / Single Alert:**
🚨 [Headline] | ⏱️ [Time] | 📊 Impact: [price action] | 📝 [2-3 sentence summary] | ⚡ Why this matters: [context]

**Daily Brief (when asked for market overview):**
🌍 GLOBAL SNAPSHOT — [SPY/QQQ/crypto/macro one-liners]
📰 TOP STORIES — numbered list with source and impact
🔥 TRENDING TICKERS — symbol: why moving | Sentiment: Bullish/Neutral/Bearish
📅 EVENTS TODAY — earnings + macro releases
⚠️ RISK WATCH — emerging tail risk

**Deep Dive (when asked for full analysis):**
Executive Summary → Fundamental Analysis → Technical Picture → Sentiment & Flows → Valuation → Bull/Base/Bear cases → Risk/Reward

**Social Sentiment Report (when asked about social buzz):**
Platform breakdown → Sentiment score + trend → Narrative analysis → Manipulation risk flag

## Interaction Modes
- **Quick query**: direct answer with sources, concise
- **Research project**: multi-section report with methodology
- **Strategy evaluation**: classify risk level + time horizon + pro/con/risk + safer alternatives
- **Portfolio review**: monitor relevant news, flag concentration risks
- **Educational**: explain clearly with examples, no jargon gatekeeping

## Investment Strategy Classification
When evaluating strategies, always classify: risk level (Low/Medium/High/Very High/Extreme), time horizon, and data backing. Flag: recency bias, leverage risks, tail risk scenarios. Present bull and bear cases with equal rigor.

## Technical Analysis Protocol
- Multi-timeframe confirmation: check 1H, 4H, 1D, 1W for confluence
- Key levels: support/resistance, MA20/50/200, Fibonacci 38.2%/50%/61.8%
- Momentum: RSI overbought/oversold/divergence, MACD crossovers, volume confirmation
- Bridge TA with fundamentals: breakout + earnings catalyst = higher conviction

## Source & Data Transparency
Tools provide live data from: internal AI Brain (5 agents), Reddit APIs, FRED macro series, and Yahoo/Finnhub/FMP market data. Options flow, SEC filings, 13F, satellite data, and earnings calendars are not currently available — state this clearly rather than speculating.

## Guardrails (Non-Negotiable)
- Never provide personalized investment advice or tell users what to buy/sell
- Never guarantee returns or predict specific prices with certainty
- Never share unverified information as fact — label speculation explicitly
- Always end high-conviction outputs with: "Not financial advice — consult a qualified professional. Past performance does not guarantee future results."
- Present both bull and bear cases; surface contradictions and risks
- Format numbers: prices in $, percentages with %, scores /100
- Respect the user's portfolio — avoid suggesting stocks they already hold

## CRITICAL — Real-Time Data Rules
- NEVER quote a stock price, support level, resistance level, or price target from your training data
- ALL price references MUST come from the analyze_symbol tool result — the tool fetches live market data
- If a user asks about a specific ticker, you MUST call analyze_symbol FIRST before saying anything about price levels
- The tool result includes "Current Price" — always use that exact figure, never a memorized price
- Your training data prices are months or years out of date — using them will mislead users`

const TOOLS = [
  {
    name: 'scan_market',
    description: 'Scan the market using the 5-agent AI Brain and rank top investment opportunities. Returns ranked picks with composite scores, entry zones, and thesis.',
    input_schema: {
      type: 'object',
      properties: {
        scanMode: {
          type: 'string',
          description: 'Scan universe: broad, stocks, stocks_tech, stocks_finance, stocks_healthcare, stocks_energy, etfs_broad, etfs_sector, etfs_bond, etfs_commodity, etfs_thematic, crypto, crypto_l1, crypto_defi, crypto_ai, mutualfunds',
          default: 'broad',
        },
        horizon: {
          type: 'string',
          enum: ['3m', '6m', '12m'],
          description: 'Investment time horizon',
          default: '6m',
        },
      },
    },
  },
  {
    name: 'get_recommendations',
    description: 'Get AI buy signal recommendations styled by a named investor persona. Returns 20 picks with entry, target, stop, and thesis.',
    input_schema: {
      type: 'object',
      properties: {
        persona: {
          type: 'string',
          enum: ['default', 'buffett', 'munger', 'lynch', 'dalio', 'burry', 'wood', 'marks', 'soros', 'greenblatt'],
          description: 'Investor persona to channel',
          default: 'default',
        },
        focusSymbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: specific symbols to focus on (e.g. ["NVDA", "TSLA"])',
        },
      },
    },
  },
  {
    name: 'analyze_symbol',
    description: 'Deep technical and AI analysis for a specific ticker. Returns signal (BUY/SELL/HOLD), entry zone, stop loss, take profit, and reasoning.',
    input_schema: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: {
          type: 'string',
          description: 'Ticker symbol (e.g. AAPL, BTC-USD, SPY)',
        },
        interval: {
          type: 'string',
          enum: ['1h', '4h', '1d', '1wk'],
          description: 'Chart interval for technical analysis',
          default: '1d',
        },
      },
    },
  },
  {
    name: 'get_social_sentiment',
    description: 'Fetch real-time Reddit/social sentiment for up to 5 tickers. Returns mention counts, bullish/bearish breakdown, and top community posts.',
    input_schema: {
      type: 'object',
      required: ['symbols'],
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of ticker symbols (max 5)',
        },
      },
    },
  },
  {
    name: 'get_macro',
    description: 'Get current macroeconomic indicators: interest rates, inflation, labor market, GDP, VIX, credit spreads, and AI-generated regime assessment.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_earnings_catalyst',
    description: 'Get upcoming earnings date, EPS estimate, analyst consensus, and last 4 quarters of EPS surprise history for a ticker. Use this before analyzing any stock to check if an earnings catalyst is imminent.',
    input_schema: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL, NVDA)' },
      },
    },
  },
  {
    name: 'get_options_flow',
    description: 'Get real-time options market data: put/call ratio, implied volatility, and unusual options activity (large bets vs open interest). Strong signal for smart-money positioning 1–3 weeks ahead.',
    input_schema: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL, TSLA)' },
      },
    },
  },
]

// ── Internal tool dispatcher ──────────────────────────────────────────────────

async function dispatchTool(name, input, req) {
  const port = process.env.PORT || 3001
  const fwdHeaders = { 'Content-Type': 'application/json', 'x-internal': '1' }
  for (const k of ['x-aisa-key', 'x-finnhub-key', 'x-fmp-key', 'x-td-key', 'x-av-key']) {
    if (req.headers[k]) fwdHeaders[k] = req.headers[k]
  }

  switch (name) {
    case 'scan_market': {
      const r = await fetch(`http://127.0.0.1:${port}/api/ai-brain/analyze`, {
        method: 'POST', headers: fwdHeaders,
        body: JSON.stringify({ scanMode: input.scanMode || 'broad', horizon: input.horizon || '6m' }),
        signal: AbortSignal.timeout(90_000),
      })
      const data = await r.json()
      if (!data.rankedStocks) return `Scan failed: ${data.error || 'unknown error'}`
      const top = data.rankedStocks.slice(0, 8)
      return (
        `Market Regime: ${data.marketRegime} · ${data.macroOutlook}\n\n` +
        top.map((s, i) =>
          `${i + 1}. **${s.symbol}** — ${s.agentVerdict} (score ${s.compositeScore}/100)\n` +
          `   Entry $${s.entryZoneLow}–$${s.entryZoneHigh} · Target $${s.targetZoneLow}–$${s.targetZoneHigh} · Stop $${s.stopZoneLow}–$${s.stopZoneHigh}\n` +
          `   ${s.supervisorSynthesis}\n` +
          (s.agentConflict?.exists ? `   ⚠️ Conflict: ${s.agentConflict.meaning}` : '')
        ).join('\n')
      )
    }

    case 'get_recommendations': {
      const r = await fetch(`http://127.0.0.1:${port}/api/recommendations`, {
        method: 'POST', headers: fwdHeaders,
        body: JSON.stringify({ persona: input.persona || 'default', focusSymbols: input.focusSymbols || [] }),
        signal: AbortSignal.timeout(60_000),
      })
      const data = await r.json()
      if (!data.recommendations) return `Failed: ${data.error || 'unknown error'}`
      const top = data.recommendations.slice(0, 6)
      return (
        `**${data.persona?.name || 'AI'} Recommendations** · ${data.marketOutlook}\n\n` +
        top.map((rec, i) =>
          `${i + 1}. **${rec.symbol}** (${rec.type}, ${rec.period}) — ${rec.risk} risk\n` +
          `   Entry $${rec.entryPrice} · Target $${rec.takeProfitPrice} (+${rec.targetReturn}%) · Stop $${rec.stopLossPrice} (-${rec.stopLoss}%)\n` +
          `   ${rec.thesis}\n` +
          `   Catalyst: ${rec.catalyst}`
        ).join('\n\n')
      )
    }

    case 'analyze_symbol': {
      const sym = encodeURIComponent(input.symbol || '')
      const interval = input.interval || '1d'

      // Pre-fetch live quote so trading-analysis uses current price, not stale bar close
      let clientLivePrice = null
      try {
        const qr = await fetch(
          `http://127.0.0.1:${port}/api/quote?symbols=${sym}`,
          { headers: fwdHeaders, signal: AbortSignal.timeout(5000) }
        )
        const qd = await qr.json()
        const lp = qd?.quoteResponse?.result?.[0]?.regularMarketPrice
        if (lp && lp > 0) clientLivePrice = lp
      } catch { /* proceed without live price */ }

      const [r, altSnippet] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/trading-analysis/analyze?symbol=${sym}&interval=${interval}`, {
          method: 'POST', headers: fwdHeaders,
          body: JSON.stringify({ clientLivePrice }),
          signal: AbortSignal.timeout(30_000),
        }),
        getAltData(input.symbol || ''),
      ])
      const data = await r.json()
      if (!data.signal) return `Analysis failed for ${input.symbol}: ${data.error || 'unknown error'}`
      const livePrice = clientLivePrice || data.entry
      return (
        `**${input.symbol}** [LIVE PRICE: $${livePrice}] — Signal: **${data.signal}** (${data.confidence}% confidence)\n` +
        `Current Price: $${livePrice} (use THIS price — do not use any other price)\n` +
        `Trend: ${data.trend} · Risk/Reward: ${data.riskReward?.toFixed(1)}:1\n` +
        `Entry $${data.entry} (zone $${data.entryZoneLow}–$${data.entryZoneHigh})\n` +
        `Stop $${data.stopLoss} · Target $${data.takeProfit?.[0]}–$${data.takeProfit?.[1]}\n\n` +
        `${data.reasoning}\n\n` +
        (data.contradictions?.length ? `⚠️ Contradictions: ${data.contradictions.join('; ')}\n` : '') +
        `Risks: ${data.risks?.join(' | ')}` +
        (altSnippet ? `\n${altSnippet}` : '')
      )
    }

    case 'get_social_sentiment': {
      const symbols = (input.symbols || []).slice(0, 5)
      const snippet = await getSocialSentiment(symbols)
      return snippet || 'No Reddit data available for these symbols right now.'
    }

    case 'get_macro': {
      const r = await fetch(`http://127.0.0.1:${port}/api/macro/summary`, {
        headers: fwdHeaders,
        signal: AbortSignal.timeout(15_000),
      })
      const data = await r.json()
      return typeof data === 'string' ? data : (data.summary || JSON.stringify(data))
    }

    case 'get_earnings_catalyst': {
      const sym = (input.symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '')
      if (!sym) return 'No symbol provided.'

      // Fetch upcoming date + EPS surprise history in parallel
      const [dateRes, surpriseRes] = await Promise.allSettled([
        fetch(`http://127.0.0.1:${port}/api/earnings/date?symbol=${sym}`, {
          headers: fwdHeaders, signal: AbortSignal.timeout(10_000),
        }).then(r => r.json()),
        fetch(`http://127.0.0.1:${port}/api/earnings/positioning?symbols=${sym}`, {
          headers: fwdHeaders, signal: AbortSignal.timeout(12_000),
        }).then(r => r.json()),
      ])

      const dateData     = dateRes.status === 'fulfilled'     ? dateRes.value     : null
      const surpriseData = surpriseRes.status === 'fulfilled' ? surpriseRes.value : null
      const surprise     = surpriseData?.results?.[0] || surpriseData?.[0] || null

      const daysUntil = dateData?.nextEarningsDate
        ? Math.round((new Date(dateData.nextEarningsDate) - Date.now()) / 86400000)
        : null

      let lines = [`**${sym} Earnings Catalyst**`]

      if (dateData?.nextEarningsDate) {
        lines.push(`📅 Next Earnings: ${dateData.nextEarningsDate} (in ${daysUntil} days)`)
        if (daysUntil <= 14) lines.push(`⚠️ IMMINENT — earnings in ≤14 days; elevated volatility risk`)
      } else {
        lines.push('📅 Next Earnings: Date not yet confirmed')
      }

      if (dateData?.epsEstimate) lines.push(`EPS Estimate: $${dateData.epsEstimate}`)
      if (dateData?.revenueEstimate) lines.push(`Revenue Estimate: ${dateData.revenueEstimate}`)

      if (surprise) {
        const beatRate = surprise.beat_rate != null
          ? `${Math.round(surprise.beat_rate * 100)}% (${surprise.beat_count}/${surprise.total_quarters} quarters)`
          : 'N/A'
        const avgSurprise = surprise.avg_eps_surprise_pct != null
          ? `${surprise.avg_eps_surprise_pct > 0 ? '+' : ''}${surprise.avg_eps_surprise_pct.toFixed(1)}%`
          : 'N/A'

        lines.push(`\nEPS Beat Rate (last ${surprise.total_quarters}q): ${beatRate}`)
        lines.push(`Avg EPS Surprise: ${avgSurprise}`)

        if (surprise.recent_quarters?.length) {
          lines.push('\nRecent EPS History:')
          surprise.recent_quarters.slice(0, 4).forEach(q => {
            if (!q.period) return
            const sp = q.surprise_pct != null
              ? ` (${q.surprise_pct > 0 ? '+' : ''}${q.surprise_pct.toFixed(1)}% surprise)`
              : ''
            lines.push(`  ${q.period}: actual $${q.actual ?? '?'} vs est $${q.estimate ?? '?'}${sp}`)
          })
        }
      }

      // Catalyst interpretation
      if (daysUntil != null && daysUntil <= 21 && surprise?.avg_eps_surprise_pct > 5) {
        lines.push('\n📊 Signal: Strong historical beat rate + imminent earnings = high-probability catalyst. Consider position sizing carefully.')
      } else if (daysUntil != null && daysUntil <= 7) {
        lines.push('\n📊 Signal: Earnings very close — options IV typically elevated. High binary risk event.')
      }

      return lines.join('\n') || `No earnings data available for ${sym}.`
    }

    case 'get_options_flow': {
      const sym = (input.symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '')
      if (!sym) return 'No symbol provided.'
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/options/flow?symbol=${sym}`, {
          headers: fwdHeaders, signal: AbortSignal.timeout(12_000),
        })
        if (!r.ok) return `Options data unavailable for ${sym} (HTTP ${r.status})`
        const data = await r.json()
        return data.snippet || JSON.stringify(data)
      } catch (e) {
        return `Options flow fetch failed for ${sym}: ${e.message}`
      }
    }

    default:
      return `Unknown tool: ${name}`
  }
}

// ── Planner: detect ticker deep-analysis queries ──────────────────────────────
// Returns the ticker symbol if the last user message is a deep-analysis request,
// null otherwise. Used to trigger the parallel pre-fetch fast path.
const DEEP_ANALYSIS_RE = /\b(analyz[ei]|analysis|check|look at|deep dive|research|breakdown|full report|what do you think of|should i buy|should i sell|tell me about|thesis on|outlook for|price target)\b/i
const TICKER_RE = /\b([A-Z]{1,5}(?:-USD)?)\b/g

function detectTickerQuery(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUser) return null
  const text = typeof lastUser.content === 'string' ? lastUser.content : ''
  if (!DEEP_ANALYSIS_RE.test(text)) return null
  const tickers = [...text.matchAll(TICKER_RE)].map(m => m[1])
  // Filter out common English words that look like tickers
  const SKIP = new Set(['A','I','AM','AN','AT','BE','BY','DO','GO','IF','IN','IS','IT','ME','MY','NO','OF','ON','OR','SO','TO','UP','US','WE','AND','ARE','FOR','HAS','NOT','THE','WAS'])
  const valid = tickers.filter(t => !SKIP.has(t))
  return valid.length === 1 ? valid[0] : null
}

// Run all analysis tools in parallel for a ticker — DeerFlow-style Planner step
async function runPlannerPrefetch(ticker, req, send) {
  send({ type: 'tool_start', tools: [
    { name: 'analyze_symbol',       input: { symbol: ticker } },
    { name: 'get_earnings_catalyst', input: { symbol: ticker } },
    { name: 'get_options_flow',      input: { symbol: ticker } },
    { name: 'get_social_sentiment',  input: { symbols: [ticker] } },
  ]})

  const [technical, earnings, options, social] = await Promise.allSettled([
    dispatchTool('analyze_symbol',        { symbol: ticker },       req),
    dispatchTool('get_earnings_catalyst', { symbol: ticker },       req),
    dispatchTool('get_options_flow',      { symbol: ticker },       req),
    dispatchTool('get_social_sentiment',  { symbols: [ticker] },    req),
  ])

  send({ type: 'tool_results', results: [
    { tool: 'analyze_symbol',       preview: technical.value?.slice?.(0, 100) },
    { tool: 'get_earnings_catalyst', preview: earnings.value?.slice?.(0, 100) },
    { tool: 'get_options_flow',      preview: options.value?.slice?.(0, 100) },
    { tool: 'get_social_sentiment',  preview: social.value?.slice?.(0, 100) },
  ]})

  return {
    technical:  technical.status  === 'fulfilled' ? technical.value  : null,
    earnings:   earnings.status   === 'fulfilled' ? earnings.value   : null,
    options:    options.status    === 'fulfilled' ? options.value    : null,
    social:     social.status     === 'fulfilled' ? social.value     : null,
  }
}

const REPORTER_SYSTEM = `You are a senior equity analyst synthesising pre-fetched live data into a structured investment report.

You have been given live tool results. Do NOT call any tools — all data is already provided in the user message.

Produce a concise structured report using this format:

## [TICKER] — [BUY/SELL/HOLD] Signal

**Current Price:** $X · **Confidence:** X%

### Technical Picture
[3-4 sentences from the technical analysis data]

### Earnings Catalyst
[Next earnings date, EPS estimate, surprise history — flag if imminent]

### Options Flow
[P/C ratio interpretation, ATM IV, any unusual activity and what it implies]

### Social Sentiment
[Reddit upvote-weighted signal + Polymarket odds if available]

### Verdict
[2-3 sentences: bull case, bear case, risk/reward. Entry zone and stop.]

---
*Not financial advice. All data is live as of analysis time.*`

// ── Provider registry (claudian-style providerId + providerState) ─────────────

const PROVIDER_DEFAULTS = {
  claude: { model: 'claude-sonnet-4-6' },
  groq:   { model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' },
  codex:  { model: 'gpt-4o',                  baseUrl: 'https://api.openai.com/v1' },
}

// Convert Anthropic tool format → OpenAI function calling format
function toOpenAITools(tools) {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
}

// Convert messages to OpenAI format (flatten Anthropic content blocks)
function toOpenAIMessages(system, messages) {
  const out = system ? [{ role: 'system', content: system }] : []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
    } else if (Array.isArray(m.content)) {
      // Anthropic content blocks → OpenAI
      const textParts = m.content.filter(b => b.type === 'text').map(b => b.text).join('')
      const toolResults = m.content.filter(b => b.type === 'tool_result')
      if (toolResults.length) {
        for (const tr of toolResults) {
          out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content) })
        }
      } else if (m.role === 'assistant') {
        // Check for tool_use blocks
        const toolUses = m.content.filter(b => b.type === 'tool_use')
        if (toolUses.length) {
          out.push({
            role: 'assistant',
            content: textParts || null,
            tool_calls: toolUses.map(tu => ({
              id: tu.id, type: 'function',
              function: { name: tu.name, arguments: JSON.stringify(tu.input) },
            })),
          })
        } else {
          if (textParts) out.push({ role: m.role, content: textParts })
        }
      } else {
        if (textParts) out.push({ role: m.role, content: textParts })
      }
    }
  }
  return out
}

/**
 * Run one agentic turn using an OpenAI-compatible provider (Groq, Codex).
 * Non-streaming for simplicity; we fake-stream the text back word by word.
 */
async function runOpenAITurn({ model, baseUrl, apiKey, system, messages, tools, send, dispatchFn, req, maxIter = 5 }) {
  const oaiTools = toOpenAITools(tools)
  let loopMessages = toOpenAIMessages(system, messages)
  let iterations = 0

  while (iterations < maxIter) {
    iterations++
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: loopMessages, tools: oaiTools, tool_choice: 'auto', max_tokens: 4096 }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!r.ok) {
      const err = await r.text()
      throw new Error(`Provider error ${r.status}: ${err.slice(0, 200)}`)
    }
    const data = await r.json()
    const choice = data.choices?.[0]
    const msg = choice?.message

    // Stream text back word by word for UX parity with Claude streaming
    if (msg?.content) {
      const words = msg.content.split(/(\s+)/)
      for (const w of words) send({ type: 'text', delta: w })
    }

    // Handle tool calls
    const toolCalls = msg?.tool_calls || []
    if (!toolCalls.length) break

    send({ type: 'tool_start', tools: toolCalls.map(tc => ({ name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') })) })

    const toolResults = await Promise.all(toolCalls.map(async tc => {
      let parsed = {}
      try { parsed = JSON.parse(tc.function.arguments || '{}') } catch {}
      try {
        const output = await dispatchFn(tc.function.name, parsed, req)
        return { role: 'tool', tool_call_id: tc.id, content: output }
      } catch (err) {
        return { role: 'tool', tool_call_id: tc.id, content: `Error: ${err.message}` }
      }
    }))

    send({ type: 'tool_results', results: toolResults.map(tr => ({ tool: tr.tool_call_id, preview: tr.content?.slice?.(0, 120) })) })

    loopMessages.push({
      role: 'assistant',
      content: msg.content || null,
      tool_calls: toolCalls,
    })
    loopMessages.push(...toolResults)
  }
}

// ── SSE streaming chat handler ─────────────────────────────────────────────────

router.post('/chat', chatLimit, async (req, res) => {
  const { messages = [], portfolio = [], watchlist = [], providerId = 'claude', providerState = {} } = req.body

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  try {
    const contextBlock = (portfolio.length || watchlist.length)
      ? `\nUser context — Portfolio: ${portfolio.join(', ') || 'none'} · Watchlist: ${watchlist.join(', ') || 'none'}`
      : ''

    const systemPrompt = COPILOT_SYSTEM + contextBlock

    // ── Route to the correct provider ──────────────────────────────────────────
    const providerKey = (providerId || 'claude').toLowerCase()
    const defaults = PROVIDER_DEFAULTS[providerKey] || PROVIDER_DEFAULTS.claude
    const model = providerState.model || defaults.model
    const baseUrl = providerState.baseUrl || defaults.baseUrl

    if (providerKey === 'groq' || providerKey === 'codex') {
      const apiKey = providerKey === 'groq' ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY
      if (!apiKey) {
        send({ type: 'error', message: `${providerKey} API key not configured on server` })
        res.end(); return
      }
      await runOpenAITurn({
        model, baseUrl, apiKey, system: systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        tools: TOOLS, send, dispatchFn: dispatchTool, req, maxIter: 5,
      })
      send({ type: 'done' })
      res.end(); return
    }

    // ── Claude provider (default) — native streaming tool_use ──────────────────

    // Planner fast-path: for single-ticker deep analysis, pre-fetch all tools in
    // parallel (DeerFlow-style), inject results as context so Claude synthesises
    // in one shot rather than 3-4 sequential tool-use rounds.
    let loopMessages = messages.map(m => ({ role: m.role, content: m.content }))
    const plannerTicker = detectTickerQuery(messages)
    if (plannerTicker) {
      const data = await runPlannerPrefetch(plannerTicker, req, send)
      const contextMsg = [
        `LIVE PRE-FETCHED DATA FOR ${plannerTicker} (all tools already executed in parallel):`,
        data.technical  ? `\n=== TECHNICAL ANALYSIS ===\n${data.technical}`   : '',
        data.earnings   ? `\n=== EARNINGS CATALYST ===\n${data.earnings}`     : '',
        data.options    ? `\n=== OPTIONS FLOW ===\n${data.options}`           : '',
        data.social     ? `\n=== SOCIAL SENTIMENT ===\n${data.social}`        : '',
        `\n\nOriginal user question: ${messages.at(-1)?.content || ''}`,
        '\nSynthesize ALL the above into a structured investment report. Do NOT call any tools.',
      ].join('')

      // Use Reporter system prompt for synthesis pass
      const stream = await anthropic.messages.stream({
        model, max_tokens: 4096,
        system: REPORTER_SYSTEM + contextBlock,
        messages: [{ role: 'user', content: contextMsg }],
      })
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          send({ type: 'text', delta: event.delta.text })
        }
      }
      send({ type: 'done' })
      res.end(); return
    }

    let iterations = 0
    const MAX_ITER = 5

    while (iterations < MAX_ITER) {
      iterations++

      const stream = await anthropic.messages.stream({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        tools: TOOLS,
        messages: loopMessages,
      })

      let assistantContent = []
      let currentText = ''
      let toolUseBlocks = []

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'text') {
            currentText = ''
          } else if (event.content_block.type === 'tool_use') {
            toolUseBlocks.push({ id: event.content_block.id, name: event.content_block.name, input: '' })
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            currentText += event.delta.text
            send({ type: 'text', delta: event.delta.text })
          } else if (event.delta.type === 'input_json_delta' && toolUseBlocks.length) {
            toolUseBlocks[toolUseBlocks.length - 1].input += event.delta.partial_json
          }
        } else if (event.type === 'content_block_stop') {
          if (currentText) {
            assistantContent.push({ type: 'text', text: currentText })
            currentText = ''
          }
        } else if (event.type === 'message_delta') {
          if (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'tool_use') {
            for (const tb of toolUseBlocks) {
              let parsed = {}
              try { parsed = JSON.parse(tb.input || '{}') } catch {}
              assistantContent.push({ type: 'tool_use', id: tb.id, name: tb.name, input: parsed })
            }
          }
        }
      }

      loopMessages.push({ role: 'assistant', content: assistantContent })

      // Check if we need tool execution
      const toolUses = assistantContent.filter(b => b.type === 'tool_use')
      if (!toolUses.length) break // no more tools — done

      // Execute all tools in parallel
      send({ type: 'tool_start', tools: toolUses.map(t => ({ name: t.name, input: t.input })) })

      const toolResults = await Promise.all(
        toolUses.map(async (tu) => {
          try {
            const output = await dispatchTool(tu.name, tu.input, req)
            return { type: 'tool_result', tool_use_id: tu.id, content: output }
          } catch (err) {
            return { type: 'tool_result', tool_use_id: tu.id, content: `Error: ${err.message}`, is_error: true }
          }
        })
      )

      send({ type: 'tool_results', results: toolResults.map(r => ({ tool: r.tool_use_id, preview: r.content?.slice?.(0, 120) })) })
      loopMessages.push({ role: 'user', content: toolResults })
    }

    send({ type: 'done' })
  } catch (err) {
    console.error('[copilot]', err.message)
    send({ type: 'error', message: err.message })
  } finally {
    res.end()
  }
})

module.exports = router
