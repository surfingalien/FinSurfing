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

module.exports = router
