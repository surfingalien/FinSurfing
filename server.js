const express      = require('express')
const cors         = require('cors')
const path         = require('path')
const fs           = require('fs')
const helmet       = require('helmet')
const compression  = require('compression')
const cookieParser = require('cookie-parser')
const rateLimit    = require('express-rate-limit')

const authRoutes        = require('./routes/auth')
const portfolioRoutes   = require('./routes/portfolios')
const publicRoutes      = require('./routes/public')
const adminRoutes       = require('./routes/admin')
const agentRoutes       = require('./routes/agent')
const earningsRoutes    = require('./routes/earnings')
const earningsCallRoutes = require('./routes/earnings-call')
const backtestRoutes    = require('./routes/backtest')
const analyticsRoutes   = require('./routes/analytics')
const rebalancerRoutes      = require('./routes/rebalancer')
const recommendationsRoutes = require('./routes/recommendations')
const aiBrainRoutes         = require('./routes/ai-brain')
const tradingAnalysisRoutes = require('./routes/trading-analysis')
const governanceRoutes      = require('./routes/governance')
const researchNotesRoutes   = require('./routes/research-notes')
const sentimentRoutes       = require('./routes/sentiment')
const quantmindRoutes       = require('./routes/quantmind')
const polymarketRoutes      = require('./routes/polymarket')
const macroRoutes           = require('./routes/macro')
const schedulerRoutes       = require('./routes/scheduler')
const agentResearchRoutes   = require('./routes/agents')
const copilotRoutes         = require('./routes/copilot')
const timelineRoutes        = require('./routes/timeline')
const rcRoutes              = require('./routes/rc')
const marketIntelRoutes     = require('./routes/market-intel')
const alertsRoutes          = require('./routes/alerts')
const backtestQueueRoutes   = require('./routes/backtest-queue')
const agenticOsRoutes       = require('./routes/agentic-os')
const optionsFlowRoutes     = require('./routes/options-flow')
const symbolRoutes          = require('./routes/symbols')
// MCP endpoint depends on @modelcontextprotocol/sdk — a load failure here
// (runtime/version mismatch) must degrade to a 503 on /api/mcp, never crash
// the server: a boot crash fails Railway's healthcheck and silently pins
// prod to the previous deployment.
let mcpRoutes = null
try { mcpRoutes = require('./routes/mcp') }
catch (e) { console.error('[mcp] route disabled — failed to load:', e.message) }
const { router: marketFocusRoutes } = require('./routes/market-focus')
const dcfRoutes           = require('./routes/dcf')
const patternFinderRoutes = require('./routes/pattern-finder')
const dividendRoutes      = require('./routes/dividend')

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

const app      = express()
const PORT     = parseInt(process.env.PORT, 10) || 3001
const PROD     = process.env.NODE_ENV === 'production'
const BOOT_AT  = new Date().toISOString()
const GIT_SHA  = process.env.RAILWAY_GIT_COMMIT_SHA
             || process.env.GIT_COMMIT
             || (() => { try { return require('child_process').execSync('git rev-parse --short HEAD', { stdio: ['ignore','pipe','ignore'] }).toString().trim() } catch { return 'unknown' } })()

// ── Compression (gzip/brotli — skip SSE streams) ─────────────────────────────
app.use(compression({
  level: 6,
  threshold: 1024,
  filter: (req, res) => {
    if (req.path.startsWith('/api/stream/')) return false
    return compression.filter(req, res)
  },
}))

// ── Security headers (OWASP-recommended) ─────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc:  ["'self'"],
      scriptSrc:   ["'self'", "'unsafe-inline'", 'https://s3.tradingview.com', 'https://*.tradingview.com'],
      styleSrc:    ["'self'", "'unsafe-inline'"],
      imgSrc:      ["'self'", 'data:', 'https:'],
      frameSrc:    ["'self'", 'https://*.tradingview.com', 'https://www.tradingview.com'],
      connectSrc:  ["'self'", 'https://finnhub.io', 'https://financialmodelingprep.com', 'https://api.aisa.one', 'https://www.alphavantage.co', 'https://api.twelvedata.com', 'https://*.tradingview.com', 'wss://*.tradingview.com'],
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

// Tighter limits for market data endpoints that hit paid external APIs
const marketDataLimit = rateLimit({
  windowMs: 60 * 1000, max: 60, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Market data rate limit exceeded — try again shortly' },
})

const chartLimit = rateLimit({
  windowMs: 60 * 1000, max: 30, standardHeaders: true, legacyHeaders: false,
  message: { error: 'Chart data rate limit exceeded — try again shortly' },
})

app.use('/api', baseLimit)
app.use('/api/quote',                marketDataLimit)
app.use('/api/chart',                chartLimit)
app.use('/api/search',               marketDataLimit)
app.use('/api/auth/login',           authLoginLimit)
app.use('/api/auth/register',        authRegisterLimit)
app.use('/api/auth/forgot-password', authForgotLimit)

// ── Auth & Portfolio routes ───────────────────────
app.use('/api/auth',         authRoutes)
app.use('/api/portfolios',   portfolioRoutes)
app.use('/api/public',       publicLimit, publicRoutes)
app.use('/api/admin',        adminRoutes)
app.use('/api/agent',        agentRoutes)
app.use('/api/earnings',      earningsRoutes)
app.use('/api/earnings-call', earningsCallRoutes)
app.use('/api/backtest',     backtestRoutes)
app.use('/api/analytics',    analyticsRoutes)
app.use('/api/rebalancer',        rebalancerRoutes)
app.use('/api/recommendations',   recommendationsRoutes)
app.use('/api/ai-brain',          aiBrainRoutes)
app.use('/api/trading-analysis',  tradingAnalysisRoutes)
app.use('/api/governance',        governanceRoutes)
app.use('/api/research-notes',    researchNotesRoutes)
app.use('/api/sentiment',         sentimentRoutes)
app.use('/api/quantmind',         quantmindRoutes)
app.use('/api/polymarket',        polymarketRoutes)
app.use('/api/macro',            macroRoutes)
app.use('/api/scheduler',       schedulerRoutes)
app.use('/api/agents',          agentResearchRoutes)
app.use('/api/copilot',         copilotRoutes)
app.use('/api/timeline',        timelineRoutes)
app.use('/api/rc',              rcRoutes)
app.use('/api/market-intel',   marketIntelRoutes)
app.use('/api/alerts',         alertsRoutes)
app.use('/api/backtest/queue', backtestQueueRoutes)
app.use('/api/agentic-os',     agenticOsRoutes)
app.use('/api/options',        optionsFlowRoutes)
app.use('/api/market-focus',   marketFocusRoutes)
app.use('/api/symbols',        symbolRoutes)
if (mcpRoutes) app.use('/api/mcp', mcpRoutes)
else app.use('/api/mcp', (_req, res) => res.status(503).json({ error: 'MCP endpoint unavailable (failed to initialize at boot — check server logs)' }))
app.use('/api/dcf',      dcfRoutes)
app.use('/api/patterns', patternFinderRoutes)
app.use('/api/dividend', dividendRoutes)

// ── OpenBB sidecar proxy (optional — set OPENBB_URL env var to enable) ────────
const OPENBB_URL = process.env.OPENBB_URL

async function proxyOpenBB(req, res) {
  const qs     = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : ''
  const target = OPENBB_URL.replace(/\/$/, '') + req.path + qs
  try {
    const opts = {
      method:  req.method,
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      signal:  AbortSignal.timeout(45_000),
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') opts.body = JSON.stringify(req.body)
    const upstream = await fetch(target, opts)
    const body     = await upstream.text()
    res.status(upstream.status).set('Content-Type', 'application/json').send(body)
  } catch (e) {
    res.status(502).json({ error: 'OpenBB sidecar unreachable', detail: e.message, openbbUrl: OPENBB_URL })
  }
}

if (OPENBB_URL) {
  app.get('/api/openbb/status', async (req, res) => {
    try {
      const r = await fetch(`${OPENBB_URL}/api/v1/user`, { signal: AbortSignal.timeout(5000) })
      res.json({ ok: r.ok, status: r.status, url: OPENBB_URL })
    } catch (e) { res.status(502).json({ ok: false, error: e.message, url: OPENBB_URL }) }
  })
  app.get('/api/openbb/quote', async (req, res) => {
    const { symbol, provider = 'fmp' } = req.query
    if (!symbol) return res.status(400).json({ error: 'symbol required' })
    try {
      const r = await fetch(`${OPENBB_URL}/api/v1/equity/price/quote?symbol=${encodeURIComponent(symbol)}&provider=${provider}`, { signal: AbortSignal.timeout(10_000) })
      const data = await r.json()
      const q = Array.isArray(data?.results) ? data.results[0] : data?.results || data
      if (!q) return res.json({ quoteResponse: { result: [] } })
      res.json({ quoteResponse: { result: [{ symbol: q.symbol, shortName: q.name || symbol, regularMarketPrice: q.last_price ?? q.price ?? null, regularMarketChange: q.change ?? null, regularMarketChangePercent: q.change_percent ?? null, regularMarketVolume: q.volume ?? null, regularMarketDayHigh: q.high ?? null, regularMarketDayLow: q.low ?? null, regularMarketOpen: q.open ?? null, regularMarketPreviousClose: q.prev_close ?? null, regularMarketTime: Math.floor(Date.now() / 1000), fiftyTwoWeekHigh: q.year_high ?? null, fiftyTwoWeekLow: q.year_low ?? null, marketCap: q.market_cap ?? null }] } })
    } catch (e) { res.status(502).json({ error: e.message }) }
  })
  app.use('/api/openbb', proxyOpenBB)
  console.log(`[OpenBB] Proxy active → ${OPENBB_URL}`)
} else {
  app.use('/api/openbb', (req, res) => res.status(503).json({ ok: false, error: 'OpenBB sidecar not configured.', setup: 'Set OPENBB_URL env var' }))
}

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

// ── Server-side quote cache (30 s TTL for quotes, 15 min for charts) ─────────
const _quoteCache = new Map()
const QUOTE_TTL    = 5_000
const CHART_TTL    = 15 * 60_000
const PC_TTL       = 24 * 60 * 60_000   // prevClose only changes once per day at market open
const CACHE_MAX    = 5_000              // LRU-style eviction above this size

function _isUsRegularSession() {
  const et   = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const day  = et.getDay()
  const mins = et.getHours() * 60 + et.getMinutes()
  return day >= 1 && day <= 5 && mins >= 570 && mins < 960
}

function _cacheTtl(key) {
  if (key.startsWith('chart:')) return CHART_TTL
  if (key.startsWith('pc:'))    return PC_TTL
  // Outside regular session: keep quote cache alive for 10 min so the SSE
  // initial-flush can serve closing prices without hitting REST APIs.
  return _isUsRegularSession() ? QUOTE_TTL : 10 * 60_000
}

function cacheSet(key, data) {
  if (_quoteCache.size >= CACHE_MAX) {
    const evict = Math.ceil(CACHE_MAX * 0.1)
    const iter  = _quoteCache.keys()
    for (let i = 0; i < evict; i++) {
      const k = iter.next().value
      if (k !== undefined) _quoteCache.delete(k)
    }
  }
  _quoteCache.set(key, { data, ts: Date.now() })
}
function cacheGet(key) {
  const hit = _quoteCache.get(key)
  if (!hit) return null
  if (Date.now() - hit.ts >= _cacheTtl(key)) { _quoteCache.delete(key); return null }
  return hit.data
}
// Evict stale entries every 5 minutes
setInterval(() => {
  const now = Date.now()
  for (const [k, v] of _quoteCache) {
    if (now - v.ts > _cacheTtl(k)) _quoteCache.delete(k)
  }
}, 5 * 60_000)

// ── Concurrency-limited map ───────────────────────────────────────────────────
// Runs `fn` over `items` with at most `limit` in flight at once. Free-tier
// providers (Finnhub 30/min, Nasdaq) return HTTP 429 when a large portfolio
// fires one request per symbol all at once via Promise.all — the burst trips
// the per-second/connection limit and a few symbols silently come back unpriced.
// Throttling the fan-out keeps every symbol within the rate budget so it gets a
// real price instead of cascading down to a delayed/last-known fallback.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length)
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++
      results[i] = await fn(items[i], i)
    }
  })
  await Promise.all(workers)
  return results
}

// ── Extract user-supplied API keys from request headers ───────────────────────
// Browser stores keys in localStorage and attaches them as custom headers.
// Header keys take precedence over server env vars so users can use their own.
function extractKeys(req) {
  return {
    aisa:      (req.headers['x-aisa-key']      || '').trim() || process.env.AISA_API_KEY    || null,
    finnhub:   (req.headers['x-finnhub-key']   || '').trim() || process.env.FINNHUB_API_KEY || null,
    fmp:       (req.headers['x-fmp-key']       || '').trim() || process.env.FMP_API_KEY     || null,
    av:        (req.headers['x-av-key']        || '').trim() || process.env.ALPHA_VANTAGE_API_KEY || process.env.AV_API_KEY || null,
    td:        (req.headers['x-td-key']        || '').trim() || process.env.TWELVE_DATA_API_KEY  || null,
    marketaux: (req.headers['x-marketaux-key'] || '').trim() || process.env.MARKETAUX_API_KEY    || null,
    tiingo:    (req.headers['x-tiingo-key']    || '').trim() || process.env.TIINGO_API_KEY        || null,
    polygon:   (req.headers['x-polygon-key']   || '').trim() || process.env.POLYGON_API_KEY || process.env.MASSIVE_API_KEY || null,
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
    const sym = encodeURIComponent(symbol)

    // Try known endpoint paths in order — logs help identify the correct one
    const candidatePaths = [
      `/financial/prices?ticker=${sym}&interval=${ivl}&interval_multiplier=${mult}&start_date=${start_date}&end_date=${end_date}`,
      `/financial/historical-prices?ticker=${sym}&start=${start_date}&end=${end_date}`,
      `/market/prices?ticker=${sym}&start_date=${start_date}&end_date=${end_date}`,
      `/financial/price-history?ticker=${sym}&from=${start_date}&to=${end_date}&interval=${ivl}`,
    ]

    let data = null
    for (const path of candidatePaths) {
      try {
        const result = await aisaFetch(path, 12000, key)
        if (Array.isArray(result) && result.length > 0) {
          data = result
          console.log(`[AISA] chart path OK: ${path.split('?')[0]} for ${symbol}`)
          break
        }
        console.warn(`[AISA] chart path ${path.split('?')[0]} non-array:`, JSON.stringify(result)?.slice(0, 150))
      } catch (e) {
        console.warn(`[AISA] chart path ${path.split('?')[0]} error: ${e.message}`)
      }
    }

    if (!data) return null
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

// Real-time quote via metrics snapshot (fully serial to respect AISA rate limits ~2 req/s)
async function getAISAQuotes(symbols, keys = {}) {
  const key = keys.aisa || AISA_KEY()
  if (!key) return null
  try {
    const results = []
    for (let i = 0; i < symbols.length; i++) {
      const sym = symbols[i]
      const ck  = `aisaq:${sym}`
      const hit = cacheGet(ck)
      if (hit) { results.push(hit); continue }

      try {
        if (i > 0) await new Promise(r => setTimeout(r, 200))  // 200ms between calls = max 5/s
        const d = await aisaFetch(`/financial/financial-metrics/snapshot?ticker=${encodeURIComponent(sym)}`, 8000, key)
        // Try multiple price field names (format varies by symbol type)
        const price = d?.price ?? d?.current_price ?? d?.regularMarketPrice ?? d?.last_price ?? d?.lastPrice ?? null
        if (!price) {
          console.warn(`[AISA] null price for ${sym}:`, JSON.stringify(d)?.slice(0, 200))
          results.push({ symbol: sym, regularMarketPrice: null })
          continue
        }
        const q = {
          symbol:                     sym,
          shortName:                  d.name || sym,
          regularMarketPrice:         price,
          regularMarketChange:        d.change              ?? d.price_change        ?? null,
          regularMarketChangePercent: d.change_percent      ?? d.price_change_percent ?? null,
          regularMarketVolume:        d.volume              ?? null,
          regularMarketDayHigh:       d.day_high            ?? null,
          regularMarketDayLow:        d.day_low             ?? null,
          regularMarketOpen:          d.open                ?? null,
          regularMarketPreviousClose: d.previous_close      ?? null,
          regularMarketTime:          Math.floor(Date.now() / 1000),
          fiftyTwoWeekHigh:           d.week_52_high        ?? null,
          fiftyTwoWeekLow:            d.week_52_low         ?? null,
          marketCap:                  d.market_cap          ?? null,
          trailingPE:                 d.pe_ratio            ?? null,
        }
        cacheSet(ck, q)
        // Warm the 24h prevClose cache so Binance WS ticks can compute changePct
        // even after the 30s quote cache expires (mirrors what getFinnhubQuotes does)
        if (q.regularMarketPreviousClose) cacheSet(`pc:${sym}`, q.regularMarketPreviousClose)
        results.push(q)
      } catch (e) {
        console.warn(`[AISA] quote error for ${sym}:`, e.message)
        results.push({ symbol: sym, regularMarketPrice: null })
      }
    }
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
    // Cap concurrency: free-tier Finnhub trips its burst/connection limit when a
    // multi-holding portfolio fires every symbol at once, returning 429 → null
    // for the overflow. 6 in flight keeps the batch inside the rate budget.
    const results = await mapLimit(symbols, 6, async sym => {
      const ck = `fhq:${sym}`
      const cached = cacheGet(ck)
      // Only use cache if it has prevClose or changePct (WS ticks may have set
      // fhq: with price but null prevClose before pc: cache was seeded)
      if (cached?.regularMarketPreviousClose != null || cached?.regularMarketChangePercent != null) return cached
      try {
        const d = await apiFetch(fhUrl(`/quote?symbol=${encodeURIComponent(sym)}`, key), 8000)
        // d.c === 0 means no current trade (market closed on free tier) — return null so
        // the cascade continues to providers that have correct post-market data.
        if (!d?.c && !d?.pc) return { symbol: sym, regularMarketPrice: null }
        if (!d.c) return { symbol: sym, regularMarketPrice: null }
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
        // Cache prevClose separately with 24 h TTL so the WS handler can compute
        // change/changePct even after the 30 s quote cache expires.
        if (d.pc) cacheSet(`pc:${sym}`, d.pc)
        return q
      } catch { return { symbol: sym, regularMarketPrice: null } }
    })
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

// FMP news — company-specific or general market news
async function getFMPStockNews(symbol, keys = {}, limit = 8) {
  const key = keys.fmp || FMP_KEY()
  if (!key) return null
  try {
    const tickerParam = symbol ? `&tickers=${encodeURIComponent(symbol)}` : ''
    const data = await apiFetch(
      fmpUrl(`/stock_news?limit=${limit}${tickerParam}`, key),
      10000
    )
    if (!Array.isArray(data) || !data.length) return null
    return {
      news: data.map(a => ({
        title:               a.title,
        link:                a.url,
        publisher:           a.site,
        providerPublishTime: a.publishedDate ? Math.floor(new Date(a.publishedDate).getTime() / 1000) : null,
        thumbnail:           a.image ? { resolutions: [{ url: a.image }] } : null,
      }))
    }
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
      regularMarketTime:          q.timestamp       ?? Math.floor(Date.now() / 1000),
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
    return { quotes: data.map(r => {
      // FMP search doesn't return a type field in v3 — infer from exchange and name
      const exch = (r.exchangeShortName || '').toUpperCase()
      const name = (r.name || '').toLowerCase()
      let quoteType = 'EQUITY'
      if (
        exch === 'ETF' ||
        /\betf\b/.test(name) ||
        name.includes(' fund') || name.includes(' trust') ||
        name.includes('vanguard') || name.includes('ishares') ||
        name.includes('spdr')    || name.includes('invesco') ||
        name.includes('schwab')  || name.includes('fidelity') ||
        name.includes('blackrock') || name.includes('direxion') ||
        name.includes('proshares') || name.includes('wisdomtree')
      ) {
        quoteType = 'ETF'
      } else if (exch === 'INDEX' || name.includes(' index')) {
        quoteType = 'INDEX'
      }
      return { symbol: r.symbol, shortname: r.name, longname: r.name, quoteType, exchange: r.exchangeShortName }
    }) }
  } catch { return null }
}

// ── Twelve Data helpers ───────────────────────────────────────────────────────
// Free tier: 800 req/day, 8 req/min. Demo key works for major US symbols.
// Register at twelvedata.com for a free 800/day key (add as TWELVE_DATA_API_KEY).
// Falls back to built-in 'demo' key for AAPL/MSFT/AMZN/GOOGL/etc.

async function getTwelveDataChart(symbol, interval = '1d', range = '1y', keys = {}) {
  const key     = keys.td || process.env.TWELVE_DATA_API_KEY || 'demo'
  const ivlMap  = { '1m':'1min','5m':'5min','15m':'15min','30m':'30min','60m':'1h','1h':'1h','1d':'1day','1wk':'1week','1mo':'1month' }
  const tdIvl   = ivlMap[interval]
  if (!tdIvl) return null
  try {
    // outputsize = number of data points (not calendar days). For intraday intervals
    // we need far more bars than calendar days, so calculate per-interval.
    const calDays = { '1d':2,'5d':7,'1mo':30,'3mo':92,'6mo':184,'1y':366,'2y':732,'5y':1827,'max':5000 }[range] || 366
    const barsPerTradingDay = { '1min':390,'5min':78,'15min':26,'30min':13,'1h':7,'1day':1,'1week':0.2,'1month':0.05 }[tdIvl] || 1
    const outputsize = Math.min(Math.ceil(calDays * barsPerTradingDay * 5 / 7), 5000)
    const url        = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${tdIvl}&outputsize=${outputsize}&apikey=${key}`
    const data       = await apiFetch(url, 15000)
    if (data?.status !== 'ok' || !Array.isArray(data?.values) || !data.values.length) {
      const errMsg = data?.message || data?.code || JSON.stringify(data)?.slice(0, 200)
      console.warn(`[TwelveData] chart fail for ${symbol}: ${errMsg}`)
      return null
    }
    // Values are newest-first; reverse to oldest-first
    const rows       = [...data.values].reverse()
    const timestamps = rows.map(r => Math.floor(new Date(r.datetime + 'Z').getTime() / 1000))
    const closes     = rows.map(r => parseFloat(r.close))
    const lastClose  = closes.at(-1)
    console.log(`[TwelveData] chart OK: ${symbol} (${rows.length} bars)`)
    return {
      chart: { result: [{
        meta: { symbol, regularMarketPrice: lastClose, chartPreviousClose: closes.at(-2) ?? null },
        timestamp: timestamps,
        indicators: {
          quote:    [{ open: rows.map(r=>parseFloat(r.open)), high: rows.map(r=>parseFloat(r.high)), low: rows.map(r=>parseFloat(r.low)), close: closes, volume: rows.map(r=>parseInt(r.volume)||0) }],
          adjclose: [{ adjclose: closes }],
        },
      }], error: null },
    }
  } catch (e) { console.warn('[TwelveData] chart error:', e.message); return null }
}

// Quote via Twelve Data (single symbol, counts against quota)
async function getTwelveDataQuote(symbol, keys = {}) {
  const key  = keys.td || process.env.TWELVE_DATA_API_KEY || 'demo'
  try {
    const url  = `https://api.twelvedata.com/quote?symbol=${encodeURIComponent(symbol)}&apikey=${key}`
    const d    = await apiFetch(url, 10000)
    if (d?.status === 'error' || !d?.close) return null
    const price = parseFloat(d.close)
    if (!price) return null
    return {
      symbol,
      shortName:                  d.name || symbol,
      regularMarketPrice:         price,
      regularMarketChange:        parseFloat(d.change)           || null,
      regularMarketChangePercent: parseFloat(d.percent_change)   || null,
      regularMarketVolume:        parseInt(d.volume)             || null,
      regularMarketDayHigh:       parseFloat(d.high)             || null,
      regularMarketDayLow:        parseFloat(d.low)              || null,
      regularMarketOpen:          parseFloat(d.open)             || null,
      regularMarketPreviousClose: parseFloat(d.previous_close)   || null,
      regularMarketTime:          parseInt(d.timestamp)           || Math.floor(Date.now() / 1000),
      fiftyTwoWeekHigh:           parseFloat(d['52_week']['high'])  || null,
      fiftyTwoWeekLow:            parseFloat(d['52_week']['low'])   || null,
    }
  } catch { return null }
}

// ── Tiingo helpers ────────────────────────────────────────────────────────────
// Good for ETFs, mutual funds, and EOD prices. Free tier: 500 req/hour.
const TIINGO_KEY = () => process.env.TIINGO_API_KEY || null

async function getTiingoQuote(symbol, keys = {}) {
  const key = keys.tiingo || TIINGO_KEY()
  if (!key) return null
  try {
    const url = `https://api.tiingo.com/iex/${encodeURIComponent(symbol.toUpperCase())}?token=${key}`
    const d = await apiFetch(url, 8000)
    const q = Array.isArray(d) ? d[0] : d
    if (!q?.last) return null
    const price = parseFloat(q.last)
    if (!price) return null
    return {
      symbol,
      shortName:                  symbol,
      regularMarketPrice:         price,
      regularMarketChange:        q.last != null && q.prevClose != null ? +(price - q.prevClose).toFixed(4) : null,
      regularMarketChangePercent: q.last != null && q.prevClose != null ? +((price - q.prevClose) / q.prevClose * 100).toFixed(4) : null,
      regularMarketVolume:        parseInt(q.volume) || null,
      regularMarketDayHigh:       parseFloat(q.high) || null,
      regularMarketDayLow:        parseFloat(q.low)  || null,
      regularMarketOpen:          parseFloat(q.open) || null,
      regularMarketPreviousClose: parseFloat(q.prevClose) || null,
      regularMarketTime:          Math.floor(Date.now() / 1000),
    }
  } catch { return null }
}

// ── Polygon.io helpers ────────────────────────────────────────────────────────
// Used for quotes (as fallback) and news. Requires POLYGON_API_KEY / MASSIVE_API_KEY.
const POLYGON_KEY = () => process.env.POLYGON_API_KEY || process.env.MASSIVE_API_KEY || null

async function getPolygonQuote(symbol, keys = {}) {
  const key = keys.polygon || POLYGON_KEY()
  if (!key) return null
  try {
    const url = `https://api.polygon.io/v2/snapshot/locale/us/markets/stocks/tickers/${encodeURIComponent(symbol.toUpperCase())}?apiKey=${key}`
    const d = await apiFetch(url, 8000)
    const t = d?.ticker
    if (!t?.day?.c) return null
    const price = t.day.c
    const prev  = t.prevDay?.c || null
    return {
      symbol,
      shortName:                  t.name || symbol,
      regularMarketPrice:         price,
      regularMarketChange:        prev ? +(price - prev).toFixed(4) : null,
      regularMarketChangePercent: prev ? +((price - prev) / prev * 100).toFixed(4) : null,
      regularMarketVolume:        t.day?.v || null,
      regularMarketDayHigh:       t.day?.h || null,
      regularMarketDayLow:        t.day?.l || null,
      regularMarketOpen:          t.day?.o || null,
      regularMarketPreviousClose: prev,
      regularMarketTime:          Math.floor(Date.now() / 1000),
    }
  } catch { return null }
}

async function getPolygonNews(symbol, keys = {}, limit = 10) {
  const key = keys.polygon || POLYGON_KEY()
  if (!key) return null
  try {
    const url = `https://api.polygon.io/v2/reference/news?ticker=${encodeURIComponent(symbol.toUpperCase())}&limit=${limit}&order=desc&sort=published_utc&apiKey=${key}`
    const d = await apiFetch(url, 8000)
    if (!Array.isArray(d?.results) || !d.results.length) return null
    return {
      news: d.results.map(a => ({
        title:               a.title,
        link:                a.article_url,
        publisher:           a.publisher?.name,
        providerPublishTime: a.published_utc ? Math.floor(new Date(a.published_utc).getTime() / 1000) : null,
        thumbnail:           a.image_url ? { resolutions: [{ url: a.image_url }] } : null,
        tickers:             a.tickers,
      }))
    }
  } catch { return null }
}

async function getTiingoNews(symbol, keys = {}, limit = 10) {
  const key = keys.tiingo || TIINGO_KEY()
  if (!key) return null
  try {
    const url = `https://api.tiingo.com/tiingo/news?tickers=${encodeURIComponent(symbol.toUpperCase())}&limit=${limit}&token=${key}`
    const d = await apiFetch(url, 8000)
    if (!Array.isArray(d) || !d.length) return null
    return {
      news: d.map(a => ({
        title:               a.title,
        link:                a.url,
        publisher:           a.source,
        providerPublishTime: a.publishedDate ? Math.floor(new Date(a.publishedDate).getTime() / 1000) : null,
        thumbnail:           null,
      }))
    }
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
    // Use TIME_SERIES_DAILY (free tier) — DAILY_ADJUSTED is premium-only
    const url = `https://www.alphavantage.co/query?function=TIME_SERIES_DAILY&symbol=${encodeURIComponent(symbol)}&outputsize=${needFull ? 'full' : 'compact'}&apikey=${key}`
    const data = await apiFetch(url, 20000)
    const series = data?.['Time Series (Daily)']
    if (!series) {
      const note = data?.['Note'] || data?.['Information'] || data?.['Error Message'] || JSON.stringify(data)?.slice(0, 200)
      console.warn(`[AV] chart no-series for ${symbol}:`, note)
      return null
    }

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
    const vols   = entries.map(([,v]) => parseInt(v['5. volume']) || 0)
    const adjs   = closes  // no adjusted close on free tier — use close

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

// ── Stooq helpers (free, no API key required) ─────────────────────────────────
// stooq.com provides free historical OHLCV CSV data for US equities.
// Used as the no-key fallback so ARM/lesser-known symbols always work.

async function apiFetchText(url, timeoutMs = 15000) {
  const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.text()
}

async function getStooqChart(symbol, interval = '1d', range = '1y') {
  // Only daily/weekly — Stooq intraday requires login
  if (!['1d', '1wk'].includes(interval)) return null
  // Never try Stooq for crypto — bare tickers (SOL, BTC, ETH) match unrelated US stocks
  if (isCryptoSymbol(symbol)) return null
  // Skip forex, futures
  if (/[=!]/.test(symbol) || symbol.endsWith('-USD') || symbol.endsWith('-GBP') || symbol.endsWith('-EUR')) return null

  const stooqInterval = interval === '1wk' ? 'w' : 'd'
  const stooqSymbol   = symbol.toLowerCase().replace(/[^a-z0-9]/g, '') + '.us'

  const rangeDays = { '1d':2,'5d':8,'1mo':35,'3mo':95,'6mo':185,'1y':370,'2y':740,'5y':1830,'max':9999 }
  const daysBack  = rangeDays[range] || 370
  const d2 = new Date()
  const d1 = new Date()
  d1.setDate(d1.getDate() - daysBack)
  const fmt = d => d.toISOString().slice(0, 10).replace(/-/g, '')

  const url = `https://stooq.com/q/d/l/?s=${stooqSymbol}&d1=${fmt(d1)}&d2=${fmt(d2)}&i=${stooqInterval}`
  try {
    const text  = await apiFetchText(url, 20000)
    const lines = text.trim().split('\n')
    // Stooq returns "No data" page or empty body when symbol unknown
    if (lines.length < 2 || !lines[0].toLowerCase().includes('date')) return null

    const header   = lines[0].toLowerCase().split(',')
    const dateIdx  = header.indexOf('date')
    const openIdx  = header.indexOf('open')
    const highIdx  = header.indexOf('high')
    const lowIdx   = header.indexOf('low')
    const closeIdx = header.indexOf('close')
    const volIdx   = header.indexOf('volume')
    if (dateIdx < 0 || closeIdx < 0) return null

    // Stooq returns newest-first; sort ascending
    const rows = lines.slice(1)
      .map(l => l.split(','))
      .filter(c => c.length > closeIdx && parseFloat(c[closeIdx]) > 0)
      .sort((a, b) => a[dateIdx].localeCompare(b[dateIdx]))

    if (rows.length < 5) return null

    const timestamps = rows.map(r => Math.floor(new Date(r[dateIdx]).getTime() / 1000))
    const opens      = rows.map(r => parseFloat(r[openIdx])  || 0)
    const highs      = rows.map(r => parseFloat(r[highIdx])  || 0)
    const lows       = rows.map(r => parseFloat(r[lowIdx])   || 0)
    const closes     = rows.map(r => parseFloat(r[closeIdx]))
    const vols       = rows.map(r => volIdx >= 0 ? parseInt(r[volIdx]) || 0 : 0)
    const lastClose  = closes.at(-1) ?? null

    console.log(`[Stooq] chart OK: ${symbol} → ${stooqSymbol} (${rows.length} bars)`)
    return {
      chart: { result: [{
        meta: { symbol, regularMarketPrice: lastClose, chartPreviousClose: closes.at(-2) ?? null },
        timestamp: timestamps,
        indicators: {
          quote:    [{ open: opens, high: highs, low: lows, close: closes, volume: vols }],
          adjclose: [{ adjclose: closes }],
        },
      }], error: null },
    }
  } catch (e) { console.warn('[Stooq] chart error:', e.message); return null }
}

// ── Binance helpers (free, no API key, crypto only) ───────────────────────────
// api.binance.com is a public REST API — no auth needed for market data.
// Covers every crypto asset TradingView lists (BTC, ETH, SOL, DOGE, etc.).

// Well-known crypto base tickers (bare symbols without -USD suffix)
// Crypto classification + exchange mapping moved to lib/crypto-classify.js
const { isCryptoSymbol, toBinancePair, cgId } = require('./lib/crypto-classify')
// Disk-persisted last-known quotes — final /api/quote fallback (lib/last-quotes.js)
const { record: recordLastQuotes, recall: recallLastQuote, size: lastQuotesSize } = require('./lib/last-quotes')
const { fetchStooqQuotes } = require('./lib/stooq')

async function getBinanceChart(symbol, interval = '1d', range = '1y') {
  if (!isCryptoSymbol(symbol)) return null
  const binSym = toBinancePair(symbol)

  const ivlMap = { '1m':'1m','5m':'5m','15m':'15m','30m':'30m','60m':'1h','1h':'1h','1d':'1d','1wk':'1w','1mo':'1M' }
  const bInterval = ivlMap[interval]
  if (!bInterval) return null

  const days   = { '1d':2,'5d':7,'1mo':30,'3mo':92,'6mo':184,'1y':365,'2y':730,'5y':1825,'max':1000 }[range] || 365
  const perDay = { '1m':1440,'5m':288,'15m':96,'30m':48,'60m':24,'1h':24,'1d':1,'1wk':1/7,'1mo':1/30 }
  const limit  = Math.min(Math.ceil(days * (perDay[interval] ?? 1)), 1000)

  const url = `https://api.binance.com/api/v3/klines?symbol=${binSym}&interval=${bInterval}&limit=${limit}`
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(15000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = await r.json()
    if (!Array.isArray(d) || d.length < 5) return null

    const timestamps = d.map(k => Math.floor(k[0] / 1000))
    const opens  = d.map(k => parseFloat(k[1]))
    const highs  = d.map(k => parseFloat(k[2]))
    const lows   = d.map(k => parseFloat(k[3]))
    const closes = d.map(k => parseFloat(k[4]))
    const vols   = d.map(k => parseFloat(k[5]))
    const lastClose = closes.at(-1)

    console.log(`[Binance] chart OK: ${symbol} → ${binSym} (${d.length} bars)`)
    return {
      chart: { result: [{
        meta: { symbol, regularMarketPrice: lastClose, chartPreviousClose: closes.at(-2) ?? null },
        timestamp: timestamps,
        indicators: {
          quote:    [{ open: opens, high: highs, low: lows, close: closes, volume: vols }],
          adjclose: [{ adjclose: closes }],
        },
      }], error: null },
    }
  } catch (e) { console.warn('[Binance] chart error:', e.message); return null }
}

// Real-time quote for a single crypto symbol via Binance 24hr ticker.
async function getBinanceSingleQuote(symbol) {
  if (!isCryptoSymbol(symbol)) return null
  const binSym = toBinancePair(symbol)
  try {
    const d = await apiFetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${binSym}`, 8000)
    const price = parseFloat(d?.lastPrice)
    if (!price) return null
    const prev  = parseFloat(d.prevClosePrice) || price
    const chg   = +(price - prev).toFixed(6)
    console.log(`[Binance] quote OK: ${symbol} → ${binSym} $${price}`)
    const base = symbol.includes('-') ? symbol.split('-')[0] : symbol
    const q = {
      symbol,
      shortName:                  base,
      regularMarketPrice:         price,
      regularMarketChange:        chg,
      regularMarketChangePercent: +(chg / prev * 100).toFixed(4),
      regularMarketVolume:        parseFloat(d.volume)    || null,
      regularMarketDayHigh:       parseFloat(d.highPrice) || null,
      regularMarketDayLow:        parseFloat(d.lowPrice)  || null,
      regularMarketOpen:          parseFloat(d.openPrice) || null,
      regularMarketPreviousClose: prev,
      regularMarketTime:          Math.floor(Date.now() / 1000),
    }
    // Seed fhq: cache and pc: cache so Binance WS tick handler can compute
    // change/changePct from prevClose without needing a separate REST call.
    cacheSet(`fhq:${symbol}`, q)
    cacheSet(`pc:${symbol}`, prev)
    return q
  } catch (e) { console.warn('[Binance] quote error:', e.message); return null }
}

// ── CoinGecko helpers (free, no key, crypto fallback when Binance is blocked) ──
// api.coingecko.com is a public REST API with generous rate limits.
// Used only when Binance fails (e.g. Railway IP block). Covers 10 000+ coins.


async function getCoinGeckoChart(symbol, interval = '1d', range = '1y') {
  if (!isCryptoSymbol(symbol)) return null
  const id = cgId(symbol)
  if (!id) return null

  // CoinGecko OHLC endpoint — days param
  const daysMap = { '1d':1,'5d':7,'1mo':30,'3mo':90,'6mo':180,'1y':365,'2y':730,'5y':1825,'max':1825 }
  const days = daysMap[range] || 365

  // CoinGecko only provides daily OHLC for all ranges; for short ranges (<2d) use hourly
  const url = `https://api.coingecko.com/api/v3/coins/${id}/ohlc?vs_currency=usd&days=${days}`
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(20000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const d = await r.json()
    if (!Array.isArray(d) || d.length < 5) return null

    const timestamps = d.map(k => Math.floor(k[0] / 1000))
    const opens  = d.map(k => k[1])
    const highs  = d.map(k => k[2])
    const lows   = d.map(k => k[3])
    const closes = d.map(k => k[4])
    const lastClose = closes.at(-1)

    console.log(`[CoinGecko] chart OK: ${symbol} → ${id} (${d.length} bars)`)
    return {
      chart: { result: [{
        meta: { symbol, regularMarketPrice: lastClose, chartPreviousClose: closes.at(-2) ?? null },
        timestamp: timestamps,
        indicators: {
          quote:    [{ open: opens, high: highs, low: lows, close: closes, volume: closes.map(() => 0) }],
          adjclose: [{ adjclose: closes }],
        },
      }], error: null },
    }
  } catch (e) { console.warn('[CoinGecko] chart error:', e.message); return null }
}

async function getCoinGeckoQuote(symbol) {
  if (!isCryptoSymbol(symbol)) return null
  const id = cgId(symbol)
  if (!id) return null
  try {
    const url = `https://api.coingecko.com/api/v3/simple/price?ids=${id}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`
    const d = await apiFetch(url, 10000)
    const c = d?.[id]
    const price = c?.usd
    if (!price) return null
    const chgPct = c?.usd_24h_change ?? null
    const chg    = chgPct != null ? +(price * chgPct / 100).toFixed(6) : null
    console.log(`[CoinGecko] quote OK: ${symbol} → ${id} $${price}`)
    return {
      symbol,
      shortName:                  id,
      regularMarketPrice:         price,
      regularMarketChange:        chg,
      regularMarketChangePercent: chgPct != null ? +chgPct.toFixed(4) : null,
      regularMarketVolume:        c?.usd_24h_vol ?? null,
    }
  } catch (e) { console.warn('[CoinGecko] quote error:', e.message); return null }
}

// ── Nasdaq.com Historical API (free, no API key, US stocks + ETFs) ────────────
// api.nasdaq.com provides daily OHLCV for all US-listed equities (NYSE, NASDAQ,
// AMEX). Covers small-caps, recent IPOs, SPACs (SOUN, PLTR, etc.) that the
// Twelve Data demo key misses. No auth required.

async function getNasdaqChart(symbol, interval = '1d', range = '1y') {
  if (!['1d', '1wk'].includes(interval)) return null
  if (isCryptoSymbol(symbol) || /[=!]/.test(symbol)) return null

  const days    = { '1d':2,'5d':8,'1mo':35,'3mo':95,'6mo':185,'1y':370,'2y':740,'5y':1830,'max':9999 }
  const daysBack = Math.min(days[range] || 370, 1825)
  const todate  = new Date().toISOString().slice(0, 10)
  const fromdate = new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10)

  for (const assetclass of ['stocks', 'etf']) {
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/historical?assetclass=${assetclass}&fromdate=${fromdate}&limit=1825&todate=${todate}&type=1`
    try {
      const r = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept':          'application/json, text/plain, */*',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer':         'https://www.nasdaq.com/',
          'Origin':          'https://www.nasdaq.com',
        },
        signal: AbortSignal.timeout(18000),
      })
      if (!r.ok) continue
      const d = await r.json()
      const rows = d?.data?.tradesTable?.rows
      if (!rows?.length) continue

      const parseNum = s => parseFloat((s ?? '').replace(/[$,]/g, '')) || 0
      const parseVol = s => parseInt((s ?? '').replace(/,/g, ''))     || 0

      const sorted = [...rows]
        .filter(row => row.close && parseNum(row.close) > 0)
        .sort((a, b) => new Date(a.date) - new Date(b.date))
      if (sorted.length < 5) continue

      const timestamps = sorted.map(r => Math.floor(new Date(r.date).getTime() / 1000))
      const opens  = sorted.map(r => parseNum(r.open))
      const highs  = sorted.map(r => parseNum(r.high))
      const lows   = sorted.map(r => parseNum(r.low))
      const closes = sorted.map(r => parseNum(r.close))
      const vols   = sorted.map(r => parseVol(r.volume))
      const lastClose = closes.at(-1)

      console.log(`[Nasdaq] chart OK: ${symbol} as ${assetclass} (${sorted.length} bars)`)
      return {
        chart: { result: [{
          meta: { symbol, regularMarketPrice: lastClose, chartPreviousClose: closes.at(-2) ?? null },
          timestamp: timestamps,
          indicators: {
            quote:    [{ open: opens, high: highs, low: lows, close: closes, volume: vols }],
            adjclose: [{ adjclose: closes }],
          },
        }], error: null },
      }
    } catch (e) { console.warn(`[Nasdaq] ${assetclass} for ${symbol}:`, e.message) }
  }
  return null
}

// ── Nasdaq.com real-time quote (free, no key, US stocks + ETFs) ───────────────
async function getNasdaqQuotes(symbols) {
  const headers = {
    'Accept':          'application/json, text/plain, */*',
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Referer':         'https://www.nasdaq.com/',
    'Origin':          'https://www.nasdaq.com',
  }
  // Each symbol probes up to 3 asset classes serially; cap concurrency so a
  // large portfolio doesn't burst dozens of requests at Nasdaq and get throttled.
  const results = await mapLimit(symbols, 5, async (sym) => {
    for (const assetclass of ['stocks', 'etf', 'index']) {
      try {
        const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/info?assetClass=${assetclass}`
        const r = await fetch(url, { headers, signal: AbortSignal.timeout(8000) })
        if (!r.ok) continue
        const d = await r.json()
        const primary = d?.data?.primaryData
        if (!primary?.lastSalePrice) continue

        const rawPrice = parseFloat(primary.lastSalePrice.replace(/[^0-9.-]/g, ''))
        if (!rawPrice || rawPrice <= 0) continue

        const sign      = primary.deltaIndicator === 'down' ? -1 : 1
        const rawChange = parseFloat((primary.netChange || '0').replace(/[^0-9.]/g, '')) * sign
        const rawPct    = parseFloat((primary.percentageChange || '0').replace(/[^0-9.]/g, '')) * sign

        const keyStats = d?.data?.keyStats || {}
        const hi52 = parseFloat((keyStats.FiftyTwoWeekHighLow?.value || '').split('/')[0]?.replace(/[^0-9.]/g, ''))
        const lo52 = parseFloat((keyStats.FiftyTwoWeekHighLow?.value || '').split('/')[1]?.replace(/[^0-9.]/g, ''))

        const prevCloseNasdaq = rawChange != null ? +(rawPrice - rawChange).toFixed(4) : null
        console.log(`[Nasdaq quote] ${sym}: $${rawPrice}`)
        return {
          symbol:                     sym,
          shortName:                  d.data?.companyName || sym,
          regularMarketPrice:         rawPrice,
          regularMarketChange:        rawChange || null,
          regularMarketChangePercent: rawPct    || null,
          regularMarketPreviousClose: prevCloseNasdaq,
          regularMarketTime:          Math.floor(Date.now() / 1000),
          regularMarketVolume:        parseInt((primary.volume || '0').replace(/,/g, '')) || null,
          fiftyTwoWeekHigh:           isNaN(hi52) ? null : hi52,
          fiftyTwoWeekLow:            isNaN(lo52) ? null : lo52,
        }
      } catch { /* try next assetclass */ }
    }
    return null
  })
  return results
}


async function getAVSummary(symbol, keys = {}) {
  const key = keys.av || process.env.ALPHA_VANTAGE_API_KEY || process.env.AV_API_KEY
  if (!key) return null
  try {
    const url = `https://www.alphavantage.co/query?function=OVERVIEW&symbol=${encodeURIComponent(symbol)}&apikey=${key}`
    const d = await apiFetch(url, 12000)
    if (!d?.Symbol) {
      const note = d?.['Note'] || d?.['Information'] || d?.['Error Message'] || JSON.stringify(d)?.slice(0, 200)
      console.warn(`[AV] summary no-symbol for ${symbol}:`, note)
      return null
    }
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
          regularMarketTime:          Math.floor(Date.now() / 1000),
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
const _lastWsTick     = new Map()   // symbol → timestamp of most recent WS trade tick

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
      if (!_isUsRegularSession()) return  // ignore after-hours/pre-market ticks
      for (const t of msg.data) {
        const sym = t.s, price = t.p
        if (!sym || price == null) continue
        const prev = cacheGet(`fhq:${sym}`)
        // Fall back to the dedicated 24h prevClose cache if the 30s quote cache has expired
        const pc     = prev?.regularMarketPreviousClose ?? cacheGet(`pc:${sym}`) ?? null
        const chg    = pc != null ? +(price - pc).toFixed(4) : null
        const chgPct = pc != null ? +((price - pc) / pc * 100).toFixed(4) : null
        cacheSet(`fhq:${sym}`, {
          ...(prev || { symbol: sym, shortName: sym }),
          regularMarketPrice:         price,
          regularMarketChange:        chg,
          regularMarketChangePercent: chgPct,
          // Never overwrite a valid prevClose with null — pc:* cache may have expired
          regularMarketPreviousClose: pc ?? prev?.regularMarketPreviousClose ?? null,
          regularMarketTime:          t.t ? Math.floor(t.t / 1000) : null,
        })
        _lastWsTick.set(sym, Date.now())
        _sseBroadcast(sym, { symbol: sym, price, change: chg, changePct: chgPct, ts: t.t })
      }
    } catch {}
  })

  _fhWs.on('close', () => {
    console.warn('[Finnhub WS] closed — reconnect in', _fhWsDelay, 'ms')
    setTimeout(() => { _fhWsDelay = Math.min(_fhWsDelay * 2, 8_000); _connectFhWs() }, _fhWsDelay)
  })

  _fhWs.on('error', e => console.warn('[Finnhub WS] error:', e.message))
}

setTimeout(() => { if (FH_KEY()) _connectFhWs() }, 1000)

// ── Binance WebSocket — real-time crypto trade stream ─────────────────────────
// Covers BTC-USD, ETH-USD, SOL-USD etc. (Finnhub WS doesn't understand these)
let   _binWs          = null
let   _binWsDelay     = 1000
const _binSubscribed  = new Set()      // lowercase stream names e.g. "btcusdt@trade"
const _binToOriginal  = new Map()      // BTCUSDT → Set<'BTC-USD', ...>

function _binSend(obj) {
  if (_binWs?.readyState === WebSocket.OPEN) _binWs.send(JSON.stringify(obj))
}

function _binEnsureSub(symbol) {
  const pair      = toBinancePair(symbol).toUpperCase()
  const stream    = pair.toLowerCase() + '@trade'
  if (!_binToOriginal.has(pair)) _binToOriginal.set(pair, new Set())
  _binToOriginal.get(pair).add(symbol)
  if (_binSubscribed.has(stream)) return
  _binSubscribed.add(stream)
  _binSend({ method: 'SUBSCRIBE', params: [stream], id: Date.now() })
}

function _binUnsubIfUnused(symbol) {
  const pair   = toBinancePair(symbol).toUpperCase()
  const stream = pair.toLowerCase() + '@trade'
  const needed = [..._sseClients.values()].some(c => c.symbols.has(symbol))
  if (!needed) {
    _binToOriginal.get(pair)?.delete(symbol)
    if (!_binToOriginal.get(pair)?.size) {
      _binSubscribed.delete(stream)
      _binSend({ method: 'UNSUBSCRIBE', params: [stream], id: Date.now() })
    }
  }
}

function _connectBinWs() {
  _binWs = new WebSocket('wss://stream.binance.com:9443/ws')

  _binWs.on('open', () => {
    console.log('[Binance WS] connected')
    _binWsDelay = 1000
    const streams = [..._binSubscribed]
    if (streams.length) _binSend({ method: 'SUBSCRIBE', params: streams, id: 1 })
  })

  _binWs.on('message', raw => {
    try {
      const msg = JSON.parse(raw)
      if (msg.e !== 'trade' || !msg.s || msg.p == null) return
      const price    = parseFloat(msg.p)
      if (!price) return
      const originals = _binToOriginal.get(msg.s.toUpperCase())
      if (!originals?.size) return
      for (const sym of originals) {
        const prev   = cacheGet(`fhq:${sym}`) || cacheGet(`aisaq:${sym}`)
        const pc     = prev?.regularMarketPreviousClose ?? cacheGet(`pc:${sym}`) ?? null
        const chg    = pc != null ? +(price - pc).toFixed(6) : null
        const chgPct = pc != null ? +((price - pc) / pc * 100).toFixed(4) : null
        cacheSet(`fhq:${sym}`, {
          ...(prev || { symbol: sym, shortName: sym }),
          regularMarketPrice:         price,
          regularMarketChange:        chg,
          regularMarketChangePercent: chgPct,
          // Never overwrite a valid prevClose with null — pc:* cache may have expired
          regularMarketPreviousClose: pc ?? prev?.regularMarketPreviousClose ?? null,
          regularMarketTime:          msg.T ? Math.floor(msg.T / 1000) : null,
        })
        _lastWsTick.set(sym, Date.now())
        _sseBroadcast(sym, { symbol: sym, price, change: chg, changePct: chgPct, ts: msg.T })
      }
    } catch {}
  })

  _binWs.on('close', () => {
    console.warn('[Binance WS] closed — reconnect in', _binWsDelay, 'ms')
    setTimeout(() => { _binWsDelay = Math.min(_binWsDelay * 2, 8_000); _connectBinWs() }, _binWsDelay)
  })

  _binWs.on('error', e => console.warn('[Binance WS] error:', e.message))
}

setTimeout(() => _connectBinWs(), 1000)

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

  // Route crypto → Binance WS, stocks/ETFs → Finnhub WS
  for (const sym of symbols) {
    if (isCryptoSymbol(sym)) _binEnsureSub(sym)
    else _fhEnsureSub(sym)
  }

  // Immediately flush any cached price so the UI isn't blank while waiting for the next trade
  // Check both fhq: (Finnhub/WS) and aisaq: (AISA — primary provider) caches
  for (const sym of symbols) {
    const c = cacheGet(`fhq:${sym}`) || cacheGet(`aisaq:${sym}`)
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
    for (const sym of symbols) {
      if (isCryptoSymbol(sym)) _binUnsubIfUnused(sym)
      else _fhUnsubIfUnused(sym)
    }
  }
  req.on('close', close)
})

// ── SSE proactive price push ───────────────────────────────────────────────────
// Every 500 ms: push cached/fresh prices ONLY for symbols that haven't had a live
// WS tick in the last 1.5 s. Symbols actively ticking via Finnhub/Binance WS already
// get sub-100 ms updates via _sseBroadcast — re-broadcasting stale cache on top
// of those just adds noise and latency.
let _sseRefreshing = false
setInterval(async () => {
  if (!_sseClients.size) return
  // Outside regular session there are no new prices to push — the SSE connection
  // flush already sent closing prices on connect, and the extended-TTL cache
  // keeps them alive for REST requests.  Skip to avoid unnecessary API calls.
  if (!_isUsRegularSession()) return

  const allSyms = [...new Set([..._sseClients.values()].flatMap(c => [...c.symbols]))]
  if (!allSyms.length) return

  // Only process symbols with no recent WS tick (last 1.5 s)
  const now         = Date.now()
  const noRecentTick = allSyms.filter(s => now - (_lastWsTick.get(s) || 0) > 1500)
  if (!noRecentTick.length) return

  // Push cached prices for no-tick symbols that still have a valid cache entry
  for (const sym of noRecentTick) {
    const q = cacheGet(`fhq:${sym}`) || cacheGet(`aisaq:${sym}`)
    if (!q?.regularMarketPrice) continue
    _sseBroadcast(sym, {
      symbol:    sym,
      price:     q.regularMarketPrice,
      change:    q.regularMarketChange        ?? null,
      changePct: q.regularMarketChangePercent ?? null,
      ts:        q.regularMarketTime ? q.regularMarketTime * 1000 : null,
    })
  }

  // REST-fetch for no-tick symbols whose cache has also expired
  const stale = noRecentTick.filter(s => !cacheGet(`fhq:${s}`) && !cacheGet(`aisaq:${s}`))
  if (!stale.length || _sseRefreshing) return

  _sseRefreshing = true
  try {
    const port = process.env.PORT || 3001
    const r = await fetch(
      `http://127.0.0.1:${port}/api/quote?symbols=${stale.map(encodeURIComponent).join(',')}`,
      { signal: AbortSignal.timeout(8000) }
    )
    if (!r.ok) return
    const data = await r.json()
    for (const q of (data?.quoteResponse?.result ?? [])) {
      if (!q?.symbol || q.regularMarketPrice == null) continue
      _sseBroadcast(q.symbol, {
        symbol:    q.symbol,
        price:     q.regularMarketPrice,
        change:    q.regularMarketChange        ?? null,
        changePct: q.regularMarketChangePercent ?? null,
        ts:        q.regularMarketTime ? q.regularMarketTime * 1000 : null,
      })
    }
  } catch (e) {
    console.warn('[SSE refresh]', e.message)
  } finally {
    _sseRefreshing = false
  }
}, 500)


/* ── Health (includes DB status + demo mode) ───── */
app.get('/api/version', (_req, res) => {
  res.json({ sha: GIT_SHA, bootAt: BOOT_AT, uptime: Math.floor(process.uptime()) })
})

app.get('/health', async (_req, res) => {
  const demoMode = !process.env.DATABASE_URL
  let dbOk = false
  if (!demoMode) {
    try { const { ping } = require('./db/db'); dbOk = await ping() } catch {}
  }
  const avKey  = process.env.ALPHA_VANTAGE_API_KEY || process.env.AV_API_KEY
  const tdKey  = process.env.TWELVE_DATA_API_KEY
  const mxKey  = process.env.MARKETAUX_API_KEY
  const briefEmail = !!(process.env.MORNING_BRIEF_EMAIL || process.env.ADMIN_EMAIL)
  const hasEmailTransport = !!(process.env.RESEND_API_KEY || (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS))
  res.json({ ok: true, db: dbOk, demoMode, aisa: !!AISA_KEY(), finnhub: !!FH_KEY(), fmp: !!FMP_KEY(), av: !!avKey, td: !!tdKey, tdDemo: !tdKey, marketaux: !!mxKey, morningBriefEmail: briefEmail, emailTransport: hasEmailTransport, ts: Date.now() })
})

// Extract last price from chart cache (populated by /api/chart calls — 15-min TTL)
// Used as a fast quote source before hitting rate-limited external APIs
function getPriceFromChartCache(symbol) {
  for (const range of ['2d','5d','1mo','3mo','1y']) {
    const chart = cacheGet(`chart:${symbol}:1d:${range}`)
    const price = chart?.chart?.result?.[0]?.meta?.regularMarketPrice
    if (price != null) return price
  }
  return null
}

/* ── Quote (batch) ─────────────────────────────── */
app.get('/api/quote', async (req, res) => {
  const symbols = (req.query.symbols || '').split(',').map(s => s.trim().toUpperCase()).filter(Boolean)
  if (!symbols.length) return res.status(400).json({ error: 'symbols required' })
  const keys = extractKeys(req)

  // Subscribe to WS — warms cache for subsequent calls
  for (const sym of symbols) {
    if (isCryptoSymbol(sym)) _binEnsureSub(sym)
    else _fhEnsureSub(sym)
  }

  try {
    // Split into crypto (Binance/CoinGecko) and non-crypto (Finnhub→AISA→FMP→AV→TD)
    // Run both branches in parallel so a mixed batch (e.g. NVDA + BTC-USD) always
    // returns real-time prices for both asset classes.
    const cryptoSyms = symbols.filter(isCryptoSymbol)
    const stockSyms  = symbols.filter(s => !isCryptoSymbol(s))

    // ── Crypto: Binance real-time → CoinGecko fallback ────────────────────────
    const cryptoPromise = cryptoSyms.length
      ? (async () => {
          // Check cache first (zero-latency)
          const cached = cryptoSyms.map(s =>
            cacheGet(`fhq:${s}`) || cacheGet(`aisaq:${s}`) || null
          )
          if (cached.every(r => r !== null)) return cached

          const binResults = await Promise.all(cryptoSyms.map(s => getBinanceSingleQuote(s).catch(() => null)))
          const cgResults  = await Promise.all(cryptoSyms.map((s, i) =>
            binResults[i]?.regularMarketPrice != null
              ? Promise.resolve(null)
              : getCoinGeckoQuote(s).catch(() => null)
          ))
          return cryptoSyms.map((s, i) => binResults[i] || cgResults[i] || { symbol: s, regularMarketPrice: null })
        })()
      : Promise.resolve([])

    // ── Stocks/ETFs: Finnhub → AISA → FMP → AV → Twelve Data → cache ─────────
    // resultMap tracks per-symbol results. Two kinds of "pending":
    //   • noPricePending  — symbol has no price yet
    //   • changePending   — symbol has price but Finnhub returned null for both
    //                       changePct and prevClose (free-tier gap); needs FMP
    const stockPromise = stockSyms.length
      ? (async () => {
          const resultMap = {}

          // Merge a provider's result array into resultMap.
          // enrich=true: if a symbol already has price but no prevClose, patch it in
          // and compute change/changePct; also warm pc: cache so WS ticks work.
          const merge = (results, enrich = false) => {
            if (!results) return
            for (const r of results) {
              if (!r?.symbol) continue
              const ex = resultMap[r.symbol]
              if (!ex) {
                if (r.regularMarketPrice != null) resultMap[r.symbol] = r
              } else if (enrich && r.regularMarketPreviousClose != null && ex.regularMarketPreviousClose == null) {
                const pc = r.regularMarketPreviousClose, p = ex.regularMarketPrice
                const enriched = {
                  ...ex,
                  regularMarketPreviousClose: pc,
                  regularMarketChange:        ex.regularMarketChange        ?? r.regularMarketChange        ?? (pc ? +(p - pc).toFixed(4)             : null),
                  regularMarketChangePercent: ex.regularMarketChangePercent ?? r.regularMarketChangePercent ?? (pc ? +((p - pc) / pc * 100).toFixed(4) : null),
                }
                resultMap[r.symbol] = enriched
                cacheSet(`fhq:${r.symbol}`, enriched)   // warm so next hit is complete
                cacheSet(`pc:${r.symbol}`, pc)           // warm so WS ticks compute changePct
              }
            }
          }

          // Helpers for the two kinds of pending
          const noPrice     = () => stockSyms.filter(s => !resultMap[s])
          const needsChange = () => stockSyms.filter(s => {
            const r = resultMap[s]
            return r?.regularMarketPrice != null
              && r.regularMarketChangePercent == null
              && r.regularMarketPreviousClose == null
          })

          // 0th: instant caches — skip fhq: entries that have price but no
          // prevClose/changePct (written by WS ticks before pc: cache was seeded)
          for (const sym of stockSyms) {
            const fhq = cacheGet(`fhq:${sym}`)
            const fhqOk = fhq && (fhq.regularMarketPreviousClose != null || fhq.regularMarketChangePercent != null)
            const cached = (fhqOk ? fhq : null)
              || cacheGet(`aisaq:${sym}`)
              || (() => { const p = getPriceFromChartCache(sym); return p != null ? { symbol: sym, shortName: sym, regularMarketPrice: p } : null })()
            if (cached) resultMap[sym] = cached
          }
          if (!noPrice().length && !needsChange().length) return stockSyms.map(s => resultMap[s])

          // 1st: Finnhub REST (parallel, fastest for US stocks/ETFs)
          merge(await getFinnhubQuotes(noPrice(), keys))
          if (!noPrice().length && !needsChange().length) return stockSyms.map(s => resultMap[s])

          // 2nd: AISA (serial, 6 s budget) — only for symbols still missing a price
          if (noPrice().length) {
            const aisa = await Promise.race([
              getAISAQuotes(noPrice(), keys).catch(() => null),
              new Promise(r => setTimeout(() => r(null), 6000)),
            ])
            merge(aisa)
          }
          if (!noPrice().length && !needsChange().length) return stockSyms.map(s => resultMap[s])

          // 3rd: FMP — covers mutual funds (NAV) + enriches prevClose for partial Finnhub results
          merge(await getFMPQuotes([...new Set([...noPrice(), ...needsChange()])], keys), true)
          if (!noPrice().length) return stockSyms.map(s => resultMap[s])

          // 4th: Alpha Vantage
          merge(await getAVQuotes(noPrice(), keys))
          if (!noPrice().length) return stockSyms.map(s => resultMap[s])

          // 5th: Nasdaq.com (free, no key — covers all US stocks/ETFs in real-time)
          merge(await getNasdaqQuotes(noPrice()).catch(() => null))
          if (!noPrice().length) return stockSyms.map(s => resultMap[s])

          // 6th: Twelve Data
          merge(await Promise.all(noPrice().map(s => getTwelveDataQuote(s, keys).catch(() => null))))
          if (!noPrice().length) return stockSyms.map(s => resultMap[s])

          // 7th: Tiingo — strong for ETFs/mutual funds missed by others
          merge(await Promise.all(noPrice().map(s => getTiingoQuote(s, keys).catch(() => null))))
          if (!noPrice().length) return stockSyms.map(s => resultMap[s])

          // 8th: Polygon — real-time snapshot, good breadth
          merge(await Promise.all(noPrice().map(s => getPolygonQuote(s, keys).catch(() => null))))
          if (!noPrice().length) return stockSyms.map(s => resultMap[s])

          // 9th: Stooq — keyless CSV fallback; works when every keyed
          // provider is down or misconfigured (delayed/EOD, price only)
          merge(await fetchStooqQuotes(noPrice()).catch(() => null))

          // Final: chart-price cache or null for anything still missing
          for (const sym of stockSyms) {
            if (!resultMap[sym]) {
              const p = getPriceFromChartCache(sym)
              resultMap[sym] = p != null ? { symbol: sym, shortName: sym, regularMarketPrice: p } : { symbol: sym, regularMarketPrice: null }
            }
          }

          return stockSyms.map(s => resultMap[s])
        })()
      : Promise.resolve([])

    // ── Merge results preserving original symbol order ─────────────────────────
    const [cryptoResults, stockResults] = await Promise.all([cryptoPromise, stockPromise])

    const cryptoMap = Object.fromEntries(cryptoResults.map(r => [r.symbol, r]))
    const stockMap  = Object.fromEntries(stockResults.map(r => [r.symbol, r]))
    // Final fallback: when every provider failed, serve the disk-persisted
    // last-known quote (flagged stale) instead of a null price — survives
    // deploys, unlike the in-memory TTL cache.
    const merged = symbols.map(s => {
      const q = cryptoMap[s] || stockMap[s]
      if (q?.regularMarketPrice != null) return q
      return recallLastQuote(s) || q || { symbol: s, regularMarketPrice: null }
    })
    recordLastQuotes(merged)

    return res.json({ quoteResponse: { result: merged } })
  } catch (e) {
    res.json({ quoteResponse: { result: symbols.map(s => recallLastQuote(s) || ({ symbol: s, regularMarketPrice: null })) } })
  }
})

/* ── Provider health — diagnose an empty /api/quote in seconds ───────────────
   Probes every quote provider live with one symbol each (8s budget),
   reporting key presence + source (booleans/labels only), success, price,
   latency, and the cache + last-known-quote store state.
   Browser-saved API keys (finsurf_api_keys → x-*-key headers) OVERRIDE server
   env keys in the quote pipeline — a stale saved key can break a provider for
   that user while the server is healthy. keySource exposes this; pass
   ?useEnvKeys=1 to probe with server env keys only for an A/B comparison. */
app.get('/api/health/providers', async (req, res) => {
  const useEnv = req.query.useEnvKeys === '1'
  const keys = useEnv ? extractKeys({ headers: {} }) : extractKeys(req)
  const HEADER_FOR = { aisa: 'x-aisa-key', finnhub: 'x-finnhub-key', fmp: 'x-fmp-key', twelvedata: 'x-td-key', tiingo: 'x-tiingo-key' }
  const keySource = (provider, configured) => {
    if (!configured) return 'none'
    if (useEnv) return 'env'
    const h = HEADER_FOR[provider]
    return h && (req.headers[h] || '').trim() ? 'header (browser-saved — overrides server key!)' : 'env'
  }
  const SYM  = 'AAPL'
  const wrap = p => Promise.resolve(p).then(r => (Array.isArray(r) ? r : [r]))
  const probes = [
    ['aisa',       !!keys.aisa,    () => wrap(getAISAQuotes([SYM], keys))],
    ['finnhub',    !!keys.finnhub, () => wrap(getFinnhubQuotes([SYM], keys))],
    ['fmp',        !!keys.fmp,     () => wrap(getFMPQuotes([SYM], keys))],
    ['twelvedata', !!keys.td,      () => wrap(getTwelveDataQuote(SYM, keys))],
    ['tiingo',     !!keys.tiingo,  () => wrap(getTiingoQuote(SYM, keys))],
    ['nasdaq',     true,           () => wrap(getNasdaqQuotes([SYM]))],
    ['stooq',      true,           () => wrap(fetchStooqQuotes([SYM]))],
    ['binance',    true,           () => wrap(getBinanceSingleQuote('BTC-USD'))],
    ['coingecko',  true,           () => wrap(getCoinGeckoQuote('BTC-USD'))],
  ]
  const providers = await Promise.all(probes.map(async ([provider, keyConfigured, fn]) => {
    const t0 = Date.now()
    try {
      const arr = await Promise.race([
        fn(),
        new Promise((_, rej) => setTimeout(() => rej(new Error('probe timeout (8s)')), 8000)),
      ])
      const q = (arr || []).find(x => x?.regularMarketPrice != null)
      return { provider, keyConfigured, keySource: keySource(provider, keyConfigured),
               ok: q != null, price: q?.regularMarketPrice ?? null,
               ms: Date.now() - t0, error: q ? null : 'no price returned' }
    } catch (e) {
      return { provider, keyConfigured, keySource: keySource(provider, keyConfigured),
               ok: false, price: null, ms: Date.now() - t0, error: e.message }
    }
  }))
  res.json({
    at: new Date().toISOString(),
    keyMode: useEnv ? 'env only (?useEnvKeys=1)' : 'as the app would use them (browser headers override env)',
    probeSymbols: { stocks: SYM, crypto: 'BTC-USD' },
    providers,
    anyStockProviderOk: providers.some(p => p.ok && !['binance', 'coingecko'].includes(p.provider)),
    lastQuotesStored: lastQuotesSize(),
    quoteCacheEntries: _quoteCache.size,
  })
})

/* ── Chart (OHLCV) ─────────────────────────────── */
app.get('/api/chart', async (req, res) => {
  const { symbol, interval = '1d', range = '1y' } = req.query
  if (!symbol) return res.status(400).json({ error: 'symbol required' })
  const keys = extractKeys(req)

  // Serve from cache when available (15-min TTL)
  const cacheKey = `chart:${symbol}:${interval}:${range}`
  const cached = cacheGet(cacheKey)
  if (cached) return res.json(cached)

  try {
    // Helper: cache chart result + warm the per-symbol price cache for /api/quote
    const saveChart = (data, provider) => {
      cacheSet(cacheKey, data)
      const price = data?.chart?.result?.[0]?.meta?.regularMarketPrice
      if (price != null && !cacheGet(`aisaq:${symbol}`)) {
        cacheSet(`aisaq:${symbol}`, { symbol, shortName: symbol, regularMarketPrice: price })
      }
      console.log(`[chart] ${provider}: ${symbol}`)
      return data
    }

    // 1st: AISA — cloud-friendly Yahoo Finance proxy
    const aisa = await getAISAChart(symbol, interval, range, keys).catch(() => null)
    if (aisa) return res.json(saveChart(aisa, 'AISA'))

    // 2nd: Finnhub candles
    const fh = await getFinnhubChart(symbol, interval, range, keys)
    if (fh) return res.json(saveChart(fh, 'Finnhub'))

    // 3rd: FMP historical
    const fmp = await getFMPChart(symbol, interval, range, keys)
    if (fmp) return res.json(saveChart(fmp, 'FMP'))

    // 3.5: Crypto fast-path — Binance then CoinGecko (free, real-time, no key)
    // Must run BEFORE Twelve Data: TD demo key returns stale crypto prices.
    // CoinGecko is the fallback if Binance is blocked on Railway's IPs.
    if (isCryptoSymbol(symbol)) {
      const binanceFast = await getBinanceChart(symbol, interval, range)
      if (binanceFast) return res.json(saveChart(binanceFast, 'Binance'))
      const cgFast = await getCoinGeckoChart(symbol, interval, range)
      if (cgFast) return res.json(saveChart(cgFast, 'CoinGecko'))
    }

    // 4th: Twelve Data (800 req/day free tier; demo key covers major US symbols)
    const td = await getTwelveDataChart(symbol, interval, range, keys)
    if (td) return res.json(saveChart(td, 'TwelveData'))

    // 5th: Alpha Vantage (25 req/day free tier)
    const av = await getAVChart(symbol, interval, range, keys)
    if (av) return res.json(saveChart(av, 'AV'))

    // 6th: Binance fallback for crypto that slipped past the fast-path
    const binance = await getBinanceChart(symbol, interval, range)
    if (binance) return res.json(saveChart(binance, 'Binance'))

    // 7th: Nasdaq.com (free, no key — all US stocks + ETFs, daily/weekly only)
    const nasdaq = await getNasdaqChart(symbol, interval, range)
    if (nasdaq) return res.json(saveChart(nasdaq, 'Nasdaq'))

    // 8th: Stooq (free, no key — additional US equity coverage)
    const stooq = await getStooqChart(symbol, interval, range)
    if (stooq) return res.json(saveChart(stooq, 'Stooq'))

    // Fallbacks for intraday when all intraday providers failed — try daily data
    if (!['1d', '1wk'].includes(interval)) {
      const nasdaqD = await getNasdaqChart(symbol, '1d', range === '1d' || range === '5d' ? '1mo' : range)
      if (nasdaqD) return res.json(saveChart(nasdaqD, 'Nasdaq-daily'))

      const binanceD = await getBinanceChart(symbol, '1d', range)
      if (binanceD) return res.json(saveChart(binanceD, 'Binance-daily'))

      const stooqD = await getStooqChart(symbol, '1d', '1y')
      if (stooqD) return res.json(saveChart(stooqD, 'Stooq-daily'))
    }

    res.status(502).json({ error: `No price history available for ${symbol} — not covered by any data provider (may be illiquid, delisted, or non-US)`, chart: { result: null, error: { code: 'unavailable', description: 'No market data provider returned data' } } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

// Build a minimal quoteSummary from the AISA snapshot (P/E, market cap, 52w range etc.)
async function getAISASummary(symbol, keys = {}) {
  const key = keys.aisa || AISA_KEY()
  if (!key) return null
  try {
    const d = await aisaFetch(`/financial/financial-metrics/snapshot?ticker=${encodeURIComponent(symbol)}`, 8000, key)
    const price = d?.price ?? d?.current_price ?? null
    if (!price) return null
    console.log(`[AISA] summary OK: ${symbol}`)
    return { quoteSummary: { result: [{
      summaryDetail: {
        trailingPE:       d.pe_ratio           ?? null,
        forwardPE:        d.forward_pe         ?? null,
        marketCap:        d.market_cap         ?? null,
        dividendYield:    d.dividend_yield     ?? null,
        beta:             d.beta               ?? null,
        fiftyTwoWeekHigh: d.week_52_high       ?? null,
        fiftyTwoWeekLow:  d.week_52_low        ?? null,
        averageVolume:    d.avg_volume          ?? null,
      },
      financialData: {
        returnOnEquity:   d.return_on_equity   ?? null,
        profitMargins:    d.profit_margin      ?? null,
        grossMargins:     d.gross_margin       ?? null,
        targetMeanPrice:  d.target_price       ?? null,
        recommendationKey: null,
        totalRevenue:     d.revenue            ?? null,
        earningsGrowth:   d.earnings_growth    ?? null,
        revenueGrowth:    d.revenue_growth     ?? null,
      },
      defaultKeyStatistics: {
        trailingEps: d.eps            ?? null,
        priceToBook: d.price_to_book  ?? null,
      },
      assetProfile: {
        sector:              d.sector           ?? null,
        industry:            d.industry         ?? null,
        longName:            d.name             ?? null,
        longBusinessSummary: d.description      ?? null,
        fullTimeEmployees:   d.employees        ?? null,
        country:             d.country          ?? null,
      },
    }], error: null } }
  } catch (e) { console.warn('[AISA] summary error:', e.message); return null }
}

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

    // 3rd: AISA snapshot (partial fundamentals — P/E, market cap, 52w range)
    const aisa = await getAISASummary(symbol, keys)
    if (aisa) return res.json(aisa)

    res.json({ quoteSummary: { result: null, error: { code: 'unavailable' } } })
  } catch (e) {
    res.status(500).json({ error: e.message })
  }
})

/* ── Search ────────────────────────────────────── */
async function getAVSearch(query, keys = {}) {
  const key = keys.av || process.env.ALPHA_VANTAGE_API_KEY || process.env.AV_API_KEY
  if (!key) return null
  try {
    const url  = `https://www.alphavantage.co/query?function=SYMBOL_SEARCH&keywords=${encodeURIComponent(query)}&apikey=${key}`
    const data = await apiFetch(url, 10000)
    const matches = data?.bestMatches
    if (!Array.isArray(matches) || !matches.length) return null
    return { quotes: matches
      .filter(m => m['4. region'] === 'United States' || m['1. symbol'].length <= 5)
      .slice(0, 8)
      .map(m => ({
        symbol:    m['1. symbol'],
        shortname: m['2. name'],
        longname:  m['2. name'],
        quoteType: m['3. type'] === 'Equity' ? 'EQUITY' : m['3. type']?.toUpperCase() || 'EQUITY',
        exchange:  m['4. region'],
      }))
    }
  } catch { return null }
}

async function getTwelveDataSearch(query, keys = {}) {
  const key  = keys.td || process.env.TWELVE_DATA_API_KEY || 'demo'
  try {
    const url  = `https://api.twelvedata.com/symbol_search?symbol=${encodeURIComponent(query)}&apikey=${key}`
    const data = await apiFetch(url, 8000)
    const list = data?.data
    if (!Array.isArray(list) || !list.length) return null
    return { quotes: list
      .filter(s =>
        s.country === 'United States' ||
        s.exchange?.startsWith('NASDAQ') ||
        s.exchange?.startsWith('NYSE') ||
        s.exchange?.startsWith('AMEX') ||
        s.exchange?.startsWith('CBOE') ||
        s.exchange?.startsWith('BATS') ||
        s.instrument_type?.toUpperCase() === 'ETF'
      )
      .slice(0, 8)
      .map(s => ({
        symbol:    s.symbol,
        shortname: s.instrument_name,
        longname:  s.instrument_name,
        quoteType: s.instrument_type?.toUpperCase() || 'EQUITY',
        exchange:  s.exchange,
      }))
    }
  } catch { return null }
}

// Rank search results: exact ticker match first, then by symbol length (shorter = more relevant)
function rankSearchQuotes(quotes, q) {
  const qUp = q.trim().toUpperCase()
  return quotes.slice().sort((a, b) => {
    const sA = (a.symbol || '').toUpperCase()
    const sB = (b.symbol || '').toUpperCase()
    const exactA = sA === qUp ? 10 : 0
    const exactB = sB === qUp ? 10 : 0
    if (exactB !== exactA) return exactB - exactA
    return sA.length - sB.length
  })
}

app.get('/api/search', async (req, res) => {
  const { q } = req.query
  if (!q) return res.status(400).json({ error: 'q required' })
  const keys = extractKeys(req)
  try {
    const fh = await getFinnhubSearch(q, keys)
    if (fh?.quotes?.length) return res.json({ quotes: rankSearchQuotes(fh.quotes, q) })

    const fmp = await getFMPSearch(q, keys)
    if (fmp?.quotes?.length) return res.json({ quotes: rankSearchQuotes(fmp.quotes, q) })

    const td = await getTwelveDataSearch(q, keys)
    if (td?.quotes?.length) return res.json({ quotes: rankSearchQuotes(td.quotes, q) })

    const av = await getAVSearch(q, keys)
    if (av?.quotes?.length) return res.json({ quotes: rankSearchQuotes(av.quotes, q) })

    res.json({ quotes: [] })
  } catch (e) {
    res.json({ quotes: [] })
  }
})

/* ── News ──────────────────────────────────────── */
app.get('/api/news', async (req, res) => {
  const symbol = req.query.symbol || null
  const keys   = extractKeys(req)
  try {
    // 1. Polygon — fast, good breadth, free tier generous
    if (symbol) {
      const poly = await getPolygonNews(symbol, keys, 10)
      if (poly?.news?.length) return res.json(poly)
    }

    // 2. FMP — better financial news coverage for general feed
    const fmp = await getFMPStockNews(symbol, keys, symbol ? 10 : 15)
    if (fmp?.news?.length) return res.json(fmp)

    // 3. Tiingo news
    if (symbol) {
      const tiingo = await getTiingoNews(symbol, keys, 10)
      if (tiingo?.news?.length) return res.json(tiingo)
    }

    // 4. Finnhub fallback
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

if (PROD) {
  if (!process.env.APP_URL)
    console.warn('[startup] WARNING: APP_URL not set — password reset links will point to http://localhost:5173')
  if (!process.env.ALLOWED_ORIGINS)
    console.warn('[startup] WARNING: ALLOWED_ORIGINS not set — CORS will only allow http://localhost:5173')
}

app.listen(PORT, '0.0.0.0', () => {
  console.log(`FinSurf listening on 0.0.0.0:${PORT}`)
  // Start scheduled background jobs after server is ready
  setTimeout(() => {
    try { require('./lib/scheduled-jobs').init() }
    catch (e) { console.error('[scheduled-jobs] init failed:', e.message) }
  }, 5_000)
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
          const url = `http://127.0.0.1:${process.env.PORT || 3001}/api/chart?symbol=${encodeURIComponent(sym)}&interval=1d&range=2d`
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

