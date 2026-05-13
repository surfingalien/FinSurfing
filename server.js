const express      = require('express')
const cors         = require('cors')
const path         = require('path')
const fs           = require('fs')
const helmet       = require('helmet')
const cookieParser = require('cookie-parser')
const rateLimit    = require('express-rate-limit')

// yahoo-finance2 handles crumb/cookie auth automatically — preferred over raw Yahoo API calls
let yf2
try {
  yf2 = require('yahoo-finance2').default
  yf2.setGlobalConfig({ validation: { logErrors: false, logWarnings: false } })
} catch (e) {
  console.warn('[YF2] yahoo-finance2 unavailable, using raw API only:', e.message)
}

const authRoutes        = require('./routes/auth')
const portfolioRoutes   = require('./routes/portfolios')
const publicRoutes      = require('./routes/public')
const adminRoutes       = require('./routes/admin')
const agentRoutes       = require('./routes/agent')
const tradingRoutes     = require('./routes/trading')
const copyTradingRoutes = require('./routes/copy-trading')
const earningsRoutes    = require('./routes/earnings')
const backtestRoutes    = require('./routes/backtest')
const analyticsRoutes   = require('./routes/analytics')
const rebalancerRoutes  = require('./routes/rebalancer')

const { seedAdminDB } = require('./db/adminSeed')

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

    // Seed admin user + Fidelity portfolio holdings (idempotent — skips if already present)
    const { query: q } = require('./db/db')
    await seedAdminDB(q)
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
      connectSrc:  ["'self'", 'https://query1.finance.yahoo.com', 'https://query2.finance.yahoo.com', 'https://ai4trade.ai'],
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
app.use('/api/auth',         authRoutes)
app.use('/api/portfolios',   portfolioRoutes)
app.use('/api/public',       publicLimit, publicRoutes)
app.use('/api/admin',        adminRoutes)
app.use('/api/agent',        agentRoutes)
app.use('/api/trading',      tradingRoutes)
app.use('/api/copy-trading', copyTradingRoutes)
app.use('/api/earnings',     earningsRoutes)
app.use('/api/backtest',     backtestRoutes)
app.use('/api/analytics',    analyticsRoutes)
app.use('/api/rebalancer',   rebalancerRoutes)

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

// ── Yahoo Finance crumb/cookie cache ──────────────────────────────────────────
// Yahoo's v7 API requires a crumb + session cookie from cloud IPs.
// We fetch once per ~45 min and attach to all raw Yahoo Finance requests.
const yfCrumb = { value: null, cookie: null, fetchedAt: 0 }
const CRUMB_TTL = 45 * 60 * 1000

async function getYFCrumb() {
  if (yfCrumb.value && Date.now() - yfCrumb.fetchedAt < CRUMB_TTL) return yfCrumb
  try {
    const r1 = await fetch('https://finance.yahoo.com/', {
      headers: { ...HEADERS, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' },
      redirect: 'follow',
      signal: AbortSignal.timeout(10000),
    })
    // Collect all Set-Cookie values into a single Cookie header string
    const rawCookie = r1.headers.get('set-cookie') || ''
    const cookie = rawCookie.split(',').map(c => c.trim().split(';')[0]).filter(Boolean).join('; ')
    const r2 = await fetch('https://query1.finance.yahoo.com/v1/test/getcrumb', {
      headers: { ...HEADERS, Cookie: cookie },
      signal: AbortSignal.timeout(8000),
    })
    const crumb = (await r2.text()).trim()
    if (crumb && crumb.length >= 3 && !crumb.startsWith('<')) {
      Object.assign(yfCrumb, { value: crumb, cookie, fetchedAt: Date.now() })
      console.log('[YF] Crumb refreshed')
      return yfCrumb
    }
  } catch (e) {
    console.warn('[YF] crumb fetch failed:', e.message)
  }
  return null
}

async function yfFetch(url, timeoutMs = 10000) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const auth = await getYFCrumb()
    const headers = { ...HEADERS }
    let authUrl = url
    if (auth?.value) {
      headers.Cookie = auth.cookie
      authUrl += (url.includes('?') ? '&' : '?') + `crumb=${encodeURIComponent(auth.value)}`
    }
    const res  = await fetch(authUrl, { headers, signal: ctrl.signal })
    const text = await res.text()
    try {
      return JSON.parse(text)
    } catch {
      // Yahoo returned non-JSON (rate limit / bot challenge) — invalidate crumb and try alt host
      if (auth) { yfCrumb.value = null; yfCrumb.fetchedAt = 0 }
      const altUrl = url.includes(YF1) ? url.replace(YF1, YF2) : url.replace(YF2, YF1)
      const res2   = await fetch(altUrl, { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) })
      const text2  = await res2.text()
      try { return JSON.parse(text2) } catch { return null }
    }
  } finally {
    clearTimeout(timer)
  }
}

// Warm up the crumb cache at startup so the first quote request doesn't pay the cost
setTimeout(() => getYFCrumb().catch(() => {}), 3000)

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
    symbol:      m.symbol || symbol,
    name:        m.symbol || symbol,
    price,
    change,
    changePct,
    volume:      m.regularMarketVolume  ?? null,
    high52:      m.fiftyTwoWeekHigh     ?? null,
    low52:       m.fiftyTwoWeekLow      ?? null,
    dayHigh:     m.regularMarketDayHigh ?? null,
    dayLow:      m.regularMarketDayLow  ?? null,
    open:        m.regularMarketOpen    ?? null,
    prevClose,
    regularMarketTime: m.regularMarketTime ?? null,  // Unix seconds — used for daily P/L reset
    marketCap:   null,
    pe:          null,
  }
}

/* ── Finnhub live quotes (works reliably from cloud IPs) ──────────────────── */
// Finnhub /quote returns { c: price, d: change, dp: changePct, h, l, o, pc, t }
async function getFinnhubQuotes(symbols) {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return null
  try {
    const results = await Promise.all(
      symbols.map(async sym => {
        try {
          const r = await fetch(
            `https://finnhub.io/api/v1/quote?symbol=${encodeURIComponent(sym)}&token=${key}`,
            { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(8000) }
          )
          const d = await r.json()
          if (d?.c == null || d.c === 0) return { symbol: sym, price: null }
          return {
            symbol,
            shortName:                  sym,
            regularMarketPrice:         d.c,
            regularMarketChange:        d.d   ?? null,
            regularMarketChangePercent: d.dp  ?? null,
            regularMarketDayHigh:       d.h   ?? null,
            regularMarketDayLow:        d.l   ?? null,
            regularMarketOpen:          d.o   ?? null,
            regularMarketPreviousClose: d.pc  ?? null,
            regularMarketTime:          d.t   ?? null,
          }
        } catch { return { symbol: sym, price: null } }
      })
    )
    return results
  } catch { return null }
}

/* ── FMP live quotes (batch, works from cloud IPs) ─────────────────────────── */
// FMP /quote/:symbols returns [{ symbol, price, change, changesPercentage, ... }]
async function getFMPQuotes(symbols) {
  const key = process.env.FMP_API_KEY
  if (!key) return null
  try {
    const r = await fetch(
      `https://financialmodelingprep.com/api/v3/quote/${symbols.join(',')}?apikey=${key}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10000) }
    )
    const data = await r.json()
    if (!Array.isArray(data) || !data.length) return null
    return data.map(q => ({
      symbol:                     q.symbol,
      shortName:                  q.name   || q.symbol,
      regularMarketPrice:         q.price                ?? null,
      regularMarketChange:        q.change               ?? null,
      regularMarketChangePercent: q.changesPercentage    ?? null,
      regularMarketVolume:        q.volume               ?? null,
      regularMarketDayHigh:       q.dayHigh              ?? null,
      regularMarketDayLow:        q.dayLow               ?? null,
      regularMarketOpen:          q.open                 ?? null,
      regularMarketPreviousClose: q.previousClose        ?? null,
      regularMarketTime:          q.timestamp            ?? null,
      fiftyTwoWeekHigh:           q.yearHigh             ?? null,
      fiftyTwoWeekLow:            q.yearLow              ?? null,
      marketCap:                  q.marketCap            ?? null,
      trailingPE:                 q.pe                   ?? null,
    }))
  } catch { return null }
}

/* ── Health (includes DB status + demo mode) ───── */
app.get('/health', async (_req, res) => {
  const demoMode = !process.env.DATABASE_URL
  let dbOk = false
  if (!demoMode) {
    try { const { ping } = require('./db/db'); dbOk = await ping() } catch {}
  }
  res.json({ ok: true, db: dbOk, demoMode, finnhub: !!process.env.FINNHUB_API_KEY, fmp: !!process.env.FMP_API_KEY, ts: Date.now() })
})

/* ── Quote (batch) ─────────────────────────────── */
app.get('/api/quote', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').filter(Boolean)
  if (!symbols.length) return res.status(400).json({ error: 'symbols required' })
  try {
    // 1st choice: Finnhub — works reliably from cloud IPs (no Yahoo IP block)
    {
      const fh = await getFinnhubQuotes(symbols).catch(() => null)
      if (fh && fh.some(r => r.regularMarketPrice != null)) {
        return res.json({ quoteResponse: { result: fh } })
      }
    }

    // 2nd choice: FMP batch quote — also cloud-friendly
    {
      const fmp = await getFMPQuotes(symbols).catch(() => null)
      if (fmp && fmp.some(r => r.regularMarketPrice != null)) {
        return res.json({ quoteResponse: { result: fmp } })
      }
    }

    // 3rd choice: yahoo-finance2 (handles crumb internally — last resort for Yahoo)
    if (yf2) {
      try {
        const raw     = await yf2.quote(symbols, {}, { validateResult: false })
        const rawArr  = Array.isArray(raw) ? raw : [raw]
        const results = rawArr.map(q => ({
          symbol:                      q.symbol,
          shortName:                   q.shortName  || q.longName || q.symbol,
          longName:                    q.longName   || q.shortName || q.symbol,
          regularMarketPrice:          q.regularMarketPrice          ?? null,
          regularMarketChange:         q.regularMarketChange         ?? null,
          regularMarketChangePercent:  q.regularMarketChangePercent  ?? null,
          regularMarketVolume:         q.regularMarketVolume         ?? null,
          regularMarketDayHigh:        q.regularMarketDayHigh        ?? null,
          regularMarketDayLow:         q.regularMarketDayLow         ?? null,
          regularMarketOpen:           q.regularMarketOpen           ?? null,
          regularMarketPreviousClose:  q.regularMarketPreviousClose  ?? null,
          regularMarketTime: q.regularMarketTime instanceof Date
            ? Math.floor(q.regularMarketTime.getTime() / 1000)
            : (q.regularMarketTime ?? null),
          fiftyTwoWeekHigh:  q.fiftyTwoWeekHigh  ?? null,
          fiftyTwoWeekLow:   q.fiftyTwoWeekLow   ?? null,
          marketCap:         q.marketCap          ?? null,
          trailingPE:        q.trailingPE         ?? null,
        }))
        if (results.some(r => r.regularMarketPrice != null)) {
          return res.json({ quoteResponse: { result: results } })
        }
      } catch (e) {
        console.warn('[YF2] quote error:', e.message)
      }
    }

    // 4th choice: raw v7 endpoint with crumb
    const url  = `${YF1}/v7/finance/quote?symbols=${symbols.join(',')}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketVolume,marketCap,trailingPE,fiftyTwoWeekHigh,fiftyTwoWeekLow,shortName,longName,regularMarketDayHigh,regularMarketDayLow,regularMarketOpen,regularMarketPreviousClose,regularMarketTime`
    const data = await yfFetch(url, 12000)
    const results = data?.quoteResponse?.result
    if (results && results.length && results.some(r => r.regularMarketPrice != null)) {
      return res.json({ quoteResponse: { result: results } })
    }

    // 5th choice: per-symbol chart API (v8)
    const quotes = await Promise.all(
      symbols.map(s => getChartQuote(s).catch(() => ({ symbol: s, price: null })))
    )
    res.json({ quoteResponse: { result: quotes } })
  } catch (e) {
    res.json({ quoteResponse: { result: symbols.map(s => ({ symbol: s, price: null })) } })
  }
})

/* ── Chart helpers: range → unix timestamps ────────────────────────────── */
function rangeToFromTo(range) {
  const now  = Math.floor(Date.now() / 1000)
  const daysMap = {
    '1d': 2, '5d': 7, '1mo': 35, '3mo': 95,
    '6mo': 185, '1y': 370, '2y': 740, '5y': 1830, 'max': 7300,
  }
  return { from: now - (daysMap[range] || 370) * 86400, to: now }
}
function intervalToFinnhubRes(interval) {
  const m = { '1m':'1','5m':'5','15m':'15','30m':'30','60m':'60','1h':'60','1d':'D','1wk':'W','1mo':'M' }
  return m[interval] || 'D'
}

/* ── Finnhub candles (works from cloud IPs) ────────────────────────────── */
async function getFinnhubCandles(symbol, interval, range) {
  const key = process.env.FINNHUB_API_KEY
  if (!key) return null
  const { from, to } = rangeToFromTo(range)
  const resolution   = intervalToFinnhubRes(interval)
  try {
    const r = await fetch(
      `https://finnhub.io/api/v1/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${resolution}&from=${from}&to=${to}&token=${key}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) }
    )
    const d = await r.json()
    if (d?.s !== 'ok' || !d.t?.length) return null
    return {
      chart: {
        result: [{
          meta:      { symbol, regularMarketPrice: d.c[d.c.length - 1] },
          timestamp: d.t,
          indicators: {
            quote:    [{ open: d.o, high: d.h, low: d.l, close: d.c, volume: d.v }],
            adjclose: [{ adjclose: d.c }],
          },
        }],
        error: null,
      },
    }
  } catch { return null }
}

/* ── FMP historical candles (works from cloud IPs) ─────────────────────── */
async function getFMPCandles(symbol, interval, range) {
  const key = process.env.FMP_API_KEY
  if (!key) return null
  // FMP free-tier only supports daily; skip intraday requests
  if (!['1d', '1wk', '1mo'].includes(interval)) return null
  const { from, to } = rangeToFromTo(range)
  const fromDate = new Date(from * 1000).toISOString().split('T')[0]
  const toDate   = new Date(to   * 1000).toISOString().split('T')[0]
  try {
    const r = await fetch(
      `https://financialmodelingprep.com/api/v3/historical-price-full/${encodeURIComponent(symbol)}?from=${fromDate}&to=${toDate}&apikey=${key}`,
      { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(12000) }
    )
    const d    = await r.json()
    const hist = d?.historical
    if (!Array.isArray(hist) || !hist.length) return null
    const sorted = [...hist].reverse()  // FMP returns newest-first; reverse to oldest-first
    return {
      chart: {
        result: [{
          meta:      { symbol, regularMarketPrice: sorted[sorted.length - 1].close },
          timestamp: sorted.map(h => Math.floor(new Date(h.date).getTime() / 1000)),
          indicators: {
            quote: [{
              open:   sorted.map(h => h.open),
              high:   sorted.map(h => h.high),
              low:    sorted.map(h => h.low),
              close:  sorted.map(h => h.close),
              volume: sorted.map(h => h.volume),
            }],
            adjclose: [{ adjclose: sorted.map(h => h.adjClose ?? h.close) }],
          },
        }],
        error: null,
      },
    }
  } catch { return null }
}

/* ── Chart (OHLCV) ─────────────────────────────── */
app.get('/api/chart', async (req, res) => {
  const { symbol, interval = '1d', range = '1y' } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  try {
    // 1st: Yahoo Finance v8 chart (query1 → query2)
    const url  = `${YF1}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=false`
    const data = await yfFetch(url, 15000)
    if (data?.chart?.result?.[0]) return res.json(data)
    const url2 = url.replace(YF1, YF2)
    const d2   = await yfFetch(url2, 15000)
    if (d2?.chart?.result?.[0]) return res.json(d2)

    // 2nd: Finnhub candles — cloud-IP friendly
    const fhChart = await getFinnhubCandles(symbol, interval, range).catch(() => null)
    if (fhChart) { console.log('[chart] served via Finnhub:', symbol); return res.json(fhChart) }

    // 3rd: FMP historical — cloud-IP friendly (daily only)
    const fmpChart = await getFMPCandles(symbol, interval, range).catch(() => null)
    if (fmpChart) { console.log('[chart] served via FMP:', symbol); return res.json(fmpChart) }

    res.json({ chart: { result: null, error: { code: 'unavailable', description: 'No market data provider returned data' } } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ── Fundamentals ──────────────────────────────── */
app.get('/api/summary', async (req, res) => {
  const { symbol, modules = 'summaryDetail,financialData,defaultKeyStatistics,assetProfile' } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  try {
    // 1st choice: yahoo-finance2
    if (yf2) {
      try {
        const moduleList = modules.split(',')
        const data = await yf2.quoteSummary(symbol, { modules: moduleList }, { validateResult: false })
        // Wrap in the v10-compatible envelope the client expects
        return res.json({ quoteSummary: { result: [data], error: null } })
      } catch (e) {
        console.warn('[YF2] quoteSummary error:', e.message)
      }
    }
    // Fallback: raw v10 endpoint with crumb
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
    if (yf2) {
      try {
        const data = await yf2.search(q, { quotesCount: 10, newsCount: 0 }, { validateResult: false })
        if (data?.quotes?.length) return res.json(data)
      } catch (e) {
        console.warn('[YF2] search error:', e.message)
      }
    }
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

// ── Signal performance checker (every 5 min) ─────────────────────────────────
// Fetches current price for signals that are 1d/7d/30d old and haven't been
// checked yet, stores the P&L, and creates a notification for notable moves.
if (process.env.DATABASE_URL) {
  const { query: dbQ } = require('./db/db')

  async function checkSignalPerformance() {
    try {
      const { rows } = await dbQ(`
        SELECT id, user_id, symbol, action, price AS entry_price, published_at,
               checked_1d_at, checked_7d_at, checked_30d_at
        FROM ai_trader_signals
        WHERE (checked_1d_at  IS NULL AND published_at < NOW() - INTERVAL '1 day')
           OR (checked_7d_at  IS NULL AND published_at < NOW() - INTERVAL '7 days')
           OR (checked_30d_at IS NULL AND published_at < NOW() - INTERVAL '30 days')
        LIMIT 20
      `)
      if (!rows.length) return

      // Batch-fetch current prices
      const uniqueSymbols = [...new Set(rows.map(r => r.symbol))]
      const priceMap = {}
      for (const sym of uniqueSymbols) {
        try {
          const url = `http://localhost:${process.env.PORT || 3001}/api/chart?symbol=${encodeURIComponent(sym)}&interval=1d&range=2d`
          const d   = await fetch(url, { signal: AbortSignal.timeout(8000) }).then(r => r.json())
          const price = d?.chart?.result?.[0]?.meta?.regularMarketPrice
          if (price) priceMap[sym] = price
        } catch {}
      }

      for (const sig of rows) {
        const currentPrice = priceMap[sig.symbol]
        if (!currentPrice || !sig.entry_price) continue

        const now    = Date.now()
        const age    = now - new Date(sig.published_at).getTime()
        const dayMs  = 86_400_000
        const isBull = ['buy', 'cover'].includes(sig.action)
        const rawPnl = (currentPrice - sig.entry_price) / sig.entry_price * 100
        const pnl    = isBull ? rawPnl : -rawPnl   // short/sell inverts direction

        const updates = []
        const params  = []
        let   p       = 1

        if (!sig.checked_1d_at  && age >= dayMs)      { updates.push(`price_1d=$${p++}, pnl_1d=$${p++}, checked_1d_at=NOW()`);   params.push(currentPrice, +pnl.toFixed(4)) }
        if (!sig.checked_7d_at  && age >= 7 * dayMs)  { updates.push(`price_7d=$${p++}, pnl_7d=$${p++}, checked_7d_at=NOW()`);   params.push(currentPrice, +pnl.toFixed(4)) }
        if (!sig.checked_30d_at && age >= 30 * dayMs) { updates.push(`price_30d=$${p++}, pnl_30d=$${p++}, checked_30d_at=NOW()`); params.push(currentPrice, +pnl.toFixed(4)) }

        if (!updates.length) continue

        params.push(sig.id)
        await dbQ(`UPDATE ai_trader_signals SET ${updates.join(', ')} WHERE id=$${p}`, params).catch(() => {})

        // Fire notification for notable moves (>3% absolute P&L)
        if (Math.abs(pnl) >= 3) {
          const label = age >= 30 * dayMs ? '30-day' : age >= 7 * dayMs ? '7-day' : '1-day'
          const dir   = pnl >= 0 ? 'up' : 'down'
          await dbQ(
            `INSERT INTO ai_trader_notifications (user_id, type, data)
             VALUES ($1, 'signal_performance', $2)`,
            [sig.user_id, JSON.stringify({
              symbol:   sig.symbol,
              action:   sig.action,
              pnl:      +pnl.toFixed(2),
              period:   label,
              content:  `Your ${sig.action.toUpperCase()} ${sig.symbol} signal is ${dir} ${Math.abs(pnl).toFixed(1)}% over ${label}`,
            })]
          ).catch(() => {})
        }
      }
    } catch {}
  }

  setTimeout(() => {
    checkSignalPerformance()
    setInterval(checkSignalPerformance, 5 * 60_000)
  }, 60_000)
}

// ── AI-Trader background heartbeat poller (every 60 s) ───────────────────────
// Polls notifications for every user that has registered an AI-Trader agent.
// Stores new messages in ai_trader_notifications so GET /api/trading/notifications
// can serve them instantly without blocking the request.
if (process.env.DATABASE_URL) {
  const at = require('./services/aiTraderClient')
  const { query: dbQ } = require('./db/db')

  async function runHeartbeatCycle() {
    try {
      const { rows } = await dbQ(
        'SELECT id, ai_trader_token FROM users WHERE ai_trader_token IS NOT NULL LIMIT 100'
      )
      for (const user of rows) {
        try {
          const hb = await at.pollHeartbeat(user.ai_trader_token)
          if (!hb?.messages?.length) continue
          for (const msg of hb.messages) {
            await dbQ(
              `INSERT INTO ai_trader_notifications (user_id, type, data)
               VALUES ($1, $2, $3)`,
              [user.id, msg.type || 'info', JSON.stringify(msg)]
            ).catch(() => {})
          }
        } catch {}
      }
    } catch {}
  }

  // Stagger first run by 30 s to let DB settle after startup
  setTimeout(() => {
    runHeartbeatCycle()
    setInterval(runHeartbeatCycle, 60_000)
  }, 30_000)
}
