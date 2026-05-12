/**
 * aiTraderService.js
 *
 * Frontend API calls to the FinSurf backend's AI-Trader proxy routes.
 * Never calls ai4trade.ai directly — always goes through /api/trading/* and /api/copy-trading/*.
 */

// Auth token supplied by AITraderContext (in-memory JWT — never in localStorage)
let _authToken = null
export function setAuthToken(token) { _authToken = token }

async function apiFetch(path, opts = {}) {
  const token = _authToken
  const res = await fetch(path, {
    ...opts,
    credentials: 'include',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
  return data
}

// ── Phase 1: Agent + Signal publishing ───────────────────────────────────────

export async function registerAgent() {
  return apiFetch('/api/trading/register-agent', { method: 'POST' })
}

export async function publishSignal({ symbol, action, price, quantity, analysis }) {
  return apiFetch('/api/trading/publish-signal', {
    method: 'POST',
    body: JSON.stringify({ symbol, action, price, quantity, analysis }),
  })
}

export async function getMySignals() {
  return apiFetch('/api/trading/my-signals')
}

export async function getTradingStatus() {
  return apiFetch('/api/trading/status')
}

// ── Phase 2: Notifications ────────────────────────────────────────────────────

export async function getNotifications() {
  return apiFetch('/api/trading/notifications')
}

export async function markNotificationsRead(ids) {
  return apiFetch('/api/trading/notifications/read', {
    method: 'POST',
    body: JSON.stringify({ ids }),
  })
}

// ── Phase 3: Copy Trading ─────────────────────────────────────────────────────

export async function getLeaderboard(limit = 20) {
  return apiFetch(`/api/copy-trading/leaderboard?limit=${limit}`)
}

export async function getFollowing() {
  return apiFetch('/api/copy-trading/following')
}

export async function followTrader(leaderId, leaderName) {
  return apiFetch(`/api/copy-trading/follow/${leaderId}`, {
    method: 'POST',
    body: JSON.stringify({ leaderName }),
  })
}

export async function unfollowTrader(leaderId) {
  return apiFetch(`/api/copy-trading/unfollow/${leaderId}`, { method: 'POST' })
}

// ── Phase 4: Market context ───────────────────────────────────────────────────

export async function getMarketContext(symbol) {
  const q = symbol ? `?symbol=${encodeURIComponent(symbol)}` : ''
  return apiFetch(`/api/trading/market-context${q}`)
}
