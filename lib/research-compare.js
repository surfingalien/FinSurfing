'use strict'
/**
 * Research Desk — Compare. Up to six symbols side by side on MEASURED facts:
 * price action, the Quant Lab's risk read (lib/quant-snapshot.js) and figures as
 * first filed with the SEC (lib/sec-facts.js). No model is involved.
 *
 * PURE: rowFor() takes bars + SEC facts and returns one symbol's row;
 * buildComparison() lines the rows up. routes/research-desk.js does the fetching.
 *
 * Deliberate choices:
 *  - NO overall score. "Best on this measure" is a fact; a weighted total would be
 *    a hand-set opinion wearing a number (the same reason the strategy report card
 *    has no composite). Each metric states its own direction, or none.
 *  - A missing value is `null` and is shown as missing — never zero, never ranked.
 *    A symbol with no SEC filings (ETF, crypto, ADR) keeps its price and risk rows.
 *  - "Best"/"worst" need at least two symbols with a value that differ.
 *  - Returns over N sessions use the bar N sessions back, not a calendar guess, and
 *    are null when the history is shorter than N.
 *  - Correlation is over the days ALL compared symbols share, so a pair is not
 *    flattered by a longer private history.
 */
const quantSnapshot = require('./quant-snapshot')

const MAX_SYMBOLS = 6
const HIGH_CORR = 0.8

/**
 * `better`: 'high' | 'low' | null (no direction — e.g. beta is a description, not a score).
 * `unit`:   pct (already in percent) | ratio | usd | text
 */
const METRICS = [
  { key: 'ret1m',        group: 'Price',        label: '1-month return',                   unit: 'pct',   better: 'high' },
  { key: 'ret3m',        group: 'Price',        label: '3-month return',                   unit: 'pct',   better: 'high' },
  { key: 'ret1y',        group: 'Price',        label: '1-year return',                    unit: 'pct',   better: 'high' },
  { key: 'fromHigh',     group: 'Price',        label: 'Distance from 52-week high',       unit: 'pct',   better: null },
  { key: 'vol21',        group: 'Risk',         label: 'Volatility forecast (annualised)', unit: 'pct',   better: 'low' },
  { key: 'var95',        group: 'Risk',         label: 'One-day value at risk (95%)',      unit: 'pct',   better: 'low' },
  { key: 'beta',         group: 'Risk',         label: 'Beta to SPY',                      unit: 'ratio', better: null },
  { key: 'character',    group: 'Risk',         label: 'Trend or mean reversion',          unit: 'text',  better: null },
  { key: 'advUsd',       group: 'Risk',         label: 'Average daily dollar volume',      unit: 'usd',   better: 'high' },
  { key: 'pe',           group: 'Valuation',    label: 'P/E (trailing, as filed)',         unit: 'ratio', better: 'low' },
  { key: 'earningsYield', group: 'Valuation',   label: 'Earnings yield',                   unit: 'pct',   better: 'high' },
  { key: 'fcfYield',     group: 'Valuation',    label: 'Free-cash-flow yield',             unit: 'pct',   better: 'high' },
  { key: 'salesGrowth',  group: 'Fundamentals', label: 'Revenue growth (year over year)',  unit: 'pct',   better: 'high' },
  { key: 'netMargin',    group: 'Fundamentals', label: 'Net margin',                       unit: 'pct',   better: 'high' },
  { key: 'roe',          group: 'Fundamentals', label: 'Return on equity',                 unit: 'pct',   better: 'high' },
  { key: 'debtToEquity', group: 'Fundamentals', label: 'Debt to equity',                   unit: 'ratio', better: 'low' },
  { key: 'accruals',     group: 'Fundamentals', label: 'Accruals (earnings not backed by cash)', unit: 'pct', better: 'low' },
]

const round = (v, dp = 2) => (v == null || !Number.isFinite(v) ? null : +v.toFixed(dp))
const okBars = (bars) => (bars || []).filter(b => b && Number.isFinite(b.c) && b.c > 0)

/** Percent change over the last `n` sessions; null when the history is shorter. */
function sessionReturn(closes, n) {
  if (closes.length <= n) return null
  return round((closes[closes.length - 1] / closes[closes.length - 1 - n] - 1) * 100, 1)
}

/** Parse "AAPL, msft nvda" → unique upper-case symbols, capped. Invalid tokens are reported, not dropped silently. */
function parseSymbols(raw, { max = MAX_SYMBOLS } = {}) {
  const tokens = String(raw || '').toUpperCase().split(/[\s,;]+/).filter(Boolean)
  const valid = [], invalid = []
  for (const t of tokens) {
    if (/^[A-Z0-9][A-Z0-9.\-]{0,11}$/.test(t)) { if (!valid.includes(t)) valid.push(t) } else if (!invalid.includes(t)) invalid.push(t)
  }
  return { symbols: valid.slice(0, max), dropped: valid.slice(max), invalid }
}

/**
 * One symbol's row. `sec` is the output of sec-facts.snapshotAt (or null).
 * Returns { symbol, ok, asOf, last, values, gaps } — `ok:false` with a reason when
 * there is not enough price history to say anything.
 */
function rowFor({ symbol, bars, benchBars = null, sec = null, name = null }) {
  const b = okBars(bars)
  if (b.length < 60) return { symbol, name, ok: false, reason: b.length ? `only ${b.length} daily bars (need 60)` : 'no price history', values: {}, gaps: [] }
  const closes = b.map(x => x.c)
  const last = closes[closes.length - 1]
  const yearHigh = Math.max(...b.slice(-252).map(x => (Number.isFinite(x.h) && x.h > 0 ? x.h : x.c)))
  const snap = quantSnapshot.symbolSnapshot(b, { benchBars: benchBars && okBars(benchBars).length >= 60 ? benchBars : null })
  const gaps = []
  const values = {
    ret1m: sessionReturn(closes, 21),
    ret3m: sessionReturn(closes, 63),
    ret1y: sessionReturn(closes, 252),
    fromHigh: round((last / yearHigh - 1) * 100, 1),
    vol21: snap.insufficient ? null : round((snap.vol?.forecast21 ?? NaN) * 100, 1),
    var95: snap.insufficient ? null : round((snap.tail?.var95 ?? NaN) * 100, 2),
    beta: round(snap.beta?.beta, 2),
    character: snap.character?.label && snap.character.label !== 'unknown' ? snap.character.label : null,
    advUsd: round(snap.liquidity?.advUsd, 0),
    pe: sec?.pe ?? null,
    earningsYield: sec?.earningsYield ?? null,
    fcfYield: sec?.fcfYield ?? null,
    salesGrowth: sec?.revenueGrowthYoY ?? null,
    netMargin: sec?.netMargin ?? null,
    roe: sec?.roe ?? null,
    debtToEquity: sec?.debtToEquity ?? null,
    accruals: sec?.accruals ?? null,
  }
  if (!sec) gaps.push('no SEC-filed figures (ETF, crypto, a foreign filer, or the SEC could not be reached)')
  if (values.ret1y == null) gaps.push('less than a year of price history')
  if (values.beta == null && symbol !== 'SPY') gaps.push('no beta (too few days shared with SPY)')
  return {
    symbol, name, ok: true, last: round(last, 2),
    asOf: b[b.length - 1].t ? new Date(b[b.length - 1].t).toISOString().slice(0, 10) : null,
    filedAsOf: sec?.lastFiled ?? null,
    values, gaps,
  }
}

/** Pearson correlation of daily returns over the dates every symbol has. */
function correlations(barsBySymbol, { window = 250 } = {}) {
  const syms = Object.keys(barsBySymbol)
  if (syms.length < 2) return { observations: 0, pairs: [] }
  const day = (t) => new Date(t).toISOString().slice(0, 10)
  const maps = syms.map(s => new Map(okBars(barsBySymbol[s]).map(x => [day(x.t), x.c])))
  let dates = [...maps[0].keys()].filter(d => maps.every(m => m.has(d))).sort()
  dates = dates.slice(-(window + 1))
  if (dates.length < 61) return { observations: Math.max(0, dates.length - 1), pairs: [] }
  const rets = maps.map(m => dates.slice(1).map((d, i) => m.get(d) / m.get(dates[i]) - 1))
  const corr = (x, y) => {
    const n = x.length, mx = x.reduce((a, v) => a + v, 0) / n, my = y.reduce((a, v) => a + v, 0) / n
    let sxy = 0, sxx = 0, syy = 0
    for (let i = 0; i < n; i++) { sxy += (x[i] - mx) * (y[i] - my); sxx += (x[i] - mx) ** 2; syy += (y[i] - my) ** 2 }
    return sxx > 0 && syy > 0 ? sxy / Math.sqrt(sxx * syy) : null
  }
  const pairs = []
  for (let i = 0; i < syms.length; i++) for (let j = i + 1; j < syms.length; j++) {
    const rho = corr(rets[i], rets[j])
    if (rho != null) pairs.push({ a: syms[i], b: syms[j], rho: round(rho, 2), movesTogether: rho >= HIGH_CORR })
  }
  return { observations: dates.length - 1, from: dates[0], to: dates[dates.length - 1], pairs: pairs.sort((p, q) => q.rho - p.rho) }
}

/** Line the rows up metric by metric and mark, per metric, who is best and worst — when that means something. */
function buildComparison(rows, { correlation = null } = {}) {
  const good = rows.filter(r => r.ok)
  const metrics = METRICS.map(m => {
    const values = good.map(r => ({ symbol: r.symbol, value: r.values[m.key] ?? null }))
    const have = values.filter(v => v.value != null)
    let best = null, worst = null
    if (m.better && m.unit !== 'text' && have.length >= 2) {
      const sorted = [...have].sort((a, b) => (m.better === 'high' ? b.value - a.value : a.value - b.value))
      if (sorted[0].value !== sorted[sorted.length - 1].value) { best = sorted[0].symbol; worst = sorted[sorted.length - 1].symbol }
    }
    return { key: m.key, group: m.group, label: m.label, unit: m.unit, better: m.better, values, best, worst, available: have.length }
  })
  const notes = []
  const together = (correlation?.pairs || []).filter(p => p.movesTogether)
  if (together.length) notes.push(`${together.map(p => `${p.a} and ${p.b} (${p.rho})`).join(', ')} moved together over the last ${correlation.observations} shared sessions — owning both is closer to one bet than two.`)
  const noSec = good.filter(r => r.filedAsOf == null).map(r => r.symbol)
  if (noSec.length && noSec.length < good.length) notes.push(`${noSec.join(', ')} ${noSec.length === 1 ? 'has' : 'have'} no SEC-filed figures, so valuation and fundamentals compare only the others.`)
  return {
    symbols: good.map(r => ({ symbol: r.symbol, name: r.name, last: r.last, asOf: r.asOf, filedAsOf: r.filedAsOf, gaps: r.gaps })),
    failed: rows.filter(r => !r.ok).map(r => ({ symbol: r.symbol, reason: r.reason })),
    groups: [...new Set(METRICS.map(m => m.group))],
    metrics, correlation, notes,
    method: 'Measured in code from daily bars and figures as first filed with the SEC. No model, and no overall score: a weighted total would be an opinion.',
  }
}

module.exports = { MAX_SYMBOLS, HIGH_CORR, METRICS, parseSymbols, sessionReturn, rowFor, correlations, buildComparison }
