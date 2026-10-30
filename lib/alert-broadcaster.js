'use strict'
/**
 * lib/alert-broadcaster.js
 *
 * In-process SSE broadcaster for alert-triggered AI analyses.
 *
 * The client connects to GET /api/alerts/stream.
 * When a price alert fires on the client, it calls POST /api/alerts/trigger
 * which runs analyze_symbol in background and pushes the result here
 * to that user's open streams.
 *
 * Exports:
 *   subscribe(res, userId)       → clientId  (call on SSE connection)
 *   unsubscribe(id)              → void
 *   broadcast(event, { userId }) → void      (userId: only that user's streams)
 *
 * The stream is signed-in only. An alert's analysis goes to the user whose
 * alert fired — it used to go to every connected client, signed in or not.
 * System events (AI Brain entry zones, signal flips) go to every subscriber.
 */

const _clients = new Map()  // clientId → { res, userId }

function subscribe(res, userId = null) {
  const id = `ac-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  _clients.set(id, { res, userId })
  return id
}

function unsubscribe(id) {
  _clients.delete(id)
}

function broadcast(event, { userId = null } = {}) {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const [id, client] of _clients) {
    if (userId != null && client.userId !== userId) continue
    try {
      client.res.write(payload)
    } catch {
      _clients.delete(id)
    }
  }
  // Also push analysis events to Telegram (no-op when unconfigured). Fire and
  // forget — must never block or break the SSE broadcast above.
  try { require('./telegram-notify').notifyAnalysis(event) } catch {}
}

module.exports = { subscribe, unsubscribe, broadcast }
