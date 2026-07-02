'use strict'
/**
 * routes/analytics.js
 *
 * GET  /api/analytics/portfolio           — beta, correlation matrix, sector concentration
 * POST /api/analytics/portfolio/critique  — (requireAuth) LLM risk critique grounded in
 *                                           the measured metrics above (lib/risk-critique.js);
 *                                           body: { symbols?: string[] } to critique an ad-hoc list
 *
 * All calculations are server-side using SPY as the market benchmark.
 * Requires auth; uses the active portfolio's holdings.
 */

const express         = require('express')
const { requireAuth } = require('../middleware/auth')
const { query }       = require('../db/db')

const { optionalAuth } = require('../middleware/auth')

const router = express.Router()
router.use(optionalAuth)

const DB_MODE = !!process.env.DATABASE_URL

// In-process response cache. This endpoint fans out up to 21 chart fetches
// (holdings + SPY); without a cache every dashboard load on a cold chart
// cache hammers the market-data providers and can exhaust free-tier quotas.
const _respCache = new Map()
const RESP_TTL   = 30 * 60_000

// ── Fetch daily closes via internal /api/chart proxy (Finnhub → FMP) ──────────
async function fetchCloses(symbol, range = '1y', fwdHeaders = {}) {
  const port = process.env.PORT || 3001
  try {
    const r    = await fetch(
      `http://127.0.0.1:${port}/api/chart?symbol=${encodeURIComponent(symbol)}&interval=1d&range=${range}`,
      { headers: fwdHeaders, signal: AbortSignal.timeout(12_000) }
    )
    const data = await r.json()
    const result = data?.chart?.result?.[0]
    const closes = result?.indicators?.quote?.[0]?.close ?? []
    const times  = result?.timestamp ?? []
    return times
      .map((ts, i) => ({ date: new Date(ts * 1000).toISOString().slice(0, 10), close: closes[i] }))
      .filter(p => p.close != null && !isNaN(p.close))
  } catch { return [] }
}

// ── Risk/performance math: lib/portfolio-metrics.js (unit-tested) ────────────
const {
  dailyReturns, sharpeRatio, sortinoRatio, maxDrawdown, annualizedReturn,
  annualizedVolatility, valueAtRisk, conditionalVaR, pearson, beta,
  weightedReturnSeries, equityFromReturns,
} = require('../lib/portfolio-metrics')

// ── Main route ────────────────────────────────────────────────────────────────
// Accepts optional ?symbols=AAPL,MSFT,GOOG query param for manual analysis
// Falls back to reading from the authenticated user's active portfolio when no symbols provided
router.get('/portfolio', async (req, res) => {
  const fwdHeaders = {}
  for (const h of ['x-aisa-key', 'x-finnhub-key', 'x-fmp-key', 'x-td-key', 'x-av-key']) {
    if (req.headers[h]) fwdHeaders[h] = req.headers[h]
  }

  const userId = req.user?.userId

  let symbols = []
  let holdingMeta = {}

  // Parse manually supplied symbols from query string
  if (req.query.symbols) {
    const manualSyms = req.query.symbols
      .split(',')
      .map(s => s.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, ''))
      .filter(Boolean)
      .slice(0, 20)
    manualSyms.forEach(s => {
      symbols.push(s)
      holdingMeta[s] = { sector: 'Unknown', shares: 1, avgCost: 0 }
    })
  } else if (userId && DB_MODE) {
    try {
      const pRes = await query(
        `SELECT id FROM portfolios WHERE user_id = $1 AND is_archived = FALSE ORDER BY is_default DESC LIMIT 1`,
        [userId]
      )
      const portfolioId = pRes.rows[0]?.id
      if (portfolioId) {
        const hRes = await query(
          `SELECT symbol, sector, shares, avg_cost_basis FROM holdings WHERE portfolio_id = $1`,
          [portfolioId]
        )
        for (const h of hRes.rows) {
          symbols.push(h.symbol)
          holdingMeta[h.symbol] = { sector: h.sector || 'Unknown', shares: parseFloat(h.shares), avgCost: parseFloat(h.avg_cost_basis || 0) }
        }
      }
    } catch (err) {
      console.error('[analytics] DB error:', err.message)
      return res.status(500).json({ error: 'Database error' })
    }
  }

  if (symbols.length === 0)
    return res.json({ symbols: [], beta: null, correlations: [], sectors: [] })

  // Cap at 20 symbols to keep response time reasonable
  const symsToFetch = [...new Set(symbols)].slice(0, 20)

  // Serve cached response when fresh (keyed by mode + symbols so a user's
  // saved-portfolio call never collides with a manual ?symbols= call)
  const cacheKey = (req.query.symbols ? 'm:' : `u:${userId}:`) + [...symsToFetch].sort().join(',')
  const hit = _respCache.get(cacheKey)
  if (hit && Date.now() - hit.ts < RESP_TTL) return res.json(hit.data)

  // Fetch benchmark + all holdings in parallel
  const [spyData, ...holdingData] = await Promise.all([
    fetchCloses('SPY', '1y', fwdHeaders),
    ...symsToFetch.map(s => fetchCloses(s, '1y', fwdHeaders)),
  ])

  const spyRet = dailyReturns(spyData.map(p => p.close))

  const closeMap = {}
  symsToFetch.forEach((s, i) => { closeMap[s] = holdingData[i] })

  // ── Beta per holding ──────────────────────────────────────────────────────
  const betas = {}
  for (const sym of symsToFetch) {
    const closes = closeMap[sym].map(p => p.close)
    betas[sym] = beta(dailyReturns(closes), spyRet)
  }

  // Portfolio-weighted beta (weight by current market value approximation)
  const totalShares = symsToFetch.reduce((s, sym) => s + (holdingMeta[sym]?.shares || 0), 0)
  let portfolioBeta = null
  if (totalShares > 0) {
    let weightedBeta = 0, validWeight = 0
    for (const sym of symsToFetch) {
      if (betas[sym] == null) continue
      const w = (holdingMeta[sym]?.shares || 0) / totalShares
      weightedBeta += betas[sym] * w
      validWeight  += w
    }
    portfolioBeta = validWeight > 0 ? weightedBeta / validWeight : null
  }

  // ── Correlation matrix ────────────────────────────────────────────────────
  const correlations = []
  for (let i = 0; i < symsToFetch.length; i++) {
    for (let j = i + 1; j < symsToFetch.length; j++) {
      const a   = symsToFetch[i]; const b2 = symsToFetch[j]
      const ra  = dailyReturns(closeMap[a].map(p => p.close))
      const rb  = dailyReturns(closeMap[b2].map(p => p.close))
      const cor = pearson(ra, rb)
      if (cor !== null)
        correlations.push({ a, b: b2, r: +cor.toFixed(3) })
    }
  }

  // ── Sector concentration ──────────────────────────────────────────────────
  const sectorMap = {}
  for (const sym of symsToFetch) {
    const sec = holdingMeta[sym]?.sector || 'Unknown'
    sectorMap[sec] = (sectorMap[sec] || 0) + (holdingMeta[sym]?.shares || 1)
  }
  const totalHoldings = Object.values(sectorMap).reduce((a, b) => a + b, 0)
  const sectors = Object.entries(sectorMap).map(([name, count]) => ({
    name,
    count: +count.toFixed(2),
    weight: totalHoldings > 0 ? +((count / totalHoldings) * 100).toFixed(1) : 0,
  })).sort((a, b) => b.weight - a.weight)

  // ── Portfolio risk metrics (Sharpe, Sortino, drawdown, vol, VaR) ─────────
  // Value-weighted by shares × latest close when real position sizes are
  // known (portfolio mode); equal-weighted for manual ?symbols= lists.
  const manualMode = !!req.query.symbols
  const riskMetrics = {}
  try {
    const alignedLength = Math.min(...symsToFetch.map(s => closeMap[s].length))
    if (alignedLength >= 20 && symsToFetch.length > 0) {
      const closeSeries = symsToFetch.map(s => closeMap[s].map(p => p.close))
      const weights = manualMode ? null : symsToFetch.map(s => {
        const closes = closeMap[s].map(p => p.close)
        const last   = closes[closes.length - 1] || 0
        return (holdingMeta[s]?.shares || 0) * last
      })
      const portReturns = weightedReturnSeries(closeSeries, weights)
      const portEquity  = equityFromReturns(portReturns)

      // Per-holding risk metrics
      const holdingRisk = {}
      for (const sym of symsToFetch) {
        const closes = closeMap[sym].map(p => p.close)
        const ret    = dailyReturns(closes)
        holdingRisk[sym] = {
          sharpe:         sharpeRatio(ret)    != null ? +sharpeRatio(ret).toFixed(3)    : null,
          maxDrawdown:    maxDrawdown(closes) != null ? +(maxDrawdown(closes) * 100).toFixed(2) : null,
          annualReturn:   annualizedReturn(closes) != null ? +(annualizedReturn(closes) * 100).toFixed(2) : null,
        }
      }

      riskMetrics.portfolio = {
        sharpe:       sharpeRatio(portReturns)  != null ? +sharpeRatio(portReturns).toFixed(3)  : null,
        sortino:      sortinoRatio(portReturns) != null ? +sortinoRatio(portReturns).toFixed(3) : null,
        maxDrawdown:  maxDrawdown(portEquity)   != null ? +(maxDrawdown(portEquity) * 100).toFixed(2) : null,
        annualReturn: annualizedReturn(portEquity) != null ? +(annualizedReturn(portEquity) * 100).toFixed(2) : null,
        volatility:   annualizedVolatility(portReturns) != null ? +(annualizedVolatility(portReturns) * 100).toFixed(2) : null,
        var95:        valueAtRisk(portReturns)     != null ? +(valueAtRisk(portReturns) * 100).toFixed(2)     : null,
        cvar95:       conditionalVaR(portReturns)  != null ? +(conditionalVaR(portReturns) * 100).toFixed(2)  : null,
        weighting:    manualMode ? 'equal' : 'value',
      }

      // SPY benchmark metrics for comparison
      riskMetrics.benchmark = {
        sharpe:       sharpeRatio(spyRet)  != null ? +sharpeRatio(spyRet).toFixed(3)  : null,
        sortino:      sortinoRatio(spyRet) != null ? +sortinoRatio(spyRet).toFixed(3) : null,
        maxDrawdown:  maxDrawdown(spyData.map(p => p.close)) != null
          ? +(maxDrawdown(spyData.map(p => p.close)) * 100).toFixed(2) : null,
        annualReturn: annualizedReturn(spyData.map(p => p.close)) != null
          ? +(annualizedReturn(spyData.map(p => p.close)) * 100).toFixed(2) : null,
        volatility:   annualizedVolatility(spyRet) != null ? +(annualizedVolatility(spyRet) * 100).toFixed(2) : null,
        var95:        valueAtRisk(spyRet)    != null ? +(valueAtRisk(spyRet) * 100).toFixed(2)    : null,
        cvar95:       conditionalVaR(spyRet) != null ? +(conditionalVaR(spyRet) * 100).toFixed(2) : null,
      }
      riskMetrics.holdings = holdingRisk

      // Raw daily-return series (%) for tail-distribution visualization —
      // real historical returns, not simulated. Capped to the trailing 1y
      // already fetched; small enough (~252 floats × 2) to inline.
      riskMetrics.returnSeries = {
        portfolio: portReturns.map(r => +(r * 100).toFixed(4)),
        benchmark: spyRet.map(r => +(r * 100).toFixed(4)),
      }
    }
  } catch (e) {
    console.warn('[analytics] risk metrics error:', e.message)
  }

  const payload = {
    symbols:       symsToFetch,
    portfolioBeta: portfolioBeta != null ? +portfolioBeta.toFixed(3) : null,
    betas:         Object.fromEntries(
      Object.entries(betas).map(([k, v]) => [k, v != null ? +v.toFixed(3) : null])
    ),
    correlations,
    sectors,
    riskMetrics,
    benchmark: 'SPY',
  }
  // Cache only responses that actually carry prices — a provider outage
  // shouldn't pin an empty result for 30 minutes
  if (Object.keys(riskMetrics).length) {
    _respCache.set(cacheKey, { ts: Date.now(), data: payload })
    if (_respCache.size > 200) _respCache.delete(_respCache.keys().next().value)
  }
  return res.json(payload)
})

// ── LLM risk critique over the measured metrics ───────────────────────────────
// The model only ever sees (and may only cite) figures computed above from
// real price history — it suggests risk reductions / return enhancers, it
// never computes a metric. Advisory only, nothing is executed.
const { getRouter }        = require('../lib/ai-router')
const { CircuitOpenError } = require('../lib/circuit-breaker')
const { INTERNAL_SECRET }  = require('../lib/internal-secret')
const { buildRiskReport, buildCritiquePrompt, parseCritique } = require('../lib/risk-critique')

const critiqueRouter = getRouter('risk-critique')

router.post('/portfolio/critique', requireAuth, async (req, res) => {
  const symbols = Array.isArray(req.body?.symbols)
    ? req.body.symbols.slice(0, 20).map(s => String(s).toUpperCase().replace(/[^A-Z0-9.-]/g, '')).filter(Boolean)
    : []

  // Reuse the measured-analytics endpoint via loopback (same pattern as
  // copilot dispatchTool) so critique and dashboard always agree on numbers.
  const fwdHeaders = { 'x-internal': '1', 'x-internal-secret': INTERNAL_SECRET }
  if (req.headers.authorization) fwdHeaders.authorization = req.headers.authorization
  for (const h of ['x-aisa-key', 'x-finnhub-key', 'x-fmp-key', 'x-td-key', 'x-av-key']) {
    if (req.headers[h]) fwdHeaders[h] = req.headers[h]
  }

  let payload
  try {
    const port = process.env.PORT || 3001
    const qs   = symbols.length ? `?symbols=${symbols.join(',')}` : ''
    const r    = await fetch(`http://127.0.0.1:${port}/api/analytics/portfolio${qs}`, {
      headers: fwdHeaders, signal: AbortSignal.timeout(60_000),
    })
    payload = await r.json()
  } catch (err) {
    return res.status(504).json({ error: 'Portfolio analytics unavailable: ' + err.message })
  }

  const report = buildRiskReport(payload)
  if (!report) {
    return res.status(422).json({ error: 'Not enough portfolio data to critique — need ≥1 holding with 20+ trading days of history (or pass symbols[])' })
  }

  let raw = '', llmUsed = 'claude'
  try {
    const result = await critiqueRouter.call({ prompt: buildCritiquePrompt(report), maxTokens: 1500, symbols: payload.symbols })
    raw     = result.text
    llmUsed = result.llmUsed
  } catch (err) {
    if (err instanceof CircuitOpenError) return res.status(503).json({ error: err.message, circuitOpen: true })
    if (err.status === 503)             return res.status(503).json({ error: err.message })
    console.error('[analytics/critique]', err.message)
    return res.status(500).json({ error: 'Risk critique failed: ' + err.message })
  }

  const critique = parseCritique(raw)
  if (!critique) {
    console.error('[analytics/critique] Unusable AI response:', raw.slice(0, 200))
    return res.status(502).json({ error: 'AI returned no usable critique — please try again' })
  }

  return res.json({ symbols: payload.symbols, report, critique, llmUsed })
})

module.exports = router
