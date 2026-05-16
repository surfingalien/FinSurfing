'use strict'
/**
 * routes/analytics.js
 *
 * GET  /api/analytics/portfolio   — beta, correlation matrix, sector concentration
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

// ── Daily returns from close array ───────────────────────────────────────────
function dailyReturns(closes) {
  const out = []
  for (let i = 1; i < closes.length; i++)
    out.push((closes[i] - closes[i - 1]) / closes[i - 1])
  return out
}

// ── Pearson correlation ───────────────────────────────────────────────────────
function pearson(a, b) {
  const n   = Math.min(a.length, b.length)
  if (n < 5) return null
  const ax  = a.slice(-n)
  const bx  = b.slice(-n)
  const ma  = ax.reduce((s, v) => s + v, 0) / n
  const mb  = bx.reduce((s, v) => s + v, 0) / n
  let num = 0, da2 = 0, db2 = 0
  for (let i = 0; i < n; i++) {
    const da = ax[i] - ma; const db = bx[i] - mb
    num += da * db; da2 += da * da; db2 += db * db
  }
  return da2 === 0 || db2 === 0 ? 0 : num / Math.sqrt(da2 * db2)
}

// ── Beta vs benchmark ─────────────────────────────────────────────────────────
function beta(stockRet, mktRet) {
  const n  = Math.min(stockRet.length, mktRet.length)
  if (n < 5) return null
  const sr = stockRet.slice(-n); const mr = mktRet.slice(-n)
  const ms = sr.reduce((a, v) => a + v, 0) / n
  const mm = mr.reduce((a, v) => a + v, 0) / n
  let cov = 0, varM = 0
  for (let i = 0; i < n; i++) {
    cov  += (sr[i] - ms) * (mr[i] - mm)
    varM += (mr[i] - mm) ** 2
  }
  return varM === 0 ? 0 : cov / varM
}

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
          `SELECT symbol, sector, shares, avg_cost FROM holdings WHERE portfolio_id = $1`,
          [portfolioId]
        )
        for (const h of hRes.rows) {
          symbols.push(h.symbol)
          holdingMeta[h.symbol] = { sector: h.sector || 'Unknown', shares: parseFloat(h.shares), avgCost: parseFloat(h.avg_cost || 0) }
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

  return res.json({
    symbols:      symsToFetch,
    portfolioBeta: portfolioBeta != null ? +portfolioBeta.toFixed(3) : null,
    betas:        Object.fromEntries(
      Object.entries(betas).map(([k, v]) => [k, v != null ? +v.toFixed(3) : null])
    ),
    correlations,
    sectors,
    benchmark: 'SPY',
  })
})

module.exports = router
