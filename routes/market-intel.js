'use strict'
/**
 * routes/market-intel.js
 *
 * Free alternative data endpoints used by Agent Hub.
 *
 * GET /api/market-intel/insider?symbol=AAPL&limit=10
 *   → SEC EDGAR full-text search for Form 4 insider transactions (free, no key)
 *
 * GET /api/market-intel/analyst?symbol=AAPL
 *   → Analyst ratings via FMP free tier (falls back to Finnhub)
 *
 * GET /api/market-intel/short?symbol=AAPL
 *   → FINRA short interest (bi-weekly, free public data)
 */

const express = require('express')
const router  = express.Router()

// ── helpers ───────────────────────────────────────────────────────────────────

function extractKeys(req) {
  return {
    fmp:     req.headers['x-fmp-key']     || process.env.FMP_API_KEY     || '',
    finnhub: req.headers['x-finnhub-key'] || process.env.FINNHUB_API_KEY || '',
  }
}

async function safeFetch(url, timeoutMs = 10_000) {
  const ctrl = new AbortController()
  const tid  = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    return await r.json()
  } finally {
    clearTimeout(tid)
  }
}

// ── GET /insider ──────────────────────────────────────────────────────────────
// SEC EDGAR full-text search: Form 4 filings for a symbol (free, no auth)

router.get('/insider', async (req, res) => {
  const symbol = (req.query.symbol || '').toUpperCase().trim()
  const limit  = Math.min(parseInt(req.query.limit) || 10, 20)

  if (!symbol) return res.status(400).json({ error: 'symbol required' })

  try {
    // EDGAR full-text search — free public API
    const searchUrl = `https://efts.sec.gov/LATEST/search-index?q=%22${encodeURIComponent(symbol)}%22&dateRange=custom&startdt=${daysAgo(90)}&forms=4&hits.hits._source=period_of_report,entity_name,file_date,display_date_filed`
    const raw = await safeFetch(searchUrl)

    const hits = raw?.hits?.hits || []
    const transactions = hits.slice(0, limit).map(h => {
      const s = h._source || {}
      return {
        filingDate:  s.file_date || s.display_date_filed || null,
        period:      s.period_of_report || null,
        filerName:   s.entity_name || 'Unknown',
        formType:    '4',
        accession:   h._id || null,
      }
    })

    res.json({
      symbol,
      source: 'SEC EDGAR (Form 4)',
      count:  transactions.length,
      transactions,
    })
  } catch (err) {
    res.status(502).json({ error: `SEC EDGAR fetch failed: ${err.message}` })
  }
})

// ── GET /analyst ──────────────────────────────────────────────────────────────
// Analyst ratings: FMP free → Finnhub fallback

router.get('/analyst', async (req, res) => {
  const symbol = (req.query.symbol || '').toUpperCase().trim()
  if (!symbol) return res.status(400).json({ error: 'symbol required' })

  const { fmp, finnhub } = extractKeys(req)

  // Try FMP first
  if (fmp) {
    try {
      const data = await safeFetch(
        `https://financialmodelingprep.com/api/v3/analyst-stock-recommendations/${symbol}?limit=10&apikey=${fmp}`
      )
      if (Array.isArray(data) && data.length) {
        const summary = summariseRatings(data)
        return res.json({ symbol, source: 'FMP', summary, ratings: data.slice(0, 10) })
      }
    } catch {}
  }

  // Try Finnhub
  if (finnhub) {
    try {
      const to   = new Date().toISOString().slice(0, 10)
      const from = daysAgo(90)
      const data = await safeFetch(
        `https://finnhub.io/api/v1/stock/recommendation?symbol=${symbol}&token=${finnhub}`
      )
      if (Array.isArray(data) && data.length) {
        const latest = data[0]
        return res.json({
          symbol,
          source: 'Finnhub',
          summary: {
            strongBuy:  latest.strongBuy,
            buy:        latest.buy,
            hold:       latest.hold,
            sell:       latest.sell,
            strongSell: latest.strongSell,
            period:     latest.period,
          },
          ratings: data.slice(0, 6),
        })
      }
    } catch {}
  }

  // No key available — return empty but valid response
  res.json({
    symbol,
    source: 'unavailable',
    note:   'Set FMP_API_KEY or FINNHUB_API_KEY for analyst ratings',
    summary: null,
    ratings: [],
  })
})

// ── GET /short ────────────────────────────────────────────────────────────────
// FINRA short interest — free public bi-weekly data

router.get('/short', async (req, res) => {
  const symbol = (req.query.symbol || '').toUpperCase().trim()
  if (!symbol) return res.status(400).json({ error: 'symbol required' })

  try {
    // FINRA OTC/equity short interest API (free, no key)
    const url = `https://regsho.finra.org/regsho-Index.html`
    // Use FINRA's market data API endpoint
    const apiUrl = `https://api.finra.org/data/group/otcMarket/name/weeklySummary?limit=2&compareFilters=[{"compareType":"EQUAL","fieldName":"issueSymbolIdentifier","fieldValue":"${symbol}"}]`
    const data = await safeFetch(apiUrl)

    if (Array.isArray(data) && data.length) {
      return res.json({
        symbol,
        source: 'FINRA',
        shortData: data.map(d => ({
          weekStartDate:    d.weekStartDate,
          totalShortVolume: d.totalShortParQuantity,
          totalVolume:      d.totalParQuantity,
          shortRatio:       d.totalParQuantity
            ? +(d.totalShortParQuantity / d.totalParQuantity * 100).toFixed(1)
            : null,
        })),
      })
    }

    res.json({ symbol, source: 'FINRA', shortData: [], note: 'No FINRA short data found for this symbol' })
  } catch (err) {
    res.status(502).json({ error: `FINRA fetch failed: ${err.message}` })
  }
})

// ── utils ─────────────────────────────────────────────────────────────────────

function daysAgo(n) {
  const d = new Date()
  d.setDate(d.getDate() - n)
  return d.toISOString().slice(0, 10)
}

function summariseRatings(data) {
  const counts = { strongBuy: 0, buy: 0, hold: 0, sell: 0, strongSell: 0 }
  for (const r of data) {
    counts.strongBuy  += r.analystRatingsStrongBuy  || 0
    counts.buy        += r.analystRatingsbuy        || 0
    counts.hold       += r.analystRatingsHold       || 0
    counts.sell       += r.analystRatingsSell       || 0
    counts.strongSell += r.analystRatingsStrongSell || 0
  }
  return counts
}

module.exports = router
