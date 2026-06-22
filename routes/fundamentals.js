'use strict'
/**
 * routes/fundamentals.js
 *
 * GET /api/fundamentals/:symbol
 *   Returns investment-grade fundamentals for a US equity:
 *   4-quarter income statement, balance sheet, cash flow, valuation ratios,
 *   analyst buy/hold/sell distribution, and EPS surprise history.
 *
 * Requires FMP_API_KEY env var (or x-fmp-key header).
 * Cache: 4h per symbol. Not applicable to crypto or most international stocks.
 */

const express  = require('express')
const router   = express.Router()

const FMP_KEY     = () => process.env.FMP_API_KEY || null
const CACHE_TTL   = 4 * 60 * 60_000
const _cache      = new Map()
const VALID_SYM   = /^[A-Z0-9.\-]{1,10}$/

function fmpUrl(sym, path, key) {
  const sep = path.includes('?') ? '&' : '?'
  return `https://financialmodelingprep.com/api/v3/${path}${sep}apikey=${key}`
}

async function fmpGet(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12_000) })
  if (!r.ok) {
    const body = await r.json().catch(() => ({}))
    if (body?.['Error Message']) throw new Error(body['Error Message'])
    throw new Error(`FMP HTTP ${r.status}`)
  }
  const data = await r.json()
  if (data?.['Error Message']) throw new Error(data['Error Message'])
  return Array.isArray(data) ? data : [data]
}

function n(v) {
  const x = parseFloat(v)
  return isNaN(x) ? null : x
}

function pct(v, dp = 1) {
  if (v == null) return null
  return parseFloat((v * 100).toFixed(dp))
}

function fmtMoney(v) {
  if (v == null) return null
  const abs = Math.abs(v)
  if (abs >= 1e12) return `$${(v / 1e12).toFixed(2)}T`
  if (abs >= 1e9)  return `$${(v / 1e9).toFixed(1)}B`
  if (abs >= 1e6)  return `$${(v / 1e6).toFixed(1)}M`
  if (abs >= 1e3)  return `$${(v / 1e3).toFixed(1)}K`
  return `$${v.toFixed(0)}`
}

// ── GET /api/fundamentals/:symbol ─────────────────────────────────────────────
router.get('/:symbol', async (req, res) => {
  const raw = (req.params.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-]/g, '')
  if (!VALID_SYM.test(raw)) return res.status(400).json({ error: 'Invalid symbol' })

  const key = (req.headers['x-fmp-key'] || '').trim() || FMP_KEY()
  if (!key) return res.status(400).json({ error: 'FMP_API_KEY required for fundamentals data' })

  const hit = _cache.get(raw)
  if (hit && Date.now() - hit.ts < CACHE_TTL) return res.json({ ...hit.data, cached: true })

  const B = 'https://financialmodelingprep.com/api/v3'

  try {
    const [incArr, balArr, cfArr, kmArr, profArr, recArr, surArr] = await Promise.all([
      fmpGet(`${B}/income-statement/${raw}?period=quarter&limit=5&apikey=${key}`),
      fmpGet(`${B}/balance-sheet-statement/${raw}?period=quarter&limit=2&apikey=${key}`),
      fmpGet(`${B}/cash-flow-statement/${raw}?period=quarter&limit=5&apikey=${key}`),
      fmpGet(`${B}/key-metrics-ttm/${raw}?apikey=${key}`),
      fmpGet(`${B}/profile/${raw}?apikey=${key}`),
      fmpGet(`${B}/analyst-stock-recommendations/${raw}?limit=5&apikey=${key}`).catch(() => []),
      fmpGet(`${B}/earnings-surprises/${raw}?limit=4&apikey=${key}`).catch(() => []),
    ])

    const incRows = incArr.slice(0, 4)
    const bsRow   = balArr[0] || {}
    const cfRows  = cfArr.slice(0, 4)
    const km      = kmArr[0]  || {}
    const prof    = profArr[0] || null
    const recRows = recArr
    const surRows = surArr

    if (!incRows.length && !prof) {
      return res.status(404).json({
        error: `No fundamental data for ${raw} — FMP does not cover this symbol (crypto, most international equities, ETFs)`,
      })
    }

    // ── Income statement ──────────────────────────────────────────────────────
    const quarters = incRows.map(q => {
      const rev = n(q.revenue)
      const gp  = n(q.grossProfit)
      const oi  = n(q.operatingIncome)
      const ni  = n(q.netIncome)
      const rd  = n(q.researchAndDevelopmentExpenses)
      return {
        period:           q.period,
        date:             q.date,
        revenue:          rev,
        revenue_fmt:      fmtMoney(rev),
        gross_profit:     gp,
        gross_margin:     (rev && gp != null) ? pct(gp / rev) : null,
        operating_income: oi,
        operating_margin: (rev && oi != null) ? pct(oi / rev) : null,
        net_income:       ni,
        net_margin:       (rev && ni != null) ? pct(ni / rev) : null,
        eps_diluted:      n(q.epsdiluted) ?? n(q.eps),
        rd_expense:       rd,
        rd_pct_rev:       (rev && rd != null) ? pct(rd / rev) : null,
      }
    })

    // TTM = sum of last 4 quarters
    const ttmRevenue = quarters.reduce((s, q) => s + (q.revenue ?? 0), 0) || null
    // YoY: compare most recent quarter vs same quarter prior year (index 3)
    const yoyRevGrowth = (quarters.length >= 4 && quarters[0].revenue && quarters[3].revenue)
      ? pct((quarters[0].revenue - quarters[3].revenue) / Math.abs(quarters[3].revenue))
      : null

    // ── Balance sheet ─────────────────────────────────────────────────────────
    const ca  = n(bsRow.totalCurrentAssets)
    const cl  = n(bsRow.totalCurrentLiabilities)
    const inv = n(bsRow.inventory) ?? 0
    const td  = n(bsRow.totalDebt)
    const eq  = n(bsRow.totalStockholdersEquity)
    const ta  = n(bsRow.totalAssets)
    const gw  = n(bsRow.goodwill)

    const balance = {
      date:             bsRow.date,
      total_assets:     ta,
      total_liabilities: n(bsRow.totalLiabilities),
      total_equity:     eq,
      cash:             n(bsRow.cashAndCashEquivalents) ?? n(bsRow.cashAndShortTermInvestments),
      short_term_inv:   n(bsRow.shortTermInvestments),
      current_assets:   ca,
      current_liabilities: cl,
      total_debt:       td,
      long_term_debt:   n(bsRow.longTermDebt),
      goodwill:         gw,
      goodwill_pct:     (ta && gw != null) ? pct(gw / ta) : null,
      current_ratio:    (ca && cl) ? parseFloat((ca / cl).toFixed(2)) : null,
      quick_ratio:      (ca != null && cl) ? parseFloat(((ca - inv) / cl).toFixed(2)) : null,
      debt_to_equity:   (td != null && eq > 0) ? parseFloat((td / eq).toFixed(2)) : null,
    }

    // ── Cash flow (TTM = sum of 4 quarters) ──────────────────────────────────
    const ttmOcf   = cfRows.reduce((s, r) => s + (n(r.operatingCashFlow) ?? 0), 0) || null
    const ttmCapex = cfRows.reduce((s, r) => s + (n(r.capitalExpenditure) ?? 0), 0) || null
    // FMP capex is negative — FCF = OCF + capex
    const ttmFcf   = (ttmOcf != null && ttmCapex != null) ? ttmOcf + ttmCapex : null
    const fcfMargin = (ttmFcf != null && ttmRevenue) ? pct(ttmFcf / ttmRevenue) : null

    const cashflow = {
      ttm_operating_cf: ttmOcf,
      ttm_capex:        ttmCapex != null ? Math.abs(ttmCapex) : null,
      ttm_fcf:          ttmFcf,
      fcf_margin:       fcfMargin,
      ttm_buybacks:     cfRows.reduce((s, r) => s + Math.abs(n(r.commonStockRepurchased) ?? 0), 0) || null,
      ttm_dividends:    cfRows.reduce((s, r) => s + Math.abs(n(r.dividendsPaid) ?? 0), 0) || null,
    }

    // ── Valuation (key-metrics-ttm) ───────────────────────────────────────────
    const valuation = {
      pe_ttm:    n(km.peRatioTTM),
      ps_ttm:    n(km.priceToSalesRatioTTM),
      pb_ttm:    n(km.pbRatioTTM),
      peg_ttm:   n(km.pegRatioTTM),
      ev_ebitda: n(km.enterpriseValueOverEBITDATTM),
      ev:        n(km.enterpriseValueTTM),
      fcf_yield: n(km.freeCashFlowYieldTTM) != null ? pct(n(km.freeCashFlowYieldTTM)) : null,
      roe:       n(km.roeTTM) != null ? pct(n(km.roeTTM)) : null,
      roic:      n(km.roicTTM) != null ? pct(n(km.roicTTM)) : null,
    }

    // ── Company profile ───────────────────────────────────────────────────────
    const company = prof ? {
      name:        prof.companyName,
      sector:      prof.sector,
      industry:    prof.industry,
      description: typeof prof.description === 'string' ? prof.description.slice(0, 500) : null,
      mkt_cap:     n(prof.mktCap),
      mkt_cap_fmt: fmtMoney(n(prof.mktCap)),
      beta:        n(prof.beta),
      exchange:    prof.exchangeShortName,
      country:     prof.country,
      employees:   prof.fullTimeEmployees,
    } : null

    // ── Analyst distribution ──────────────────────────────────────────────────
    let analyst_dist = null
    if (recRows.length) {
      const r = recRows[0]
      const buy  = (n(r.buy) ?? 0) + (n(r.strongBuy) ?? 0)
      const hold = n(r.hold) ?? 0
      const sell = (n(r.sell) ?? 0) + (n(r.strongSell) ?? 0)
      const total = buy + hold + sell
      analyst_dist = {
        date: r.date,
        buy, hold, sell, total,
        buy_pct:  total ? pct(buy  / total) : null,
        hold_pct: total ? pct(hold / total) : null,
        sell_pct: total ? pct(sell / total) : null,
        strong_buy:  n(r.strongBuy),
        strong_sell: n(r.strongSell),
      }
    }

    // ── EPS surprise history ──────────────────────────────────────────────────
    const eps_surprises = surRows.slice(0, 4).map(s => {
      const est = n(s.estimatedEps)
      const act = n(s.actualEarningResult)
      return {
        date:     s.date,
        estimate: est,
        actual:   act,
        surprise_pct: (act != null && est != null && est !== 0)
          ? pct((act - est) / Math.abs(est))
          : null,
      }
    })

    const data = {
      symbol:             raw,
      company,
      quarters,
      ttm_revenue:        ttmRevenue,
      ttm_revenue_fmt:    fmtMoney(ttmRevenue),
      yoy_rev_growth:     yoyRevGrowth,
      balance,
      cashflow,
      valuation,
      analyst_dist,
      eps_surprises,
      generated_at:       new Date().toISOString(),
      source:             'FMP',
    }

    _cache.set(raw, { ts: Date.now(), data })
    return res.json({ ...data, cached: false })

  } catch (err) {
    return res.status(502).json({ error: err.message })
  }
})

module.exports = router
