'use strict'
/**
 * routes/dcf.js
 *
 * POST /api/dcf  (public — no auth)
 * body: { symbol }
 *
 * Fetches 5 years of FMP fundamentals (income statement, cash flow, balance
 * sheet, profile), then asks Claude to build a two-method DCF (perpetuity
 * growth + exit multiple) with a 3x3 sensitivity table and bull/bear cases.
 */

const express       = require('express')
const { startJsonHeartbeat } = require('../lib/http-heartbeat')

const router        = express.Router()
const rateLimit     = require('express-rate-limit')
const { getRouter } = require('../lib/ai-router')

const aiRouter = getRouter('dcf')

const fmp     = require('../lib/fmp')
const FMP_KEY = () => process.env.FMP_API_KEY || null

const dcfLimit = rateLimit({
  windowMs: 60 * 1000, max: 10,
  message: { error: 'Too many DCF requests — wait a minute' },
})

const VALID_SYMBOL = /^[A-Za-z0-9.\-]{1,10}$/

const SYSTEM_PROMPT =
  'You are a Morgan Stanley DCF analyst. Return ONLY valid JSON matching the ' +
  'exact schema provided. No markdown, no explanation.'

// ── FMP fetch helper — never throws, returns null on any failure ──────────────
// Tracks the last FMP error message seen during a request so the handler can
// distinguish "symbol genuinely has no data" from "FMP rejected the call"
// (rate limit, or fundamental endpoints not included in the API plan — both
// return HTTP 200 with an {"Error Message": ...} body).
let _lastFmpError = null

// Awaits one lib/fmp call; on failure records why (for the 502 below) and
// yields null so the other three calls can still answer.
async function fmpSoft(promise) {
  try { return await promise } catch (e) {
    _lastFmpError = e?.status === 429 ? 'FMP rate limit reached — try again shortly' : (e?.message || 'FMP request failed')
    return null
  }
}

function num(v) {
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

// ── Build the analyst prompt from extracted financials ────────────────────────
function buildPrompt(sym, profile, history) {
  const currentYear = new Date().getFullYear()

  const histTable = history.map(h =>
    `| ${h.year} | ${h.revenue ?? 'n/a'} | ${h.netIncome ?? 'n/a'} | ${h.ebitda ?? 'n/a'} | ${h.fcf ?? 'n/a'} | ${h.da ?? 'n/a'} | ${h.capex ?? 'n/a'} |`
  ).join('\n')

  return `Build a discounted cash flow (DCF) valuation for ${profile.companyName || sym} (${sym}).

COMPANY PROFILE:
- Company: ${profile.companyName || sym}
- Symbol: ${sym}
- Current Price: ${profile.price ?? 'unknown'} ${profile.currency || 'USD'}
- Market Cap: ${profile.mktCap ?? 'unknown'}
- Beta: ${profile.beta ?? 'unknown'}
- Shares Outstanding: ${profile.sharesOutstanding ?? 'unknown'}
- Total Debt: ${profile.totalDebt ?? 'unknown'}
- Cash & Equivalents: ${profile.cash ?? 'unknown'}
- Net Debt (debt - cash): ${profile.netDebt ?? 'unknown'}

HISTORICAL FINANCIALS (most recent first, raw currency units):
| Year | Revenue | Net Income | EBITDA | Free Cash Flow | D&A | CapEx |
| ---- | ------- | ---------- | ------ | -------------- | --- | ----- |
${histTable || '| (no historical data available — estimate from profile) |'}

INSTRUCTIONS:
1. Estimate WACC from the beta, a risk-free rate (~4.3%), and an equity risk premium (~5%); document it.
2. Project 5 forward fiscal years: ${currentYear}, ${currentYear + 1}, ${currentYear + 2}, ${currentYear + 3}, ${currentYear + 4}. Use a declining revenue growth curve grounded in the historical trend.
3. Compute terminal value two ways: (a) Gordon Growth perpetuity using terminalGrowthRate, and (b) an EBITDA exit multiple.
4. Discount projected FCF + terminal value to present, subtract net debt, divide by shares to get per-share fair value for BOTH methods, and a blended value (average of the two).
5. Compute upside = (dcfValueBlended - currentPrice) / currentPrice * 100.
6. verdict: "Undervalued" if upside > 15, "Overvalued" if upside < -15, else "Fairly Valued".
7. sensitivityTable: exactly 9 cells = 3 discount rates [WACC-1%, WACC, WACC+1%] x 3 terminal growth rates [terminalGrowth-0.5%, terminalGrowth, terminalGrowth+0.5%], each with the resulting per-share fairValue.
8. bearCase / bullCase: per-share fair values under conservative and optimistic assumptions.
9. modelBreakers: assumptions that, if wrong, most change the valuation.

All percentages as plain numbers (e.g. 8.5 means 8.5%). Return ONLY this JSON object:
{
  "company": "string",
  "symbol": "string",
  "currentPrice": number,
  "historicalData": [{ "year": "YYYY", "revenue": number, "fcf": number, "margin": number }],
  "projections": [{ "year": "YYYY", "revenue": number, "revenueGrowth": number, "ebitdaMargin": number, "fcf": number }],
  "wacc": number,
  "terminalGrowthRate": number,
  "exitMultiple": number,
  "terminalValuePerpetual": number,
  "terminalValueExitMultiple": number,
  "dcfValuePerpetual": number,
  "dcfValueExitMultiple": number,
  "dcfValueBlended": number,
  "upside": number,
  "verdict": "Undervalued" | "Fairly Valued" | "Overvalued",
  "sensitivityTable": [{ "discountRate": number, "terminalGrowth": number, "fairValue": number }],
  "keyAssumptions": ["string"],
  "bearCase": number,
  "bullCase": number,
  "modelBreakers": ["string"]
}`
}

// ── POST / ────────────────────────────────────────────────────────────────────
router.post('/', dcfLimit, async (req, res) => {
  // Four provider calls plus a 4k-token LLM call; keeps a slow mobile
  // connection from idling out mid-request. Failures after the first heartbeat
  // arrive as 200 + `error` in the body.
  startJsonHeartbeat(res)

  const raw = req.body?.symbol
  if (!raw || typeof raw !== 'string' || !VALID_SYMBOL.test(raw.trim()))
    return res.status(400).json({ error: 'Valid symbol required (alphanumeric, . or -, max 10 chars)' })

  const sym = raw.trim().toUpperCase()

  const fmpKey = req.headers['x-fmp-key'] || FMP_KEY()
  if (!fmpKey) return res.status(400).json({ error: 'FMP_API_KEY required' })

  _lastFmpError = null
  try {
    const o = { key: fmpKey, timeoutMs: 10000 }
    const [income, cashflow, balance, profileRow] = await Promise.all([
      fmpSoft(fmp.statements('income-statement',        sym, { limit: 5, ...o })),
      fmpSoft(fmp.statements('cash-flow-statement',     sym, { limit: 5, ...o })),
      fmpSoft(fmp.statements('balance-sheet-statement', sym, { limit: 1, ...o })),
      fmpSoft(fmp.profile(sym, o)),
    ])

    const incomeArr   = Array.isArray(income) ? income : []
    const cashflowArr = Array.isArray(cashflow) ? cashflow : []
    const balanceRow  = Array.isArray(balance) ? balance[0] : null

    // No usable data → distinguish an FMP error from a genuinely unknown symbol
    if (!incomeArr.length && !cashflowArr.length && !profileRow) {
      if (_lastFmpError)
        return res.status(502).json({ error: `Financial data provider error: ${_lastFmpError}` })
      return res.status(404).json({ error: `No fundamental data found for ${sym}` })
    }

    // Build per-year historical financials (align income + cash flow by calendar year)
    const cfByYear = {}
    for (const c of cashflowArr) {
      const yr = String(c.calendarYear ?? (c.date || '').slice(0, 4))
      if (yr) cfByYear[yr] = c
    }

    const history = incomeArr.map(inc => {
      const yr = String(inc.calendarYear ?? (inc.date || '').slice(0, 4))
      const cf = cfByYear[yr] || {}
      const ocf   = num(cf.operatingCashFlow)
      const capex = num(cf.capitalExpenditure)
      const fcf   = (ocf != null && capex != null) ? ocf + capex : null // capex is negative in FMP
      return {
        year:      yr,
        revenue:   num(inc.revenue),
        netIncome: num(inc.netIncome),
        ebitda:    num(inc.ebitda),
        da:        num(cf.depreciationAndAmortization),
        capex:     capex,
        fcf:       fcf,
      }
    })

    const totalDebt = num(balanceRow?.totalDebt)
    const cash      = num(balanceRow?.cashAndCashEquivalents ?? balanceRow?.cashAndShortTermInvestments)
    const netDebt   = (totalDebt != null && cash != null) ? totalDebt - cash : null

    const profile = {
      companyName:       profileRow?.companyName || sym,
      price:             num(profileRow?.price),
      currency:          profileRow?.currency || 'USD',
      mktCap:            num(profileRow?.mktCap),
      beta:              num(profileRow?.beta),
      sharesOutstanding: num(profileRow?.sharesOutstanding) ?? (num(profileRow?.mktCap) != null && num(profileRow?.price) ? Math.round(num(profileRow.mktCap) / num(profileRow.price)) : null),
      totalDebt,
      cash,
      netDebt,
    }

    const prompt = buildPrompt(sym, profile, history)

    const { text: rawText, llmUsed } = await aiRouter.call({
      prompt,
      maxTokens: 4096,
      system:    SYSTEM_PROMPT,
      symbols:   [sym],
    })

    const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
    let model
    try {
      model = JSON.parse(cleaned)
    } catch {
      const m = cleaned.match(/\{[\s\S]*\}/)
      if (!m) return res.status(500).json({ error: 'DCF model returned no parseable JSON — please try again' })
      try { model = JSON.parse(m[0]) }
      catch { return res.status(500).json({ error: 'DCF model response was malformed — please try again' }) }
    }

    // Validate required top-level fields
    const required = ['symbol', 'currentPrice', 'dcfValueBlended', 'upside', 'verdict', 'projections', 'sensitivityTable']
    const missing  = required.filter(f => model[f] == null)
    if (missing.length)
      return res.status(500).json({ error: `DCF model missing required fields: ${missing.join(', ')}` })

    return res.json({
      ...model,
      llmUsed,
      generatedAt: new Date().toISOString(),
    })
  } catch (err) {
    if (err.name === 'AbortError' || err.name === 'TimeoutError')
      return res.status(504).json({ error: 'Data request timed out' })
    console.error('[dcf]', err.message)
    return res.status(500).json({ error: 'DCF analysis failed: ' + err.message })
  }
})

module.exports = router
