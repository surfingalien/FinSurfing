'use strict'
/**
 * lib/event-study.js — what one stock did after its own past events.
 *
 * Pure maths over daily bars; the route (routes/quant.js) fetches the bars and
 * the SEC filing index. No model is called.
 *
 * Events are dated by an SEC filing: `earnings` = original 8-Ks carrying
 * Item 2.02 (results of operations — the earnings release), `filings` = the
 * periodic reports themselves (10-K / 10-Q, or 20-F / 40-F for a foreign
 * issuer), `custom` = dates the user typed.
 *
 * Two different questions, kept apart:
 *
 *  1. THE REACTION (descriptive, not tradable): close of the last session
 *     before the event date → close of the first session after it. A filing
 *     date does not say whether the news came before the open or after the
 *     close, and this window covers both.
 *
 *  2. THE DRIFT (tradable): enter at the OPEN of the first session strictly
 *     after the event date — the first price nobody could have traded before
 *     the news — and hold h sessions, exit at that session's close, net of the
 *     round-trip cost, minus the benchmark over the same sessions. A
 *     pre-market release's day-0 move is skipped, never looked ahead at.
 *
 * Rules that keep the answer honest:
 *  - windows of one horizon never overlap (a later event inside an open window
 *    is dropped for that horizon and counted);
 *  - the t-statistic is across calendar MONTHS of entry, not events;
 *  - several horizons are several tests: the bar is two-sided Bonferroni with
 *    a Student-t correction for the small number of months;
 *  - fewer than MIN_EVENTS usable events → `insufficient`, no verdict.
 *
 * Tests: tests/event-study.test.js
 */

const { wilson } = require('./calibration-stats')
const { normInv } = require('./quant/linalg')

const HORIZONS   = [1, 5, 20]
const MIN_EVENTS = 12
const MAX_DATES  = 80
const KINDS      = ['earnings', 'filings', 'custom']
const PERIODIC   = new Set(['10-K', '10-Q', '20-F', '40-F'])

const dayKey = t => new Date(t).toISOString().slice(0, 10)
const mean = a => a.reduce((s, x) => s + x, 0) / a.length
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)) }
const median = a => { const s = [...a].sort((x, y) => x - y), n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2 }
const r2 = v => (v == null ? null : +v.toFixed(2))

/** Event dates from EDGAR's `filings.recent` parallel arrays. Oldest first, one per day. */
function eventDates(recent, kind) {
  if (!recent || !Array.isArray(recent.form)) return []
  const seen = new Map()
  for (let i = 0; i < recent.form.length; i++) {
    const form = recent.form[i], date = recent.filingDate?.[i]
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) continue
    const hit = kind === 'earnings'
      ? form === '8-K' && String(recent.items?.[i] || '').split(',').map(s => s.trim()).includes('2.02')
      : kind === 'filings' ? PERIODIC.has(form) : false
    if (hit && !seen.has(date)) seen.set(date, { date, form })
  }
  return [...seen.values()].sort((a, b) => a.date.localeCompare(b.date))
}

/** User-typed dates → { events, invalid, dropped }. */
function parseCustomDates(input) {
  const tokens = Array.isArray(input) ? input.map(String) : String(input || '').split(/[\s,;]+/)
  const ok = new Set(), invalid = []
  for (const raw of tokens) {
    const t = raw.trim()
    if (!t) continue
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(t) && !Number.isNaN(Date.parse(`${t}T00:00:00Z`)) && dayKey(Date.parse(`${t}T00:00:00Z`)) === t
    if (valid) ok.add(t); else invalid.push(t.slice(0, 20))
  }
  const all = [...ok].sort()
  return { events: all.slice(-MAX_DATES).map(date => ({ date, form: null })), invalid: invalid.slice(0, 10), dropped: Math.max(0, all.length - MAX_DATES) }
}

/** Two-sided Bonferroni bar over `tests`, Cornish–Fisher corrected for `df`. */
function tBar(tests, df) {
  const z = normInv(1 - 0.05 / (2 * Math.max(1, tests)))
  return z + (z ** 3 + z) / (4 * Math.max(1, df))
}

function summarize(rows, h, tests) {
  const abn = rows.map(r => r.abn)
  const out = { horizon: h, n: abn.length }
  if (!abn.length) return { ...out, verdict: 'insufficient' }
  const byMonth = new Map()
  for (const r of rows) {
    const m = r.entryDate.slice(0, 7)
    if (!byMonth.has(m)) byMonth.set(m, [])
    byMonth.get(m).push(r.abn)
  }
  const mm = [...byMonth.values()].map(mean)
  const t = mm.length >= 3 && sd(mm) > 0 ? mean(mm) / (sd(mm) / Math.sqrt(mm.length)) : null
  const wins = abn.filter(a => a > 0).length, w = wilson(wins, abn.length)
  const bar = tBar(tests, mm.length - 1)
  Object.assign(out, {
    months: mm.length,
    meanAbn: r2(mean(abn)), medianAbn: r2(median(abn)), sdAbn: r2(sd(abn)),
    meanRet: r2(mean(rows.map(r => r.ret))), meanBench: r2(mean(rows.map(r => r.bench))),
    beat: +(wins / abn.length).toFixed(3), beatLo: +w.lo.toFixed(3), beatHi: +w.hi.toFixed(3),
    t: t == null ? null : r2(t), tBar: r2(bar),
  })
  out.verdict = abn.length < MIN_EVENTS || t == null ? 'insufficient'
    : t >= bar ? 'positive' : t <= -bar ? 'negative' : 'no-clear-effect'
  return out
}

/**
 * @param {object}   o
 * @param {object[]} o.bars       the symbol's daily bars {t,o,c}, oldest first
 * @param {object[]} o.benchBars  the benchmark's
 * @param {object[]} o.events     [{date:'YYYY-MM-DD', form}] oldest first
 * @param {number}   o.costBps    round trip, charged once per event
 */
function study({ bars = [], benchBars = [], events = [], horizons = HORIZONS, costBps = 10 } = {}) {
  const days = bars.map(b => dayKey(b.t))
  const bench = new Map(benchBars.map(b => [dayKey(b.t), b]))
  const maxH = Math.max(...horizons)
  const cost = costBps / 100
  const skipped = { beforeHistory: 0, tooRecent: 0, noBenchmark: 0 }
  const rows = []

  for (const ev of events) {
    if (!days.length || ev.date < days[0]) { skipped.beforeHistory += 1; continue }
    const i = days.findIndex(d => d > ev.date)
    if (i < 1) { skipped.tooRecent += 1; continue }
    const entry = bars[i].o > 0 ? bars[i].o : bars[i].c
    const be = bench.get(days[i])
    if (!(entry > 0) || !be) { skipped.noBenchmark += 1; continue }
    const benchEntry = be.o > 0 ? be.o : be.c

    // The reaction: last close before the event date → first close after it.
    let j = i - 1
    while (j >= 0 && days[j] >= ev.date) j -= 1
    const bj = j >= 0 ? bench.get(days[j]) : null
    const reaction = j >= 0 && bars[j].c > 0 && bars[i].c > 0 ? (bars[i].c / bars[j].c - 1) * 100 : null
    const reactionBench = bj && be.c > 0 && bj.c > 0 ? (be.c / bj.c - 1) * 100 : null

    const row = { date: ev.date, form: ev.form ?? null, entryDate: days[i], entryIdx: i, reaction: r2(reaction), reactionAbn: reaction != null && reactionBench != null ? r2(reaction - reactionBench) : null, byHorizon: {} }
    for (const h of horizons) {
      const x = i + h - 1
      if (x >= bars.length) continue
      const bx = bench.get(days[x])
      if (!bx || !(bars[x].c > 0)) continue
      const ret = (bars[x].c / entry - 1) * 100 - cost
      const b = (bx.c / benchEntry - 1) * 100
      row.byHorizon[h] = { ret, bench: b, abn: ret - b, exitIdx: x }
    }
    // Day-by-day path for the chart (before costs), only when the longest window is complete.
    if (i + maxH - 1 < bars.length) {
      const path = []
      for (let d = 1; d <= maxH; d++) {
        const bd = bench.get(days[i + d - 1])
        if (!bd || !(bars[i + d - 1].c > 0)) { path.length = 0; break }
        path.push((bars[i + d - 1].c / entry - 1) * 100 - (bd.c / benchEntry - 1) * 100)
      }
      if (path.length === maxH) row.path = path
    }
    rows.push(row)
  }

  const results = horizons.map(h => {
    let lastExit = -1, overlapped = 0
    const kept = []
    for (const r of rows) {
      const v = r.byHorizon[h]
      if (!v) continue
      if (r.entryIdx <= lastExit) { overlapped += 1; v.overlap = true; continue }
      lastExit = v.exitIdx
      kept.push({ entryDate: r.entryDate, ...v })
    }
    return { ...summarize(kept, h, horizons.length), overlapped, pending: rows.filter(r => !r.byHorizon[h]).length }
  })

  // Mean path over the events the longest horizon kept.
  const pathRows = rows.filter(r => r.path && !r.byHorizon[maxH]?.overlap)
  const path = pathRows.length >= 3
    ? Array.from({ length: maxH }, (_, d) => ({ day: d + 1, mean: r2(mean(pathRows.map(r => r.path[d]))), median: r2(median(pathRows.map(r => r.path[d]))) }))
    : null

  const react = rows.filter(r => r.reactionAbn != null)
  const reaction = react.length ? (() => {
    const abs = react.map(r => Math.abs(r.reactionAbn))
    const up = react.filter(r => r.reactionAbn > 0).length, w = wilson(up, react.length)
    const best = react.reduce((a, b) => (b.reactionAbn > a.reactionAbn ? b : a)), worst = react.reduce((a, b) => (b.reactionAbn < a.reactionAbn ? b : a))
    return {
      n: react.length, medianAbs: r2(median(abs)), meanAbs: r2(mean(abs)),
      up: +(up / react.length).toFixed(3), upLo: +w.lo.toFixed(3), upHi: +w.hi.toFixed(3),
      best: { date: best.date, move: best.reactionAbn }, worst: { date: worst.date, move: worst.reactionAbn },
    }
  })() : null

  return {
    events: rows.length, requested: events.length, skipped,
    from: rows[0]?.date ?? null, to: rows[rows.length - 1]?.date ?? null,
    minEvents: MIN_EVENTS, costBps,
    horizons: results, reaction, path,
    table: rows.slice(-40).reverse().map(r => ({
      date: r.date, form: r.form, entryDate: r.entryDate, reaction: r.reaction, reactionAbn: r.reactionAbn,
      ...Object.fromEntries(horizons.map(h => [`abn${h}`, r.byHorizon[h] ? r2(r.byHorizon[h].abn) : null])),
    })),
  }
}

/** One plain sentence per result, for the page and the Research Desk. */
function describe(result, { symbol = 'The stock', kind = 'earnings', benchmark = 'SPY' } = {}) {
  const what = kind === 'earnings' ? 'earnings releases' : kind === 'filings' ? 'periodic filings' : 'the dates entered'
  const lines = []
  if (result.reaction) lines.push(`Across ${result.reaction.n} ${what}, ${symbol} moved a median ${result.reaction.medianAbs}% against ${benchmark} on the event (either direction); it rose in ${Math.round(result.reaction.up * 100)}% of them.`)
  for (const h of result.horizons) {
    if (h.verdict === 'insufficient') { lines.push(`${h.horizon}-session drift: ${h.n} usable events, fewer than the ${result.minEvents} needed — no verdict.`); continue }
    const tail = h.verdict === 'positive' ? 'a positive drift that clears the bar' : h.verdict === 'negative' ? 'a negative drift that clears the bar' : 'not distinguishable from zero'
    lines.push(`${h.horizon}-session drift after the first tradable open: mean ${h.meanAbn > 0 ? '+' : ''}${h.meanAbn}% vs ${benchmark} over ${h.n} events (t ${h.t}, needs ±${h.tBar}) — ${tail}.`)
  }
  return lines
}

// ── Network: the filing index (keyless, cached) ─────────────────────────────

const INDEX_TTL_MS = 12 * 3600_000
const _index = new Map()

/**
 * EDGAR's recent-filings index for a symbol → { name, recent } or null when the
 * symbol has no SEC registrant (an ETF, a crypto pair, a foreign listing).
 * Throws when EDGAR cannot be reached, so "no filer" and "could not check"
 * are never confused.
 */
async function fetchFilingIndex(symbol, { fetchImpl = fetch, now = Date.now() } = {}) {
  const key = String(symbol).toUpperCase(), hit = _index.get(key)
  if (hit && now - hit.t < INDEX_TTL_MS) return hit.v
  const filings = require('./filings')
  const cik = await filings.resolveCik(key, { fetchImpl })
  let v = null
  if (cik) {
    const subs = await filings.edgarGet(filings.SUBMISSIONS_URL(cik), { fetchImpl })
    if (!subs?.filings?.recent) throw new Error('the SEC filing index did not answer')
    v = { name: subs.name || null, recent: subs.filings.recent }
  }
  _index.set(key, { t: now, v })
  if (_index.size > 200) _index.delete(_index.keys().next().value)
  return v
}

module.exports = {
  fetchFilingIndex, _resetForTests: () => _index.clear(),
  HORIZONS, MIN_EVENTS, MAX_DATES, KINDS, eventDates, parseCustomDates, tBar, study, describe }
