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

const router = express.Router()
const anthropic = new Anthropic()

const chatLimit = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { error: 'Too many copilot requests — wait a minute' },
})

const COPILOT_SYSTEM = `You are FinSurf Copilot, an AI financial analyst embedded in FinSurfing — a real-time US equity and crypto trading platform.

You have access to live tools:
- scan_market: Run the 5-agent AI Brain to rank investment opportunities across stocks, ETFs, crypto
- get_recommendations: Get personalized buy signals using a named investor persona
- analyze_symbol: Deep technical + AI analysis for a specific ticker
- get_social_sentiment: Real-time Reddit/social sentiment for up to 5 tickers
- get_macro: Current macroeconomic indicators and regime assessment

Guidelines:
- Be concise and actionable. Lead with the signal, follow with reasoning.
- When the user asks about a stock/crypto, call analyze_symbol first.
- When the user asks for "top picks" or "what to buy", call scan_market.
- Always surface contradictions and risks — never give false confidence.
- Format numbers clearly: prices in $, percentages with %, scores /100.
- Respect the user's existing portfolio — avoid suggesting stocks they already hold.
- Not financial advice — always note this for high-conviction calls.`

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
      const r = await fetch(`http://127.0.0.1:${port}/api/trading-analysis/analyze?symbol=${sym}&interval=${interval}`, {
        method: 'POST', headers: fwdHeaders,
        body: JSON.stringify({}),
        signal: AbortSignal.timeout(30_000),
      })
      const data = await r.json()
      if (!data.signal) return `Analysis failed for ${input.symbol}: ${data.error || 'unknown error'}`
      return (
        `**${input.symbol}** — Signal: **${data.signal}** (${data.confidence}% confidence)\n` +
        `Trend: ${data.trend} · Risk/Reward: ${data.riskReward?.toFixed(1)}:1\n` +
        `Entry $${data.entry} (zone $${data.entryZoneLow}–$${data.entryZoneHigh})\n` +
        `Stop $${data.stopLoss} · Target $${data.takeProfit?.[0]}–$${data.takeProfit?.[1]}\n\n` +
        `${data.reasoning}\n\n` +
        (data.contradictions?.length ? `⚠️ Contradictions: ${data.contradictions.join('; ')}\n` : '') +
        `Risks: ${data.risks?.join(' | ')}`
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

    default:
      return `Unknown tool: ${name}`
  }
}

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
    let loopMessages = messages.map(m => ({ role: m.role, content: m.content }))
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
