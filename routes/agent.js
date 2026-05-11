/**
 * routes/agent.js
 *
 * Stock Analyst Agent — uses Claude claude-opus-4-7 with tool_use to fetch live
 * data and compute technical indicators, then produces structured research briefings.
 *
 * POST /api/agent/analyze
 *   Body: { symbol?, prompt, history? }
 *   Streams: newline-delimited JSON events (SSE-style)
 *
 * GET  /api/agent/health
 *   Returns { ok, hasKey }
 */

'use strict'

const express  = require('express')
const router   = express.Router()
const { computeAll } = require('../utils/technicals')

// ── Lazy-load Anthropic (requires ANTHROPIC_API_KEY at runtime) ───────────────
let _client = null
function getClient() {
  if (_client) return _client
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY environment variable is not set')
  }
  const Anthropic = require('@anthropic-ai/sdk')
  _client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  return _client
}

// ── Tool: get_stock_data ──────────────────────────────────────────────────────

const TOOL_DEF = {
  name: 'get_stock_data',
  description: `Fetches live stock price, OHLCV history, and computes all technical indicators for a symbol.
Returns: current price, RSI(14), MACD(12,26,9), Bollinger Bands(20,2), SMA50, SMA200, ATR(14),
support/resistance levels, volume analysis, and price action metrics.
Use this whenever you need actual market data or indicator values for any ticker symbol.`,
  input_schema: {
    type: 'object',
    properties: {
      symbol: {
        type: 'string',
        description: 'Stock ticker symbol (e.g. AAPL, TSLA, NVDA)',
      },
      range: {
        type: 'string',
        enum: ['3mo', '6mo', '1y', '2y'],
        description: 'Historical data range (default: 1y). Use 2y for SMA200.',
      },
    },
    required: ['symbol'],
  },
}

// ── Fetch OHLCV from local proxy ──────────────────────────────────────────────

async function fetchOHLCV(symbol, range = '1y') {
  // Build internal URL pointing to our own server
  const port = process.env.PORT || 3001
  const baseUrl = process.env.INTERNAL_BASE_URL || `http://localhost:${port}`
  const url = `${baseUrl}/api/chart?symbol=${encodeURIComponent(symbol)}&interval=1d&range=${range}`

  const res  = await fetch(url, { signal: AbortSignal.timeout(15000) })
  const data = await res.json()

  const result    = data?.chart?.result?.[0]
  if (!result) throw new Error(`No chart data returned for ${symbol}`)

  const timestamps = result.timestamp || []
  const quotes     = result.indicators?.quote?.[0] || {}
  const adjClose   = result.indicators?.adjclose?.[0]?.adjclose

  const opens   = quotes.open   || []
  const highs   = quotes.high   || []
  const lows    = quotes.low    || []
  const closes  = adjClose || quotes.close || []
  const volumes = quotes.volume || []

  // Filter nulls (market holidays)
  const valid = timestamps.reduce((acc, t, i) => {
    if (closes[i] != null) {
      acc.ts.push(t)
      acc.o.push(opens[i]   || closes[i])
      acc.h.push(highs[i]   || closes[i])
      acc.l.push(lows[i]    || closes[i])
      acc.c.push(closes[i])
      acc.v.push(volumes[i] || 0)
    }
    return acc
  }, { ts: [], o: [], h: [], l: [], c: [], v: [] })

  return {
    symbol:     result.meta?.symbol || symbol,
    currency:   result.meta?.currency || 'USD',
    timestamps: valid.ts,
    opens:      valid.o,
    highs:      valid.h,
    lows:       valid.l,
    closes:     valid.c,
    volumes:    valid.v,
    meta: {
      regularMarketPrice: result.meta?.regularMarketPrice,
      previousClose:      result.meta?.chartPreviousClose || result.meta?.previousClose,
      exchange:           result.meta?.exchangeName,
      instrumentType:     result.meta?.instrumentType,
    },
  }
}

// ── Execute tool call ─────────────────────────────────────────────────────────

async function executeGetStockData({ symbol, range = '1y' }) {
  const ticker = symbol.toUpperCase().trim()

  // Expand range for SMA200 if needed
  const effectiveRange = range === '2y' ? '2y' : '1y'

  const ohlcv = await fetchOHLCV(ticker, effectiveRange)
  const technicals = computeAll({
    opens:   ohlcv.opens,
    highs:   ohlcv.highs,
    lows:    ohlcv.lows,
    closes:  ohlcv.closes,
    volumes: ohlcv.volumes,
  })

  // Build human-readable summary alongside structured data
  const p = technicals.priceAction
  const ind = technicals.indicators
  const sr  = technicals.supportResistance
  const vol = technicals.volume

  return {
    symbol: ticker,
    timestamp: new Date().toISOString(),
    quote: {
      price:        p?.price ?? ohlcv.meta.regularMarketPrice,
      change:       p?.dayChange,
      changePct:    p?.dayChangePct,
      open:         p?.open,
      high:         p?.high,
      low:          p?.low,
      prevClose:    ohlcv.meta.previousClose,
    },
    technicals: {
      rsi:          ind?.rsi,
      macd:         ind?.macd,
      bollingerBands: ind?.bb,
      sma50:        ind?.sma50,
      sma200:       ind?.sma200,
      ema20:        ind?.ema20,
      atr:          ind?.atr,
      maSignals:    technicals?.maSignals,
    },
    supportResistance: sr,
    volume:        vol,
    priceAction:   p,
    dataPoints:    technicals.dataPoints,
    meta: {
      exchange:        ohlcv.meta.exchange,
      instrumentType:  ohlcv.meta.instrumentType,
      rangeUsed:       effectiveRange,
    },
  }
}

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are FinSurf AI, an expert stock analyst and trader with deep expertise in:
- Technical analysis (RSI, MACD, Bollinger Bands, moving averages, support/resistance)
- Price action and candlestick patterns
- Volume analysis and market microstructure
- Risk management and position sizing
- Options flow and market sentiment
- Sector rotation and macro context

When a user asks about a stock, ALWAYS call get_stock_data first to fetch live data before analysis.
Never make up prices or indicator values — use the tool.

Structure your responses as clear, actionable research briefings:

**Executive Summary** — 2-3 sentence bottom line (bullish/bearish/neutral + key reason)
**Price Action** — current price context, trend, key levels
**Indicator Breakdown** — RSI reading and signal, MACD trend, Bollinger Band position
**Moving Averages** — position vs SMA50/200, golden/death cross status
**Support & Resistance** — nearest levels above and below with significance
**Volume** — current vs average, any unusual activity
**Trade Hypothesis** — entry zone, target(s), stop loss, risk/reward ratio
**Risk Factors** — 2-3 specific risks to the thesis

Keep analysis concise but complete. Use bullet points within sections.
For screening or comparison tasks, use multiple get_stock_data calls.
Always disclose: "Not financial advice. Do your own research."`

// ── POST /api/agent/analyze ───────────────────────────────────────────────────

router.post('/analyze', async (req, res) => {
  const { prompt, symbol, history = [] } = req.body || {}

  if (!prompt) {
    return res.status(400).json({ error: 'prompt is required' })
  }

  // Check API key
  let client
  try {
    client = getClient()
  } catch (err) {
    return res.status(503).json({ error: err.message, code: 'NO_API_KEY' })
  }

  // ── Set up SSE streaming ──
  res.setHeader('Content-Type', 'text/event-stream; charset=utf-8')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('X-Accel-Buffering', 'no')

  function send(event, data) {
    res.write(`data: ${JSON.stringify({ event, ...data })}\n\n`)
  }

  function sendError(msg) {
    send('error', { message: msg })
    res.end()
  }

  // Build initial user message
  const userContent = symbol
    ? `Analyze ${symbol.toUpperCase()}. ${prompt}`
    : prompt

  // Reconstruct message history (only user/assistant turns)
  const messages = [
    ...history.slice(-10).map(m => ({
      role:    m.role,
      content: m.content,
    })),
    { role: 'user', content: userContent },
  ]

  // ── Agentic tool-use loop ──
  let iteration = 0
  const MAX_ITERATIONS = 5

  try {
    while (iteration < MAX_ITERATIONS) {
      iteration++

      const streamParams = {
        model:      'claude-opus-4-7',
        max_tokens: 8192,
        thinking:   { type: 'adaptive' },
        system:     SYSTEM_PROMPT,
        tools:      [TOOL_DEF],
        messages,
      }

      // Stream the response
      const stream  = client.messages.stream(streamParams)
      let   fullText = ''
      let   toolUseBlocks = []

      // Forward text deltas as they arrive
      stream.on('text', (text) => {
        fullText += text
        send('delta', { text })
      })

      // Notify when tool is being called
      stream.on('message', () => {}) // no-op, handled via finalMessage

      const message = await stream.finalMessage()

      // Check stop reason
      if (message.stop_reason === 'end_turn') {
        // Done — emit completion
        send('done', {
          usage: {
            input_tokens:  message.usage?.input_tokens,
            output_tokens: message.usage?.output_tokens,
          },
        })
        res.end()
        return
      }

      if (message.stop_reason === 'tool_use') {
        // Collect tool_use blocks
        const toolUses = message.content.filter(b => b.type === 'tool_use')

        if (!toolUses.length) {
          send('done', {})
          res.end()
          return
        }

        // Append assistant message
        messages.push({ role: 'assistant', content: message.content })

        // Execute tools in parallel
        const toolResults = await Promise.all(
          toolUses.map(async (tu) => {
            send('tool_start', { name: tu.name, input: tu.input })
            try {
              let result
              if (tu.name === 'get_stock_data') {
                result = await executeGetStockData(tu.input)
                send('tool_end', { name: tu.name, symbol: tu.input.symbol })
              } else {
                result = { error: `Unknown tool: ${tu.name}` }
              }
              return {
                type:        'tool_result',
                tool_use_id: tu.id,
                content:     JSON.stringify(result),
              }
            } catch (err) {
              send('tool_error', { name: tu.name, error: err.message })
              return {
                type:        'tool_result',
                tool_use_id: tu.id,
                content:     JSON.stringify({ error: err.message }),
                is_error:    true,
              }
            }
          })
        )

        // Append tool results and loop
        messages.push({ role: 'user', content: toolResults })
        continue
      }

      // Unexpected stop reason
      send('done', {})
      res.end()
      return
    }

    // Hit max iterations
    send('error', { message: 'Agent reached maximum iterations. Please try again.' })
    res.end()

  } catch (err) {
    console.error('[Agent] Error:', err.message)
    if (!res.headersSent) {
      return res.status(500).json({ error: err.message })
    }
    sendError(err.message)
  }
})

// ── GET /api/agent/health ─────────────────────────────────────────────────────

router.get('/health', (_req, res) => {
  res.json({
    ok:     true,
    hasKey: !!process.env.ANTHROPIC_API_KEY,
    model:  'claude-opus-4-7',
  })
})

module.exports = router
