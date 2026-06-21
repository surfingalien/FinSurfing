'use strict'
/**
 * routes/sentiment-adanos.js
 *
 * GET /api/sentiment/adanos?symbols=AAPL,TSLA&source=reddit&days=7
 *   source: reddit | x | news | polymarket (default: reddit)
 *   days:   1-30 (default: 7)
 *
 * Returns:
 *   { enabled, provider, source, days, stocks: [{ticker, sentimentScore, buzzScore,
 *     bullishPct, bearishPct, mentions, trend}], cached }
 *
 * Requires ADANOS_API_KEY env var. Returns enabled:false gracefully when absent.
 * Cache: 15 min per (symbols+source+days) key.
 */

const express = require('express')
const router  = express.Router()

const BASE_URL     = 'https://api.adanos.org'
const CACHE_TTL_MS = 15 * 60_000
const _cache       = new Map()

const SOURCES = {
  reddit:     'reddit/stocks/v1',
  x:          'x/stocks/v1',
  news:       'news/stocks/v1',
  polymarket: 'polymarket/stocks/v1',
}

function cacheKey(symbols, source, days) { return `${symbols.sort().join(',')}|${source}|${days}` }

function normalizeRecord(r, source) {
  const ticker = String(r.ticker || r.symbol || '').replace('$', '').toUpperCase()
  if (!ticker) return null
  return {
    ticker,
    company_name:    r.company_name || r.name || null,
    source,
    sentiment_score: r.sentiment_score ?? r.sentiment ?? r.score ?? null,
    buzz_score:      r.buzz_score      ?? r.buzz      ?? null,
    bullish_pct:     r.bullish_pct     ?? null,
    bearish_pct:     r.bearish_pct     ?? null,
    mentions:        r.mentions        ?? r.mention_count ?? null,
    trend:           r.trend           ?? null,
  }
}

// ── GET /api/sentiment/adanos ────────────────────────────────────────────────
router.get('/', async (req, res) => {
  const apiKey = process.env.ADANOS_API_KEY || ''
  if (!apiKey) return res.json({ enabled: false, provider: 'adanos', error: 'ADANOS_API_KEY not configured', stocks: [] })

  const rawSyms = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase().replace(/[^A-Z0-9.]/g, '')).filter(Boolean).slice(0, 20)
  if (!rawSyms.length) return res.status(400).json({ error: 'symbols required' })

  const source = (['reddit','x','news','polymarket'].includes(req.query.source) ? req.query.source : 'reddit')
  const days   = Math.min(Math.max(parseInt(req.query.days || '7', 10) || 7, 1), 30)

  const ck  = cacheKey(rawSyms, source, days)
  const hit = _cache.get(ck)
  if (hit && Date.now() - hit.ts < CACHE_TTL_MS) return res.json({ ...hit.data, cached: true })

  try {
    const url = new URL(`${BASE_URL}/${SOURCES[source]}/compare`)
    url.searchParams.set('tickers', rawSyms.join(','))
    url.searchParams.set('days', String(days))
    const r2 = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json', 'X-API-Key': apiKey },
      signal:  AbortSignal.timeout(10_000),
    })
    if (!r2.ok) {
      const errBody = await r2.json().catch(() => ({}))
      const errMsg  = errBody.error || errBody.message || `Adanos HTTP ${r2.status}`
      return res.status(502).json({ enabled: true, provider: 'adanos', error: errMsg, stocks: [] })
    }

    const payload = await r2.json()
    const rows    = Array.isArray(payload) ? payload : (payload.stocks || payload.data || payload.results || [])

    // Adanos sometimes returns 200 OK with an error field and no data
    if (!rows.length && payload?.error) {
      return res.status(502).json({ enabled: true, provider: 'adanos', error: payload.error, stocks: [] })
    }

    const stocks  = rows.map(row => normalizeRecord(row, source)).filter(Boolean)

    const data = { enabled: true, provider: 'adanos', source, days, tickers: rawSyms, stocks }
    _cache.set(ck, { ts: Date.now(), data })
    return res.json({ ...data, cached: false })
  } catch (err) {
    return res.status(502).json({ enabled: true, provider: 'adanos', error: err.message, stocks: [] })
  }
})

module.exports = router
