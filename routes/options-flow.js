'use strict'
/**
 * routes/options-flow.js
 *
 * GET /api/options/flow?symbol=AAPL
 *
 * Provider cascade:
 *   1. Polygon.io — real greeks, IV surface, unusual volume (best quality)
 *   2. FMP /api/v3/options/{symbol} — full chain, compute P/C + IV stats
 *   3. Synthetic from recent price volatility if all else fails
 */

const express = require('express')
const { INTERNAL_SECRET } = require('../lib/internal-secret')
const router  = express.Router()

// ── 1. Polygon.io options chain ───────────────────────────────────────────────
async function fetchPolygonOptions(symbol, polygonKey) {
  if (!polygonKey) return null
  try {
    // Get snapshot for the ticker (includes IV, greeks, P/C data)
    const snapUrl = `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(symbol)}?limit=250&apiKey=${polygonKey}`
    const r = await fetch(snapUrl, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return null
    const data = await r.json()
    const results = data?.results
    if (!Array.isArray(results) || !results.length) return null

    // Get spot price from the first result's underlying
    const spot = results[0]?.underlying_asset?.price || null

    // Filter to nearest 3 expiries, strikes within 15% of spot
    const expiries = [...new Set(results.map(o => o.details?.expiration_date))].filter(Boolean).sort().slice(0, 3)
    const near = results.filter(o =>
      expiries.includes(o.details?.expiration_date) &&
      (spot ? Math.abs((o.details?.strike_price || spot) - spot) / spot < 0.15 : true)
    )

    let callVol = 0, putVol = 0, callOI = 0, putOI = 0
    const unusual = []
    let atmIV = null
    let closestStrikeDist = Infinity

    for (const o of near) {
      const vol  = o.day?.volume || 0
      const oi   = o.open_interest || 0
      const type = o.details?.contract_type?.toLowerCase()
      const iv   = o.implied_volatility
      const strike = o.details?.strike_price

      if (type === 'call') { callVol += vol; callOI += oi }
      else if (type === 'put') { putVol += vol; putOI += oi }

      // Track ATM IV
      if (spot && strike && iv) {
        const dist = Math.abs(strike - spot)
        if (dist < closestStrikeDist) { closestStrikeDist = dist; atmIV = +(iv * 100).toFixed(1) }
      }

      // Unusual: vol > 3× OI
      if (oi > 0 && vol > oi * 3 && vol > 100) {
        unusual.push({
          type, strike, expiry: o.details?.expiration_date,
          volume: vol, oi,
          iv: iv ? +(iv * 100).toFixed(1) : null,
          delta: o.greeks?.delta ? +o.greeks.delta.toFixed(2) : null,
        })
      }
    }

    const pcRatio = callVol > 0 ? +(putVol / callVol).toFixed(2) : null

    return {
      symbol: symbol.toUpperCase(), spot: spot ? +spot.toFixed(2) : null,
      pcRatio, atmIV, callVol, putVol, callOI, putOI,
      unusual: unusual.sort((a, b) => b.volume - a.volume).slice(0, 5),
      expiries, source: 'polygon',
    }
  } catch (e) {
    console.warn(`[options-flow] Polygon error for ${symbol}:`, e.message)
    return null
  }
}

// ── 2. FMP options chain ──────────────────────────────────────────────────────
async function fetchFMPOptions(symbol, fmpKey) {
  if (!fmpKey) return null
  try {
    const url = `https://financialmodelingprep.com/api/v3/options/${encodeURIComponent(symbol)}?apikey=${fmpKey}`
    const r = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!r.ok) return null
    const data = await r.json()
    const chain = data?.optionChain || []
    if (!chain.length) return null

    // Filter to nearest 2 expiries, strikes within 15% of current price
    const spot = chain[0]?.underlyingPrice || chain[0]?.strike
    const expiryDates = [...new Set(chain.map(c => c.expirationDate))].sort().slice(0, 2)
    const near = chain.filter(c => expiryDates.includes(c.expirationDate) && spot
      ? Math.abs(c.strike - spot) / spot < 0.15
      : true
    )

    const calls = near.filter(c => c.optionType === 'call' || c.type === 'call')
    const puts  = near.filter(c => c.optionType === 'put'  || c.type === 'put')

    const callVol   = calls.reduce((s, c) => s + (c.volume || c.openInterest || 0), 0)
    const putVol    = puts.reduce((s,  c) => s + (c.volume || c.openInterest || 0), 0)
    const pcRatio   = callVol > 0 ? +(putVol / callVol).toFixed(2) : null

    // ATM IV — closest strike to spot price
    const sortedByStrike = near
      .filter(c => c.impliedVolatility != null)
      .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
    const atmIV = sortedByStrike[0]?.impliedVolatility
      ? +(sortedByStrike[0].impliedVolatility * 100).toFixed(1)
      : null

    // Unusual activity — contracts with volume > 3x open interest
    const unusual = near
      .filter(c => c.volume && c.openInterest && c.volume > c.openInterest * 3)
      .sort((a, b) => b.volume - a.volume)
      .slice(0, 3)
      .map(c => ({
        type:   c.optionType || c.type,
        strike: c.strike,
        expiry: c.expirationDate,
        volume: c.volume,
        oi:     c.openInterest,
        iv:     c.impliedVolatility ? +(c.impliedVolatility * 100).toFixed(1) : null,
      }))

    return {
      symbol:   symbol.toUpperCase(),
      spot:     spot ? +spot.toFixed(2) : null,
      pcRatio,
      atmIV,
      callVol,
      putVol,
      unusual,
      expiries: expiryDates,
      source:   'fmp',
    }
  } catch (e) {
    console.warn(`[options-flow] FMP error for ${symbol}:`, e.message)
    return null
  }
}

// ── Fallback: synthetic IV from 30d price volatility ─────────────────────────
async function fetchSyntheticFlow(symbol, port, fwdHeaders) {
  try {
    const r = await fetch(
      `http://127.0.0.1:${port}/api/chart?symbol=${encodeURIComponent(symbol)}&interval=1d&range=3mo`,
      { headers: fwdHeaders, signal: AbortSignal.timeout(8000) }
    )
    const data = await r.json()
    const closes = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close?.filter(Boolean) || []
    if (closes.length < 20) return null

    // Annualised historical vol (30d)
    const window = closes.slice(-30)
    const logRets = window.slice(1).map((c, i) => Math.log(c / window[i]))
    const mean    = logRets.reduce((a, b) => a + b, 0) / logRets.length
    const variance = logRets.reduce((a, b) => a + (b - mean) ** 2, 0) / logRets.length
    const hvol30   = +(Math.sqrt(variance * 252) * 100).toFixed(1)

    return {
      symbol:  symbol.toUpperCase(),
      spot:    +closes.at(-1).toFixed(2),
      pcRatio: null,
      atmIV:   hvol30,
      callVol: null,
      putVol:  null,
      unusual: [],
      source:  'synthetic-hvol',
    }
  } catch { return null }
}

// ── Format as plain-text snippet for Copilot ─────────────────────────────────
function formatFlowSnippet(d) {
  if (!d) return null
  const pcLabel = d.pcRatio != null
    ? d.pcRatio < 0.7 ? `${d.pcRatio} 🟢 (bullish — more call buying)`
    : d.pcRatio > 1.2 ? `${d.pcRatio} 🔴 (bearish — put protection buying)`
    : `${d.pcRatio} ⚪ (neutral)`
    : 'N/A'

  const ivLabel = d.atmIV != null
    ? `${d.atmIV}% (${d.source === 'synthetic-hvol' ? '30d hist vol' : 'ATM implied vol'})`
    : 'N/A'

  let lines = [
    `**${d.symbol} Options Flow** [${d.source}]`,
    d.spot    ? `Spot: $${d.spot}` : '',
    `Put/Call Ratio: ${pcLabel}`,
    `IV: ${ivLabel}`,
  ].filter(Boolean)

  if (d.callVol != null && d.putVol != null) {
    lines.push(`Call Volume: ${d.callVol.toLocaleString()} · Put Volume: ${d.putVol.toLocaleString()}`)
  }

  if (d.unusual?.length) {
    lines.push('\nUnusual Activity (volume > 3× OI):')
    d.unusual.forEach(u => {
      lines.push(`  ${u.type?.toUpperCase()} $${u.strike} exp ${u.expiry} — vol ${u.volume?.toLocaleString()} vs OI ${u.oi?.toLocaleString()}${u.iv ? ` (IV ${u.iv}%)` : ''}`)
    })
  }

  if (d.expiries?.length) {
    lines.push(`\nNearest expiries: ${d.expiries.join(', ')}`)
  }

  // Interpretation hint
  if (d.pcRatio != null) {
    if (d.pcRatio < 0.7 && d.unusual?.some(u => u.type === 'call')) {
      lines.push('\n📊 Signal: Strong bullish options positioning — unusual call buying with low P/C ratio. Smart money may be positioning for upside move in 1–3 weeks.')
    } else if (d.pcRatio > 1.3) {
      lines.push('\n📊 Signal: Elevated put buying — market participants hedging or betting on downside. Could indicate near-term caution.')
    } else {
      lines.push('\n📊 Signal: Options flow is neutral — no strong directional conviction from options market.')
    }
  }

  return lines.join('\n')
}

// ── Route ─────────────────────────────────────────────────────────────────────
router.get('/flow', async (req, res) => {
  const symbol = (req.query.symbol || '').trim().toUpperCase().replace(/[^A-Z0-9.-]/g, '')
  if (!symbol) return res.status(400).json({ error: 'symbol required' })

  const polygonKey = process.env.POLYGON_API_KEY || process.env.MASSIVE_API_KEY || null
  const fmpKey     = (req.headers['x-fmp-key'] || '').trim() || process.env.FMP_API_KEY || null
  const port       = process.env.PORT || 3001
  const fwdHdrs    = { 'Content-Type': 'application/json', 'x-internal': '1', 'x-internal-secret': INTERNAL_SECRET }
  if (req.headers['x-fmp-key'])      fwdHdrs['x-fmp-key']      = req.headers['x-fmp-key']
  if (req.headers['x-finnhub-key'])  fwdHdrs['x-finnhub-key']  = req.headers['x-finnhub-key']

  let flow = await fetchPolygonOptions(symbol, polygonKey)
  if (!flow) flow = await fetchFMPOptions(symbol, fmpKey)
  if (!flow) flow = await fetchSyntheticFlow(symbol, port, fwdHdrs)

  if (!flow) return res.status(502).json({ error: 'Options data unavailable for ' + symbol })

  res.json({
    ...flow,
    snippet: formatFlowSnippet(flow),
  })
})

module.exports = router
module.exports.formatFlowSnippet = formatFlowSnippet
