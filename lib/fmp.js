'use strict'

/**
 * lib/fmp.js — one Financial Modeling Prep client for the whole server.
 *
 * FMP retired its `/api/v3` and `/api/v4` paths for every key issued after
 * 31 Aug 2025: they answer "Legacy Endpoint : ... only available for legacy
 * users", often with a 200 status. Every FMP call in this repo was v3, so on a
 * current key fundamentals, the screener, DCF, dividends, fund NAV quotes,
 * earnings and news all failed — while the quote cascade quietly moved on to
 * the next provider and nothing said FMP was dead.
 *
 * Each call here tries FMP's current "stable" API first and the legacy path
 * second (legacy subscriptions still serve v3), and hands back the LEGACY
 * RESPONSE SHAPE, so a call site only swaps its URL for a function call. The
 * stable API renamed fields (`changePercentage` for `changesPercentage`,
 * `marketCap` for `mktCap`, ratios moved out of key-metrics-ttm into
 * ratios-ttm, `epsActual` for `actualEarningResult`…); the `*ToLegacy`
 * adapters below add the old names alongside the new ones and never drop a
 * field, so code reading either spelling works.
 *
 * FMP reports plan limits and bad keys in the BODY (`{"Error Message": …}`),
 * sometimes with HTTP 200, so a response is checked for that before it is
 * treated as data. `FmpError` carries the message so routes can show it.
 *
 * Every network function takes `{ key, fetchImpl, timeoutMs }`; `key` falls
 * back to FMP_API_KEY. Adapters are pure. Tests: tests/fmp.test.js
 */

const STABLE = 'https://financialmodelingprep.com/stable'
const LEGACY = 'https://financialmodelingprep.com/api/v3'
const LEGACY_V4 = 'https://financialmodelingprep.com/api/v4'

class FmpError extends Error {
  constructor(message, status = null) {
    super(message)
    this.name = 'FmpError'
    this.status = status
  }
}

const envKey = () => process.env.FMP_API_KEY || null

function buildUrl(base, path, params = {}, key) {
  const u = new URL(`${base}/${String(path).replace(/^\/+/, '')}`)
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== '') u.searchParams.set(k, String(v))
  }
  u.searchParams.set('apikey', key)
  return u.toString()
}

/** FMP's in-body error, whatever shape it arrived in; null for real data. */
function errorMessage(body) {
  if (typeof body === 'string') return body.trim() ? body.trim().slice(0, 300) : null
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    const m = body['Error Message'] || body.error
    return m ? String(m).slice(0, 300) : null
  }
  return null
}

async function getJson(url, { fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  let r
  try {
    r = await fetchImpl(url, { headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(timeoutMs) })
  } catch (e) {
    throw new FmpError(e?.name === 'TimeoutError' ? 'FMP request timed out' : `FMP unreachable: ${e?.message || e}`)
  }
  const text = await r.text()
  let body
  try { body = text ? JSON.parse(text) : null } catch { body = text }
  const msg = errorMessage(body)
  if (msg) throw new FmpError(msg, r.status)
  if (!r.ok) throw new FmpError(`FMP HTTP ${r.status}`, r.status)
  return body
}

/**
 * Try each attempt in order; the first that yields data wins. `accept` decides
 * what counts as data (default: a non-empty array). When every attempt fails
 * the FIRST error is thrown — on a current key that is the stable API's own
 * message, not the legacy "Legacy Endpoint" notice.
 */
async function firstOf(attempts, { accept = isNonEmptyArray, ...opts } = {}) {
  let firstErr = null
  let lastEmpty
  for (const make of attempts) {
    try {
      const body = await getJson(make(), opts)
      if (accept(body)) return body
      lastEmpty = body
    } catch (e) {
      firstErr = firstErr || e
    }
  }
  if (lastEmpty !== undefined) return lastEmpty
  throw firstErr || new FmpError('FMP returned no data')
}

const isNonEmptyArray = (b) => Array.isArray(b) && b.length > 0
const asArray = (b) => (Array.isArray(b) ? b : b && typeof b === 'object' ? [b] : [])

function ctx(opts = {}) {
  const key = opts.key || envKey()
  if (!key) throw new FmpError('FMP_API_KEY not set')
  return { key, net: { fetchImpl: opts.fetchImpl || fetch, timeoutMs: opts.timeoutMs || 12_000 } }
}

const S = (path, params, key) => () => buildUrl(STABLE, path, params, key)
const L = (path, params, key) => () => buildUrl(LEGACY, path, params, key)
const enc = encodeURIComponent

// ── Adapters: stable → legacy field names (additive, pure) ───────────────────

const pickFirst = (...vals) => vals.find(v => v != null) ?? null

function quoteToLegacy(q = {}) {
  return { ...q, changesPercentage: pickFirst(q.changesPercentage, q.changePercentage) }
}

function profileToLegacy(p = {}) {
  return {
    ...p,
    mktCap:             pickFirst(p.mktCap, p.marketCap),
    lastDiv:            pickFirst(p.lastDiv, p.lastDividend),
    lastAnnualDividend: pickFirst(p.lastAnnualDividend, p.lastDividend, p.lastDiv),
    volAvg:             pickFirst(p.volAvg, p.averageVolume),
    changes:            pickFirst(p.changes, p.change),
    exchangeShortName:  pickFirst(p.exchangeShortName, p.exchange),
  }
}

/**
 * v3 key-metrics-ttm carried the valuation ratios; stable split them into
 * key-metrics-ttm + ratios-ttm and renamed most. One merged object with both
 * spellings, so `km.peRatioTTM` and `km.priceToEarningsRatioTTM` both work.
 */
function metricsTtmToLegacy(km = {}, ratios = {}) {
  const m = { ...ratios, ...km }
  const alias = (legacy, ...names) => { if (m[legacy] == null) m[legacy] = pickFirst(...names.map(n => m[n])) }
  alias('peRatioTTM',                    'priceToEarningsRatioTTM')
  alias('pegRatioTTM',                   'priceToEarningsGrowthRatioTTM')
  alias('pbRatioTTM',                    'priceToBookRatioTTM')
  alias('priceToBookRatioTTM',           'pbRatioTTM')
  alias('ptbRatioTTM',                   'priceToBookRatioTTM')
  alias('priceToSalesRatioTTM',          'priceSalesRatioTTM')
  alias('roeTTM',                        'returnOnEquityTTM')
  alias('returnOnEquityTTM',             'roeTTM')
  alias('roicTTM',                       'returnOnInvestedCapitalTTM')
  alias('debtToEquityTTM',               'debtToEquityRatioTTM', 'debtEquityRatioTTM')
  alias('debtEquityRatioTTM',            'debtToEquityRatioTTM', 'debtToEquityTTM')
  alias('payoutRatioTTM',                'dividendPayoutRatioTTM')
  alias('enterpriseValueOverEBITDATTM',  'evToEBITDATTM', 'enterpriseValueMultipleTTM')
  alias('interestCoverageTTM',           'interestCoverageRatioTTM')
  alias('marketCapTTM',                  'marketCap')
  alias('epsTTM',                        'netIncomePerShareTTM')
  alias('netIncomePerShareTTM',          'epsTTM')
  return m
}

function searchToLegacy(r = {}) {
  return {
    ...r,
    stockExchange:     pickFirst(r.stockExchange, r.exchangeFullName),
    exchangeShortName: pickFirst(r.exchangeShortName, r.exchange),
  }
}

/** Statement rows: stable renamed calendarYear→fiscalYear, epsdiluted→epsDiluted, dividendsPaid split. */
function statementToLegacy(r = {}) {
  return {
    ...r,
    calendarYear:  pickFirst(r.calendarYear, r.fiscalYear),
    epsdiluted:    pickFirst(r.epsdiluted, r.epsDiluted),
    fillingDate:   pickFirst(r.fillingDate, r.filingDate),
    dividendsPaid: pickFirst(r.dividendsPaid, r.netDividendsPaid, r.commonDividendsPaid),
  }
}

/** Earnings rows → the v3 earnings-surprises shape. Future (unreported) rows have no actual. */
function earningsToSurprise(r = {}) {
  return {
    ...r,
    actualEarningResult: pickFirst(r.actualEarningResult, r.epsActual),
    estimatedEarning:    pickFirst(r.estimatedEarning, r.epsEstimated),
    estimatedEps:        pickFirst(r.estimatedEps, r.estimatedEarning, r.epsEstimated),
  }
}

/** Earnings-calendar rows → v3 earning_calendar shape (`eps`, `revenue` are actuals). */
function earningsCalendarToLegacy(r = {}) {
  return {
    ...r,
    eps:     pickFirst(r.eps, r.epsActual),
    revenue: pickFirst(r.revenue, r.revenueActual),
  }
}

/** v4 spelled it `acquistionOrDisposition` and `link`; stable fixed the typo and says `url`. */
function insiderToLegacy(r = {}) {
  return {
    ...r,
    acquistionOrDisposition: pickFirst(r.acquistionOrDisposition, r.acquisitionOrDisposition),
    acquisitionOrDisposition: pickFirst(r.acquisitionOrDisposition, r.acquistionOrDisposition),
    link: pickFirst(r.link, r.url),
  }
}

/**
 * Which side of the market an insider transaction was on. The SEC transaction
 * code (the letter before the dash in "S-Sale") decides: P is an open-market
 * purchase, S an open-market sale. Awards, option exercises, tax withholding
 * and gifts (A/M/F/G/…) are NOT trades on the market and return 'other' —
 * counting a grant as "insider buying" is the classic misread. Without a code,
 * fall back to acquired/disposed.
 */
function insiderSide(r = {}) {
  const code = String(r.transactionType || '').trim().toUpperCase().split(/[-\s]/)[0]
  if (code === 'P' || code === 'PURCHASE' || code === 'BUY') return 'buy'
  if (code === 'S' || code === 'SALE' || code === 'SELL') return 'sell'
  if (code) return 'other'
  const ad = String(r.acquisitionOrDisposition || r.acquistionOrDisposition || '').trim().toUpperCase()
  return ad === 'A' ? 'buy' : ad === 'D' ? 'sell' : 'other'
}

/** v3 analyst-stock-recommendations rows (note the lowercase `analystRatingsbuy`) → counts. */
function ratingsRowToCounts(r = {}) {
  return {
    date:       r.date ?? null,
    strongBuy:  pickFirst(r.strongBuy,  r.analystRatingsStrongBuy),
    buy:        pickFirst(r.buy,        r.analystRatingsBuy, r.analystRatingsbuy),
    hold:       pickFirst(r.hold,       r.analystRatingsHold),
    sell:       pickFirst(r.sell,       r.analystRatingsSell),
    strongSell: pickFirst(r.strongSell, r.analystRatingsStrongSell),
    consensus:  r.consensus ?? null,
  }
}

// ── Endpoints ────────────────────────────────────────────────────────────────

/**
 * Quotes for many symbols, v3 shape. batch-quote first; a plan that refuses
 * batches gets per-symbol calls, capped so one request can't spend a day's
 * quota; legacy last.
 */
async function quotes(symbols, opts = {}) {
  const { key, net } = ctx(opts)
  const list = [...new Set((symbols || []).map(s => String(s).toUpperCase()).filter(Boolean))]
  if (!list.length) return []
  try {
    const rows = await firstOf([S('batch-quote', { symbols: list.join(',') }, key)], net)
    if (isNonEmptyArray(rows)) return rows.map(quoteToLegacy)
  } catch { /* try per-symbol */ }
  const PER_SYMBOL_CAP = opts.perSymbolCap ?? 10
  const settled = await Promise.allSettled(list.slice(0, PER_SYMBOL_CAP).map(sym =>
    getJson(buildUrl(STABLE, 'quote', { symbol: sym }, key), net)))
  const single = settled.flatMap(s => (s.status === 'fulfilled' ? asArray(s.value) : [])).filter(q => q?.symbol)
  if (single.length) return single.map(quoteToLegacy)
  const legacy = await firstOf([L(`quote/${list.map(enc).join(',')}`, {}, key)], net)
  return asArray(legacy).map(quoteToLegacy)
}

/** Daily bars, newest first, v3 `historical` row shape. */
async function dailyHistory(symbol, { from, to, ...opts } = {}) {
  const { key, net } = ctx(opts)
  const body = await firstOf([
    S('historical-price-eod/full', { symbol, from, to }, key),
    L(`historical-price-full/${enc(symbol)}`, { from, to }, key),
  ], { ...net, accept: b => isNonEmptyArray(b) || isNonEmptyArray(b?.historical) })
  return Array.isArray(body) ? body : (body?.historical || [])
}

/** Intraday bars (interval: 1min 5min 15min 30min 1hour 4hour), newest first. */
async function intradayHistory(interval, symbol, { from, to, ...opts } = {}) {
  const { key, net } = ctx(opts)
  return asArray(await firstOf([
    S(`historical-chart/${interval}`, { symbol, from, to }, key),
    L(`historical-chart/${interval}/${enc(symbol)}`, { from, to }, key),
  ], net))
}

async function profile(symbol, opts = {}) {
  const { key, net } = ctx(opts)
  const rows = asArray(await firstOf([
    S('profile', { symbol }, key),
    L(`profile/${enc(symbol)}`, {}, key),
  ], net))
  return rows[0] ? profileToLegacy(rows[0]) : null
}

/** key-metrics-ttm + ratios-ttm merged, with legacy aliases. {} when neither answers. */
async function metricsTtm(symbol, opts = {}) {
  const { key, net } = ctx(opts)
  const [km, rat] = await Promise.allSettled([
    firstOf([S('key-metrics-ttm', { symbol }, key), L(`key-metrics-ttm/${enc(symbol)}`, {}, key)], net),
    firstOf([S('ratios-ttm', { symbol }, key), L(`ratios-ttm/${enc(symbol)}`, {}, key)], net),
  ])
  const kmRow  = km.status  === 'fulfilled' ? asArray(km.value)[0]  : null
  const ratRow = rat.status === 'fulfilled' ? asArray(rat.value)[0] : null
  if (!kmRow && !ratRow) throw (km.reason || rat.reason || new FmpError(`No TTM metrics for ${symbol}`))
  return metricsTtmToLegacy(kmRow || {}, ratRow || {})
}

/** Symbol + company-name search, merged and de-duplicated, v3 shape. */
async function search(query, opts = {}) {
  const { key, net } = ctx(opts)
  const limit = opts.limit ?? 25
  const [bySym, byName] = await Promise.allSettled([
    getJson(buildUrl(STABLE, 'search-symbol', { query, limit }, key), net),
    getJson(buildUrl(STABLE, 'search-name',   { query, limit }, key), net),
  ])
  const seen = new Set()
  const rows = [bySym, byName]
    .flatMap(s => (s.status === 'fulfilled' && Array.isArray(s.value) ? s.value : []))
    .filter(r => r?.symbol && !seen.has(r.symbol) && seen.add(r.symbol))
  if (rows.length) return rows.map(searchToLegacy)
  const legacy = await firstOf([L('search', { query, limit }, key)], net)
  return asArray(legacy).map(searchToLegacy)
}

/** News for tickers (array or null for the general feed), v3 stock_news shape. */
async function stockNews(symbols, opts = {}) {
  const { key, net } = ctx(opts)
  const limit   = opts.limit ?? 20
  const tickers = Array.isArray(symbols) ? symbols.join(',') : (symbols || '')
  const attempts = tickers
    ? [S('news/stock', { symbols: tickers, limit }, key), L('stock_news', { tickers, limit }, key)]
    : [S('news/stock-latest', { page: 0, limit }, key), L('stock_news', { limit }, key)]
  return asArray(await firstOf(attempts, net))
}

/** Bulk screener. Parameter names are the same on both APIs. */
async function screener(params = {}, opts = {}) {
  const { key, net } = ctx(opts)
  return asArray(await firstOf([
    S('company-screener', params, key),
    L('stock-screener', params, key),
  ], net))
}

/** kind: income-statement | balance-sheet-statement | cash-flow-statement */
async function statements(kind, symbol, { period = 'annual', limit = 5, ...opts } = {}) {
  const { key, net } = ctx(opts)
  const params = { period, limit }
  return asArray(await firstOf([
    S(kind, { symbol, ...params }, key),
    L(`${kind}/${enc(symbol)}`, params, key),
  ], net)).map(statementToLegacy)
}

/** Current analyst buy/hold/sell counts: {date, strongBuy, buy, hold, sell, strongSell, consensus} or null. */
async function analystConsensus(symbol, opts = {}) {
  const { key, net } = ctx(opts)
  const rows = asArray(await firstOf([
    S('grades-consensus', { symbol }, key),
    S('grades-historical', { symbol, limit: 1 }, key),
    L(`analyst-stock-recommendations/${enc(symbol)}`, { limit: 1 }, key),
  ], net))
  return rows[0] ? ratingsRowToCounts(rows[0]) : null
}

/** Monthly analyst-rating snapshots, newest first, as counts. */
async function analystHistory(symbol, opts = {}) {
  const { key, net } = ctx(opts)
  const limit = opts.limit ?? 10
  return asArray(await firstOf([
    S('grades-historical', { symbol, limit }, key),
    L(`analyst-stock-recommendations/${enc(symbol)}`, { limit }, key),
  ], net)).map(ratingsRowToCounts)
}

/** REPORTED quarters only (newest first), v3 earnings-surprises shape. */
async function earningsSurprises(symbol, opts = {}) {
  const { key, net } = ctx(opts)
  const limit = opts.limit ?? 4
  const rows = asArray(await firstOf([
    S('earnings', { symbol, limit: limit + 4 }, key),     // + upcoming rows, which carry no actual
    L(`earnings-surprises/${enc(symbol)}`, {}, key),
  ], net)).map(earningsToSurprise)
  return rows.filter(r => r.actualEarningResult != null).slice(0, limit)
}

/** Earnings calendar between two YYYY-MM-DD dates (stable caps the range at 90 days). */
async function earningsCalendar(from, to, opts = {}) {
  const { key, net } = ctx(opts)
  return asArray(await firstOf([
    S('earnings-calendar', { from, to }, key),
    L('earning_calendar', { from, to }, key),
  ], net)).map(earningsCalendarToLegacy)
}

/**
 * The latest `limit` call transcripts, newest first: [{symbol, quarter, year, date, content}].
 * Stable needs a year+quarter per transcript, so the dates list comes first.
 */
async function transcripts(symbol, opts = {}) {
  const { key, net } = ctx(opts)
  const limit = opts.limit ?? 3
  let dates = []
  try { dates = asArray(await getJson(buildUrl(STABLE, 'earning-call-transcript-dates', { symbol }, key), net)) } catch { /* legacy */ }
  if (dates.length) {
    const recent = [...dates]
      .sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')))
      .slice(0, limit)
    const got = await Promise.allSettled(recent.map(d =>
      getJson(buildUrl(STABLE, 'earning-call-transcript', { symbol, year: d.fiscalYear ?? d.year, quarter: d.quarter }, key), net)))
    const rows = got.flatMap((g, i) => (g.status === 'fulfilled' ? asArray(g.value) : []).map(t => ({
      ...t,
      quarter: Number(String(t.quarter ?? t.period ?? recent[i].quarter).replace(/\D/g, '')) || recent[i].quarter,
      year:    t.year ?? recent[i].fiscalYear,
    }))).filter(t => t.content)
    if (rows.length) return rows
  }
  return asArray(await firstOf([L(`earning_call_transcript/${enc(symbol)}`, { limit }, key)], net))
}

async function dcf(symbol, opts = {}) {
  const { key, net } = ctx(opts)
  const rows = asArray(await firstOf([
    S('discounted-cash-flow', { symbol }, key),
    L(`discounted-cash-flow/${enc(symbol)}`, {}, key),
  ], net))
  return rows[0] || null
}

/** Dividend history, newest first, v3 `historical` row shape. */
async function dividends(symbol, opts = {}) {
  const { key, net } = ctx(opts)
  const body = await firstOf([
    S('dividends', { symbol }, key),
    L(`historical-price-full/stock_dividend/${enc(symbol)}`, {}, key),
  ], { ...net, accept: b => isNonEmptyArray(b) || isNonEmptyArray(b?.historical) })
  return Array.isArray(body) ? body : (body?.historical || [])
}

/** Form 4 insider transactions, newest first, with both field spellings. */
async function insiderTrades(symbol, opts = {}) {
  const { key, net } = ctx(opts)
  const limit = opts.limit ?? 30
  return asArray(await firstOf([
    S('insider-trading/search', { symbol, page: 0, limit }, key),
    () => buildUrl(LEGACY_V4, 'insider-trading', { symbol, page: 0, limit }, key),
  ], net)).map(insiderToLegacy)
}

/** Forward analyst estimates (annual), newest first. */
async function analystEstimates(symbol, opts = {}) {
  const { key, net } = ctx(opts)
  const limit = opts.limit ?? 4
  return asArray(await firstOf([
    S('analyst-estimates', { symbol, period: 'annual', limit }, key),
    L(`analyst-estimates/${enc(symbol)}`, { limit }, key),
  ], net)).map(e => ({
    ...e,
    estimatedRevenueLow:    pickFirst(e.estimatedRevenueLow,    e.revenueLow),
    estimatedRevenueHigh:   pickFirst(e.estimatedRevenueHigh,   e.revenueHigh),
    estimatedEpsLow:        pickFirst(e.estimatedEpsLow,        e.epsLow),
    estimatedEpsHigh:       pickFirst(e.estimatedEpsHigh,       e.epsHigh),
    estimatedNetIncomeLow:  pickFirst(e.estimatedNetIncomeLow,  e.netIncomeLow),
    estimatedNetIncomeHigh: pickFirst(e.estimatedNetIncomeHigh, e.netIncomeHigh),
  }))
}

/** Peer tickers: string[]. */
async function peers(symbol, opts = {}) {
  const { key, net } = ctx(opts)
  const body = await firstOf([
    S('stock-peers', { symbol }, key),
    L('stock_peers', { symbol }, key),
  ], { ...net, accept: b => isNonEmptyArray(b) || isNonEmptyArray(b?.[0]?.peersList) })
  const rows = asArray(body)
  if (Array.isArray(rows[0]?.peersList)) return rows[0].peersList          // legacy: [{symbol, peersList:[]}]
  return rows.map(r => r?.symbol).filter(s => s && s !== symbol)           // stable: [{symbol, companyName, …}]
}

module.exports = {
  STABLE, LEGACY, FmpError,
  // network
  quotes, dailyHistory, intradayHistory, profile, metricsTtm, search, stockNews, screener,
  statements, analystConsensus, analystHistory, earningsSurprises, earningsCalendar,
  transcripts, dcf, dividends, insiderTrades, analystEstimates, peers,
  // pure
  buildUrl, errorMessage, quoteToLegacy, profileToLegacy, metricsTtmToLegacy, searchToLegacy,
  statementToLegacy, earningsToSurprise, earningsCalendarToLegacy, insiderToLegacy, insiderSide,
  ratingsRowToCounts,
}
