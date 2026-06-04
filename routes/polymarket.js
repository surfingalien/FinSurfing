'use strict'
/**
 * routes/polymarket.js
 *
 * Polymarket prediction market data — proxied from the public Gamma API.
 * No API key required. Results cached 5 minutes.
 *
 * Endpoints:
 *   GET /api/polymarket/search?q=NVDA&limit=10
 *   GET /api/polymarket/markets?tag=crypto&limit=20
 *   GET /api/polymarket/tags
 */

const express   = require('express')
const rateLimit = require('express-rate-limit')

const router = express.Router()

const GAMMA_BASE = 'https://gamma-api.polymarket.com'
const PM_TTL     = 5 * 60_000   // 5-minute cache

// ── Simple in-process cache ───────────────────────────────────────────────────
const _cache = new Map()
function pmCacheGet(key) {
  const entry = _cache.get(key)
  if (!entry) return null
  if (Date.now() - entry.ts > PM_TTL) { _cache.delete(key); return null }
  return entry.data
}
function pmCacheSet(key, data) { _cache.set(key, { data, ts: Date.now() }) }

// ── Gamma API fetch helper ────────────────────────────────────────────────────
async function gammaFetch(path, timeoutMs = 10_000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(`${GAMMA_BASE}${path}`, {
      headers: { 'Accept': 'application/json', 'User-Agent': 'FinSurfing/1.0' },
      signal: ctrl.signal,
    })
    if (!res.ok) throw new Error(`Gamma API ${res.status}`)
    return await res.json()
  } finally {
    clearTimeout(timer)
  }
}

// ── Shape a raw market object into what the UI needs ──────────────────────────
function shapeMarket(m) {
  let outcomes    = []
  let prices      = []
  try { outcomes = typeof m.outcomes    === 'string' ? JSON.parse(m.outcomes)    : (m.outcomes    || []) } catch {}
  try { prices   = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : (m.outcomePrices || []) } catch {}

  // Yes probability is first outcome price (0–1 float)
  const yesPct = prices[0] != null ? Math.round(parseFloat(prices[0]) * 100) : null

  return {
    id:          m.id          || m.conditionId,
    conditionId: m.conditionId || m.id,
    slug:        m.slug,
    question:    m.question,
    outcomes,
    prices:      prices.map(p => parseFloat(p)),
    yesPct,
    volume:      parseFloat(m.volume   || 0),
    liquidity:   parseFloat(m.liquidity || 0),
    endDate:     m.endDate     || null,
    active:      m.active      ?? true,
    closed:      m.closed      ?? false,
    tags:        (m.tags || []).map(t => t.slug || t.label || t),
    url:         m.slug ? `https://polymarket.com/event/${m.slug}` : 'https://polymarket.com',
  }
}

// ── Rate limits ───────────────────────────────────────────────────────────────
const pmLimit = rateLimit({
  windowMs: 60_000, max: 30,
  message: { error: 'Too many Polymarket requests — wait a minute' },
})

// ── GET /api/polymarket/tags ──────────────────────────────────────────────────
router.get('/tags', pmLimit, async (req, res) => {
  const cached = pmCacheGet('tags')
  if (cached) return res.json(cached)
  try {
    const data = await gammaFetch('/tags')
    const tags = (Array.isArray(data) ? data : [])
      .filter(t => t.forceShow || ['crypto', 'finance', 'politics', 'sports', 'science', 'pop-culture'].includes(t.slug))
      .map(t => ({ id: t.id, slug: t.slug, label: t.label }))
    pmCacheSet('tags', { tags })
    return res.json({ tags })
  } catch (err) {
    console.error('[polymarket/tags]', err.message)
    return res.status(502).json({ error: err.message })
  }
})

// ── GET /api/polymarket/search?q=NVDA&limit=10 ───────────────────────────────
router.get('/search', pmLimit, async (req, res) => {
  const q     = (req.query.q || '').slice(0, 120).trim()
  const limit = Math.min(parseInt(req.query.limit) || 10, 30)
  if (!q) return res.status(400).json({ error: 'q is required' })

  const cacheKey = `search:${q.toLowerCase()}:${limit}`
  const cached   = pmCacheGet(cacheKey)
  if (cached) return res.json(cached)

  try {
    const params = new URLSearchParams({ search: q, limit, active: 'true' })
    const data   = await gammaFetch(`/markets?${params}`)
    const markets = (Array.isArray(data) ? data : []).map(shapeMarket)
    const result  = { markets, total: markets.length, query: q }
    pmCacheSet(cacheKey, result)
    return res.json(result)
  } catch (err) {
    console.error('[polymarket/search]', err.message)
    return res.status(502).json({ error: err.message })
  }
})

// ── GET /api/polymarket/markets?tag=crypto&limit=20&offset=0 ─────────────────
router.get('/markets', pmLimit, async (req, res) => {
  const tag    = (req.query.tag  || '').slice(0, 60).trim()
  const limit  = Math.min(parseInt(req.query.limit)  || 20, 50)
  const offset = Math.max(parseInt(req.query.offset) || 0,  0)

  const cacheKey = `markets:${tag}:${limit}:${offset}`
  const cached   = pmCacheGet(cacheKey)
  if (cached) return res.json(cached)

  try {
    const params = new URLSearchParams({ limit, offset, active: 'true', order: 'volume', ascending: 'false' })
    if (tag) params.set('tag_slug', tag)
    const data    = await gammaFetch(`/markets?${params}`)
    const markets = (Array.isArray(data) ? data : []).map(shapeMarket)
    const result  = { markets, total: markets.length, tag, offset }
    pmCacheSet(cacheKey, result)
    return res.json(result)
  } catch (err) {
    console.error('[polymarket/markets]', err.message)
    return res.status(502).json({ error: err.message })
  }
})

module.exports = router
