'use strict'
/**
 * routes/market-focus.js
 *
 * GET  /api/market-focus        — returns current focus items (cached, refreshed every 30 min during market hours)
 * POST /api/market-focus/refresh — manually trigger a fresh analysis (auth required)
 *
 * The AI looks at the user's holdings + watchlist symbols, fetches live quotes,
 * options flow signals, and macro context, then returns a prioritised list of
 * what to watch/act on during the current trading session.
 */

const express    = require('express')
const rateLimit  = require('express-rate-limit')
const { requireAuth } = require('../middleware/auth')
const { getRouter } = require('../lib/ai-router')
const { getSocialSentiment } = require('../lib/social-sentiment')
const { getOptionsFlowCompact } = require('../lib/options-flow-cache')

const aiRouter = getRouter('market-focus')

const router = express.Router()

const refreshLimit = rateLimit({
  windowMs: 5 * 60 * 1000, max: 3,
  skip: (req) => {
    const addr = req.socket?.remoteAddress || ''
    return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
  },
  message: { error: 'Too many refresh requests — wait a few minutes' },
})

// ── In-memory cache ───────────────────────────────────────────────────────────
// Shared across all users — focus is market-wide + common holdings/watchlist.
// Per-user personalisation is handled via the holdings/watchlist passed in.

let _cache = {
  focusItems:    [],
  marketPulse:   null,
  sessionTheme:  '',
  updatedAt:     null,
  nextRefreshAt: null,
  dataSource:    'pending',
}

function isMarketHours() {
  const now = new Date()
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const day = et.getDay()   // 0=Sun, 6=Sat
  if (day === 0 || day === 6) return false
  const h = et.getHours(), m = et.getMinutes()
  const mins = h * 60 + m
  return mins >= 9 * 60 + 30 && mins < 16 * 60
}

function isPreMarket() {
  const now = new Date()
  const et = new Date(now.toLocaleString('en-US', { timeZone: 'America/New_York' }))
  const day = et.getDay()
  if (day === 0 || day === 6) return false
  const h = et.getHours(), m = et.getMinutes()
  const mins = h * 60 + m
  return mins >= 7 * 60 && mins < 9 * 60 + 30
}

function getSessionLabel() {
  if (isPreMarket()) return 'Pre-Market'
  if (isMarketHours()) return 'Live Market'
  return 'After Hours'
}

const BASE_URL = () => `http://127.0.0.1:${process.env.PORT || 3001}`

async function fetchLiveQuotes(symbols) {
  try {
    const r = await fetch(
      `${BASE_URL()}/api/quote?symbols=${symbols.join(',')}`,
      { headers: { 'x-internal': '1' }, signal: AbortSignal.timeout(15_000) }
    )
    const d = await r.json()
    return d?.quoteResponse?.result ?? []
  } catch { return [] }
}

async function fetchMacroSummary() {
  try {
    const r = await fetch(`${BASE_URL()}/api/macro/summary`, {
      headers: { 'x-internal': '1' }, signal: AbortSignal.timeout(10_000)
    })
    const d = await r.json()
    return typeof d === 'string' ? d : d?.summary ?? ''
  } catch { return '' }
}

// ── Core analysis ─────────────────────────────────────────────────────────────

async function runFocusAnalysis({ holdings = [], watchlist = [] }) {

  // Combine and deduplicate — holdings take priority
  const allSymbols = [...new Set([...holdings.slice(0, 15), ...watchlist.slice(0, 10)])]
  if (!allSymbols.length) {
    // Fall back to broad defaults when user has no holdings
    allSymbols.push('SPY', 'QQQ', 'NVDA', 'AAPL', 'MSFT', 'AMZN', 'META', 'TSLA', 'BTC-USD', 'ETH-USD')
  }

  const sessionLabel = getSessionLabel()
  const now = new Date()
  const etTime = now.toLocaleString('en-US', {
    timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit', hour12: true
  })

  const stockSyms = allSymbols.filter(s => !s.includes('-') && !s.includes('='))
  const port = process.env.PORT || 3001

  const [quotes, macroSummary, socialSnippet, optionsResults] = await Promise.all([
    fetchLiveQuotes(allSymbols),
    fetchMacroSummary(),
    getSocialSentiment(allSymbols.slice(0, 8)).catch(() => ''),
    stockSyms.length
      ? Promise.all(stockSyms.slice(0, 5).map(s => getOptionsFlowCompact(s, port, {}).catch(() => null)))
      : Promise.resolve([]),
  ])

  const optionsSnippet = optionsResults.filter(Boolean).length
    ? '\nOPTIONS FLOW (P/C ratio + unusual activity):\n  ' + optionsResults.filter(Boolean).join('\n  ')
    : ''

  // Build quote snapshot
  const quoteRows = quotes
    .filter(q => q?.regularMarketPrice)
    .map(q => {
      const pct = q.regularMarketChangePercent ?? 0
      const vol = q.regularMarketVolume
      const avg = q.averageDailyVolume3Month
      const volRatio = (vol && avg) ? (vol / avg).toFixed(2) : null
      const hi52 = q.fiftyTwoWeekHigh
      const lo52 = q.fiftyTwoWeekLow
      const pctFrom52hi = hi52 ? ((q.regularMarketPrice - hi52) / hi52 * 100).toFixed(1) : null
      const isHolding = holdings.includes(q.symbol)
      // Analyst consensus
      const target  = q.targetMedianPrice
      const recMean = q.recommendationMean
      const count   = q.numberOfAnalystOpinions
      const analystStr = target != null
        ? ` analyst_target=$${target.toFixed(0)}${count ? `(${count}×)` : ''}${recMean != null ? ` rec=${recMean.toFixed(1)}/5` : ''}`
        : ''
      return `${isHolding ? '★' : '○'} ${q.symbol}: $${q.regularMarketPrice.toFixed(q.regularMarketPrice >= 1 ? 2 : 6)} (${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%)${volRatio ? ` vol=${volRatio}x` : ''}${pctFrom52hi !== null ? ` 52wk_hi${pctFrom52hi}%` : ''}${analystStr}`
    })
    .join('\n')

  const holdingSet = new Set(holdings)

  const prompt = `You are a real-time trading intelligence system. It is ${etTime} ET — ${sessionLabel}.

${macroSummary ? `MACRO CONTEXT: ${macroSummary}\n` : ''}${socialSnippet || ''}${optionsSnippet}
LIVE SNAPSHOT (★ = user holding, ○ = watchlist):
${quoteRows || 'No live data — use recent knowledge'}

Holdings (owned positions): ${holdings.join(', ') || 'none'}
Watchlist: ${watchlist.join(', ') || 'none'}

Your job: Analyze what the user should FOCUS ON during this trading session.

For EACH symbol, decide:
- Is there an intraday signal (breakout, breakdown, volume spike, momentum shift)?
- Is a holding approaching stop-loss or take-profit zone?
- Is there a news/catalyst risk today?
- What is the predicted direction for the rest of TODAY's session?
- What ACTION if any should the user consider?

Priority tiers:
  🔴 URGENT — stop-loss approach, breakout imminent, high vol anomaly, crash signal
  🟡 WATCH  — building momentum, catalyst expected, near key level
  🟢 HOLD   — performing as expected, no action needed
  ⚪ SKIP   — irrelevant today

Respond ONLY with valid JSON (no markdown):
{
  "sessionTheme": "≤12 words describing the dominant market theme right now",
  "marketPulse": {
    "sentiment": "Bullish|Bearish|Mixed|Cautious",
    "strength": "Strong|Moderate|Weak",
    "breadth": "≤10 words on market breadth",
    "keyRisk": "≤12 words on single biggest risk today"
  },
  "focusItems": [
    {
      "symbol": "TICKER",
      "priority": "urgent|watch|hold|skip",
      "isHolding": true,
      "action": "Hold|Buy dip|Trim|Cut|Watch|Skip",
      "prediction": "≤12 words — predicted direction and reasoning for today",
      "signal": "≤10 words — specific technical/flow signal driving this",
      "priceTarget": 182.50,
      "stopWatch": 174.00,
      "analystTarget": 190.00,
      "confidence": "High|Medium|Low",
      "timeframe": "Next 1h|Rest of session|2-3 days|Week"
    }
  ],
  "topOpportunity": "≤15 words — single best trade setup right now",
  "topRisk": "≤15 words — single biggest threat to act on",
  "sessionPlan": "2-3 sentences — what to do for the rest of this session"
}

Rules:
- Sort focusItems: urgent first, then watch, then hold, skip last
- Only include up to 10 items total
- priceTarget: the next meaningful upside price level to watch (resistance, prior high, round number) — always provide a number, do NOT leave null
- stopWatch: the key support level that, if broken, signals trouble — always provide a number for holdings and urgent/watch items, null only for skip items
- analystTarget: the analyst_target from the snapshot above if available, otherwise null
- Holdings (★) get more weight — protect capital first
- If market closed / pre-market, focus on preparation for next session`

  try {
    const { text } = await aiRouter.call({ prompt, maxTokens: 2000, symbols: allSymbols })
    const match = text.match(/\{[\s\S]*\}/)
    if (!match) throw new Error('No JSON in focus analysis response')
    const data = JSON.parse(match[0])

    const nextMins = 30
    _cache = {
      focusItems:   data.focusItems   || [],
      marketPulse:  data.marketPulse  || null,
      sessionTheme: data.sessionTheme || '',
      topOpportunity: data.topOpportunity || '',
      topRisk:        data.topRisk        || '',
      sessionPlan:    data.sessionPlan    || '',
      updatedAt:    new Date().toISOString(),
      nextRefreshAt: new Date(Date.now() + nextMins * 60_000).toISOString(),
      dataSource:   quotes.length > 0 ? 'live' : 'knowledge',
      sessionLabel,
    }
    console.log(`[market-focus] analysis done: ${_cache.focusItems.length} items, theme="${_cache.sessionTheme}"`)
    return _cache
  } catch (e) {
    console.error('[market-focus] analysis failed:', e.message)
    return null
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

router.get('/', async (req, res) => {
  // Serve cache if fresh (< 35 min old)
  if (_cache.updatedAt) {
    const age = Date.now() - new Date(_cache.updatedAt).getTime()
    if (age < 35 * 60_000) return res.json({ ..._cache, cached: true })
  }

  // No cache — run analysis with empty holdings (user context not needed for first load)
  const result = await runFocusAnalysis({ holdings: [], watchlist: [] })
  if (!result) return res.json({ ..._cache, cached: false, error: 'Analysis unavailable' })
  res.json({ ...result, cached: false })
})

router.post('/refresh', requireAuth, refreshLimit, async (req, res) => {
  const { holdings = [], watchlist = [] } = req.body
  const result = await runFocusAnalysis({ holdings, watchlist })
  if (!result) return res.status(500).json({ error: 'Focus analysis failed — try again' })
  res.json({ ...result, cached: false })
})

// Called by scheduled-jobs — no auth needed (internal)
async function runScheduledFocus(holdings = [], watchlist = []) {
  return runFocusAnalysis({ holdings, watchlist })
}

module.exports = { router, runScheduledFocus, getCache: () => _cache }
