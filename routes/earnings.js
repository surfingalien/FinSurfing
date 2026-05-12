'use strict'

/**
 * routes/earnings.js
 *
 * Earnings calendar — upcoming earnings dates for a list of symbols.
 * Provider priority (same as /api/quote — Yahoo Finance is IP-blocked on Railway):
 *   1. Finnhub  /calendar/earnings  (FINNHUB_API_KEY)
 *   2. FMP      /earning_calendar   (FMP_API_KEY)
 *   3. Yahoo Finance v10 quoteSummary (last resort, often blocked from cloud)
 *
 * GET /api/earnings/calendar?symbols=AAPL,MSFT,NVDA,...
 * GET /api/earnings/date?symbol=AAPL
 */

const express = require('express')
const router  = express.Router()

const DEFAULT_SYMBOLS = [
  'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AMD','INTC','QCOM',
  'JPM','GS','BAC','WFC','MS','V','MA',
  'JNJ','PFE','MRK','ABBV',
  'XOM','CVX',
  'WMT','COST','TGT',
  'SPY','QQQ',
]

// ── Finnhub earnings calendar ─────────────────────────────────────────────────
async function fetchFinnhubEarnings(symbols) {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return null
  try {
    const today  = new Date()
    const from   = today.toISOString().slice(0, 10)
    const to     = new Date(today.getTime() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const r = await fetch(
      `https://finnhub.io/api/v1/calendar/earnings?from=${from}&to=${to}&token=${key}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) }
    )
    const data = await r.json()
    if (!Array.isArray(data?.earningsCalendar)) return null

    const symSet = new Set(symbols.map(s => s.toUpperCase()))
    return data.earningsCalendar
      .filter(e => !symbols.length || symSet.has(e.symbol?.toUpperCase()))
      .map(e => ({
        symbol:           e.symbol?.toUpperCase(),
        name:             e.symbol,
        nextEarningsDate: e.date,
        earningsDates:    [e.date].filter(Boolean),
        epsEstimate:      e.epsEstimate != null ? String(e.epsEstimate) : null,
        epsLow:           null,
        epsHigh:          null,
        revenueEstimate:  e.revenueEstimate != null ? String(e.revenueEstimate) : null,
        currentPrice:     null,
        changePct:        null,
        source:           'finnhub',
      }))
  } catch (e) {
    console.warn('[Finnhub] earnings error:', e.message)
    return null
  }
}

// ── FMP earnings calendar ─────────────────────────────────────────────────────
async function fetchFMPEarnings(symbols) {
  const key = process.env.FMP_API_KEY
  if (!key) return null
  try {
    const today = new Date()
    const from  = today.toISOString().slice(0, 10)
    const to    = new Date(today.getTime() + 90 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const r = await fetch(
      `https://financialmodelingprep.com/api/v3/earning_calendar?from=${from}&to=${to}&apikey=${key}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) }
    )
    const data = await r.json()
    if (!Array.isArray(data) || !data.length) return null

    const symSet = new Set(symbols.map(s => s.toUpperCase()))
    return data
      .filter(e => !symbols.length || symSet.has(e.symbol?.toUpperCase()))
      .map(e => ({
        symbol:           e.symbol?.toUpperCase(),
        name:             e.symbol,
        nextEarningsDate: e.date,
        earningsDates:    [e.date].filter(Boolean),
        epsEstimate:      e.epsEstimated != null ? String(e.epsEstimated) : null,
        epsLow:           null,
        epsHigh:          null,
        revenueEstimate:  e.revenueEstimated != null ? String(e.revenueEstimated) : null,
        currentPrice:     null,
        changePct:        null,
        source:           'fmp',
      }))
  } catch (e) {
    console.warn('[FMP] earnings error:', e.message)
    return null
  }
}

// ── Yahoo Finance fallback (often IP-blocked on Railway) ──────────────────────
const YF1 = 'https://query1.finance.yahoo.com'
const YF2 = 'https://query2.finance.yahoo.com'
const YF_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://finance.yahoo.com/',
  'Origin':          'https://finance.yahoo.com',
}

async function yfGet(url) {
  try {
    const res  = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(8000) })
    if (!res.ok) return null
    const text = await res.text()
    try { return JSON.parse(text) } catch { return null }
  } catch { return null }
}

async function fetchYahooEarningsForSymbol(symbol) {
  const modules = 'calendarEvents,summaryDetail,price'
  const path    = `/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`
  const data    = await yfGet(`${YF1}${path}`) || await yfGet(`${YF2}${path}`)
  if (!data) return null

  const result = data?.quoteSummary?.result?.[0]
  if (!result) return null

  const cal   = result.calendarEvents || {}
  const price = result.price          || {}
  const sd    = result.summaryDetail  || {}

  const earningsDates = (cal.earnings?.earningsDate || [])
    .map(d => d.raw ? new Date(d.raw * 1000).toISOString().slice(0, 10) : null)
    .filter(Boolean)

  return {
    symbol:           symbol.toUpperCase(),
    name:             price.shortName || price.longName || symbol,
    nextEarningsDate: earningsDates[0] || null,
    earningsDates,
    epsEstimate:      cal.earnings?.earningsAverage?.fmt || null,
    epsLow:           cal.earnings?.earningsLow?.fmt     || null,
    epsHigh:          cal.earnings?.earningsHigh?.fmt    || null,
    revenueEstimate:  cal.earnings?.revenueAverage?.fmt  || null,
    exDividendDate:   cal.exDividendDate?.fmt            || null,
    dividendDate:     cal.dividendDate?.fmt              || null,
    currentPrice:     price.regularMarketPrice?.raw      || null,
    changePct:        price.regularMarketChangePercent?.raw || null,
    marketCap:        price.marketCap?.fmt               || null,
    trailingPE:       sd.trailingPE?.raw                 || null,
    source:           'yahoo',
  }
}

// ── Shared result shaping ─────────────────────────────────────────────────────
function filterUpcoming(results) {
  const today  = new Date()
  const cutoff = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000)
  return results
    .filter(r => {
      if (!r.nextEarningsDate) return false
      const d = new Date(r.nextEarningsDate)
      return d >= today && d <= cutoff
    })
    .sort((a, b) => a.nextEarningsDate.localeCompare(b.nextEarningsDate))
}

// ── GET /api/earnings/calendar ────────────────────────────────────────────────
router.get('/calendar', async (req, res) => {
  const symbols = (req.query.symbols || '')
    .split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  const targetSymbols = symbols.length ? symbols.slice(0, 40) : DEFAULT_SYMBOLS

  try {
    // Try Finnhub first (range query — one request for all symbols)
    const fh = await fetchFinnhubEarnings(targetSymbols)
    if (fh && fh.length) {
      const upcoming = filterUpcoming(fh)
      return res.json({ upcoming, noDate: [], total: fh.length, source: 'finnhub' })
    }

    // Try FMP (range query)
    const fmp = await fetchFMPEarnings(targetSymbols)
    if (fmp && fmp.length) {
      const upcoming = filterUpcoming(fmp)
      return res.json({ upcoming, noDate: [], total: fmp.length, source: 'fmp' })
    }

    // Last resort: Yahoo Finance per-symbol (likely blocked on Railway)
    console.warn('[earnings] Finnhub/FMP unavailable — falling back to Yahoo (may fail)')
    const results = []
    for (let i = 0; i < targetSymbols.length; i += 8) {
      const batch = targetSymbols.slice(i, i + 8)
      const batchResults = await Promise.all(
        batch.map(s => fetchYahooEarningsForSymbol(s).catch(() => null))
      )
      results.push(...batchResults.filter(Boolean))
    }

    const upcoming = filterUpcoming(results)
    const noDate   = results.filter(r => !r.nextEarningsDate)
    res.json({ upcoming, noDate, total: results.length, source: 'yahoo' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/earnings/date ────────────────────────────────────────────────────
router.get('/date', async (req, res) => {
  const { symbol } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  const sym = symbol.toUpperCase()
  try {
    // Finnhub single-symbol
    const fh = await fetchFinnhubEarnings([sym])
    if (fh && fh.length) return res.json(fh[0])

    // FMP single-symbol
    const fmp = await fetchFMPEarnings([sym])
    if (fmp && fmp.length) return res.json(fmp[0])

    // Yahoo fallback
    const result = await fetchYahooEarningsForSymbol(sym)
    if (result) return res.json(result)

    res.json({ symbol: sym, error: 'unavailable' })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
