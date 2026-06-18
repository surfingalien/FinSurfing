'use strict'
// Per-symbol 15-min cache for options flow compact summaries.
// Used by AI Brain batch scan to inject put/call ratio + unusual activity
// into the prompt without hammering the options API on every scan.

const _cache = new Map()  // symbol → { value, expiresAt }
const TTL_MS = 15 * 60_000
const ERR_TTL = 5 * 60_000

async function getOptionsFlowCompact(symbol, port, headers) {
  const key = symbol.toUpperCase()
  const hit = _cache.get(key)
  if (hit && Date.now() < hit.expiresAt) return hit.value

  try {
    const r = await fetch(
      `http://127.0.0.1:${port}/api/options/flow?symbol=${encodeURIComponent(key)}`,
      { headers, signal: AbortSignal.timeout(10_000) }
    )
    if (!r.ok) {
      _cache.set(key, { value: null, expiresAt: Date.now() + ERR_TTL })
      return null
    }
    const d = await r.json()
    if (!d || d.error) {
      _cache.set(key, { value: null, expiresAt: Date.now() + ERR_TTL })
      return null
    }

    const pcLabel = d.pcRatio != null
      ? `P/C=${d.pcRatio}${d.pcRatio < 0.70 ? '🟢' : d.pcRatio > 1.20 ? '🔴' : '⚪'}`
      : ''
    const ivLabel = d.atmIV != null ? `ATM-IV=${d.atmIV}%` : ''
    const unusualCalls = d.unusual?.filter(u => u.type === 'call').length ?? 0
    const unusualPuts  = d.unusual?.filter(u => u.type === 'put').length ?? 0
    const unusualStr = unusualCalls || unusualPuts
      ? ` (${[
          unusualCalls ? `${unusualCalls}unusual-CALL` : '',
          unusualPuts  ? `${unusualPuts}unusual-PUT`  : '',
        ].filter(Boolean).join(' ')})`
      : ''
    const sourceNote = d.source === 'synthetic-hvol' ? ' [hist-vol only]' : ''

    const parts = [pcLabel, ivLabel].filter(Boolean)
    const value = parts.length
      ? `${key}: ${parts.join(' ')}${unusualStr}${sourceNote}`
      : null

    _cache.set(key, { value, expiresAt: Date.now() + TTL_MS })
    return value
  } catch {
    _cache.set(key, { value: null, expiresAt: Date.now() + ERR_TTL })
    return null
  }
}

module.exports = { getOptionsFlowCompact }
