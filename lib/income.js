'use strict'
/**
 * lib/income.js — what holding a stock or holding cash actually pays.
 *
 * Every price series in the app is a PRICE series: SPY's first bar five years
 * back is the $464.60 it traded at, not a dividend-adjusted figure. So every
 * "beats buy & hold" test compared a strategy with a buy-and-hold that never
 * received a dividend, and a strategy sitting in cash earned nothing on it.
 * Both bend the comparison — the first flatters timing rules (they hold the
 * stock less often, so they lose fewer of the missing dividends), the second
 * penalises them. This module supplies the two missing cash flows:
 *
 *   dividends   per ex-date, SPLIT-ADJUSTED to match the split-adjusted prices.
 *               Sources in order: Yahoo chart events (adjusted, keyless,
 *               unofficial), FMP (`adjDividend`, needs a key), Nasdaq (keyless
 *               but AS PAID — a pre-split dividend is 10× too large on a 10:1
 *               split — so a Nasdaq dividend over MAX_NASDAQ_YIELD of the
 *               price is dropped as a probable unadjusted pre-split row).
 *               Crypto pays none. When every source fails the bars carry no
 *               dividend field and the backtest says it ran on price only —
 *               "could not check" is never shown as "pays nothing".
 *   cash rate   the 3-month Treasury bill (FRED DTB3, keyless CSV), the rate
 *               KNOWN on each bar (the last observation dated on or before it).
 *
 * Nothing here throws into a caller: attachIncome returns the bars it was
 * given plus whatever it could add, and says what it could not.
 *
 * Tests: tests/income.test.js
 */

const DAY_MS = 86_400_000
const CACHE_MS = 24 * 3600_000
const MAX_NASDAQ_YIELD = 0.05            // one cash dividend above 5% of the price: treated as an unadjusted pre-split row
const FRED_DTB3 = 'https://fred.stlouisfed.org/graph/fredgraph.csv?id=DTB3'
const UA = { 'user-agent': 'Mozilla/5.0 (FinSurfing research)' }

const _divCache = new Map()
let _rateCache = null

const dayOf = ms => new Date(ms).toISOString().slice(0, 10)
const isCrypto = s => /-USD$|-USDT$/.test(String(s || ''))
const yahooSymbol = s => String(s).toUpperCase().replace(/\./g, '-')

async function getJson(url, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const r = await fetchImpl(url, { headers: UA, signal: AbortSignal.timeout(timeoutMs) })
  if (!r.ok) throw new Error(`HTTP ${r.status}`)
  return r.json()
}

/** Yahoo chart events: split-adjusted dividends and the splits themselves. */
async function yahooDividends(symbol, { fetchImpl, range = '10y' } = {}) {
  const d = await getJson(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(yahooSymbol(symbol))}?range=${range}&interval=1d&events=div%2Csplit`, { fetchImpl })
  const res = d?.chart?.result?.[0]
  if (!res) throw new Error(d?.chart?.error?.description || 'no result')
  const ev = res.events || {}
  const dividends = Object.values(ev.dividends || {})
    .map(x => ({ date: dayOf(x.date * 1000), amount: Number(x.amount) }))
    .filter(x => x.amount > 0)
  const splits = Object.values(ev.splits || {})
    .map(x => ({ date: dayOf(x.date * 1000), ratio: Number(x.numerator) / Number(x.denominator) }))
    .filter(x => Number.isFinite(x.ratio) && x.ratio > 0)
  return { source: 'yahoo', adjusted: true, dividends, splits }
}

/** FMP dividend history — `adjDividend` is split-adjusted. */
async function fmpDividends(symbol, { fmp = require('./fmp') } = {}) {
  if (!process.env.FMP_API_KEY) throw new Error('no FMP key')
  const rows = await fmp.dividends(symbol)
  if (!Array.isArray(rows)) throw new Error('no rows')
  const dividends = rows
    .map(r => ({ date: String(r.date || r.exDividendDate || '').slice(0, 10), amount: Number(r.adjDividend ?? r.dividend) }))
    .filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.amount > 0)
  return { source: 'fmp', adjusted: true, dividends, splits: [] }
}

/** Nasdaq dividend history — as paid, not split-adjusted. */
async function nasdaqDividends(symbol, { fetchImpl } = {}) {
  for (const cls of ['stocks', 'etf']) {
    const d = await getJson(`https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/dividends?assetclass=${cls}`, { fetchImpl })
    const rows = d?.data?.dividends?.rows || []
    if (!rows.length) continue
    const dividends = rows.map(r => {
      const [m, dd, y] = String(r.exOrEffDate || '').split('/')
      return { date: y && m && dd ? `${y}-${m}-${dd}` : '', amount: Number(String(r.amount || '').replace(/[$,]/g, '')), type: r.type }
    }).filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && x.amount > 0 && (!x.type || /cash/i.test(x.type)))
    return { source: 'nasdaq', adjusted: false, dividends: dividends.map(({ date, amount }) => ({ date, amount })), splits: [] }
  }
  throw new Error('no dividend rows')   // a non-payer and an unknown ETF look the same here
}

/**
 * Dividend history for one symbol, cached a day. Never throws:
 * { source, adjusted, dividends:[{date, amount}], splits, failed:[{source, reason}] } —
 * source null when nothing could be read (unknown, not zero).
 */
async function dividendHistory(symbol, opts = {}) {
  const sym = String(symbol || '').toUpperCase()
  if (isCrypto(sym)) return { source: 'none-paid', adjusted: true, dividends: [], splits: [], failed: [] }
  const hit = _divCache.get(sym)
  if (hit && Date.now() - hit.at < CACHE_MS && !opts.fresh) return hit.value
  const failed = []
  let value = null
  for (const [name, fn] of [['yahoo', yahooDividends], ['fmp', fmpDividends], ['nasdaq', nasdaqDividends]]) {
    if (opts.sources && !opts.sources.includes(name)) continue
    try { value = await (opts.impl?.[name] || fn)(sym, opts); break }
    catch (e) { failed.push({ source: name, reason: e.message }) }
  }
  value = value ? { ...value, failed } : { source: null, adjusted: null, dividends: [], splits: [], failed }
  _divCache.set(sym, { at: Date.now(), value })
  return value
}

/** 3-month T-bill rate (percent a year) by date, from FRED's keyless CSV. Cached a day; [] when unreachable. */
async function cashRateSeries({ fetchImpl = fetch, fresh = false } = {}) {
  if (_rateCache && Date.now() - _rateCache.at < CACHE_MS && !fresh) return _rateCache.value
  let value = []
  try {
    const r = await fetchImpl(FRED_DTB3, { headers: UA, signal: AbortSignal.timeout(15_000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    value = parseFredCsv(await r.text())
  } catch { value = [] }
  if (value.length) _rateCache = { at: Date.now(), value }
  return value
}

function parseFredCsv(text) {
  return String(text).trim().split(/\r?\n/).slice(1)
    .map(l => l.split(','))
    .map(([date, v]) => ({ date: String(date).slice(0, 10), rate: Number(v) }))
    .filter(x => /^\d{4}-\d{2}-\d{2}$/.test(x.date) && Number.isFinite(x.rate))
}

/**
 * Per-bar arrays aligned to `timestampsMs` (ascending). Pure.
 *   dividends[i]  cash per share for an ex-date on bar i's day; an ex-date on a
 *                 day with no bar goes to the NEXT bar (you held at the prior close)
 *   cashRates[i]  the rate (percent a year) last observed on or before bar i's day
 * A Nasdaq (as-paid) dividend above MAX_NASDAQ_YIELD of that bar's close is dropped.
 */
function alignIncome(timestampsMs, closes, { dividends = null, adjusted = true, rates = null } = {}) {
  const days = timestampsMs.map(dayOf)
  const out = {}
  if (Array.isArray(dividends)) {
    const div = new Array(days.length).fill(0)
    let dropped = 0
    for (const d of dividends) {
      if (d.date < days[0] || d.date > days[days.length - 1]) continue
      let i = days.findIndex(x => x >= d.date)
      if (i <= 0) continue                         // no bar before it: nobody in the window held through it
      if (!adjusted && closes[i] > 0 && d.amount / closes[i] > MAX_NASDAQ_YIELD) { dropped++; continue }
      div[i] += d.amount
    }
    out.dividends = div
    out.droppedDividends = dropped
  }
  if (Array.isArray(rates) && rates.length) {
    const cr = new Array(days.length).fill(null)
    let j = -1
    for (let i = 0; i < days.length; i++) {
      while (j + 1 < rates.length && rates[j + 1].date <= days[i]) j++
      cr[i] = j >= 0 ? rates[j].rate : null
    }
    if (cr.some(v => v != null)) out.cashRates = cr.map(v => (v == null ? 0 : v))
  }
  return out
}

/**
 * Bars ({t ms, c, …}) with `div` and `rf` added where known, and a note saying
 * what was used. Never throws; on any failure the bars come back as they were.
 */
async function attachIncome(bars, symbol, opts = {}) {
  if (!Array.isArray(bars) || !bars.length) return bars
  try {
    const [hist, rates] = await Promise.all([
      opts.dividends === false ? null : dividendHistory(symbol, opts),
      opts.cash === false ? [] : cashRateSeries(opts),
    ])
    const a = alignIncome(bars.map(b => b.t), bars.map(b => b.c), {
      dividends: hist?.source ? hist.dividends : null, adjusted: hist?.adjusted !== false, rates,
    })
    const out = bars.map((b, i) => ({
      ...b,
      ...(a.dividends ? { div: a.dividends[i] } : {}),
      ...(a.cashRates ? { rf: a.cashRates[i] } : {}),
    }))
    out.income = {
      dividends: hist?.source ? hist.source : null,
      dividendsAdjusted: hist?.adjusted ?? null,
      dividendsFailed: hist?.failed || [],
      droppedDividends: a.droppedDividends || 0,
      cashRate: a.cashRates ? 'FRED DTB3' : null,
    }
    return out
  } catch { return bars }
}

module.exports = {
  MAX_NASDAQ_YIELD, FRED_DTB3, isCrypto, yahooSymbol,
  yahooDividends, fmpDividends, nasdaqDividends, dividendHistory,
  cashRateSeries, parseFredCsv, alignIncome, attachIncome,
  _clearCache: () => { _divCache.clear(); _rateCache = null },
}
