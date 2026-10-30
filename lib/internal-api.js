'use strict'
/**
 * lib/internal-api.js
 *
 * Helpers for calling this server's own market-data API from backend code.
 * Consolidates the chart-fetch logic previously duplicated between
 * lib/brain-learnings.js and routes/ai-brain.js.
 */

// An empty result still says why (`bars.reason`): "0 bars" alone reads as
// "this stock has no history" when the providers were slow or refused it.
const noBars = reason => Object.assign([], { reason })

/**
 * Fetch daily OHLCV bars via the internal /api/chart proxy.
 * Returns [{ t(ms), o, h, l, c, v }] sorted ascending (bars with null closes
 * dropped), or [] on any failure — callers treat missing data as non-fatal;
 * an empty result carries `reason`.
 */
async function fetchDailyBars(symbol, { range = '6mo', headers = {}, timeoutMs = 15_000 } = {}) {
  try {
    const port = process.env.PORT || 3001
    const r = await fetch(
      `http://127.0.0.1:${port}/api/chart?symbol=${encodeURIComponent(symbol)}&interval=1d&range=${range}`,
      { headers, signal: AbortSignal.timeout(timeoutMs) }
    )
    const d    = await r.json()
    const res0 = d?.chart?.result?.[0]
    const ts   = res0?.timestamp
    const q    = res0?.indicators?.quote?.[0]
    if (!ts?.length || !q?.close) return noBars((typeof d?.error === 'string' && d.error) || `chart answered HTTP ${r.status} with no bars`)
    return ts.map((t, i) => ({
      t: t * 1000,
      o: q.open?.[i],  h: q.high?.[i],
      l: q.low?.[i],   c: q.close?.[i],
      v: q.volume?.[i] ?? 0,
    })).filter(b => b.c != null && !isNaN(b.c))
  } catch (e) {
    return noBars(e?.name === 'TimeoutError' || e?.name === 'AbortError'
      ? `the data providers did not answer within ${Math.round(timeoutMs / 1000)}s — the server keeps fetching, so try again in a minute`
      : e.message)
  }
}

module.exports = { fetchDailyBars }
