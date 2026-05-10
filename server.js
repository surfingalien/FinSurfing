const express      = require('express')
const cors         = require('cors')
const path         = require('path')
const fs           = require('fs')
const helmet       = require('helmet')
const cookieParser = require('cookie-parser')
const rateLimit    = require('express-rate-limit')

const authRoutes      = require('./routes/auth')
const portfolioRoutes = require('./routes/portfolios')
const publicRoutes    = require('./routes/public')
const adminRoutes     = require('./routes/admin')

// ── Auto-migrate: run schema.sql when DATABASE_URL is present ────────────────
// Runs once at startup; all CREATE TABLE / CREATE INDEX statements use
// IF NOT EXISTS so repeated runs are safe (idempotent).
;(async () => {
  if (!process.env.DATABASE_URL) {
    console.log('[DB] No DATABASE_URL — running in memory mode')
    return
  }
  try {
    const { query } = require('./db/db')
    const schemaPath = path.join(__dirname, 'db', 'schema.sql')
    if (!fs.existsSync(schemaPath)) {
      console.warn('[DB] schema.sql not found — skipping migration')
      return
    }
    const sql = fs.readFileSync(schemaPath, 'utf8')
    // Split on semicolons but keep multi-statement blocks intact.
    // Filter blank / comment-only lines.
    const statements = sql
      .split(/;\s*(\n|$)/)
      .map(s => s.trim())
      .filter(s => s.length > 0 && !s.startsWith('--'))
    for (const stmt of statements) {
      await query(stmt).catch(err => {
        // Log but continue — some statements may fail on partial schemas
        console.warn('[DB] migration stmt warning:', err.message.slice(0, 120))
      })
    }
    console.log('[DB] Schema migration complete')
  } catch (err) {
    console.error('[DB] Migration failed:', err.message)
  }
})()

const app  = express()
const PORT = parseInt(process.env.PORT, 10) || 3001
const PROD = process.env.NODE_ENV === 'production'

// ── Security headers (OWASP-recommended) ─────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'"],   // Vite needs inline scripts
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:', 'https:'],
      connectSrc:  ["'self'", 'https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com'],
      fontSrc:     ["'self'", 'data:'],
      objectSrc:   ["'none'"],
      upgradeInsecureRequests: PROD ? [] : null,
    },
  },
  hsts: PROD ? { maxAge: 31536000, includeSubDomains: true } : false,
  frameguard: { action: 'deny' },
  xssFilter: true,
  noSniff: true,
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
}))

// ── CORS — tighten in production ──────────────────
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS?.split(',') || ['http://localhost:5173']
app.use(cors({
  origin: PROD ? ALLOWED_ORIGINS : true,
  credentials: true,   // allow cookies on cross-origin in dev
}))

app.use(cookieParser())
app.use(express.json({ limit: '256kb' }))
app.use(express.static(path.join(__dirname, 'dist')))

// ── Rate limiting (OWASP auth defence) ───────────
const baseLimit = rateLimit({
  windowMs: 60 * 1000, max: 120, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests — slow down' },
})

const publicLimit = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Too many requests — slow down' },
})

const authLoginLimit = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10, skipSuccessfulRequests: true,
  message: { error: 'Too many login attempts — try again in 15 minutes' },
})

const authRegisterLimit = rateLimit({
  windowMs: 60 * 60 * 1000, max: 5,
  message: { error: 'Too many registrations from this IP' },
})

const authForgotLimit = rateLimit({
  windowMs: 60 * 60 * 1000, max: 3,
  message: { error: 'Too many password reset requests — try again in 1 hour' },
})

app.use('/api', baseLimit)
app.use('/api/auth/login',           authLoginLimit)
app.use('/api/auth/register',        authRegisterLimit)
app.use('/api/auth/forgot-password', authForgotLimit)

// ── Auth & Portfolio routes ───────────────────────
app.use('/api/auth',       authRoutes)
app.use('/api/portfolios', portfolioRoutes)
app.use('/api/public',     publicLimit, publicRoutes)
app.use('/api/admin',      adminRoutes)

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

  const price     = m.regularMarketPrice ?? null
  // chart API returns chartPreviousClose (not previousClose) for change base
  const prevClose = m.chartPreviousClose ?? m.previousClose ?? null
  // Yahoo rarely includes regularMarketChange in chart meta — compute it
  const change    = m.regularMarketChange
    ?? (price != null && prevClose != null ? +((price - prevClose).toFixed(4)) : null)
  const changePct = m.regularMarketChangePercent
    ?? (change != null && prevClose != null ? +((change / prevClose * 100).toFixed(4)) : null)

  return {
    symbol:    m.symbol || symbol,
    name:      m.symbol || symbol,
    price,
    change,
    changePct,
    volume:    m.regularMarketVolume  ?? null,
    high52:    m.fiftyTwoWeekHigh     ?? null,
    low52:     m.fiftyTwoWeekLow      ?? null,
    dayHigh:   m.regularMarketDayHigh ?? null,
    dayLow:    m.regularMarketDayLow  ?? null,
    open:      m.regularMarketOpen    ?? null,
    prevClose,
    marketCap: null,
    pe:        null,
  }
}

/* ── Health (includes DB status + demo mode) ───── */
app.get('/health', async (_req, res) => {
  const demoMode = !process.env.DATABASE_URL
  let dbOk = false
  if (!demoMode) {
    try { const { ping } = require('./db/db'); dbOk = await ping() } catch {}
  }
  res.json({ ok: true, db: dbOk, demoMode, ts: Date.now() })
})

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
