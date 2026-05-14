const express      = require('express')
const cors         = require('cors')
const path         = require('path')
const fs           = require('fs')
const helmet       = require('helmet')
const cookieParser = require('cookie-parser')
const rateLimit    = require('express-rate-limit')

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
      connectSrc:  ["'self'", 'https://finnhub.io', 'https://financialmodelingprep.com', 'https://ai4trade.ai', 'https://api.aisa.one'],
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

/* ── Market data helpers (AISA primary → Finnhub → FMP fallback) ─────────────
   Yahoo Finance is completely removed — its IPs are blocked on Railway.
   AISA (api.aisa.one) is the primary source — cloud-friendly, pay-per-use.
   Set AISA_API_KEY in Railway env vars: https://aisa.one
   ─────────────────────────────────────────────────────────────────────────── */

const JSON_HEADERS = { Accept: 'application/json' }

async function apiFetch(url, timeoutMs = 10000) {
  const r = await fetch(url, { headers: JSON_HEADERS, signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

// ── Server-side quote cache (30 s TTL) — reduces API calls per request ───────
const _quoteCache = new Map()
const QUOTE_TTL = 30_000

function cacheSet(key, data) { _quoteCache.set(key, { data, ts: Date.now() }) }
function cacheGet(key) {
  const hit = _quoteCache.get(key)
  return hit && Date.now() - hit.ts < QUOTE_TTL ? hit.data : null
}
// Evict stale entries every 2 minutes to prevent unbounded memory growth
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of _quoteCache) if (now - v.ts > QUOTE_TTL) _quoteCache.delete(k)
}, 2 * 60_000)

// ── Extract user-supplied API keys from request headers ───────────────────────
// Browser stores keys in localStorage and attaches them as custom headers.
// Header keys take precedence over server env vars so users can use their own.
function extractKeys(req) {
  return {
    aisa:    (req.headers['x-aisa-key']    || '').trim() || process.env.AISA_API_KEY    || null,
    finnhub: (req.headers['x-finnhub-key'] || '').trim() || process.env.FINNHUB_API_KEY || null,
    fmp:     (req.headers['x-fmp-key']     || '').trim() || process.env.FMP_API_KEY     || null,
    av:      (req.headers['x-av-key']      || '').trim() || process.env.ALPHA_VANTAGE_API_KEY || process.env.AV_API_KEY || null,
  }
}

// ── AISA helpers (api.aisa.one) ────────────────────────────────────────────────
// Primary data source — works from Railway/cloud IPs, no IP blocking.
// Get a key at https://aisa.one (~$0.001/request, pay-as-you-go)
const AISA_KEY  = () => process.env.AISA_API_KEY
const AISA_BASE = 'https://api.aisa.one/apis/v1'

async function aisaFetch(path, timeoutMs = 12000, key = AISA_KEY()) {
  if (!key) return null
  const r = await fetch(`${AISA_BASE}${path}`, {
    headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
    signal:  AbortSignal.timeout(timeoutMs),
  })
  if (!r.ok) throw new Error(`AISA HTTP ${r.status}`)
  return r.json()
}

// Convert range string to { start_date, end_date } (YYYY-MM-DD)
function rangeToDateRange(range) {
  const end   = new Date()
  const start = new Date()
  const days  = { '1d':2,'5d':7,'1mo':35,'3mo':95,'6mo':185,'1y':370,'2y':740,'5y':1830,'max':7300 }
  start.setDate(end.getDate() - (days[range] || 370))
  const fmt = d => d.toISOString().slice(0, 10)
  return { start_date: fmt(start), end_date: fmt(end) }
}

// Convert interval to AISA interval + multiplier
function intervalToAISA(interval) {
  const map = { '1m':['minute',1],'5m':['minute',5],'15m':['minute',15],'30m':['minute',30],
                '60m':['minute',60],'1h':['minute',60],'1d':['day',1],'1wk':['week',1],'1mo':['month',1] }
  return map[interval] || ['day', 1]
}

// Historical OHLCV chart — returns Yahoo-envelope format the client expects
async function getAISAChart(symbol, interval = '1d', range = '1y', keys = {}) {
  const key = keys.aisa || AISA_KEY()
  if (!key) return null
  try {
    const [ivl, mult] = intervalToAISA(interval)
    const { start_date, end_date } = rangeToDateRange(range)
    const data = await aisaFetch(
      `/financial/prices?ticker=${encodeURIComponent(symbol)}&interval=${ivl}&interval_multiplier=${mult}&start_date=${start_date}&end_date=${end_date}`,
      15000,
      key
    )
    if (!Array.isArray(data) || !data.length) return null
    // AISA returns [{date|timestamp, open, high, low, close, volume}]
    const sorted = [...data].sort((a, b) => new Date(a.date || a.timestamp) - new Date(b.date || b.timestamp))
    const timestamps = sorted.map(d => Math.floor(new Date(d.date || d.timestamp).getTime() / 1000))
    const opens  = sorted.map(d => d.open  ?? null)
    const highs  = sorted.map(d => d.high  ?? null)
    const lows   = sorted.map(d => d.low   ?? null)
    const closes = sorted.map(d => d.close ?? null)
    const vols   = sorted.map(d => d.volume ?? 0)
    const lastClose = closes.filter(Boolean).at(-1) ?? null
    return {
      chart: { result: [{
        meta:      { symbol, regularMarketPrice: lastClose, chartPreviousClose: closes.filter(Boolean).at(-2) ?? null },
        timestamp: timestamps,
        indicators: {
          quote:    [{ open: opens, high: highs, low: lows, close: closes, volume: vols }],
          adjclose: [{ adjclose: closes }],
        },
      }], error: null },
    }
  } catch (e) { console.warn('[AISA] chart error:', e.message); return null }
}

// Real-time quote via metrics snapshot
async function getAISAQuotes(symbols, keys = {}) {
  const key = keys.aisa || AISA_KEY()
  if (!key) return null
  try {
    const results = await Promise.all(symbols.map(async sym => {
      try {
        const d = await aisaFetch(`/financial/financial-metrics/snapshot?ticker=${encodeURIComponent(sym)}`, 8000, key)
        // snapshot returns { price, change, change_percent, market_cap, pe_ratio, ... }
        const price = d?.price ?? d?.current_price ?? null
        if (!price) return { symbol: sym, regularMarketPrice: null }
        return {
          symbol,
          shortName:                  d.name || sym,
          regularMarketPrice:         price,
          regularMarketChange:        d.change              ?? d.price_change        ?? null,
          regularMarketChangePercent: d.change_percent      ?? d.price_change_percent ?? null,
          regularMarketVolume:        d.volume              ?? null,
          regularMarketDayHigh:       d.day_high            ?? null,
          regularMarketDayLow:        d.day_low             ?? null,
          regularMarketOpen:          d.open                ?? null,
          regularMarketPreviousClose: d.previous_close      ?? null,
          fiftyTwoWeekHigh:           d.week_52_high        ?? null,
          fiftyTwoWeekLow:            d.week_52_low         ?? null,
          marketCap:                  d.market_cap          ?? null,
          trailingPE:                 d.pe_ratio            ?? null,
        }
      } catch { return { symbol: sym, regularMarketPrice: null } }
    }))
    return results
  } catch { return null }
}

// ── Finnhub helpers ───────────────────────────────────────────────────────────
function fhUrl(path, key = FH_KEY()) {
  const sep = path.includes('?') ? '&' : '?'
  return `https://finnhub.io/api/v1${path}${sep}token=${key}`
}
const FH_KEY = () => process.env.FINNHUB_API_KEY

// Quote (per-symbol, parallel)
async function getFinnhubQuotes(symbols, keys = {}) {
  const key = keys.finnhub || FH_KEY()
  if (!key) return null
  try {
    const results = await Promise.all(symbols.map(async sym => {
      const ck = `fhq:${sym}`
      const cached = cacheGet(ck)
      if (cached) return cached
      try {
        const d = await apiFetch(fhUrl(`/quote?symbol=${encodeURIComponent(sym)}`, key), 8000)
        // d.c === 0 happens after market hours on the free tier — fall back to d.pc (previous close)
        const price = d?.c || d?.pc || null
        if (!price) return { symbol: sym, regularMarketPrice: null }
        const isStale = !d.c && !!d.pc  // using prev close when market is closed
        const q = {
          symbol:                     sym,
          shortName:                  sym,
          regularMarketPrice:         price,
          regularMarketChange:        isStale ? 0 : (d.d   ?? null),
          regularMarketChangePercent: isStale ? 0 : (d.dp  ?? null),
          regularMarketDayHigh:       d.h   ?? null,
          regularMarketDayLow:        d.l   ?? null,
          regularMarketOpen:          d.o   ?? null,
          regularMarketPreviousClose: d.pc  ?? null,
          regularMarketTime:          d.t   ?? null,
        }
        cacheSet(ck, q)
        return q
      } catch { return { symbol: sym, regularMarketPrice: null } }
    }))
    return results
  } catch { return null }
}

// Chart OHLCV — returns data in Yahoo chart envelope (client expects this format)
function toFhResolution(interval) {
  return { '1m':'1','5m':'5','15m':'15','30m':'30','60m':'60','1h':'60','1d':'D','1wk':'W','1mo':'M' }[interval] || 'D'
}
function rangeToUnix(range) {
  const to   = Math.floor(Date.now() / 1000)
  const secs = { '1d':86400,'5d':432000,'1mo':2592000,'3mo':7776000,'6mo':15552000,'1y':31536000,'2y':63072000,'5y':157680000,'max':630720000 }
  return { from: to - (secs[range] || 31536000), to }
}
async function getFinnhubChart(symbol, interval = '1d', range = '1y', keys = {}) {
  const key = keys.finnhub || FH_KEY()
  if (!key) return null
  try {
    const res = toFhResolution(interval)
    const { from, to } = rangeToUnix(range)
    const d = await apiFetch(
      fhUrl(`/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${res}&from=${from}&to=${to}`, key),
      15000
    )
    if (d?.s !== 'ok' || !d.t?.length) return null
    return {
      chart: { result: [{
        meta: { symbol, regularMarketPrice: d.c.at(-1) ?? null, chartPreviousClose: d.c.at(-2) ?? null, regularMarketTime: d.t.at(-1) ?? null },
        timestamp: d.t,
        indicators: {
          quote:    [{ open: d.o, high: d.h, low: d.l, close: d.c, volume: d.v }],
          adjclose: [{ adjclose: d.c }],
        },
      }], error: null }
    }
  } catch (e) { console.warn('[Finnhub] chart error:', e.message); return null }
}

// Symbol search
async function getFinnhubSearch(q, keys = {}) {
  const key = keys.finnhub || FH_KEY()
  if (!key) return null
  try {
    const d = await apiFetch(fhUrl(`/search?q=${encodeURIComponent(q)}`, key), 8000)
    if (!d?.result?.length) return null
    const typeMap = { 'Common Stock':'EQUITY', 'ETP':'ETF', 'Index':'INDEX', 'ADR':'EQUITY' }
    return { quotes: d.result.slice(0, 10).map(r => ({
      symbol: r.symbol, shortname: r.description, longname: r.description,
      quoteType: typeMap[r.type] || 'EQUITY', exchange: r.displaySymbol,
    })) }
  } catch { return null }
}

// News
async function getFinnhubNews(symbol, keys = {}) {
  const key = keys.finnhub || FH_KEY()
  if (!key) return null
  try {
    const today = new Date().toISOString().slice(0, 10)
    const from  = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
    const path  = symbol
      ? `/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${today}`
      : `/news?category=general&minId=0`
    const data  = await apiFetch(fhUrl(path, key), 10000)
    if (!Array.isArray(data)) return null
    return { news: data.slice(0, 8).map(a => ({
      title: a.headline, link: a.url, publisher: a.source,
      providerPublishTime: a.datetime,
      thumbnail: a.image ? { resolutions: [{ url: a.image }] } : null,
    })) }
  } catch { return null }
}

// ── FMP helpers ───────────────────────────────────────────────────────────────
const FMP_KEY = () => process.env.FMP_API_KEY
function fmpUrl(path, key = FMP_KEY()) {
  const sep = path.includes('?') ? '&' : '?'
  return `https://financialmodelingprep.com/api/v3${path}${sep}apikey=${key}`
}

// Batch quote
async function getFMPQuotes(symbols, keys = {}) {
  const key = keys.fmp || FMP_KEY()
  if (!key) return null
  try {
    const data = await apiFetch(fmpUrl(`/quote/${symbols.join(',')}`, key), 10000)
    if (!Array.isArray(data) || !data.length) return null
    return data.map(q => ({
      symbol:                     q.symbol,
      shortName:                  q.name            || q.symbol,
      regularMarketPrice:         q.price           ?? null,
      regularMarketChange:        q.change          ?? null,
      regularMarketChangePercent: q.changesPercentage ?? null,
      regularMarketVolume:        q.volume          ?? null,
      regularMarketDayHigh:       q.dayHigh         ?? null,
      regularMarketDayLow:        q.dayLow          ?? null,
      regularMarketOpen:          q.open            ?? null,
      regularMarketPreviousClose: q.previousClose   ?? null,
      regularMarketTime:          q.timestamp       ?? null,
      fiftyTwoWeekHigh:           q.yearHigh        ?? null,
      fiftyTwoWeekLow:            q.yearLow         ?? null,
      marketCap:                  q.marketCap       ?? null,
      trailingPE:                 q.pe              ?? null,
    }))
  } catch { return null }
}

// Chart OHLCV
async function getFMPChart(symbol, interval = '1d', range = '1y', keys = {}) {
  const key = keys.fmp || FMP_KEY()
  if (!key) return null
  try {
    const today = new Date()
    const to    = today.toISOString().slice(0, 10)
    const days  = { '1d':1,'5d':5,'1mo':30,'3mo':90,'6mo':180,'1y':365,'2y':730,'5y':1825,'max':7300 }[range] || 365
    const from  = new Date(today.getTime() - days * 86400000).toISOString().slice(0, 10)
    const isDailyPlus = ['1d','1wk','1mo'].includes(interval)
    let url, historical
    if (isDailyPlus) {
      const data = await apiFetch(fmpUrl(`/historical-price-full/${encodeURIComponent(symbol)}?from=${from}&to=${to}`, key), 15000)
      historical = data?.historical
    } else {
      const intMap = { '1m':'1min','5m':'5min','15m':'15min','30m':'30min','60m':'1hour','1h':'1hour' }
      const fi = intMap[interval] || '1hour'
      historical = await apiFetch(fmpUrl(`/historical-chart/${fi}/${encodeURIComponent(symbol)}?from=${from}&to=${to}`, key), 15000)
    }
    if (!Array.isArray(historical) || !historical.length) return null
    const hist = [...historical].reverse()  // FMP returns newest-first
    const ts  = hist.map(d => Math.floor(new Date(d.date).getTime() / 1000))
    const cls = hist.map(d => d.close ?? d.adjClose ?? null)
    return {
      chart: { result: [{
        meta: { symbol, regularMarketPrice: cls.at(-1) ?? null, chartPreviousClose: cls.at(-2) ?? null },
        timestamp: ts,
        indicators: {
          quote:    [{ open: hist.map(d => d.open), high: hist.map(d => d.high), low: hist.map(d => d.low), close: cls, volume: hist.map(d => d.volume) }],
          adjclose: [{ adjclose: hist.map(d => d.adjClose || d.close) }],
        },
      }], error: null }
    }
  } catch (e) { console.warn('[FMP] chart error:', e.message); return null }
}

// Fundamentals summary — returns Yahoo quoteSummary-compatible envelope
async function getFMPSummary(symbol, keys = {}) {
  const key = keys.fmp || FMP_KEY()
  if (!key) return null
  try {
    const [profileR, metricsR] = await Promise.allSettled([
      apiFetch(fmpUrl(`/profile/${encodeURIComponent(symbol)}`, key), 10000),
      apiFetch(fmpUrl(`/key-metrics-ttm/${encodeURIComponent(symbol)}`, key), 10000),
    ])
    const p = profileR.status  === 'fulfilled' ? (profileR.value?.[0]  || {}) : {}
    const m = metricsR.status  === 'fulfilled' ? (metricsR.value?.[0]  || {}) : {}
    if (!p.symbol) return null
    return { quoteSummary: { result: [{
      summaryDetail: {
        trailingPE:      p.pe           ?? null,
        marketCap:       p.mktCap       ?? null,
        dividendYield:   p.lastDiv && p.price ? p.lastDiv / p.price : null,
        beta:            p.beta          ?? null,
        fiftyTwoWeekHigh: p['52WeekHigh'] ?? null,
        fiftyTwoWeekLow:  p['52WeekLow']  ?? null,
        averageVolume:   p.volAvg        ?? null,
      },
      financialData: {
        returnOnEquity:   m.roeTTM                  ?? null,
        debtToEquity:     m.debtToEquityTTM          ?? null,
        currentRatio:     m.currentRatioTTM          ?? null,
        revenueGrowth:    m.revenueGrowthTTM         ?? null,
        profitMargins:    m.netProfitMarginTTM       ?? null,
        grossMargins:     m.grossProfitMarginTTM     ?? null,
        operatingMargins: m.operatingProfitMarginTTM ?? null,
        targetMeanPrice:  p.dcf                      ?? null,
        recommendationKey: p.dcfDiff > 0 ? 'buy' : p.dcfDiff < 0 ? 'sell' : null,
      },
      defaultKeyStatistics: {
        trailingEps: m.epsTTM     ?? null,
        priceToBook: m.pbRatioTTM ?? null,
      },
      assetProfile: {
        sector:              p.sector           ?? null,
        industry:            p.industry         ?? null,
        longName:            p.companyName      ?? null,
        longBusinessSummary: p.description      ?? null,
        fullTimeEmployees:   p.fullTimeEmployees ?? null,
        country:             p.country          ?? null,
      },
    }], error: null } }
  } catch (e) { console.warn('[FMP] summary error:', e.message); return null }
}

// Symbol search
async function getFMPSearch(q, keys = {}) {
  const key = keys.fmp || FMP_KEY()
  if (!key) return null
  try {
    const data = await apiFetch(fmpUrl(`/search?query=${encodeURIComponent(q)}&limit=10`, key), 8000)
    if (!Array.isArray(data) || !data.length) return null
    return { quotes: data.map(r => ({
      symbol: r.symbol, shortname: r.name, longname: r.name,
      quoteType: 'EQUITY', exchange: r.exchangeShortName,
    })) }
  } catch { return null }
}

// ── Alpha Vantage helpers ─────────────────────────────────────────────────────
// Free tier: 25 req/day, 5 req/min. Used as final fallback for chart + summary.

// Historical daily OHLCV chart
async function getAVChart(symbol, interval = '1d', range = '1y', keys = {}) {
  const key = keys.av || process.env.ALPHA_VANTAGE_API_KEY || process.env.AV_API_KEY
  if (!key) return null
  // AV intraday not on free tier — daily only
  if (!['1d','1wk','1mo'].includes(interval)) return null
  try {
    const needFull = ['2y','5y','max'].includes(range)
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY_ADJUSTED&symbol=${encodeURIComponent(symbol)}&outputsize=${needFull ? 'full' : 'compact'}&apikey=${key}`
    const data = await apiFetch(url, 20000)
    const series = data?.['Time Series (Daily)']
    if (!series) return null

    const days = { '1d':2,'5d':8,'1mo':35,'3mo':95,'6mo':185,'1y':370,'2y':740,'5y':1830,'max':9999 }
    const cutoff = new Date()
    cutoff.setDate(cutoff.getDate() - (days[range] || 370))

    const entries = Object.entries(series)
      .filter(([date]) => new Date(date) >= cutoff)
      .sort(([a],[b]) => a.localeCompare(b))

    if (entries.length < 5) return null

    const timestamps = entries.map(([date]) => Math.floor(new Date(date).getTime() / 1000))
    const opens  = entries.map(([,v]) => parseFloat(v['1. open']))
    const highs  = entries.map(([,v]) => parseFloat(v['2. high']))
    const lows   = entries.map(([,v]) => parseFloat(v['3. low']))
    const closes = entries.map(([,v]) => parseFloat(v['4. close']))
    const adjs   = entries.map(([,v]) => parseFloat(v['5. adjusted close']))
    const vols   = entries.map(([,v]) => parseInt(v['6. volume']) || 0)

    const lastClose = closes.at(-1) ?? null
    console.log(`[AV] chart OK: ${symbol} (${entries.length} bars)`)
    return {
      chart: { result: [{
        meta: { symbol, regularMarketPrice: lastClose, chartPreviousClose: closes.at(-2) ?? null },
        timestamp: timestamps,
        indicators: {
          quote:    [{ open: opens, high: highs, low: lows, close: closes, volume: vols }],
          adjclose: [{ adjclose: adjs }],
        },
      }], error: null },
    }
  } catch (e) { console.warn('[AV] chart error:', e.message); return null }
}

// Company overview — fundamentals (P/E, margins, sector, etc.)
async function getAVSummary(symbol, keys = {}) {
  const key = keys.av || process.env.ALPHA_VANTAGE_API_KEY || process.env.AV_API_KEY
  if (!key) return null
  try {
    const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${key}`
    const d = await apiFetch(url, 12000)
    if (!d?.Symbol) return null
    const p = (field) => { const v = parseFloat(d[field]); return isNaN(v) ? null : v }
    const i = (field) => { const v = parseInt(d[field]);   return isNaN(v) ? null : v }
    console.log(`[AV] summary OK: ${symbol}`)
    return { quoteSummary: { result: [{
      summaryDetail: {
        trailingPE:      p('TrailingPE'),
        forwardPE:       p('ForwardPE'),
        marketCap:       i('MarketCapitalization'),
        dividendYield:   p('DividendYield'),
        beta:            p('Beta'),
        fiftyTwoWeekHigh: p('52WeekHigh'),
        fiftyTwoWeekLow:  p('52WeekLow'),
        averageVolume:   i('AverageVolume'),
      },
      financialData: {
        returnOnEquity:   p('ReturnOnEquityTTM'),
        profitMargins:    p('ProfitMargin'),
        grossMargins:     null,
        operatingMargins: p('OperatingMarginTTM'),
        revenueGrowth:    p('QuarterlyRevenueGrowthYOY'),
        earningsGrowth:   p('QuarterlyEarningsGrowthYOY'),
        targetMeanPrice:  p('AnalystTargetPrice'),
        recommendationKey: null,
        totalRevenue:     i('RevenueTTM'),
        freeCashflow:     null,
      },
      defaultKeyStatistics: {
        trailingEps: p('EPS'),
        priceToBook: p('PriceToBookRatio'),
      },
      assetProfile: {
        sector:              d.Sector              || null,
        industry:            d.Industry            || null,
        longName:            d.Name                || null,
        longBusinessSummary: d.Description         || null,
        fullTimeEmployees:   i('FullTimeEmployees'),
        country:             d.Country             || null,
      },
    }], error: null } }
  } catch (e) { console.warn('[AV] summary error:', e.message); return null }
}

// Quote fallback — last resort, free tier only (25 req/day)
async function getAVQuotes(symbols, keys = {}) {
  const key = keys.av || process.env.ALPHA_VANTAGE_API_KEY || process.env.AV_API_KEY
  if (!key) return null
  try {
    // AV free tier: 25 requests/day, 5/min — use only first symbol for quote
    const results = await Promise.all(symbols.slice(0, 5).map(async sym => {
      try {
        const url  = `https://www.alphavantage.co/query?function=GLOBAL_QUOTE&symbol=${encodeURIComponent(sym)}&apikey=${key}`
        const data = await apiFetch(url, 10000)
        const q    = data?.['Global Quote']
        const price = parseFloat(q?.['05. price'])
        if (!price) return { symbol: sym, regularMarketPrice: null }
        return {
          symbol:                     sym,
          shortName:                  sym,
          regularMarketPrice:         price,
          regularMarketChange:        parseFloat(q?.['09. change'])         || null,
          regularMarketChangePercent: parseFloat(q?.['10. change percent']) || null,
          regularMarketVolume:        parseInt(q?.['06. volume'])           || null,
          regularMarketDayHigh:       parseFloat(q?.['03. high'])           || null,
          regularMarketDayLow:        parseFloat(q?.['04. low'])            || null,
          regularMarketOpen:          parseFloat(q?.['02. open'])           || null,
          regularMarketPreviousClose: parseFloat(q?.['08. previous close']) || null,
        }
      } catch { return { symbol: sym, regularMarketPrice: null } }
    }))
    return results
  } catch { return null }
}

// ── Finnhub 30-minute health check ───────────────────────────────────────────
// Validates the key is still working; logs the status so it's visible in Railway logs.
async function finnhubHealthCheck() {
  if (!FH_KEY()) { console.log('[Finnhub] FINNHUB_API_KEY not set — using FMP only'); return }
  try {
    const d = await apiFetch(fhUrl('/quote?symbol=SPY'), 8000)
    const price = d?.c || d?.pc
    if (price) {
      console.log(`[Finnhub] health OK — SPY $${price}${!d.c ? ' (prev close)' : ''}`)
    } else {
      console.warn('[Finnhub] health check: unexpected response', JSON.stringify(d).slice(0, 120))
    }
  } catch (e) {
    console.warn('[Finnhub] health check failed:', e.message)
  }
}
// Run at startup (after 5 s) then every 30 minutes
setTimeout(() => { finnhubHealthCheck(); setInterval(finnhubHealthCheck, 30 * 60_000) }, 5000)

// ── Finnhub WebSocket — real-time trade stream ────────────────────────────────
// Server-side WS connection to Finnhub; price updates pushed to browser clients
// via the /api/stream/quotes SSE endpoint below.
const WebSocket       = require('ws')
let   _fhWs           = null
let   _fhWsDelay      = 1000
const _fhSubscribed   = new Set()   // symbols currently subscribed on Finnhub WS
const _sseClients     = new Map()   // clientId → { res, symbols: Set<string> }

function _fhSend(obj) {
  if (_fhWs?.readyState === WebSocket.OPEN) _fhWs.send(JSON.stringify(obj))
}

function _fhEnsureSub(symbol) {
  if (_fhSubscribed.has(symbol)) return
  _fhSubscribed.add(symbol)
  _fhSend({ type: 'subscribe', symbol })
}

function _fhUnsubIfUnused(symbol) {
  const needed = [..._sseClients.values()].some(c => c.symbols.has(symbol))
  if (!needed) {
    _fhSubscribed.delete(symbol)
    _fhSend({ type: 'unsubscribe', symbol })
  }
}

function _sseBroadcast(symbol, payload) {
  const line = `data: ${JSON.stringify(payload)}\n\n`
  for (const [, c] of _sseClients) {
    if (c.symbols.has(symbol)) {
      try { c.res.write(line) } catch {}
    }
  }
}

function _connectFhWs() {
  if (!FH_KEY()) return
  _fhWs = new WebSocket(`wss://ws.finnhub.io?token=${FH_KEY()}`)

  _fhWs.on('open', () => {
    console.log('[Finnhub WS] connected')
    _fhWsDelay = 1000
    for (const sym of _fhSubscribed) _fhSend({ type: 'subscribe', symbol: sym })
  })

  _fhWs.on('message', raw => {
    try {
      const msg = JSON.parse(raw)
      if (msg.type !== 'trade' || !Array.isArray(msg.data)) return
      for (const t of msg.data) {
        const sym = t.s, price = t.p
        if (!sym || price == null) continue
        const prev    = cacheGet(`fhq:${sym}`)
        const pc      = prev?.regularMarketPreviousClose ?? null
        const chg     = pc != null ? +(price - pc).toFixed(4) : null
        const chgPct  = pc != null ? +((price - pc) / pc * 100).toFixed(4) : null
        cacheSet(`fhq:${sym}`, {
          ...(prev || { symbol: sym, shortName: sym }),
          regularMarketPrice:         price,
          regularMarketChange:        chg,
          regularMarketChangePercent: chgPct,
          regularMarketTime:          t.t ? Math.floor(t.t / 1000) : null,
        })
        _sseBroadcast(sym, { symbol: sym, price, change: chg, changePct: chgPct, ts: t.t })
      }
    } catch {}
  })

  _fhWs.on('close', () => {
    console.warn('[Finnhub WS] closed — reconnect in', _fhWsDelay, 'ms')
    setTimeout(() => { _fhWsDelay = Math.min(_fhWsDelay * 2, 30_000); _connectFhWs() }, _fhWsDelay)
  })

  _fhWs.on('error', e => console.warn('[Finnhub WS] error:', e.message))
}

// Delay 6 s so REST health check fires first (which warms the cache)
setTimeout(() => { if (FH_KEY()) _connectFhWs() }, 6000)

/* ── SSE: real-time quote stream ───────────────────────────────────────────── */
// GET /api/stream/quotes?symbols=AAPL,MSFT
// Sends: data: {"symbol":"AAPL","price":182.5,"change":1.2,"changePct":0.66,"ts":1234567890000}
app.get('/api/stream/quotes', (req, res) => {
  const symbols = (req.query.symbols || '')
    .split(',')
    .map(s => s.trim().toUpperCase().replace(/[^A-Z0-9.-]/g, ''))
    .filter(Boolean)
    .slice(0, 30)
  if (!symbols.length) return res.status(400).end()

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')   // prevent nginx from buffering the stream
  res.flushHeaders()

  const id     = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  const symSet = new Set(symbols)
  _sseClients.set(id, { res, symbols: symSet })

  // Subscribe these symbols on the Finnhub WS
  for (const sym of symbols) _fhEnsureSub(sym)

  // Immediately flush any cached price so the UI isn't blank while waiting for the next trade
  for (const sym of symbols) {
    const c = cacheGet(`fhq:${sym}`)
    if (c?.regularMarketPrice != null) {
      res.write(`data: ${JSON.stringify({
        symbol: sym, price: c.regularMarketPrice,
        change: c.regularMarketChange ?? null,
        changePct: c.regularMarketChangePercent ?? null,
        ts: c.regularMarketTime ? c.regularMarketTime * 1000 : null,
      })}\n\n`)
    }
  }

  // Keep-alive ping every 25 s (proxies drop idle SSE after ~30 s)
  const hb = setInterval(() => {
    try { res.write(': ping\n\n') } catch { close() }
  }, 25_000)

  function close() {
    clearInterval(hb)
    _sseClients.delete(id)
    for (const sym of symbols) _fhUnsubIfUnused(sym)
  }
  req.on('close', close)
})


/* ── Health (includes DB status + demo mode) ───── */
app.get('/health', async (_req, res) => {
  const demoMode = !process.env.DATABASE_URL
  let dbOk = false
  if (!demoMode) {
    try { const { ping } = require('./db/db'); dbOk = await ping() } catch {}
  }
  const avKey = process.env.ALPHA_VANTAGE_API_KEY || process.env.AV_API_KEY
  res.json({ ok: true, db: dbOk, demoMode, aisa: !!AISA_KEY(), finnhub: !!FH_KEY(), fmp: !!FMP_KEY(), av: !!avKey, ts: Date.now() })
})

/* ── Quote (batch) ─────────────────────────────── */
app.get('/api/quote', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').filter(Boolean)
  if (!symbols.length) return res.status(400).json({ error: 'symbols required' })
  const keys = extractKeys(req)
  try {
    // 1st: AISA — cloud-friendly, Yahoo Finance data via proxy
    const aisa = await getAISAQuotes(symbols, keys).catch(() => null)
    if (aisa?.some(r => r.regularMarketPrice != null))
      return res.json({ quoteResponse: { result: aisa } })

    // 2nd: Finnhub
    const fh = await getFinnhubQuotes(symbols, keys)
    if (fh?.some(r => r.regularMarketPrice != null))
      return res.json({ quoteResponse: { result: fh } })

    // 3rd: FMP
    const fmp = await getFMPQuotes(symbols, keys)
    if (fmp?.some(r => r.regularMarketPrice != null))
      return res.json({ quoteResponse: { result: fmp } })

    // 4th: Alpha Vantage (free tier, 5 req/min — last resort)
    const av = await getAVQuotes(symbols, keys)
    if (av?.some(r => r.regularMarketPrice != null))
      return res.json({ quoteResponse: { result: av } })

    res.json({ quoteResponse: { result: symbols.map(s => ({ symbol: s, regularMarketPrice: null })) } })
  } catch (e) {
    res.json({ quoteResponse: { result: symbols.map(s => ({ symbol: s, regularMarketPrice: null })) } })
  }
})

/* ── Chart (OHLCV) ─────────────────────────────── */
app.get('/api/chart', async (req, res) => {
  const { symbol, interval = '1d', range = '1y' } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  const keys = extractKeys(req)
  try {
    // 1st: AISA — cloud-friendly Yahoo Finance proxy
    const aisa = await getAISAChart(symbol, interval, range, keys).catch(() => null)
    if (aisa) { console.log('[chart] AISA:', symbol); return res.json(aisa) }

    // 2nd: Finnhub candles
    const fh = await getFinnhubChart(symbol, interval, range, keys)
    if (fh) return res.json(fh)

    // 3rd: FMP historical
    const fmp = await getFMPChart(symbol, interval, range, keys)
    if (fmp) return res.json(fmp)

    // 4th: Alpha Vantage (daily only, 25 req/day free tier)
    const av = await getAVChart(symbol, interval, range, keys)
    if (av) return res.json(av)

    res.status(502).json({ chart: { result: null, error: { code: 'unavailable', description: 'No market data provider returned data' } } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ── Fundamentals ──────────────────────────────── */
app.get('/api/summary', async (req, res) => {
  const { symbol } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  const keys = extractKeys(req)
  try {
    // 1st: FMP (most complete fundamentals)
    const fmp = await getFMPSummary(symbol, keys)
    if (fmp) return res.json(fmp)

    // 2nd: Alpha Vantage OVERVIEW (free, cloud-friendly)
    const av = await getAVSummary(symbol, keys)
    if (av) return res.json(av)

    res.json({ quoteSummary: { result: null, error: { code: 'unavailable' } } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ── Search ────────────────────────────────────── */
app.get('/api/search', async (req, res) => {
  const { q } = req.query
  if (!q) return res.status(400).json({ error: 'q required' })
  const keys = extractKeys(req)
  try {
    const fh = await getFinnhubSearch(q, keys)
    if (fh?.quotes?.length) return res.json(fh)

    const fmp = await getFMPSearch(q, keys)
    if (fmp?.quotes?.length) return res.json(fmp)

    res.json({ quotes: [] })
  } catch (e) {
    res.json({ quotes: [] })
  }
})

/* ── News ──────────────────────────────────────── */
app.get('/api/news', async (req, res) => {
  const symbol = req.query.symbol || null
  const keys = extractKeys(req)
  try {
    const fh = await getFinnhubNews(symbol, keys)
    if (fh) return res.json(fh)
    res.json({ news: [] })
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
