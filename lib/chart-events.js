'use strict'
/**
 * lib/chart-events.js — what gets drawn on a price chart besides the candles.
 *
 * Pure and shared with the browser (listed in tools/vite-shared-cjs.mjs), so it
 * requires nothing. Three jobs:
 *
 *  - chartEvents():  dated facts for one symbol — earnings releases and periodic
 *                    filings from EDGAR's filing index, and the user's own
 *                    theses — as markers. Facts only: a marker says "this
 *                    happened on this day", never "buy here".
 *  - snapMarkers():  a chart can only hang a marker on a bar that exists. A
 *                    filing made on a Saturday is placed on the next session,
 *                    because that is the first day the market could react;
 *                    markers outside the drawn range are dropped and counted.
 *  - planLevels():   a trade plan (lib/trade-levels.js) as horizontal lines —
 *                    the same numbers as the plan grid, nothing recomputed.
 *  - indexSeries():  several symbols as percent change from a common first day,
 *                    using only the days all of them have.
 *
 * Tests: tests/chart-events.test.js
 */

const KINDS = {
  earnings: { label: 'Earnings release', short: 'E' },
  filing:   { label: 'Annual or quarterly report', short: 'F' },
  thesis:   { label: 'Your thesis', short: 'T' },
  alert:    { label: 'Your TradingView alert', short: 'A' },
  buy:      { label: 'Buy', short: 'B' },
  sell:     { label: 'Sell', short: 'S' },
}
const PERIODIC = { '10-K': 1, '10-Q': 1, '20-F': 1, '40-F': 1 }
const ISO = /^\d{4}-\d{2}-\d{2}$/
const dayKey = t => new Date(t).toISOString().slice(0, 10)

/**
 * @param {object}   o
 * @param {object}  [o.recent]  EDGAR `filings.recent` (parallel arrays)
 * @param {object[]}[o.theses]  the user's journal rows for this symbol {at, judgement}
 * @param {object[]}[o.alerts]  the user's inbound alerts for this symbol {at, message}
 * @param {string}  [o.from]    drop anything before this day
 */
function chartEvents({ recent = null, theses = [], alerts = [], from = null } = {}) {
  const out = []
  const seen = new Set()
  const push = (date, kind, text) => {
    if (!ISO.test(date) || (from && date < from)) return
    const key = `${date}|${kind}`
    if (seen.has(key)) return
    seen.add(key)
    out.push({ date, kind, text })
  }
  if (recent && Array.isArray(recent.form)) {
    for (let i = 0; i < recent.form.length; i++) {
      const form = recent.form[i], date = recent.filingDate && recent.filingDate[i]
      if (!date) continue
      if (form === '8-K' && String((recent.items && recent.items[i]) || '').split(',').map(s => s.trim()).includes('2.02')) push(date, 'earnings', 'Earnings release (8-K)')
      else if (PERIODIC[form]) push(date, 'filing', `${form} filed`)
    }
  }
  for (const t of theses || []) {
    if (!t || !t.at) continue
    const v = t.judgement && t.judgement.verdict
    push(dayKey(t.at), 'thesis', v === 'actionable' ? 'Your thesis: actionable' : v === 'no-trade' ? 'Your thesis: no trade' : 'Your thesis')
  }
  for (const a of alerts || []) {
    if (!a || !a.at) continue
    push(dayKey(a.at), 'alert', a.message ? `Alert: ${String(a.message).slice(0, 80)}` : 'TradingView alert')
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind))
}

/**
 * Place events on the bars that exist. `days` = the chart's bar dates, ascending.
 * → { markers: [{time, kind, text}], dropped } — markers ascending by time.
 */
function snapMarkers(events = [], days = []) {
  const markers = []
  let dropped = 0
  if (!days.length) return { markers, dropped: events.length }
  const first = days[0], last = days[days.length - 1]
  for (const e of events) {
    if (!e || !ISO.test(e.date) || e.date < first || e.date > last) { dropped += 1; continue }
    // First bar on or after the event day (binary search).
    let lo = 0, hi = days.length - 1
    while (lo < hi) { const mid = (lo + hi) >> 1; if (days[mid] < e.date) lo = mid + 1; else hi = mid }
    markers.push({ time: days[lo], kind: e.kind, text: e.text, date: e.date })
  }
  markers.sort((a, b) => a.time.localeCompare(b.time))
  return { markers, dropped }
}

/** A trade plan as horizontal levels. Invalid or missing numbers are left out, never drawn at zero. */
function planLevels(plan) {
  if (!plan) return []
  const out = []
  const add = (price, label, role) => { if (Number.isFinite(price) && price > 0) out.push({ price, label, role }) }
  if (plan.entry) { add(plan.entry.high, 'Entry high', 'entry'); add(plan.entry.low, 'Entry low', 'entry') }
  if (plan.stop) add(plan.stop.price, 'Stop', 'stop')
  for (const b of plan.booking || []) add(b.price, String(b.label || 'Target').split(/\s+[—-]\s+/)[0], 'target')
  return out
}

/**
 * Percent change from the first day every series has.
 * @param {Object<string, {date:string, close:number}[]>} bySymbol
 * → { from, days, series: [{symbol, points:[{time, value}]}], skipped }
 */
function indexSeries(bySymbol = {}) {
  const symbols = Object.keys(bySymbol).filter(s => (bySymbol[s] || []).length >= 2)
  const skipped = Object.keys(bySymbol).filter(s => !symbols.includes(s))
  if (symbols.length < 1) return { from: null, days: 0, series: [], skipped }
  let common = null
  for (const s of symbols) {
    const set = new Set(bySymbol[s].filter(p => p.close > 0).map(p => p.date))
    common = common ? new Set([...common].filter(d => set.has(d))) : set
  }
  const days = [...common].sort()
  if (days.length < 2) return { from: null, days: days.length, series: [], skipped }
  const keep = new Set(days)
  const series = symbols.map(symbol => {
    const rows = bySymbol[symbol].filter(p => keep.has(p.date) && p.close > 0).sort((a, b) => a.date.localeCompare(b.date))
    const base = rows[0].close
    return { symbol, points: rows.map(p => ({ time: p.date, value: +(((p.close / base) - 1) * 100).toFixed(2) })) }
  })
  return { from: days[0], days: days.length, series, skipped }
}

module.exports = { KINDS, chartEvents, snapMarkers, planLevels, indexSeries }
