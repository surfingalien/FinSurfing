'use strict'

/**
 * lib/scheduled-jobs.js
 *
 * Registers the three built-in scheduled jobs.
 * Call init() once after the server is listening.
 *
 * Jobs:
 *   pre-market-scan  — daily 8:30 AM  — AI Brain broad scan (top signals)
 *   earnings-watch   — daily 7:00 AM  — upcoming earnings next 5 days
 *   macro-pulse      — hourly :00      — FRED macro refresh + regime summary
 */

const scheduler = require('./scheduler')

const BASE_URL = () => `http://127.0.0.1:${process.env.PORT || 3001}`

async function internalGet(path, timeoutMs = 30_000) {
  const r = await fetch(`${BASE_URL()}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: { 'x-internal': '1' },
  })
  if (!r.ok) throw new Error(`Internal fetch ${path} → HTTP ${r.status}`)
  return r.json()
}

async function internalPost(path, body, timeoutMs = 60_000) {
  const r = await fetch(`${BASE_URL()}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json', 'x-internal': '1' },
    body:    JSON.stringify(body),
    signal:  AbortSignal.timeout(timeoutMs),
  })
  if (!r.ok) {
    const txt = await r.text().catch(() => '')
    throw new Error(`Internal POST ${path} → HTTP ${r.status}: ${txt.slice(0, 200)}`)
  }
  return r.json()
}

// ── Job handlers ──────────────────────────────────────────────────────────────

async function preMarketScan() {
  if (!process.env.ANTHROPIC_API_KEY) return { skipped: true, reason: 'ANTHROPIC_API_KEY not set' }
  const data = await internalPost('/api/ai-brain/scan', { universe: 'broad', maxSignals: 10 }, 90_000)
  const signals = (data.signals ?? []).slice(0, 10).map(s => ({
    symbol: s.symbol, signal: s.signal, confidence: s.confidence, summary: s.summary,
  }))
  return { signals, scannedAt: new Date().toISOString(), universe: 'broad' }
}

async function earningsWatch() {
  const fmpKey = process.env.FMP_API_KEY
  if (!fmpKey) return { skipped: true, reason: 'FMP_API_KEY not set' }
  const today = new Date()
  const from  = today.toISOString().slice(0, 10)
  const to    = new Date(today.getTime() + 5 * 86_400_000).toISOString().slice(0, 10)
  const url   = `https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${fmpKey}`
  const ctrl  = new AbortController()
  const tid   = setTimeout(() => ctrl.abort(), 15_000)
  let data
  try {
    const r = await fetch(url, { signal: ctrl.signal })
    data = await r.json()
  } finally { clearTimeout(tid) }
  const events = Array.isArray(data) ? data.slice(0, 40).map(e => ({
    symbol: e.symbol, date: e.date, eps: e.eps, epsEstimated: e.epsEstimated, time: e.time,
  })) : []
  return { events, from, to, fetchedAt: new Date().toISOString() }
}

async function macroPulse() {
  if (!process.env.FRED_API_KEY) return { skipped: true, reason: 'FRED_API_KEY not set' }
  const data    = await internalGet('/api/macro/indicators', 30_000)
  const summary = await internalGet('/api/macro/summary', 15_000).catch(() => null)
  return {
    regime:    data.regime ?? null,
    signals:   (data.signals ?? []).slice(0, 5),
    summary:   typeof summary === 'string' ? summary : null,
    refreshedAt: new Date().toISOString(),
  }
}

// ── Registration ───────────────────────────────────────────────────────────────

function init() {
  scheduler.register('pre-market-scan', {
    name:        'Pre-Market AI Scan',
    description: 'AI Brain scans the broad market universe for top trade signals before open.',
    schedule:    { type: 'daily', hour: 8, minute: 30 },
    handler:     preMarketScan,
  })

  scheduler.register('earnings-watch', {
    name:        'Earnings Watch',
    description: 'Fetches upcoming earnings for the next 5 days from FMP.',
    schedule:    { type: 'daily', hour: 7, minute: 0 },
    handler:     earningsWatch,
  })

  scheduler.register('macro-pulse', {
    name:        'Macro Pulse',
    description: 'Refreshes FRED macro indicators and extracts the current market regime.',
    schedule:    { type: 'hourly', minute: 0 },
    handler:     macroPulse,
  })

  scheduler.start()
  console.log('[scheduled-jobs] 3 jobs registered')
}

module.exports = { init }
