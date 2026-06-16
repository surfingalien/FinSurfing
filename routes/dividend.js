'use strict'
/**
 * routes/dividend.js
 *
 * POST /api/dividend/screen  (public — no auth)
 * body: { symbols?, investmentAmount?, monthlyIncomeGoal? }
 *
 * Screens a dividend universe: pulls FMP profile + 5y dividend history per
 * symbol, computes yield / growth streak / 5y CAGR server-side, then asks
 * Claude to score safety, build a portfolio income projection, and pick a top.
 */

const express       = require('express')
const router        = express.Router()
const rateLimit     = require('express-rate-limit')
const { getRouter } = require('../lib/ai-router')

const aiRouter = getRouter('dividend')

const FMP_KEY = () => process.env.FMP_API_KEY || null

const dividendLimit = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: 'Too many dividend screen requests — wait a minute' },
})

const DEFAULT_UNIVERSE = [
  'JNJ', 'KO', 'PG', 'ABBV', 'MCD', 'T', 'VZ', 'XOM', 'CVX', 'O',
  'MAIN', 'ARCC', 'EPD', 'MMP', 'BTI', 'AVGO', 'TXN', 'MSFT', 'HD', 'LOW',
]

const VALID_SYMBOL = /^[A-Za-z0-9.\-]{1,10}$/

const SYSTEM_PROMPT =
  'You are a dividend income strategist. Return ONLY valid JSON matching the ' +
  'exact schema provided. No markdown, no explanation.'

// See routes/dcf.js for why FMP errors must be surfaced (plan/rate limits
// arrive as HTTP 200 with an {"Error Message": ...} body).
let _lastFmpError = null

async function fmpJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!r.ok) {
      if (r.status === 401 || r.status === 403) _lastFmpError = 'FMP API key invalid or lacks access to this data'
      else if (r.status === 429) _lastFmpError = 'FMP rate limit reached — try again shortly'
      return null
    }
    const d = await r.json()
    if (d && !Array.isArray(d) && (d['Error Message'] || d.error)) {
      _lastFmpError = d['Error Message'] || d.error
      return null
    }
    return d
  } catch {
    return null
  }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ── Per-symbol metric computation from profile + dividend history ─────────────
function computeMetrics(sym, profileRow, dividendData) {
  const price = num(profileRow?.price)
  const lastAnnualDividend = num(profileRow?.lastAnnualDividend)
  const dividendYield = (lastAnnualDividend != null && price && price > 0)
    ? Number((lastAnnualDividend / price * 100).toFixed(3))
    : null

  // Aggregate dividends by calendar year
  const hist = Array.isArray(dividendData?.historical) ? dividendData.historical : []
  const byYear = {}
  for (const d of hist) {
    const yr = (d.date || d.paymentDate || '').slice(0, 4)
    const amt = num(d.dividend ?? d.adjDividend)
    if (yr && amt != null) byYear[yr] = (byYear[yr] || 0) + amt
  }

  const currentYear = new Date().getFullYear()
  // Use completed years only for streak/CAGR (exclude the in-progress current year)
  const years = Object.keys(byYear)
    .map(Number)
    .filter(y => y < currentYear)
    .sort((a, b) => b - a) // descending
    .slice(0, 5)

  // Consecutive years of growth (most recent backwards)
  let consecutiveYearsGrowth = 0
  for (let i = 0; i < years.length - 1; i++) {
    if (byYear[years[i]] > byYear[years[i + 1]]) consecutiveYearsGrowth++
    else break
  }

  // 5yr CAGR of annual dividend
  let dividendGrowthRate5yr = null
  if (years.length >= 2) {
    const newest = byYear[years[0]]
    const oldest = byYear[years[years.length - 1]]
    const span = years.length - 1
    if (oldest > 0 && newest > 0) {
      dividendGrowthRate5yr = Number(((Math.pow(newest / oldest, 1 / span) - 1) * 100).toFixed(2))
    }
  }

  return {
    symbol: sym,
    name: profileRow?.companyName || sym,
    sector: profileRow?.sector || 'Unknown',
    price,
    beta: num(profileRow?.beta),
    mktCap: num(profileRow?.mktCap),
    dividendYield,
    lastAnnualDividend,
    payoutRatio: num(profileRow?.payoutRatio),
    consecutiveYearsGrowth,
    dividendGrowthRate5yr,
  }
}

function buildPrompt(stocks, investmentAmount, monthlyIncomeGoal) {
  const rows = stocks.map(s =>
    `${s.symbol} (${s.name}) | sector=${s.sector} | price=${s.price ?? 'n/a'} | yield=${s.dividendYield ?? 'n/a'}% | annualDiv=${s.lastAnnualDividend ?? 'n/a'} | payoutRatio=${s.payoutRatio ?? 'n/a'} | consecGrowthYrs=${s.consecutiveYearsGrowth} | 5yrCAGR=${s.dividendGrowthRate5yr ?? 'n/a'}% | beta=${s.beta ?? 'n/a'}`
  ).join('\n')

  const perStock = stocks.length ? investmentAmount / stocks.length : 0

  return `Screen this dividend stock universe for income investing.

CAPITAL: $${investmentAmount} invested equally across ${stocks.length} stocks (~$${perStock.toFixed(2)} each).
${monthlyIncomeGoal ? `MONTHLY INCOME GOAL: $${monthlyIncomeGoal}` : ''}

STOCK DATA (computed server-side from FMP):
${rows}

INSTRUCTIONS:
- safetyScore (1-10): weigh payout ratio, growth streak, sector stability, and beta. Lower payout + longer streak = safer.
- annualIncomePerShare = current annual dividend per share.
- recommendation: "Core Hold" | "Buy" | "Monitor" | "Avoid".
- risk: "Low" | "Medium" | "High".
- portfolioSummary.totalAnnualIncome: sum over stocks of (perStock / price * annualDividendPerShare), using equal $${perStock.toFixed(2)} per stock.
- monthlyIncome = totalAnnualIncome / 12.
- drip10yr: projected portfolio value after 10 years assuming dividends reinvested and growing at each stock's 5yr CAGR (blended).
- sectorBreakdown: group by sector with count and pct of holdings.

Return ONLY this JSON object:
{
  "stocks": [{
    "symbol": "string",
    "name": "string",
    "currentYield": number,
    "safetyScore": number,
    "consecutiveGrowthYears": number,
    "payoutRatio": number,
    "dividendGrowthRate5yr": number,
    "annualIncomePerShare": number,
    "thesis": "string",
    "risk": "Low",
    "recommendation": "Core Hold"
  }],
  "portfolioSummary": {
    "totalAnnualIncome": number,
    "monthlyIncome": number,
    "avgYield": number,
    "avgSafetyScore": number,
    "drip10yr": number
  },
  "topPick": "string",
  "sectorBreakdown": [{ "sector": "string", "count": number, "pct": number }],
  "disclaimer": "string"
}`
}

// ── POST /screen ──────────────────────────────────────────────────────────────
router.post('/screen', dividendLimit, async (req, res) => {
  const body = req.body || {}

  // Resolve symbol list
  let symbols = DEFAULT_UNIVERSE
  if (Array.isArray(body.symbols) && body.symbols.length) {
    symbols = body.symbols
      .filter(s => typeof s === 'string' && VALID_SYMBOL.test(s.trim()))
      .map(s => s.trim().toUpperCase())
      .slice(0, 20)
    if (!symbols.length)
      return res.status(400).json({ error: 'No valid symbols provided' })
  }

  const investmentAmount = (num(body.investmentAmount) || num(body.amount) || 0) > 0
    ? (num(body.investmentAmount) || num(body.amount)) : 10000
  const monthlyIncomeGoal = num(body.monthlyIncomeGoal) ?? num(body.monthlyGoal)

  const fmpKey = req.headers['x-fmp-key'] || FMP_KEY()
  if (!fmpKey) return res.status(400).json({ error: 'FMP_API_KEY required' })

  _lastFmpError = null
  try {
    const v3 = 'https://financialmodelingprep.com/api/v3'

    const settled = await Promise.allSettled(symbols.map(async sym => {
      const [profileArr, dividendData] = await Promise.all([
        fmpJson(`${v3}/profile/${sym}?apikey=${fmpKey}`),
        fmpJson(`${v3}/historical-price-full/stock_dividend/${sym}?apikey=${fmpKey}`),
      ])
      const profileRow = Array.isArray(profileArr) ? profileArr[0] : null
      if (!profileRow) return null
      return computeMetrics(sym, profileRow, dividendData)
    }))

    const stocks = settled
      .filter(r => r.status === 'fulfilled' && r.value)
      .map(r => r.value)

    if (!stocks.length) {
      if (_lastFmpError)
        return res.status(502).json({ error: `Financial data provider error: ${_lastFmpError}` })
      return res.status(404).json({ error: 'No dividend data found for the requested symbols' })
    }

    const prompt = buildPrompt(stocks, investmentAmount, monthlyIncomeGoal)

    const { text: rawText, llmUsed } = await aiRouter.call({
      prompt,
      maxTokens: 4096,
      system:    SYSTEM_PROMPT,
      symbols:   stocks.map(s => s.symbol),
    })

    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    let result
    try {
      result = JSON.parse(cleaned)
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/)
      if (!m) return res.status(500).json({ error: 'Dividend screen returned no parseable JSON — please try again' })
      try { result = JSON.parse(m[0]) }
      catch { return res.status(500).json({ error: 'Dividend screen response was malformed — please try again' }) }
    }

    return res.json({
      ...result,
      investmentAmount,
      monthlyIncomeGoal: monthlyIncomeGoal ?? null,
      symbolsScreened: stocks.map(s => s.symbol),
      llmUsed,
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError')
      return res.status(504).json({ error: 'Data request timed out' })
    console.error('[dividend]', err.message)
    return res.status(500).json({ error: 'Dividend screen failed: ' + err.message })
  }
})

module.exports = router
