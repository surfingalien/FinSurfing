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
      connectSrc:  ["'self'", 'https://finnhub.io', 'https://financialmodelingprep.com', 'https://ai4trade.ai'],
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

/* ── Market data helpers (Finnhub primary, FMP fallback) ─────────────────────
   Yahoo Finance is completely removed — its IPs are blocked on Railway.
   All live data comes from Finnhub (FINNHUB_API_KEY) and/or FMP (FMP_API_KEY).
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

// ── Finnhub helpers ───────────────────────────────────────────────────────────
function fhUrl(path) {
  const sep = path.includes('?') ? '&' : '?'
  return `https://finnhub.io/api/v1${path}${sep}token=${process.env.FINNHUB_API_KEY}`
}
const FH_KEY = () => process.env.FINNHUB_API_KEY

// Quote (per-symbol, parallel)
async function getFinnhubQuotes(symbols) {
  if (!FH_KEY()) return null
  try {
    const results = await Promise.all(symbols.map(async sym => {
      const ck = `fhq:${sym}`
      const cached = cacheGet(ck)
      if (cached) return cached
      try {
        const d = await apiFetch(fhUrl(`/quote?symbol=${encodeURIComponent(sym)}`), 8000)
        if (!d?.c) return { symbol: sym, regularMarketPrice: null }
        const q = {
          symbol:                     sym,
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
async function getFinnhubChart(symbol, interval = '1d', range = '1y') {
  if (!FH_KEY()) return null
  try {
    const res = toFhResolution(interval)
    const { from, to } = rangeToUnix(range)
    const d = await apiFetch(
      fhUrl(`/stock/candle?symbol=${encodeURIComponent(symbol)}&resolution=${res}&from=${from}&to=${to}`),
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
async function getFinnhubSearch(q) {
  if (!FH_KEY()) return null
  try {
    const d = await apiFetch(fhUrl(`/search?q=${encodeURIComponent(q)}`), 8000)
    if (!d?.result?.length) return null
    const typeMap = { 'Common Stock':'EQUITY', 'ETP':'ETF', 'Index':'INDEX', 'ADR':'EQUITY' }
    return { quotes: d.result.slice(0, 10).map(r => ({
      symbol: r.symbol, shortname: r.description, longname: r.description,
      quoteType: typeMap[r.type] || 'EQUITY', exchange: r.displaySymbol,
    })) }
  } catch { return null }
}

// News
async function getFinnhubNews(symbol) {
  if (!FH_KEY()) return null
  try {
    const today = new Date().toISOString().slice(0, 10)
    const from  = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10)
    const path  = symbol
      ? `/company-news?symbol=${encodeURIComponent(symbol)}&from=${from}&to=${today}`
      : `/news?category=general&minId=0`
    const data  = await apiFetch(fhUrl(path), 10000)
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
function fmpUrl(path) {
  const sep = path.includes('?') ? '&' : '?'
  return `https://financialmodelingprep.com/api/v3${path}${sep}apikey=${process.env.FMP_API_KEY}`
}

// Batch quote
async function getFMPQuotes(symbols) {
  if (!FMP_KEY()) return null
  try {
    const data = await apiFetch(fmpUrl(`/quote/${symbols.join(',')}`), 10000)
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
async function getFMPChart(symbol, interval = '1d', range = '1y') {
  if (!FMP_KEY()) return null
  try {
    const today = new Date()
    const to    = today.toISOString().slice(0, 10)
    const days  = { '1d':1,'5d':5,'1mo':30,'3mo':90,'6mo':180,'1y':365,'2y':730,'5y':1825,'max':7300 }[range] || 365
    const from  = new Date(today.getTime() - days * 86400000).toISOString().slice(0, 10)
    const isDailyPlus = ['1d','1wk','1mo'].includes(interval)
    let url, historical
    if (isDailyPlus) {
      const data = await apiFetch(fmpUrl(`/historical-price-full/${encodeURIComponent(symbol)}?from=${from}&to=${to}`), 15000)
      historical = data?.historical
    } else {
      const intMap = { '1m':'1min','5m':'5min','15m':'15min','30m':'30min','60m':'1hour','1h':'1hour' }
      const fi = intMap[interval] || '1hour'
      historical = await apiFetch(fmpUrl(`/historical-chart/${fi}/${encodeURIComponent(symbol)}?from=${from}&to=${to}`), 15000)
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
async function getFMPSummary(symbol) {
  if (!FMP_KEY()) return null
  try {
    const [profileR, metricsR] = await Promise.allSettled([
      apiFetch(fmpUrl(`/profile/${encodeURIComponent(symbol)}`), 10000),
      apiFetch(fmpUrl(`/key-metrics-ttm/${encodeURIComponent(symbol)}`), 10000),
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
async function getFMPSearch(q) {
  if (!FMP_KEY()) return null
  try {
    const data = await apiFetch(fmpUrl(`/search?query=${encodeURIComponent(q)}&limit=10`), 8000)
    if (!Array.isArray(data) || !data.length) return null
    return { quotes: data.map(r => ({
      symbol: r.symbol, shortname: r.name, longname: r.name,
      quoteType: 'EQUITY', exchange: r.exchangeShortName,
    })) }
  } catch { return null }
}

// ── Finnhub 30-minute health check ───────────────────────────────────────────
// Validates the key is still working; logs the status so it's visible in Railway logs.
async function finnhubHealthCheck() {
  if (!FH_KEY()) { console.log('[Finnhub] FINNHUB_API_KEY not set — using FMP only'); return }
  try {
    const d = await apiFetch(fhUrl('/quote?symbol=SPY'), 8000)
    if (d?.c) {
      console.log(`[Finnhub] health OK — SPY $${d.c}`)
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
  res.json({ ok: true, db: dbOk, demoMode, finnhub: !!FH_KEY(), fmp: !!FMP_KEY(), ts: Date.now() })
})

/* ── Quote (batch) ─────────────────────────────── */
app.get('/api/quote', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').filter(Boolean)
  if (!symbols.length) return res.status(400).json({ error: 'symbols required' })
  try {
    const fh = await getFinnhubQuotes(symbols)
    if (fh?.some(r => r.regularMarketPrice != null))
      return res.json({ quoteResponse: { result: fh } })

    const fmp = await getFMPQuotes(symbols)
    if (fmp?.some(r => r.regularMarketPrice != null))
      return res.json({ quoteResponse: { result: fmp } })

    res.json({ quoteResponse: { result: symbols.map(s => ({ symbol: s, regularMarketPrice: null })) } })
  } catch (e) {
    res.json({ quoteResponse: { result: symbols.map(s => ({ symbol: s, regularMarketPrice: null })) } })
  }
})

/* ── Chart (OHLCV) ─────────────────────────────── */
app.get('/api/chart', async (req, res) => {
  const { symbol, interval = '1d', range = '1y' } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  try {
    const fh = await getFinnhubChart(symbol, interval, range)
    if (fh) return res.json(fh)

    const fmp = await getFMPChart(symbol, interval, range)
    if (fmp) return res.json(fmp)

    res.status(502).json({ chart: { result: null, error: { code: 'unavailable', description: 'No market data provider returned data' } } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ── Fundamentals ──────────────────────────────── */
app.get('/api/summary', async (req, res) => {
  const { symbol } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  try {
    const fmp = await getFMPSummary(symbol)
    if (fmp) return res.json(fmp)

    res.json({ quoteSummary: { result: null, error: { code: 'unavailable' } } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ── Search ────────────────────────────────────── */
app.get('/api/search', async (req, res) => {
  const { q } = req.query
  if (!q) return res.status(400).json({ error: 'q required' })
  try {
    const fh = await getFinnhubSearch(q)
    if (fh?.quotes?.length) return res.json(fh)

    const fmp = await getFMPSearch(q)
    if (fmp?.quotes?.length) return res.json(fmp)

    res.json({ quotes: [] })
  } catch (e) {
    res.json({ quotes: [] })
  }
})

/* ── News ──────────────────────────────────────── */
app.get('/api/news', async (req, res) => {
  const symbol = req.query.symbol || null
  try {
    const fh = await getFinnhubNews(symbol)
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
