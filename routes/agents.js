'use strict'

/**
 * routes/agents.js
 *
 * Multi-agent research orchestrator — OpenSkynet-inspired fan-out pattern.
 *
 * POST /api/agents/research
 * body: { symbol, includeInsider?, includeAnalyst?, includeMacro? }
 *
 * Fans out to 5 parallel sub-agents, collects results with Promise.allSettled,
 * then calls Claude to synthesise a comprehensive research brief.
 *
 * Response:
 * {
 *   symbol,
 *   agents: [{ id, name, status, data, error, durationMs }],
 *   synthesis: "...",
 *   llmUsed: "claude"|"groq",
 *   timestamp
 * }
 */

const express  = require('express')
const router   = express.Router()
const { getRouter } = require('../lib/ai-router')

const aiRouter = getRouter('agents')

const BASE_URL = () => `http://127.0.0.1:${process.env.PORT || 3001}`

function fwdHeaders(req) {
  const h = { 'Content-Type': 'application/json' }
  for (const k of ['x-aisa-key','x-finnhub-key','x-fmp-key','x-td-key','x-av-key'])
    if (req.headers[k]) h[k] = req.headers[k]
  return h
}

async function timedFetch(url, opts, timeoutMs = 20_000) {
  const ctrl = new AbortController()
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs)
  const t0   = Date.now()
  try {
    const r    = await fetch(url, { ...opts, signal: ctrl.signal })
    const data = await r.json()
    return { data: r.ok ? data : null, error: r.ok ? null : (data.error || `HTTP ${r.status}`), durationMs: Date.now() - t0 }
  } catch (e) {
    return { data: null, error: e.name === 'AbortError' ? 'Timed out' : e.message, durationMs: Date.now() - t0 }
  } finally { clearTimeout(tid) }
}

// ── Sub-agent definitions ─────────────────────────────────────────────────────

function buildAgents(symbol, req, opts) {
  const base = BASE_URL()
  const hdrs = fwdHeaders(req)
  const sym  = encodeURIComponent(symbol)

  return [
    {
      id:   'market-data',
      name: 'Market Data',
      icon: '📊',
      run:  () => timedFetch(`${base}/api/quote?symbols=${sym}`, { headers: hdrs }),
    },
    {
      id:   'technical',
      name: 'Technical Analysis',
      icon: '📈',
      run:  async () => {
        const r = await timedFetch(`${base}/api/chart?symbol=${sym}&interval=1d&range=6mo`, { headers: hdrs })
        if (!r.data) return r
        // Extract close prices for brief technical summary
        const closes = r.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Boolean) ?? []
        const last   = closes.at(-1) ?? null
        const sma20  = closes.length >= 20 ? closes.slice(-20).reduce((s,v) => s+v,0) / 20 : null
        const sma50  = closes.length >= 50 ? closes.slice(-50).reduce((s,v) => s+v,0) / 50 : null
        const sma200 = closes.length >= 200 ? closes.slice(-200).reduce((s,v) => s+v,0) / 200 : null
        return {
          data: {
            price: last,
            sma20: sma20 ? +sma20.toFixed(2) : null,
            sma50: sma50 ? +sma50.toFixed(2) : null,
            sma200: sma200 ? +sma200.toFixed(2) : null,
            aboveSma20:  sma20  ? last > sma20  : null,
            aboveSma50:  sma50  ? last > sma50  : null,
            aboveSma200: sma200 ? last > sma200 : null,
            dataPoints:  closes.length,
          },
          error:      null,
          durationMs: r.durationMs,
        }
      },
    },
    {
      id:   'insider',
      name: 'Insider Activity',
      icon: '👥',
      skip: !opts.includeInsider,
      run:  () => timedFetch(`${base}/api/market-intel/insider?symbol=${sym}&limit=10`, { headers: hdrs }),
    },
    {
      id:   'analyst',
      name: 'Analyst Ratings',
      icon: '⭐',
      skip: !opts.includeAnalyst,
      run:  () => timedFetch(`${base}/api/market-intel/analyst?symbol=${sym}`, { headers: hdrs }),
    },
    {
      id:   'macro',
      name: 'Macro Context',
      icon: '🌍',
      skip: !opts.includeMacro,
      run:  () => timedFetch(`${base}/api/macro/summary`, { headers: hdrs }),
    },
  ]
}

// ── Synthesis prompt ──────────────────────────────────────────────────────────

function buildPrompt(symbol, agentResults) {
  const lines = [`# Multi-Agent Research Brief: ${symbol}\n`]

  for (const a of agentResults) {
    lines.push(`## ${a.icon} ${a.name} (${a.status}, ${a.durationMs}ms)`)
    if (a.status === 'error') {
      lines.push(`Error: ${a.error}\n`)
    } else if (a.data) {
      lines.push('```json')
      lines.push(JSON.stringify(a.data, null, 2).slice(0, 1200))
      lines.push('```\n')
    }
  }

  lines.push(`## Your Task`)
  lines.push(
    `You are a senior equity analyst. Using the data above from ${agentResults.length} parallel research agents, ` +
    `write a concise but comprehensive research brief for ${symbol}. Include:\n` +
    `1. **Current Situation** — price context, trend direction (SMA position)\n` +
    `2. **Insider Signal** — notable insider buys/sells if present\n` +
    `3. **Analyst Consensus** — recent upgrades/downgrades/initiations\n` +
    `4. **Macro Backdrop** — how the current macro regime affects this position\n` +
    `5. **Key Risks** — 2-3 specific risks\n` +
    `6. **Verdict** — one of: BULLISH / NEUTRAL / BEARISH with one-sentence rationale\n\n` +
    `Be direct and specific. No generic disclaimers. Use numbers from the data.`
  )

  return lines.join('\n')
}

// ── Route ─────────────────────────────────────────────────────────────────────

router.post('/research', async (req, res) => {
  const {
    symbol,
    includeInsider = true,
    includeAnalyst = true,
    includeMacro   = true,
  } = req.body

  if (!symbol || typeof symbol !== 'string')
    return res.status(400).json({ error: 'symbol is required' })

  const sym  = symbol.toUpperCase().replace(/[^A-Z0-9.-]/g, '')
  const opts = { includeInsider, includeAnalyst, includeMacro }
  const agents = buildAgents(sym, req, opts)

  // Fan out all non-skipped agents in parallel
  const active = agents.filter(a => !a.skip)
  const settled = await Promise.allSettled(active.map(a => a.run()))

  const agentResults = active.map((a, i) => {
    const outcome = settled[i]
    if (outcome.status === 'fulfilled') {
      return { id: a.id, name: a.name, icon: a.icon, status: outcome.value.error ? 'error' : 'done', data: outcome.value.data, error: outcome.value.error, durationMs: outcome.value.durationMs }
    }
    return { id: a.id, name: a.name, icon: a.icon, status: 'error', data: null, error: outcome.reason?.message ?? 'Unknown error', durationMs: 0 }
  })

  // Add skipped agents as-is
  agents.filter(a => a.skip).forEach(a => {
    agentResults.push({ id: a.id, name: a.name, icon: a.icon, status: 'skipped', data: null, error: null, durationMs: 0 })
  })

  // Sort back to original order
  agentResults.sort((a, b) => agents.findIndex(x => x.id === a.id) - agents.findIndex(x => x.id === b.id))

  // Synthesise with Claude
  let synthesis  = null
  let llmUsed    = null
  let synthError = null
  try {
    const prompt = buildPrompt(sym, agentResults.filter(a => a.status !== 'skipped'))
    const result = await aiRouter.call({ prompt, maxTokens: 1024, symbols: [sym] })
    synthesis = result.text
    llmUsed   = result.llmUsed
  } catch (e) {
    synthError = e.message
  }

  res.json({
    symbol:    sym,
    agents:    agentResults,
    synthesis,
    synthError,
    llmUsed,
    timestamp: new Date().toISOString(),
  })
})

// ── POST /api/agents/pipeline ─────────────────────────────────────────────────
// 3-phase sequential research pipeline (open-team inspired)
// Phase 1 (Analyst):    fan-out data gather + trend/momentum read
// Phase 2 (Quant):      risk/reward levels, ATR, 52-week range position
// Phase 3 (Strategist): final actionable recommendation synthesising both phases

router.post('/pipeline', async (req, res) => {
  const { symbol } = req.body
  if (!symbol || typeof symbol !== 'string')
    return res.status(400).json({ error: 'symbol is required' })

  const sym  = symbol.toUpperCase().replace(/[^A-Z0-9.-]/g, '')
  const t0   = Date.now()
  const base = BASE_URL()
  const hdrs = fwdHeaders(req)
  const enc  = encodeURIComponent(sym)

  try {
    // ── Phase 1: Analyst ──
    const p1t0 = Date.now()
    const [quoteR, chartR, macroR] = await Promise.all([
      timedFetch(`${base}/api/quote?symbols=${enc}`,                         { headers: hdrs }),
      timedFetch(`${base}/api/chart?symbol=${enc}&interval=1d&range=6mo`,    { headers: hdrs }),
      timedFetch(`${base}/api/macro/summary`,                                { headers: hdrs }),
    ])

    const q       = quoteR.data?.quoteResponse?.result?.[0] ?? null
    const closes  = chartR.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Boolean) ?? []
    const highs   = chartR.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.high?.filter(Boolean)  ?? []
    const lows    = chartR.data?.chart?.result?.[0]?.indicators?.quote?.[0]?.low?.filter(Boolean)   ?? []
    const price   = q?.regularMarketPrice ?? 0
    const sma20   = closes.length >= 20  ? closes.slice(-20).reduce((s,v)=>s+v,0)/20   : null
    const sma50   = closes.length >= 50  ? closes.slice(-50).reduce((s,v)=>s+v,0)/50   : null
    const sma200  = closes.length >= 200 ? closes.slice(-200).reduce((s,v)=>s+v,0)/200 : null
    const high52  = highs.length >= 50   ? Math.max(...highs.slice(-252)) : null
    const low52   = lows.length  >= 50   ? Math.min(...lows.slice(-252))  : null
    const atrArr  = highs.slice(-15).map((h,i) => h - (lows[lows.length-15+i]||h)).filter(v=>v>0)
    const atr14   = atrArr.length ? atrArr.reduce((s,v)=>s+v,0)/atrArr.length : null
    const macroStr= typeof macroR.data === 'string' ? macroR.data.slice(0,200) : ''

    const p1Prompt = `Analyst phase for ${sym}. Be precise and brief.

DATA: Price=$${price.toFixed(2)} | Day=${q?.regularMarketChangePercent?.toFixed(2)||'?'}% | MCap=$${((q?.marketCap||0)/1e9).toFixed(1)}B
SMA20=${sma20?'$'+sma20.toFixed(2):'N/A'} SMA50=${sma50?'$'+sma50.toFixed(2):'N/A'} SMA200=${sma200?'$'+sma200.toFixed(2):'N/A'}
Macro context: ${macroStr}

Respond ONLY with JSON (no markdown):
{"trend":"UPTREND or DOWNTREND or SIDEWAYS","momentum":"STRONG or WEAK or NEUTRAL","price_context":"one sentence","bull_points":["b1","b2","b3"],"bear_points":["r1","r2"]}`

    const p1r = await aiRouter.call({ prompt: p1Prompt, maxTokens: 400, symbols: [sym] })
    let p1d = {}
    try { p1d = JSON.parse(p1r.text.match(/\{[\s\S]*\}/)?.[0] || '{}') } catch {}

    // ── Phase 2: Quant ──
    const p2t0    = Date.now()
    const inRange = high52 && low52 && price ? (((price-low52)/(high52-low52))*100).toFixed(0) : null
    const stopEst = atr14 ? (price - atr14*1.5).toFixed(2) : (price*0.93).toFixed(2)
    const t1Est   = atr14 ? (price + atr14*2.5).toFixed(2) : (price*1.10).toFixed(2)
    const t2Est   = atr14 ? (price + atr14*5.0).toFixed(2) : (price*1.20).toFixed(2)

    const p2Prompt = `Quant phase for ${sym}. Phase-1: trend=${p1d.trend}, momentum=${p1d.momentum}.

METRICS: Price=$${price.toFixed(2)} | 52wHigh=${high52?'$'+high52.toFixed(2):'N/A'} | 52wLow=${low52?'$'+low52.toFixed(2):'N/A'} | ATR14=${atr14?'$'+atr14.toFixed(2):'N/A'} | RangePos=${inRange||'N/A'}%

Compute trade levels. Respond ONLY with JSON:
{"entry":${price.toFixed(2)},"stop_loss":${stopEst},"target_1":${t1Est},"target_2":${t2Est},"risk_reward":"${atr14?((parseFloat(t1Est)-price)/(price-parseFloat(stopEst))).toFixed(1):'2.0'}","position_quality":"ATTRACTIVE or NEUTRAL or STRETCHED","volatility":"LOW or NORMAL or HIGH"}`

    const p2r = await aiRouter.call({ prompt: p2Prompt, maxTokens: 256, symbols: [sym] })
    let p2d = {}
    try { p2d = JSON.parse(p2r.text.match(/\{[\s\S]*\}/)?.[0] || '{}') } catch {}

    // ── Phase 3: Strategist ──
    const p3t0   = Date.now()
    const p3Prompt = `Strategist phase — final recommendation for ${sym}.

ANALYST: trend=${p1d.trend}, momentum=${p1d.momentum}
Bull: ${(p1d.bull_points||[]).join(' | ')}
Bear: ${(p1d.bear_points||[]).join(' | ')}

QUANT: entry=$${p2d.entry}, stop=$${p2d.stop_loss}, T1=$${p2d.target_1}, T2=$${p2d.target_2}, R/R=${p2d.risk_reward}, quality=${p2d.position_quality}

Write a concise final recommendation (plain text, not JSON). Cover:
## Verdict — BULLISH / BEARISH / NEUTRAL
One-sentence rationale with specific numbers.

## Setup Quality
Rate 1-10 with explanation.

## Trade Plan
Entry: | Stop: | Target 1: | Target 2: | R/R:

## Key Risk
One specific risk that could invalidate this setup.

## Catalyst Watch
What to watch for trade confirmation.`

    const p3r = await aiRouter.call({ prompt: p3Prompt, maxTokens: 600, symbols: [sym] })
    const p3end = Date.now()

    return res.json({
      symbol: sym,
      phases: [
        { id: 'analyst',    name: 'Analyst',    icon: '🔍', model: p1r.llmUsed, durationMs: p2t0-p1t0, data: p1d, status: 'done' },
        { id: 'quant',      name: 'Quant',      icon: '📐', model: p2r.llmUsed, durationMs: p3t0-p2t0, data: p2d, status: 'done' },
        { id: 'strategist', name: 'Strategist', icon: '🎯', model: p3r.llmUsed, durationMs: p3end-p3t0, data: null, status: 'done' },
      ],
      synthesis:  p3r.text,
      llmUsed:    p3r.llmUsed,
      totalMs:    Date.now() - t0,
      timestamp:  new Date().toISOString(),
    })
  } catch (err) {
    console.error('[agents/pipeline]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router
