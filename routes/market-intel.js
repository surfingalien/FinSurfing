'use strict'

/**
 * routes/market-intel.js
 *
 * FinViz-inspired market intelligence endpoints.
 *
 * GET /api/market-intel/insider   — insider trades (by symbol or recent market-wide)
 * GET /api/market-intel/analyst   — analyst upgrades / downgrades
 * GET /api/market-intel/sectors   — sector + industry performance
 * GET /api/market-intel/screener  — live FMP stock screener
 * GET /api/market-intel/overview  — major ETF snapshot (SPY/QQQ/DIA/IWM/TLT/GLD)
 */

const express = require('express')
const router  = express.Router()

const CACHE     = new Map()
const DEFAULT_TTL = 10 * 60 * 1000  // 10 min

function getKey(req) {
  return (req.headers['x-fmp-key'] || '').trim() || process.env.FMP_API_KEY || null
}

async function fmpFetch(path, key, ttl = DEFAULT_TTL) {
  const sep = path.includes('?') ? '&' : '?'
  const url = `https://financialmodelingprep.com/api${path}${sep}apikey=${key}`
  const now = Date.now()
  const hit = CACHE.get(url)
  if (hit && now - hit.ts < ttl) return hit.data
  const ctrl = new AbortController()
  const tid  = setTimeout(() => ctrl.abort(), 15_000)
  try {
    const r    = await fetch(url, { signal: ctrl.signal })
    if (!r.ok) throw new Error(`FMP HTTP ${r.status}`)
    const data = await r.json()
    CACHE.set(url, { data, ts: now })
    return data
  } finally { clearTimeout(tid) }
}

// Prune stale cache entries every 30 min
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000
  for (const [k, v] of CACHE) if (v.ts < cutoff) CACHE.delete(k)
}, 30 * 60 * 1000)

// ── Insider Trades ────────────────────────────────────────────────────────────
// ?symbol=AAPL  → company-specific trades (page,limit accepted)
// (no symbol)   → recent market-wide trades
router.get('/insider', async (req, res) => {
  const key = getKey(req)
  if (!key) return res.status(400).json({ error: 'FMP API key required — add it in Settings → API Keys.' })
  const { symbol, page = 0, limit = 50 } = req.query
  try {
    const sym  = symbol ? symbol.toUpperCase().replace(/[^A-Z0-9.^-]/g, '') : null
    const path = sym
      ? `/v4/insider-trading?symbol=${sym}&page=${page}&limit=${limit}`
      : `/v4/insider-trading?page=${page}&limit=${limit}`
    const data = await fmpFetch(path, key, 5 * 60 * 1000)
    return res.json(Array.isArray(data) ? data : [])
  } catch (e) {
    console.error('[market-intel/insider]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Analyst Upgrades / Downgrades ─────────────────────────────────────────────
// ?symbol=AAPL  → per-symbol feed + consensus
// (no symbol)   → recent cross-market feed
router.get('/analyst', async (req, res) => {
  const key = getKey(req)
  if (!key) return res.status(400).json({ error: 'FMP API key required — add it in Settings → API Keys.' })
  const { symbol, page = 0 } = req.query
  try {
    let ratingsData, consensusData = null
    if (symbol) {
      const sym = symbol.toUpperCase().replace(/[^A-Z0-9.^-]/g, '')
      const [ratingsR, consensusR] = await Promise.allSettled([
        fmpFetch(`/v4/upgrades-downgrades?symbol=${sym}`, key),
        fmpFetch(`/v3/rating/${sym}`, key),
      ])
      ratingsData   = ratingsR.status   === 'fulfilled' ? ratingsR.value   : []
      consensusData = consensusR.status === 'fulfilled' ? consensusR.value : null
    } else {
      ratingsData = await fmpFetch(`/v4/upgrades-downgrades-grading-company?page=${page}`, key)
    }
    return res.json({
      ratings:   Array.isArray(ratingsData)   ? ratingsData   : [],
      consensus: Array.isArray(consensusData) ? consensusData[0] ?? null : null,
    })
  } catch (e) {
    console.error('[market-intel/analyst]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Sector + Industry Performance ─────────────────────────────────────────────
router.get('/sectors', async (req, res) => {
  const key = getKey(req)
  if (!key) return res.status(400).json({ error: 'FMP API key required.' })
  try {
    const [sectorsR, industriesR] = await Promise.allSettled([
      fmpFetch('/v3/sectors-performance', key),
      fmpFetch('/v3/industries-performance', key),
    ])
    return res.json({
      sectors:    sectorsR.status    === 'fulfilled' ? (sectorsR.value    ?? []) : [],
      industries: industriesR.status === 'fulfilled' ? (industriesR.value ?? []) : [],
    })
  } catch (e) {
    console.error('[market-intel/sectors]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Live Stock Screener ────────────────────────────────────────────────────────
router.get('/screener', async (req, res) => {
  const key = getKey(req)
  if (!key) return res.status(400).json({ error: 'FMP API key required.' })
  const {
    sector, exchange, country = 'US',
    priceMin, priceMax,
    marketCapMin, marketCapMax,
    volumeMin, betaMin, betaMax,
    dividendMin, limit = 200,
  } = req.query
  try {
    let path = `/v3/stock-screener?limit=${Math.min(+limit || 200, 500)}&isEtf=false&isActivelyTrading=true`
    if (sector)       path += `&sector=${encodeURIComponent(sector)}`
    if (exchange)     path += `&exchange=${encodeURIComponent(exchange)}`
    if (country)      path += `&country=${encodeURIComponent(country)}`
    if (priceMin)     path += `&priceMoreThan=${+priceMin}`
    if (priceMax)     path += `&priceLowerThan=${+priceMax}`
    if (marketCapMin) path += `&marketCapMoreThan=${+marketCapMin}`
    if (marketCapMax) path += `&marketCapLowerThan=${+marketCapMax}`
    if (volumeMin)    path += `&volumeMoreThan=${+volumeMin}`
    if (betaMin)      path += `&betaMoreThan=${+betaMin}`
    if (betaMax)      path += `&betaLowerThan=${+betaMax}`
    if (dividendMin)  path += `&dividendMoreThan=${+dividendMin}`
    const data = await fmpFetch(path, key, 5 * 60 * 1000)
    return res.json(Array.isArray(data) ? data : [])
  } catch (e) {
    console.error('[market-intel/screener]', e.message)
    res.status(500).json({ error: e.message })
  }
})

// ── Market Overview ────────────────────────────────────────────────────────────
// Returns quotes for major benchmark ETFs + VIX proxy
router.get('/overview', async (req, res) => {
  const key = getKey(req)
  if (!key) return res.status(400).json({ error: 'FMP API key required.' })
  const SYMBOLS = ['SPY', 'QQQ', 'DIA', 'IWM', 'TLT', 'GLD', 'VXX']
  try {
    const data = await fmpFetch(`/v3/quote/${SYMBOLS.join(',')}`, key, 60 * 1000)
    return res.json(Array.isArray(data) ? data : [])
  } catch (e) {
    console.error('[market-intel/overview]', e.message)
    res.status(500).json({ error: e.message })
  }
})

module.exports = router
