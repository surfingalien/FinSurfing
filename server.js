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
    const url  = `${YF1}/v7/finance/quote?symbols=${symbols.join(',')}&fields=regularMarketPrice,regularMarketChange,regularMarketChangePercent,regularMarketVolume,marketCap,trailingPE,fiftyTwoWeekHigh,fiftyTwoWeekLow,shortName,longName,regularMarketDayHigh,regularMarketDayLow,regularMarketOpen,regularMarketPreviousClose,regularMarketTime`
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
