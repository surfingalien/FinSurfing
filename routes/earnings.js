'use strict'

/**
 * routes/earnings.js  (F)
 *
 * Earnings calendar — upcoming earnings dates for a list of symbols.
 * Pulls calendarEvents + summaryDetail from Yahoo Finance (same proxy pattern as /api/summary).
 *
 * GET /api/earnings/calendar?symbols=AAPL,MSFT,NVDA,...
 * GET /api/earnings/date?symbol=AAPL   (single-symbol quick check)
 */

const express = require('express')
const router  = express.Router()

const YF1 = 'https://query1.finance.yahoo.com'
const YF2 = 'https://query2.finance.yahoo.com'

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://finance.yahoo.com/',
  'Origin':          'https://finance.yahoo.com',
  'sec-fetch-dest':  'empty',
  'sec-fetch-mode':  'cors',
  'sec-fetch-site':  'same-site',
}

async function yfGet(url) {
  const res  = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(12000) })
  if (!res.ok) return null
  const text = await res.text()
  try { return JSON.parse(text) } catch { return null }
}

async function fetchEarningsForSymbol(symbol) {
  const modules = 'calendarEvents,summaryDetail,price'
  const path    = `/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}&corsDomain=finance.yahoo.com`
  let data      = await yfGet(`${YF1}${path}`)
  if (!data)    data = await yfGet(`${YF2}${path}`)
  // v11 fallback
  if (!data) {
    const p11 = `/v11/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`
    data = await yfGet(`${YF1}${p11}`) || await yfGet(`${YF2}${p11}`)
  }
  if (!data)    return { symbol, error: 'unavailable' }

  const result = data?.quoteSummary?.result?.[0]
  if (!result) return { symbol, error: 'no data' }

  const cal   = result.calendarEvents   || {}
  const price = result.price            || {}
  const sd    = result.summaryDetail    || {}

  // Earnings dates can be a range or a single date
  const earningsDateRaw = cal.earnings?.earningsDate || []
  const earningsDates   = earningsDateRaw
    .map(d => d.raw ? new Date(d.raw * 1000).toISOString().slice(0, 10) : null)
    .filter(Boolean)

  const nextDate = earningsDates[0] || null

  return {
    symbol:             symbol.toUpperCase(),
    name:               price.shortName || price.longName || symbol,
    nextEarningsDate:   nextDate,
    earningsDates,
    epsEstimate:        cal.earnings?.earningsAverage?.fmt   || null,
    epsLow:             cal.earnings?.earningsLow?.fmt       || null,
    epsHigh:            cal.earnings?.earningsHigh?.fmt      || null,
    revenueEstimate:    cal.earnings?.revenueAverage?.fmt    || null,
    exDividendDate:     cal.exDividendDate?.fmt              || null,
    dividendDate:       cal.dividendDate?.fmt                || null,
    currentPrice:       price.regularMarketPrice?.raw        || null,
    changePct:          price.regularMarketChangePercent?.raw || null,
    marketCap:          price.marketCap?.fmt                 || null,
    sector:             price.sector || null,
    trailingPE:         sd.trailingPE?.raw                   || null,
  }
}

// ── GET /api/earnings/calendar ────────────────────────────────────────────────

router.get('/calendar', async (req, res) => {
  const raw = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)

  // Default to a broad set of large-caps if no symbols provided
  const DEFAULT_SYMBOLS = [
    'AAPL','MSFT','NVDA','GOOGL','AMZN','META','TSLA','AMD','INTC','QCOM',
    'JPM','GS','BAC','WFC','MS','V','MA',
    'JNJ','PFE','MRK','ABBV',
    'XOM','CVX',
    'WMT','COST','TGT','AMZN',
    'SPY','QQQ',
  ]
  const symbols = raw.length ? raw.slice(0, 40) : DEFAULT_SYMBOLS

  try {
    // Fetch in parallel batches of 8 to avoid rate limiting
    const results = []
    for (let i = 0; i < symbols.length; i += 8) {
      const batch = symbols.slice(i, i + 8)
      const batchResults = await Promise.all(batch.map(s => fetchEarningsForSymbol(s).catch(() => ({ symbol: s, error: 'fetch failed' }))))
      results.push(...batchResults)
    }

    // Filter to those with upcoming earnings (next 60 days), sort by date
    const today    = new Date()
    const cutoff   = new Date(today.getTime() + 60 * 24 * 60 * 60 * 1000)

    const upcoming = results
      .filter(r => {
        if (!r.nextEarningsDate) return false
        const d = new Date(r.nextEarningsDate)
        return d >= today && d <= cutoff
      })
      .sort((a, b) => a.nextEarningsDate.localeCompare(b.nextEarningsDate))

    const noDate = results.filter(r => !r.nextEarningsDate && !r.error)

    res.json({ upcoming, noDate, total: results.length })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ── GET /api/earnings/date ────────────────────────────────────────────────────

router.get('/date', async (req, res) => {
  const { symbol } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  try {
    const result = await fetchEarningsForSymbol(symbol.toUpperCase())
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
