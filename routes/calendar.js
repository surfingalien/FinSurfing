'use strict'
/**
 * routes/calendar.js
 *
 * GET /api/calendar/events
 *   Economic calendar for the next 14 days (+ 3-day lookback).
 *   Free-first: Finnhub (keyless endpoint) → stale cache on error.
 *   Optional: set TRADING_ECONOMICS_KEY for richer data.
 *
 * Returns:
 *   { events: [{id,date,time,name,country,importance,actual,forecast,previous,impactScore,affectedAssets}],
 *     source, generatedAt, cached }
 *
 * Cache: 1h (calendar data changes infrequently during market hours)
 */

const express = require('express')
const router  = express.Router()

const CACHE_TTL_MS = 60 * 60_000   // 1 hour
const _cache = { ts: 0, data: null }

// Importance tiers (maps Finnhub 1–3 to labels)
const IMP_MAP = { 1: 'low', 2: 'medium', 3: 'high', high: 'high', medium: 'medium', low: 'low' }

// Assets affected by each event type (used for prompt injection)
const EVENT_ASSETS = {
  rate:      ['DXY', 'BONDS', 'SPY', 'GLD'],
  inflation: ['GLD', 'TIPS', 'DXY', 'SPY'],
  labor:     ['SPY', 'DXY', 'QQQ'],
  gdp:       ['SPY', 'DXY', 'BTC-USD'],
  trade:     ['DXY', 'CNY', 'EWJ'],
  oil:       ['USO', 'XLE', 'DXY'],
  default:   ['SPY', 'DXY'],
}

function classifyEvent(name) {
  const n = (name || '').toLowerCase()
  if (/rate|fed|fomc|boj|boe|ecb|central bank/.test(n)) return 'rate'
  if (/cpi|ppi|inflation|price index/.test(n)) return 'inflation'
  if (/payroll|nfp|employment|jobs|unemployment|jobless/.test(n)) return 'labor'
  if (/gdp|growth/.test(n)) return 'gdp'
  if (/trade|export|import|balance/.test(n)) return 'trade'
  if (/oil|opec|crude|eia/.test(n)) return 'oil'
  return 'default'
}

function impactScore(importance, hasActual) {
  const base = { high: 80, medium: 50, low: 20 }[importance] ?? 30
  return hasActual ? Math.min(100, base + 10) : base
}

// Normalize a Finnhub calendar event row
function normalizeFinnhub(row, idx) {
  const name = (row.event || '').trim()
  if (!name) return null
  const importance = IMP_MAP[row.importance] ?? 'low'
  const hasActual  = row.actual != null && row.actual !== ''
  const eventType  = classifyEvent(name)
  return {
    id:            `fh-${idx}-${row.date || ''}`,
    date:          row.date     || null,
    time:          row.time     || '00:00',
    name,
    country:       (row.country || 'US').toUpperCase(),
    currency:      (row.unit    || row.currency || '').toUpperCase() || null,
    importance,
    actual:        row.actual   ?? null,
    forecast:      row.estimate ?? null,
    previous:      row.prev     ?? null,
    impactScore:   impactScore(importance, hasActual),
    eventType,
    affectedAssets: EVENT_ASSETS[eventType] ?? EVENT_ASSETS.default,
    source:        'finnhub',
  }
}

async function fetchFinnhubCalendar(apiKey) {
  const today    = new Date()
  const from     = new Date(today); from.setDate(from.getDate() - 3)
  const to       = new Date(today); to.setDate(to.getDate() + 14)
  const fmt      = d => d.toISOString().slice(0, 10)
  const base     = 'https://finnhub.io/api/v1/calendar/economic'
  const url      = `${base}?from=${fmt(from)}&to=${fmt(to)}${apiKey ? `&token=${apiKey}` : ''}`

  const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!r.ok) throw new Error(`Finnhub HTTP ${r.status}`)
  const data = await r.json()
  const rows = data.economicCalendar ?? data.data ?? data ?? []
  if (!Array.isArray(rows)) throw new Error('Unexpected Finnhub response shape')

  return rows
    .map((row, i) => normalizeFinnhub(row, i))
    .filter(Boolean)
    .sort((a, b) => {
      const impRank = { high: 0, medium: 1, low: 2 }
      return (impRank[a.importance] ?? 2) - (impRank[b.importance] ?? 2) || a.date.localeCompare(b.date)
    })
}

// ── GET /api/calendar/events ─────────────────────────────────────────────────
router.get('/events', async (req, res) => {
  if (_cache.data && Date.now() - _cache.ts < CACHE_TTL_MS) {
    return res.json({ ..._cache.data, cached: true })
  }

  const finnhubKey = process.env.FINNHUB_API_KEY || null

  try {
    const events = await fetchFinnhubCalendar(finnhubKey)
    const payload = {
      events,
      source:      'finnhub',
      generatedAt: new Date().toISOString(),
      cached:      false,
    }
    _cache.ts   = Date.now()
    _cache.data = payload
    return res.json(payload)
  } catch (err) {
    console.warn('[calendar] Finnhub fetch failed:', err.message)
    // Serve stale cache rather than failing hard
    if (_cache.data) return res.json({ ..._cache.data, cached: true, stale: true })
    return res.status(503).json({ error: 'Economic calendar unavailable', events: [] })
  }
})

// ── GET /api/calendar/summary — compact string for prompt injection ───────────
router.get('/summary', async (req, res) => {
  if (!_cache.data) return res.json({ summary: null })
  const high = _cache.data.events.filter(e => e.importance === 'high' && !e.actual)
  if (!high.length) return res.json({ summary: 'No high-impact events in the next 14 days.' })
  const lines = high.slice(0, 5).map(e => `${e.date} ${e.time} ${e.country} ${e.name}${e.forecast ? ` (fcst: ${e.forecast})` : ''}`)
  return res.json({ summary: `Upcoming high-impact events: ${lines.join(' | ')}` })
})

module.exports = router
