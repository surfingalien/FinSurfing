const express = require('express')
const cors    = require('cors')
const path    = require('path')

const app  = express()
const PORT = parseInt(process.env.PORT, 10) || 3001

app.use(cors())
app.use(express.json())
app.use(express.static(path.join(__dirname, 'dist')))

/* ── Safe fetch helpers ────────────────────────── */
const YF1 = 'https://query1.finance.yahoo.com'
const YF2 = 'https://query2.finance.yahoo.com'

const HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer':         'https://finance.yahoo.com/',
  'Origin':          'https://finance.yahoo.com',
  'sec-ch-ua':       '"Chromium";v="124"',
  'sec-fetch-dest':  'empty',
  'sec-fetch-mode':  'cors',
  'sec-fetch-site':  'same-site',
}

async function yfFetch(url, timeoutMs = 10000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    // Try query1 first, fall back to query2
    const base = url.startsWith(YF1) ? url : url
    const res  = await fetch(base, { headers: HEADERS, signal: ctrl.signal })
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      // Yahoo returned non-JSON (rate limit / bot challenge) — try query2
      const alt = url.replace(YF1, YF2).replace(YF2 + YF2.slice(YF2.indexOf('/')), YF2)
      const res2  = await fetch(url.includes(YF1) ? url.replace(YF1, YF2) : url.replace(YF2, YF1),
                                { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) })
      const text2 = await res2.text()
      try { return JSON.parse(text2) } catch { return null }
    }
  } finally {
    clearTimeout(timer)
  }
}

/* ── Price via chart v8 (most reliable from cloud IPs) */
async function getChartQuote(symbol) {
  const url  = `${YF1}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2d`
  const data = await yfFetch(url, 12000)
  const r    = data?.chart?.result?.[0]
  if (!r) return null
  const m    = r.meta || {}
  return {
    symbol:    m.symbol || symbol,
    name:      m.symbol || symbol,
    price:     m.regularMarketPrice      ?? m.previousClose ?? null,
    change:    m.regularMarketChange     ?? null,
    changePct: m.regularMarketChangePercent ?? null,
    volume:    m.regularMarketVolume     ?? null,
    high52:    m.fiftyTwoWeekHigh        ?? null,
    low52:     m.fiftyTwoWeekLow         ?? null,
    dayHigh:   m.regularMarketDayHigh    ?? null,
    dayLow:    m.regularMarketDayLow     ?? null,
    open:      m.regularMarketOpen       ?? null,
    prevClose: m.previousClose           ?? null,
    marketCap: null,
    pe:        null,
  }
}

/* ── Health ────────────────────────────────────── */
app.get('/health', (_req, res) => res.json({ ok: true, ts: Date.now() }))

/* ── Quote (batch) ─────────────────────────────── */
app.get('/api/quote', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').filter(Boolean)
  if (!symbols.length) return res.status(400).json({ error: 'symbols required' })
  try {
    // Try v7 quote endpoint first
    const url  = `${YF1}/v7/finance/quote?symbols=${symbols.join(',')}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketVolume,marketCap,trailingPE,fiftyTwoWeekHigh,fiftyTwoWeekLow,shortName,longName,regularMarketDayHigh,regularMarketDayLow,regularMarketOpen,regularMarketPreviousClose`
    const data = await yfFetch(url, 12000)
    const results = data?.quoteResponse?.result
    if (results && results.length) {
      return res.json({ quoteResponse: { result: results } })
    }
    // Fallback: fetch each symbol via chart API (works on more IPs)
    const quotes = await Promise.all(
      symbols.map(s => getChartQuote(s).catch(() => ({ symbol: s, price: null })))
    )
    res.json({ quoteResponse: { result: quotes } })
  } catch (e) {
    // Last resort: return empty quotes so UI shows dashes, not crash
    res.json({ quoteResponse: { result: symbols.map(s => ({ symbol: s, price: null })) } })
  }
})

/* ── Chart (OHLCV) ─────────────────────────────── */
app.get('/api/chart', async (req, res) => {
  const { symbol, interval = '1d', range = '1y' } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  try {
    const url  = `${YF1}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`
    const data = await yfFetch(url, 15000)
    if (data) return res.json(data)
    const url2 = url.replace(YF1, YF2)
    const d2   = await yfFetch(url2, 15000)
    res.json(d2 || { chart: { result: null, error: { code: 'blocked', description: 'Rate limited' } } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ── Fundamentals ──────────────────────────────── */
app.get('/api/summary', async (req, res) => {
  const { symbol, modules = 'summaryDetail,financialData,defaultKeyStatistics,assetProfile' } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  try {
    const url  = `${YF1}/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`
    const data = await yfFetch(url, 15000)
    if (data) return res.json(data)
    const url2 = url.replace(YF1, YF2)
    res.json(await yfFetch(url2, 15000) || {})
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ── Search ────────────────────────────────────── */
app.get('/api/search', async (req, res) => {
  const { q } = req.query
  if (!q) return res.status(400).json({ error: 'q required' })
  try {
    const url  = `${YF2}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`
    const data = await yfFetch(url, 10000)
    res.json(data || { quotes: [] })
  } catch (e) {
    res.json({ quotes: [] })
  }
})

/* ── News ──────────────────────────────────────── */
app.get('/api/news', async (req, res) => {
  const q   = req.query.symbol || 'stock market'
  try {
    const url  = `${YF1}/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=8`
    const data = await yfFetch(url, 10000)
    res.json(data || { news: [] })
  } catch (e) {
    res.json({ news: [] })
  }
})

/* ── SPA fallback ──────────────────────────────── */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FinSurf listening on 0.0.0.0:${PORT}`)
})
