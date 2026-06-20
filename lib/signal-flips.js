'use strict'

/**
 * lib/signal-flips.js
 *
 * Pure detection of signal direction changes between consecutive scans —
 * "tell me the moment the model changes its mind" alerts for watchlist and
 * holdings symbols. Consumed by the hourly scan job, which broadcasts flips
 * over the existing alert SSE stream.
 *
 * A flip requires the symbol to be present in BOTH snapshots (first sighting
 * of a symbol is not a flip). Severity:
 *   'high'   — direct bullish↔bearish crossing (e.g. BUY → SELL)
 *   'normal' — any other change (e.g. BUY → HOLD, HOLD → SELL)
 */

// Accept both underscore form (trading-analysis schema) and spaced form (AI Brain agentVerdict)
const BULLISH = new Set(['BUY', 'STRONG_BUY', 'STRONG BUY', 'MODERATE BUY', 'ACCUMULATE'])
const BEARISH = new Set(['SELL', 'STRONG_SELL', 'STRONG SELL', 'MODERATE SELL', 'AVOID', 'REDUCE'])

function camp(signal) {
  const s = String(signal || '').toUpperCase()
  if (BULLISH.has(s)) return 'bullish'
  if (BEARISH.has(s)) return 'bearish'
  if (!s) return null
  return 'neutral'
}

/**
 * prev/curr: { SYMBOL: 'BUY' | 'SELL' | 'HOLD' | ... }
 * → [{ symbol, from, to, severity }]
 */
function detectFlips(prev = {}, curr = {}) {
  const flips = []
  for (const [symbol, to] of Object.entries(curr)) {
    const from = prev[symbol]
    if (from == null || to == null) continue
    const f = String(from).toUpperCase(), t = String(to).toUpperCase()
    if (f === t) continue
    const cf = camp(f), ct = camp(t)
    if (!cf || !ct) continue
    flips.push({
      symbol,
      from: f,
      to:   t,
      severity: (cf === 'bullish' && ct === 'bearish') || (cf === 'bearish' && ct === 'bullish')
        ? 'high' : 'normal',
    })
  }
  return flips
}

module.exports = { detectFlips, camp }
