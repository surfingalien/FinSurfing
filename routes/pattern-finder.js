'use strict'
/**
 * routes/pattern-finder.js
 *
 * GET /api/patterns/:symbol  (public — no auth)
 *
 * Combines server-computed seasonal/day-of-week return patterns (from 3y of
 * daily prices) with FMP insider, institutional, and short-interest data, then
 * asks Claude to synthesize the statistical edge.
 */

const express       = require('express')
const router        = express.Router()
const rateLimit     = require('express-rate-limit')
const { getRouter } = require('../lib/ai-router')

const aiRouter = getRouter('pattern-finder')

const FMP_KEY = () => process.env.FMP_API_KEY || null

const patternLimit = rateLimit({
  windowMs: 60 * 1000, max: 15,
  message: { error: 'Too many pattern requests — wait a minute' },
})

const VALID_SYMBOL = /^[A-Za-z0-9.\-]{1,10}$/

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']
const WEEKDAYS = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday']

const SYSTEM_PROMPT =
  'You are a quantitative pattern analyst. Return ONLY valid JSON matching the ' +
  'exact schema provided. No markdown, no explanation.'

// ── FMP fetch helper — never throws ───────────────────────────────────────────
async function fmpJson(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(10000) })
    if (!r.ok) return null
    const d = await r.json()
    // FMP returns plan/rate errors as a 200 with an Error Message field —
    // treat those as no-data so callers don't try to iterate an error object.
    if (d && !Array.isArray(d) && (d['Error Message'] || d.error)) return null
    return d
  } catch {
    return null
  }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ── Seasonal + day-of-week computation from daily closes ──────────────────────
function computeSeasonality(timestamps, closes) {
  const monthBuckets = Array.from({ length: 12 }, () => [])
  const dowBuckets   = Array.from({ length: 7 }, () => [])

  for (let i = 1; i < closes.length; i++) {
    const prev = closes[i - 1]
    const cur  = closes[i]
    if (prev == null || cur == null || prev === 0) continue
    const ret = ((cur - prev) / prev) * 100
    if (!Number.isFinite(ret)) continue
    const d = new Date(timestamps[i] * 1000)
    monthBuckets[d.getUTCMonth()].push(ret)
    dowBuckets[d.getUTCDay()].push(ret)
  }

  const mean = arr => arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null

  const monthlyReturns = MONTHS.map((m, i) => ({
    month: m,
    avgReturn: monthBuckets[i].length ? Number(mean(monthBuckets[i]).toFixed(3)) : null,
  }))

  // Trading weekdays only (Mon..Fri)
  const dayOfWeekPatterns = [1, 2, 3, 4, 5].map(i => ({
    day: WEEKDAYS[i],
    avgReturn: dowBuckets[i].length ? Number(mean(dowBuckets[i]).toFixed(3)) : null,
  }))

  return { monthlyReturns, dayOfWeekPatterns }
}

// ── Insider transaction summarization ─────────────────────────────────────────
function summarizeInsiders(rows) {
  const list = Array.isArray(rows) ? rows : []
  const now = Date.now()
  const NINETY_DAYS = 90 * 24 * 60 * 60 * 1000

  let buyValue90 = 0
  let sellValue90 = 0

  const recentTransactions = []
  for (const t of list) {
    const typeRaw = String(t.transactionType || t.acquistionOrDisposition || '').toUpperCase()
    const isBuy = typeRaw.includes('P') || typeRaw.includes('A') || typeRaw.includes('BUY')
    const isSell = typeRaw.includes('S') || typeRaw.includes('D') || typeRaw.includes('SELL')
    const shares = num(t.securitiesTransacted) ?? num(t.shares) ?? 0
    const pricePer = num(t.price) ?? 0
    const value = Math.abs(shares * pricePer)
    const date = t.transactionDate || t.filingDate || t.date || null

    const type = isBuy && !isSell ? 'buy' : isSell && !isBuy ? 'sell' : (isBuy ? 'buy' : 'sell')

    if (date) {
      const ts = new Date(date).getTime()
      if (Number.isFinite(ts) && now - ts <= NINETY_DAYS) {
        if (type === 'buy') buyValue90 += value
        else sellValue90 += value
      }
    }

    if (recentTransactions.length < 10) {
      recentTransactions.push({
        date,
        name: t.reportingName || t.name || 'Unknown',
        type,
        shares: Math.abs(shares),
        value: Number(value.toFixed(2)),
      })
    }
  }

  const netValue90d = Number((buyValue90 - sellValue90).toFixed(2))
  let sentiment = 'Neutral'
  if (netValue90d > 0 && buyValue90 > sellValue90 * 1.1) sentiment = 'Buying'
  else if (netValue90d < 0 && sellValue90 > buyValue90 * 1.1) sentiment = 'Selling'

  return { sentiment, netValue90d, recentTransactions }
}

// ── Institutional holder summarization ────────────────────────────────────────
function summarizeInstitutional(rows) {
  const list = Array.isArray(rows) ? rows : []
  let total = 0
  const holders = []
  for (const h of list) {
    const shares = num(h.shares) ?? 0
    total += shares
    holders.push({
      holder: h.holder || h.investorName || 'Unknown',
      shares,
      dateReported: h.dateReported || h.date || null,
    })
  }
  holders.sort((a, b) => b.shares - a.shares)
  return {
    totalInstitutionalShares: total,
    topHolders: holders.slice(0, 5),
  }
}

// ── Short interest extraction ─────────────────────────────────────────────────
function summarizeShort(rows) {
  const list = Array.isArray(rows) ? rows : []
  const latest = list[0] || null
  if (!latest) return { shortFloat: null, shortRatio: null }
  return {
    shortFloat: num(latest.shortPercentOfFloat ?? latest.shortFloat ?? latest.shortPercent),
    shortRatio: num(latest.shortRatio ?? latest.daysToCover),
  }
}

// ── Prompt builder ────────────────────────────────────────────────────────────
function buildPrompt(sym, seasonal, insiders, institutional, shortData) {
  return `Analyze quantifiable trading patterns for ${sym}.

SEASONAL MONTHLY AVERAGE RETURNS (% per day, grouped by calendar month over ~3 years):
${seasonal.monthlyReturns.map(m => `${m.month}: ${m.avgReturn ?? 'n/a'}`).join(', ')}

DAY-OF-WEEK AVERAGE RETURNS (% per day):
${seasonal.dayOfWeekPatterns.map(d => `${d.day}: ${d.avgReturn ?? 'n/a'}`).join(', ')}

INSIDER ACTIVITY:
- Sentiment (computed): ${insiders.sentiment}
- Net insider value last 90d: ${insiders.netValue90d}
- Recent transactions: ${JSON.stringify(insiders.recentTransactions)}

INSTITUTIONAL OWNERSHIP:
- Total institutional shares: ${institutional.totalInstitutionalShares}
- Top holders: ${JSON.stringify(institutional.topHolders)}

SHORT INTEREST:
- Short % of float: ${shortData.shortFloat ?? 'n/a'}
- Short ratio (days to cover): ${shortData.shortRatio ?? 'n/a'}

INSTRUCTIONS:
- Identify the best and worst months by average return.
- Assess institutional trend (Increasing/Decreasing/Stable) and short-squeeze risk (High/Medium/Low) from the data.
- statisticalEdge: 2-3 sentences on the single most significant quantifiable advantage.
- keyPatterns: max 5, one pattern each. riskFactors: max 3.
- Carry through the computed monthlyReturns and dayOfWeekPatterns values into your JSON.

Return ONLY this JSON object:
{
  "symbol": "string",
  "seasonalPatterns": { "bestMonths": ["Jan"], "worstMonths": ["Sep"], "monthlyReturns": [{"month":"Jan","avgReturn":1.2}] },
  "dayOfWeekPatterns": [{"day":"Monday","avgReturn":0.1}],
  "insiderActivity": { "sentiment": "Buying", "netValue90d": number, "recentTransactions": [] },
  "institutionalOwnership": { "totalHeld": number, "topHolders": [], "trend": "Increasing" },
  "shortInterest": { "shortFloat": number, "shortRatio": number, "squeezeRisk": "Low" },
  "statisticalEdge": "string",
  "keyPatterns": ["string"],
  "riskFactors": ["string"],
  "earningsPatterns": "string",
  "correlationSignals": "string"
}`
}

// ── GET /:symbol ──────────────────────────────────────────────────────────────
router.get('/:symbol', patternLimit, async (req, res) => {
  const raw = req.params.symbol
  if (!raw || !VALID_SYMBOL.test(raw))
    return res.status(400).json({ error: 'Valid symbol required (alphanumeric, . or -, max 10 chars)' })

  const sym = raw.trim().toUpperCase()

  const fmpKey = req.headers['x-fmp-key'] || FMP_KEY()
  if (!fmpKey) return res.status(400).json({ error: 'FMP_API_KEY required' })

  try {
    const port = process.env.PORT || 3001
    const fwdHeaders = {}
    for (const h of ['x-aisa-key', 'x-finnhub-key', 'x-fmp-key', 'x-td-key', 'x-av-key']) {
      if (req.headers[h]) fwdHeaders[h] = req.headers[h]
    }

    const v3 = 'https://financialmodelingprep.com/api/v3'
    const v4 = 'https://financialmodelingprep.com/api/v4'

    const [insiderRaw, institutionalRaw, shortRaw, chartData] = await Promise.all([
      fmpJson(`${v4}/insider-trading?symbol=${sym}&limit=30&apikey=${fmpKey}`),
      fmpJson(`${v3}/institutional-holder/${sym}?apikey=${fmpKey}`),
      fmpJson(`${v4}/short-of-float?symbol=${sym}&apikey=${fmpKey}`),
      (async () => {
        try {
          const r = await fetch(
            `http://127.0.0.1:${port}/api/chart?symbol=${encodeURIComponent(sym)}&interval=1d&range=3y`,
            { headers: fwdHeaders, signal: AbortSignal.timeout(30000) }
          )
          return await r.json()
        } catch { return null }
      })(),
    ])

    // Seasonal patterns (partial data tolerated)
    const result = chartData?.chart?.result?.[0]
    const timestamps = result?.timestamp || []
    const closes = result?.indicators?.quote?.[0]?.close || []
    const seasonal = (timestamps.length && closes.length)
      ? computeSeasonality(timestamps, closes)
      : { monthlyReturns: MONTHS.map(m => ({ month: m, avgReturn: null })),
          dayOfWeekPatterns: [1, 2, 3, 4, 5].map(i => ({ day: WEEKDAYS[i], avgReturn: null })) }

    const insiders      = summarizeInsiders(insiderRaw)
    const institutional = summarizeInstitutional(institutionalRaw)
    const shortData     = summarizeShort(shortRaw)

    const prompt = buildPrompt(sym, seasonal, insiders, institutional, shortData)

    const { text: rawText, llmUsed } = await aiRouter.call({
      prompt,
      maxTokens: 3072,
      system:    SYSTEM_PROMPT,
      symbols:   [sym],
    })

    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    let analysis
    try {
      analysis = JSON.parse(cleaned)
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/)
      if (!m) return res.status(500).json({ error: 'Pattern analysis returned no parseable JSON — please try again' })
      try { analysis = JSON.parse(m[0]) }
      catch { return res.status(500).json({ error: 'Pattern analysis response was malformed — please try again' }) }
    }

    return res.json({
      ...analysis,
      symbol: sym,
      computed: {
        seasonalPatterns: seasonal.monthlyReturns,
        dayOfWeekPatterns: seasonal.dayOfWeekPatterns,
        insiderActivity: insiders,
        institutionalOwnership: institutional,
        shortInterest: shortData,
      },
      llmUsed,
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError')
      return res.status(504).json({ error: 'Data request timed out' })
    console.error('[pattern-finder]', err.message)
    return res.status(500).json({ error: 'Pattern analysis failed: ' + err.message })
  }
})

module.exports = router
