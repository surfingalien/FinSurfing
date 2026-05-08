import express from 'express'
import cors from 'cors'
import { createRequire } from 'module'
import { fileURLToPath } from 'url'
import path from 'path'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const app = express()
const PORT = parseInt(process.env.PORT, 10) || 3001

app.use(cors())
app.use(express.json())

// Always serve the built React app (dist/ is always present in production container)
app.use(express.static(path.join(__dirname, 'dist')))

const YF_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Accept-Language': 'en-US,en;q=0.9',
  'Referer': 'https://finance.yahoo.com/',
  'Origin': 'https://finance.yahoo.com',
}

/* ── Quote (batch) ─────────────────────────────── */
app.get('/api/quote', async (req, res) => {
  try {
    const symbols = (req.query.symbols || '').split(',').filter(Boolean)
    if (!symbols.length) return res.status(400).json({ error: 'symbols required' })

    const yfUrl = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${symbols.join(',')}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketVolume,marketCap,trailingPE,fiftyTwoWeekHigh,fiftyTwoWeekLow,shortName,longName,regularMarketDayHigh,regularMarketDayLow,regularMarketOpen,regularMarketPreviousClose`
    const r = await fetch(yfUrl, { headers: YF_HEADERS, signal: AbortSignal.timeout(10000) })
    const data = await r.json()
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ── Chart (OHLCV) ─────────────────────────────── */
app.get('/api/chart', async (req, res) => {
  try {
    const { symbol, interval = '1d', range = '1y' } = req.query
    if (!symbol) return res.status(400).json({ error: 'symbol required' })

    const yfUrl = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`
    const r = await fetch(yfUrl, { headers: YF_HEADERS, signal: AbortSignal.timeout(15000) })
    const data = await r.json()
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ── Fundamentals ──────────────────────────────── */
app.get('/api/summary', async (req, res) => {
  try {
    const { symbol, modules = 'summaryDetail,financialData,defaultKeyStatistics,assetProfile' } = req.query
    if (!symbol) return res.status(400).json({ error: 'symbol required' })

    const yfUrl = `https://query1.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(symbol)}?modules=${modules}`
    const r = await fetch(yfUrl, { headers: YF_HEADERS, signal: AbortSignal.timeout(15000) })
    const data = await r.json()
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ── Search / autocomplete ─────────────────────── */
app.get('/api/search', async (req, res) => {
  try {
    const { q } = req.query
    if (!q) return res.status(400).json({ error: 'q required' })

    const yfUrl = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=10&newsCount=0&enableFuzzyQuery=false&quotesQueryId=tss_match_phrase_query`
    const r = await fetch(yfUrl, { headers: YF_HEADERS, signal: AbortSignal.timeout(10000) })
    const data = await r.json()
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ── News ──────────────────────────────────────── */
app.get('/api/news', async (req, res) => {
  try {
    const { symbol } = req.query
    const q = symbol || 'stock market'
    const yfUrl = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&quotesCount=0&newsCount=8`
    const r = await fetch(yfUrl, { headers: YF_HEADERS, signal: AbortSignal.timeout(10000) })
    const data = await r.json()
    res.json(data)
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// SPA fallback — serve index.html for all non-API routes
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'dist', 'index.html'))
})

// Bind to 0.0.0.0 so Railway's proxy can reach the container
app.listen(PORT, '0.0.0.0', () => {
  console.log(`FinSurf running on http://0.0.0.0:${PORT}`)
})
