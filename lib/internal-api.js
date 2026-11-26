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
async function fetchDailyBars(symbol, { range = '6mo', headers = {}, timeoutMs = 15_000, income = false } = {}) {
  const bars = await fetchPriceBars(symbol, { range, headers, timeoutMs })
  // Strategy backtests compare with buy & hold, so they ask for the cash flows a
  // price series leaves out — dividends and T-bill interest on idle cash (lib/income.js).
  return income && bars.length ? require('./income').attachIncome(bars, symbol) : bars
}

async function fetchPriceBars(symbol, { range, headers, timeoutMs }) {
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
    // A provider that could not split-adjust (Alpha Vantage's free series without
    // a split list) and shows a split-sized one-day move: refuse it rather than
    // pass a fake crash on. A data gap is reported; a wrong history is not.
    if (res0?.meta?.splitAdjusted === false) {
      const jumps = require('./split-guard').suspectJumps(ts, q.close)
      if (jumps.length) return noBars(`price history from ${res0.meta.provider || 'the provider'} is not adjusted for a stock split (a ${jumps[0].ratio >= 1 ? jumps[0].ratio + '-for-1' : '1-for-' + Math.round(1 / jumps[0].ratio)} move on ${jumps[0].date})`)
    }
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
