const express = require('express')
const cors    = require('cors')
const path    = require('path')

const app  = express()
const PORT = parseInt(process.env.PORT, 10) || 3001

app.use(cors())
app.use(express.json())

// Serve the built React app
app.use(express.static(path.join(__dirname, 'dist')))

const YF_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer':         'https://finance.yahoo.com/',
  'Origin':          'https://finance.yahoo.com',
}

/* ── Health ────────────────────────────────────── */
app.get('/health', (_req, res) => res.json({ ok: true }))

/* ── Quote (batch) ─────────────────────────────── */
app.get('/api/quote', async (req, res) => {
  try {
    const symbols = (req.query.symbols || '').split(',').filter(Boolean)
    if (!symbols.length) return res.status(400).json({ error: 'symbols required' })
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketVolume,marketCap,trailingPE,fiftyTwoWeekHigh,fiftyTwoWeekLow,shortName,longName,regularMarketDayHigh,regularMarketDayLow,regularMarketOpen,regularMarketPreviousClose`
    const r    = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(10000) })
    res.json(await r.json())
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ── Chart (OHLCV) ─────────────────────────────── */
app.get('/api/chart', async (req, res) => {
  try {
    const { symbol, interval = '1d', range = '1y' } = req.query
    if (!symbol) return res.status(400).json({ error: 'symbol required' })
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`
    const r   = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(15000) })
    res.json(await r.json())
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ── Fundamentals ──────────────────────────────── */
app.get('/api/summary', async (req, res) => {
  try {
    const { symbol, modules = 'summaryDetail,financialData,defaultKeyStatistics,assetProfile' } = req.query
    if (!symbol) return res.status(400).json({ error: 'symbol required' })
    const url = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`
    const r   = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(15000) })
    res.json(await r.json())
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ── Search ────────────────────────────────────── */
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query
    if (!q) return res.status(400).json({ error: 'q required' })
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0`
    const r   = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(10000) })
    res.json(await r.json())
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ── News ──────────────────────────────────────── */
app.get('/api/news', async (req, res) => {
  try {
    const q   = req.query.symbol || 'stock market'
    const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=8`
    const r   = await fetch(url, { headers: YF_HEADERS, signal: AbortSignal.timeout(10000) })
    res.json(await r.json())
  } catch (e) { res.status(500).json({ error: e.message }) }
})

/* ── SPA fallback ──────────────────────────────── */
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FinSurf listening on 0.0.0.0:${PORT}`)
})
