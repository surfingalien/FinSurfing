'use strict'
/**
 * lib/alert-broadcaster.js
 *
 * In-process SSE broadcaster for alert-triggered AI analyses.
 *
 * The client connects to GET /api/alerts/stream.
 * When a price alert fires on the client, it calls POST /api/alerts/trigger
 * which runs analyze_symbol in background and pushes the result here
 * to all connected SSE clients.
 *
 * Exports:
 *   subscribe(res)    → clientId  (call on SSE connection)
 *   unsubscribe(id)   → void
 *   broadcast(event)  → void      (called after analyze_symbol completes)
 */

const _clients = new Map()  // clientId → res

function subscribe(res) {
  const id = `ac-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  _clients.set(id, res)
  return id
}

function unsubscribe(id) {
  _clients.delete(id)
}

function broadcast(event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`
  for (const [id, res] of _clients) {
    try {
      res.write(payload)
    } catch {
      _clients.delete(id)
    }
  }
}

module.exports = { subscribe, unsubscribe, broadcast }
