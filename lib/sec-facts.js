'use strict'

/**
 * lib/sec-facts.js — reported fundamentals from SEC XBRL "company facts",
 * keyless and point-in-time.
 *
 * FMP is the app's fundamentals source, and its quota runs out (production
 * answered "Limit Reach" on 2026-10-24), taking valuation evidence, the
 * screener and the earnings-drift study down with it. data.sec.gov publishes
 * every figure a company has reported in a 10-Q/10-K, each with the date it
 * was FILED — which also makes fundamental factors testable without lookahead:
 * a figure is known from its filing date, not its period end.
 *
 * The raw facts mix discrete quarters with year-to-date totals (cash flow is
 * almost always YTD: H1, 9M, FY), so quarters are rebuilt per fiscal year by
 * differencing cumulative totals that share a start date. Only the FIRST
 * filing of each (period) figure is kept — a later restatement was not known
 * at the earlier date, and using it would leak the future into a backtest.
 *
 * Concept names drift (NVDA reported revenue as
 * RevenueFromContractWithCustomerExcludingAssessedTax until 2022, then
 * Revenues), so each field merges a priority list of tags by period.
 *
 * Network only in `getCompanyFacts` (SEC asks for a descriptive User-Agent —
 * lib/filings.js:EDGAR_UA; cached 12h, compact form only). Everything else is
 * pure. Tests: tests/sec-facts.test.js
 */

const DAY = 86_400_000

const FLOW = {
  revenue:   ['Revenues', 'RevenueFromContractWithCustomerExcludingAssessedTax', 'SalesRevenueNet', 'RevenueFromContractWithCustomerIncludingAssessedTax'],
  netIncome: ['NetIncomeLoss', 'ProfitLoss', 'NetIncomeLossAvailableToCommonStockholdersBasic'],
  eps:       ['EarningsPerShareDiluted', 'EarningsPerShareBasicAndDiluted', 'EarningsPerShareBasic'],
  ocf:       ['NetCashProvidedByUsedInOperatingActivities', 'NetCashProvidedByUsedInOperatingActivitiesContinuingOperations'],
  capex:     ['PaymentsToAcquirePropertyPlantAndEquipment', 'PaymentsToAcquireProductiveAssets'],
}
const INSTANT = {
  equity: ['StockholdersEquity', 'StockholdersEquityIncludingPortionAttributableToNoncontrollingInterest'],
  assets: ['Assets'],
  debt:   ['LongTermDebt', 'LongTermDebtNoncurrent'],
}
const FORMS = new Set(['10-Q', '10-K', '10-Q/A', '10-K/A', '20-F', '40-F'])

const days = (a, b) => Math.round((Date.parse(b) - Date.parse(a)) / DAY)
const quarterLike = d => d >= 75 && d <= 105

/** Units array for a tag, whichever unit it reports in (USD, USD/shares, shares). */
function unitRows(facts, tag) {
  const node = facts?.['us-gaap']?.[tag] || facts?.dei?.[tag] || facts?.['ifrs-full']?.[tag]
  if (!node?.units) return []
  return Object.values(node.units)[0] || []
}

/** First-filed row per key — the value as it was first known. */
function firstFiled(rows, key) {
  const m = new Map()
  for (const r of rows) {
    if (!FORMS.has(r.form) || !Number.isFinite(r.val) || !r.filed) continue
    const k = key(r)
    const cur = m.get(k)
    if (!cur || r.filed < cur.filed) m.set(k, r)
  }
  return [...m.values()]
}

/**
 * Discrete quarters for one flow tag: [{start, end, val, filed, derived}],
 * by end date. Direct ~3-month rows first; the rest rebuilt by differencing
 * cumulative rows with a common start (Q2 = H1 − Q1, Q4 = FY − 9M …). Pure.
 */
function quarterlyFlow(rows) {
  const periods = firstFiled(rows.filter(r => r.start && r.end), r => `${r.start}|${r.end}`)
  const out = new Map()
  for (const r of periods) {
    if (quarterLike(days(r.start, r.end))) out.set(r.end, { start: r.start, end: r.end, val: r.val, filed: r.filed, derived: false })
  }
  const byStart = new Map()
  for (const r of periods) {
    const d = days(r.start, r.end)
    if (d < 75 || d > 380) continue
    if (!byStart.has(r.start)) byStart.set(r.start, [])
    byStart.get(r.start).push(r)
  }
  for (const list of byStart.values()) {
    list.sort((a, b) => a.end.localeCompare(b.end))
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1], cur = list[i]
      if (out.has(cur.end) || !quarterLike(days(prev.end, cur.end))) continue
      out.set(cur.end, {
        start: new Date(Date.parse(prev.end) + DAY).toISOString().slice(0, 10), end: cur.end,
        val: cur.val - prev.val,
        // Known only once BOTH cumulative figures were.
        filed: cur.filed > prev.filed ? cur.filed : prev.filed,
        derived: true,
      })
    }
  }
  // Filers that report discrete quarters give no 9M total, so Q4 is the full
  // year minus the three quarters inside it.
  for (const fy of periods) {
    const d = days(fy.start, fy.end)
    if (d < 350 || d > 380 || out.has(fy.end)) continue
    const inside = [...out.values()].filter(q => q.start >= fy.start && q.end < fy.end).sort((a, b) => a.end.localeCompare(b.end))
    if (inside.length !== 3 || !quarterLike(days(inside[2].end, fy.end))) continue
    out.set(fy.end, {
      start: new Date(Date.parse(inside[2].end) + DAY).toISOString().slice(0, 10), end: fy.end,
      val: fy.val - inside.reduce((a, q) => a + q.val, 0),
      filed: [fy.filed, ...inside.map(q => q.filed)].sort().at(-1),
      derived: true,
    })
  }
  return [...out.values()].sort((a, b) => a.end.localeCompare(b.end))
}

function instantSeries(rows) {
  return firstFiled(rows.filter(r => r.end && !r.start), r => r.end)
    .map(r => ({ end: r.end, val: r.val, filed: r.filed }))
    .sort((a, b) => a.end.localeCompare(b.end))
}

/** Merge per-tag series by period end, earlier tags in the list winning. */
function mergeTags(facts, tags, build) {
  const m = new Map()
  for (const tag of [...tags].reverse()) for (const q of build(unitRows(facts, tag))) m.set(q.end, { ...q, tag })
  return [...m.values()].sort((a, b) => a.end.localeCompare(b.end))
}

/** Compact series for every field from a raw companyfacts payload. Pure. */
function compactFacts(raw) {
  const facts = raw?.facts || {}
  const series = {}
  for (const [k, tags] of Object.entries(FLOW)) series[k] = mergeTags(facts, tags, quarterlyFlow)
  for (const [k, tags] of Object.entries(INSTANT)) series[k] = mergeTags(facts, tags, instantSeries)
  series.shares = instantSeries(unitRows(facts, 'EntityCommonStockSharesOutstanding'))
  return { cik: raw?.cik ?? null, name: raw?.entityName ?? null, series }
}

// ── Point-in-time snapshot ───────────────────────────────────────────────────

const knownBy = (series, asOf) => (series || []).filter(q => q.filed <= asOf)

/** Sum of the last four consecutive quarters known by asOf (and ending ≤ endBy). */
function ttm(series, asOf, { endBy = null } = {}) {
  const qs = knownBy(series, asOf).filter(q => !endBy || q.end <= endBy)
  if (qs.length < 4) return null
  const last4 = qs.slice(-4)
  if (days(last4[0].start || last4[0].end, last4[3].end) > 380) return null   // a gap, not a year
  return { val: last4.reduce((a, q) => a + q.val, 0), end: last4[3].end }
}

function latest(series, asOf) {
  const qs = knownBy(series, asOf)
  return qs.length ? qs[qs.length - 1] : null
}

/**
 * Everything known about a company on `asOf` (YYYY-MM-DD) from its filings.
 * Ratios are percents. Returns null when no quarterly revenue or earnings is known.
 */
function snapshotAt(compact, asOf, { price = null } = {}) {
  const s = compact?.series || {}
  const rev = ttm(s.revenue, asOf), ni = ttm(s.netIncome, asOf), eps = ttm(s.eps, asOf)
  if (!rev && !ni && !eps) return null
  const ocf = ttm(s.ocf, asOf), capex = ttm(s.capex, asOf)
  const equity = latest(s.equity, asOf), assets = latest(s.assets, asOf), debt = latest(s.debt, asOf), shares = latest(s.shares, asOf)
  const yearEarlier = rev ? new Date(Date.parse(rev.end) - 360 * DAY).toISOString().slice(0, 10) : null
  const revPrior = rev ? ttm(s.revenue, asOf, { endBy: yearEarlier }) : null
  const pct = (a, b) => (a != null && b ? +((a / b) * 100).toFixed(1) : null)
  const fcf = ocf && capex ? ocf.val - Math.abs(capex.val) : null
  const lastFiled = [s.revenue, s.netIncome, s.eps].map(x => latest(x, asOf)?.filed).filter(Boolean).sort().at(-1) ?? null
  const out = {
    asOf, lastFiled, periodEnd: rev?.end ?? ni?.end ?? eps?.end ?? null,
    revenueTtm: rev?.val ?? null,
    revenueGrowthYoY: rev && revPrior && revPrior.val > 0 ? +(((rev.val / revPrior.val) - 1) * 100).toFixed(1) : null,
    netIncomeTtm: ni?.val ?? null,
    netMargin: rev && ni ? pct(ni.val, rev.val) : null,
    epsTtm: eps ? +eps.val.toFixed(2) : null,
    ocfTtm: ocf?.val ?? null,
    fcfTtm: fcf,
    fcfMargin: rev && fcf != null ? pct(fcf, rev.val) : null,
    equity: equity?.val ?? null,
    roe: ni && equity?.val > 0 ? pct(ni.val, equity.val) : null,
    debtToEquity: debt && equity?.val > 0 ? +(debt.val / equity.val).toFixed(2) : null,
    // Accruals: earnings not backed by cash, scaled by assets. High accruals
    // have historically predicted LOWER returns (Sloan 1996).
    accruals: ni && ocf && assets?.val > 0 ? +(((ni.val - ocf.val) / assets.val) * 100).toFixed(2) : null,
    shares: shares?.val ?? null,
  }
  if (price > 0) {
    out.pe = out.epsTtm > 0 ? +(price / out.epsTtm).toFixed(1) : null
    out.earningsYield = out.epsTtm != null ? +((out.epsTtm / price) * 100).toFixed(2) : null
    out.fcfYield = fcf != null && out.shares > 0 ? +((fcf / (price * out.shares)) * 100).toFixed(2) : null
  }
  return out
}

/** Quarterly diluted EPS as first filed: [{end, val, filed}] — input to the SUE drift track. */
function epsQuarters(compact) {
  return (compact?.series?.eps || []).map(q => ({ end: q.end, val: q.val, filed: q.filed, derived: q.derived }))
}

// ── Network ──────────────────────────────────────────────────────────────────
const _cache = new Map()
const CACHE_MS = 12 * 60 * 60 * 1000
const CACHE_MAX = 150

/** Compact facts for a ticker, or null (unknown ticker, foreign filer without XBRL, SEC down). */
async function getCompanyFacts(symbol, { fetchImpl = fetch, now = Date.now() } = {}) {
  const sym = String(symbol || '').toUpperCase()
  const hit = _cache.get(sym)
  if (hit && now - hit.at < CACHE_MS) return hit.value
  const filings = require('./filings')
  const cik = await filings.resolveCik(sym, { fetchImpl })
  if (!cik) return null
  const r = await fetchImpl(`https://data.sec.gov/api/xbrl/companyfacts/CIK${filings.padCik(cik)}.json`, {
    headers: { 'User-Agent': filings.EDGAR_UA, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  })
  if (r.status === 404) return null
  if (!r.ok) throw new Error(`SEC companyfacts HTTP ${r.status}`)
  const value = compactFacts(await r.json())
  _cache.set(sym, { at: now, value })
  if (_cache.size > CACHE_MAX) _cache.delete(_cache.keys().next().value)
  return value
}

function _resetForTests() { _cache.clear() }

module.exports = {
  FLOW, INSTANT,
  quarterlyFlow, instantSeries, compactFacts, ttm, snapshotAt, epsQuarters,
  getCompanyFacts, _resetForTests,
}
