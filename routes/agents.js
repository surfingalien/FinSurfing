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
const { requireAuth } = require('../middleware/auth')
const { computeATR, computeRSI } = require('../lib/technical-indicators')
const planCheck = require('../lib/plan-check')
const { wrapUntrusted, UNTRUSTED_POLICY } = require('../lib/untrusted')

const aiRouter = getRouter('agents')

// Both routes pay for model calls, so they need a signed-in user.
router.use(requireAuth)

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
        const r = await timedFetch(`${base}/api/chart?symbol=${sym}&interval=1d&range=1y`, { headers: hdrs })
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
      // Insider names, analyst firms and headlines are third-party text:
      // fenced as data (lib/untrusted.js), truncated inside the fence.
      lines.push(wrapUntrusted(JSON.stringify(a.data, null, 2), a.name, { maxChars: 1200, label: `${a.name} data` }) + '\n')
    }
  }

  lines.push(UNTRUSTED_POLICY + '\n')
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
// Phase 1 (Analyst):    trend/momentum measured in code; the model writes the
//                       bull and bear points around them
// Phase 2 (Quant):      levels, ATR and range position, all computed in code —
//                       it used to be a paid model call that echoed numbers
//                       code had already worked out — then checked for after-
//                       cost expected value (lib/plan-check.js)
// Phase 3 (Strategist): the final recommendation; the long levels apply only
//                       to a BULLISH verdict (the app does not short)

// One row per session with high, low and close all present. Filtering each
// array separately (as before) misaligned highs and lows from different days.
function barsFromChart(data) {
  const r = data?.chart?.result?.[0]
  const ts = r?.timestamp || []
  const q = r?.indicators?.quote?.[0] || {}
  return ts.map((t, i) => ({ t, h: q.high?.[i], l: q.low?.[i], c: q.close?.[i] }))
    .filter(b => b.h > 0 && b.l > 0 && b.c > 0)
}

const mean = a => a.reduce((s, v) => s + v, 0) / a.length
const round2 = v => (v == null ? null : +v.toFixed(2))

/** Everything the pipeline states as a number, from the bars. Pure. */
function pipelineFacts(bars, quotePrice = null) {
  const closes = bars.map(b => b.c), highs = bars.map(b => b.h), lows = bars.map(b => b.l)
  const price = quotePrice > 0 ? quotePrice : closes.at(-1) ?? null
  const sma = n => (closes.length >= n ? mean(closes.slice(-n)) : null)
  const sma20 = sma(20), sma50 = sma(50), sma200 = sma(200)
  // A "52-week" high needs about a year of sessions; with less, say how many.
  const window = bars.slice(-252)
  const rangeLabel = window.length >= 240 ? '52-week' : `${window.length}-session`
  const rangeHigh = window.length ? Math.max(...window.map(b => b.h)) : null
  const rangeLow  = window.length ? Math.min(...window.map(b => b.l)) : null
  const atr14 = computeATR(highs, lows, closes, 14)
  const rsi14 = closes.length > 15 ? computeRSI(closes, 14) : null

  let trend = 'SIDEWAYS'
  if (price && sma50 && sma200) {
    if (price > sma50 && sma50 > sma200) trend = 'UPTREND'
    else if (price < sma50 && sma50 < sma200) trend = 'DOWNTREND'
  } else if (price && sma20 && sma50) {
    if (price > sma20 && sma20 > sma50) trend = 'UPTREND'
    else if (price < sma20 && sma20 < sma50) trend = 'DOWNTREND'
  }
  const momentum = rsi14 == null ? 'NEUTRAL' : rsi14 >= 60 ? 'STRONG' : rsi14 <= 40 ? 'WEAK' : 'NEUTRAL'
  const rangePos = price && rangeHigh > rangeLow ? Math.round(((price - rangeLow) / (rangeHigh - rangeLow)) * 100) : null
  const atrPct = price && atr14 ? (atr14 / price) * 100 : null

  // Long levels from ATR (1.5× stop, 2.5× and 5× targets); fixed percentages
  // only when there are too few bars for an ATR.
  const stop = price ? (atr14 ? price - 1.5 * atr14 : price * 0.93) : null
  const t1   = price ? (atr14 ? price + 2.5 * atr14 : price * 1.10) : null
  const t2   = price ? (atr14 ? price + 5.0 * atr14 : price * 1.20) : null

  return {
    price: round2(price), sessions: bars.length,
    sma20: round2(sma20), sma50: round2(sma50), sma200: round2(sma200),
    rangeLabel, rangeHigh: round2(rangeHigh), rangeLow: round2(rangeLow), rangePos,
    atr14: round2(atr14), atrPct: atrPct == null ? null : +atrPct.toFixed(2),
    rsi14: rsi14 == null ? null : +Number(rsi14).toFixed(1), trend, momentum,
    levels: price ? {
      entry: round2(price), stop_loss: round2(stop), target_1: round2(t1), target_2: round2(t2),
      risk_reward: stop < price ? +((t1 - price) / (price - stop)).toFixed(2) : null,
      basis: atr14 ? 'ATR(14): stop 1.5×, targets 2.5× and 5×' : 'fixed −7% / +10% / +20% (too few bars for an ATR)',
    } : null,
    position_quality: rangePos == null ? 'NEUTRAL' : rangePos >= 85 ? 'STRETCHED' : (rangePos <= 40 && trend === 'UPTREND') ? 'ATTRACTIVE' : 'NEUTRAL',
    volatility: atrPct == null ? 'UNKNOWN' : atrPct < 1.5 ? 'LOW' : atrPct < 3.5 ? 'NORMAL' : 'HIGH',
  }
}

/** The strategist's verdict word, from its "## Verdict" section. Pure. */
function verdictOf(text) {
  const t = String(text || '')
  const m = t.match(/verdict[^\n]*\n?[^\n]*?\b(BULLISH|BEARISH|NEUTRAL)\b/i) || t.match(/\b(BULLISH|BEARISH|NEUTRAL)\b/i)
  return m ? m[1].toUpperCase() : null
}

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
      // A year: SMA200 and a real 52-week range need it (6 months gave neither)
      timedFetch(`${base}/api/chart?symbol=${enc}&interval=1d&range=1y`,     { headers: hdrs }),
      timedFetch(`${base}/api/macro/summary`,                                { headers: hdrs }),
    ])

    const q     = quoteR.data?.quoteResponse?.result?.[0] ?? null
    const facts = pipelineFacts(barsFromChart(chartR.data), q?.regularMarketPrice)
    // No price at all used to become $0 and every level was computed off it.
    if (!facts.price)
      return res.status(422).json({ error: `No price for ${sym}: ${quoteR.error || chartR.error || 'no data provider returned one'}` })
    const macroStr = typeof macroR.data === 'string' ? macroR.data.slice(0, 200) : ''
    const $ = v => (v == null ? 'N/A' : `$${v}`)

    const p1Prompt = `Analyst phase for ${sym}. Be precise and brief.

MEASURED (computed in code — do not restate them differently):
Price=${$(facts.price)} | Day=${q?.regularMarketChangePercent?.toFixed(2) ?? '?'}% | MCap=$${((q?.marketCap || 0) / 1e9).toFixed(1)}B
SMA20=${$(facts.sma20)} SMA50=${$(facts.sma50)} SMA200=${$(facts.sma200)} | RSI14=${facts.rsi14 ?? 'N/A'}
Trend=${facts.trend} | Momentum=${facts.momentum}
Macro context: ${macroStr}

Respond ONLY with JSON (no markdown):
{"price_context":"one sentence","bull_points":["b1","b2","b3"],"bear_points":["r1","r2"]}`

    const p1r = await aiRouter.call({ prompt: p1Prompt, maxTokens: 400, symbols: [sym] })
    let p1d = {}
    try { p1d = JSON.parse(p1r.text.match(/\{[\s\S]*\}/)?.[0] || '{}') } catch {}
    p1d = { trend: facts.trend, momentum: facts.momentum, rsi14: facts.rsi14, ...p1d }

    // ── Phase 2: Quant (code) ──
    const p2t0  = Date.now()
    const assetType = /-USD$/.test(sym) ? 'crypto' : 'stock'
    const check = planCheck.checkPlan({
      side: 'long', entry: facts.levels.entry, target: facts.levels.target_1, stop: facts.levels.stop_loss,
      price: facts.price, assetType, winProb: planCheck.winProbFor(assetType),
    })
    const p2d = {
      ...facts.levels,
      position_quality: facts.position_quality, volatility: facts.volatility,
      atr14: facts.atr14, atrPct: facts.atrPct,
      [`${facts.rangeLabel} high`]: facts.rangeHigh, [`${facts.rangeLabel} low`]: facts.rangeLow, rangePos: facts.rangePos,
      check: { verdict: check.verdict, line: planCheck.describeCheck(check) },
    }

    // ── Phase 3: Strategist ──
    const p3t0   = Date.now()
    const p3Prompt = `Strategist phase — final recommendation for ${sym}.

ANALYST: trend=${facts.trend}, momentum=${facts.momentum}
Bull: ${(p1d.bull_points || []).join(' | ')}
Bear: ${(p1d.bear_points || []).join(' | ')}

QUANT (computed in code; LONG levels only — this app does not short):
entry=$${p2d.entry}, stop=$${p2d.stop_loss}, T1=$${p2d.target_1}, T2=$${p2d.target_2}, R/R=${p2d.risk_reward}, quality=${p2d.position_quality}, volatility=${p2d.volatility}
Code check of the long plan: ${p2d.check.line}

Write a concise final recommendation (plain text, not JSON). Cover:
## Verdict — BULLISH / BEARISH / NEUTRAL
One-sentence rationale with specific numbers.

## Setup Quality
Rate 1-10 with explanation.

## Trade Plan
If BULLISH: Entry: | Stop: | Target 1: | Target 2: | R/R: — use the QUANT levels exactly.
If BEARISH or NEUTRAL: write "No trade" and why. Do not list the long levels.

## Key Risk
One specific risk that could invalidate this setup.

## Catalyst Watch
What to watch for trade confirmation.`

    const p3r = await aiRouter.call({ prompt: p3Prompt, maxTokens: 600, symbols: [sym] })
    const p3end = Date.now()
    const verdict = verdictOf(p3r.text)

    // The long plan stands only behind a BULLISH verdict, and only then is it
    // recorded so the pipeline's calls are scored.
    const plan = verdict === 'BULLISH'
      ? { ...check, line: planCheck.describeCheck(check), strategistVerdict: verdict }
      : { verdict: 'no-trade', ok: true, strategistVerdict: verdict, line: `Strategist verdict ${verdict ?? 'unclear'} — the long levels are reference only.` }
    if (verdict === 'BULLISH')
      planCheck.recordPlan({ surface: 'agent-hub', symbol: sym, check, price: facts.price, meta: { userId: req.user?.userId ?? null, trend: facts.trend } })

    return res.json({
      symbol: sym,
      phases: [
        { id: 'analyst',    name: 'Analyst',    icon: '🔍', model: p1r.llmUsed, durationMs: p2t0-p1t0, data: p1d, status: 'done' },
        { id: 'quant',      name: 'Quant',      icon: '📐', model: 'code',      durationMs: p3t0-p2t0, data: p2d, status: 'done' },
        { id: 'strategist', name: 'Strategist', icon: '🎯', model: p3r.llmUsed, durationMs: p3end-p3t0, data: { verdict }, status: 'done' },
      ],
      synthesis:  p3r.text,
      plan,
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
module.exports._test = { barsFromChart, pipelineFacts, verdictOf }
