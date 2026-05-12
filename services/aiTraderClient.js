'use strict'

/**
 * AI-Trader API client
 *
 * Wraps all communication with https://ai4trade.ai so the rest of the
 * codebase never touches raw fetch calls to that domain.
 *
 * All methods throw on network failures; callers should try/catch.
 */

const BASE = 'https://ai4trade.ai'
const TIMEOUT_MS = 15000

async function atFetch(path, opts = {}) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS)
  try {
    const res = await fetch(`${BASE}${path}`, {
      ...opts,
      signal: ctrl.signal,
      headers: {
        'Content-Type': 'application/json',
        ...(opts.headers || {}),
      },
    })
    const text = await res.text()
    let body
    try { body = JSON.parse(text) } catch { body = { raw: text } }
    if (!res.ok) throw Object.assign(new Error(body?.message || body?.error || `AI-Trader ${res.status}`), { status: res.status, body })
    return body
  } finally {
    clearTimeout(timer)
  }
}

function authHeader(token) {
  return { Authorization: `Bearer ${token}` }
}

// ── Agent registration ────────────────────────────────────────────────────────

async function registerAgent({ name, email, password }) {
  return atFetch('/api/claw/agents/selfRegister', {
    method: 'POST',
    body: JSON.stringify({ name, email, password }),
  })
}

async function loginAgent({ email, password }) {
  return atFetch('/api/claw/agents/login', {
    method: 'POST',
    body: JSON.stringify({ email, password }),
  })
}

// ── Signal publishing ─────────────────────────────────────────────────────────

async function publishSignal(token, { market = 'us-stock', action, symbol, price, quantity, content }) {
  const body = {
    market,
    action,
    symbol,
    content,
    executed_at: new Date().toISOString(),
  }
  if (price    != null) body.price    = price
  if (quantity != null) body.quantity = quantity
  return atFetch('/api/signals/realtime', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify(body),
  })
}

// ── Heartbeat (notifications) ─────────────────────────────────────────────────

async function pollHeartbeat(token) {
  return atFetch('/api/claw/agents/heartbeat', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({}),
  })
}

// ── Leaderboard / signals ─────────────────────────────────────────────────────

async function getTopTraders({ limit = 20 } = {}) {
  return atFetch(`/api/signals/grouped?limit=${limit}`)
}

async function getSignalsBySymbol(symbol, { limit = 20 } = {}) {
  return atFetch(`/api/signals/realtime?symbol=${encodeURIComponent(symbol)}&limit=${limit}`)
}

// ── Follow / unfollow ─────────────────────────────────────────────────────────

async function followTrader(token, leaderId) {
  return atFetch('/api/signals/follow', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ leader_id: leaderId }),
  })
}

async function unfollowTrader(token, leaderId) {
  return atFetch('/api/signals/unfollow', {
    method: 'POST',
    headers: authHeader(token),
    body: JSON.stringify({ leader_id: leaderId }),
  })
}

// ── Market intel ──────────────────────────────────────────────────────────────

async function getMarketOverview() {
  return atFetch('/api/market-intel/overview')
}

async function getMarketNews(symbol) {
  const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''
  return atFetch(`/api/market-intel/news${q}`)
}

module.exports = {
  registerAgent,
  loginAgent,
  publishSignal,
  pollHeartbeat,
  getTopTraders,
  getSignalsBySymbol,
  followTrader,
  unfollowTrader,
  getMarketOverview,
  getMarketNews,
}
