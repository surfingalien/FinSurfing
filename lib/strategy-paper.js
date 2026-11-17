'use strict'
/**
 * lib/strategy-paper.js — the strategy paper desk.
 *
 * Every strategy the library admits is traded on virtual money, on bars that
 * arrive AFTER it was enrolled, for four weeks. A backtest is a claim about
 * the past; this is the first evidence nobody could have fitted to. A program
 * ends as:
 *
 *   graduated  it finished the four weeks in profit after costs AND its worst
 *              fall was no deeper than simply holding the stock over the same
 *              days (the admission gate's drawdown rule, lib/strategy-evidence.js)
 *   failed     it lost money, or fell further than holding — the reason is kept
 *   no-trades  it never held a position in the window. Four weeks is too short
 *              to judge a rule that trades a few times a year; this is said,
 *              never counted as a pass or a fail
 *
 * What it is not: it places no order anywhere, it moves no money, and
 * graduating changes nothing else in the app — the nightly forward re-test
 * (lib/brain-evolution.js) still decides what stays in the library. Four weeks
 * of one strategy is a small sample and the page says so.
 *
 * How a day is run. Signals are computed over the full history (so indicators
 * are warm) but only bars after enrolment are traded, with the same engine,
 * costs and execution model the strategy was admitted with
 * (utils/backtest.js:simulateWithSignals — next-bar fills). Because a signal on
 * bar i reads bars ≤ i, replaying from enrolment each night gives exactly what
 * trading day by day would have. Each day's equity is APPENDED once and never
 * rewritten, so a later data revision cannot quietly improve the record.
 *
 * Store: data/strategy-paper.json (atomic; in lib/durable-files.js FILES).
 * Tests: tests/strategy-paper.test.js
 */

const fs   = require('fs')
const path = require('path')
const { DATA_DIR } = require('./data-dir')
const { writeJsonAtomic } = require('./atomic-write')

const STORE_FILE  = path.join(DATA_DIR, 'strategy-paper.json')
const CAPITAL     = 10_000
const SESSIONS    = 20            // four weeks of trading days
const MAX_RUNNING = 24            // bars are fetched per symbol each night; keep the desk a desk
const MAX_KEPT    = 200           // decided programs kept for the record

const dayOf = t => new Date(t * 1000).toISOString().slice(0, 10)

function read(file = STORE_FILE) {
  try { const s = JSON.parse(fs.readFileSync(file, 'utf8')); return { programs: s.programs && typeof s.programs === 'object' ? s.programs : {}, lastRun: s.lastRun ?? null } }
  catch { return { programs: {}, lastRun: null } }
}
const write = (s, file = STORE_FILE) => writeJsonAtomic(file, s)

/** A new program for a library entry. The strategy's spec is copied: the library drops retired entries. */
function newProgram(entry, now = Date.now()) {
  return {
    id: entry.id, symbol: entry.symbol, name: entry.name || entry.description || entry.strategy,
    spec: { symbol: entry.symbol, strategy: entry.strategy, params: entry.params },
    origin: entry.origin?.arm ?? null,
    startedAt: new Date(now).toISOString(), capital: CAPITAL,
    days: [], fills: [], status: 'running', reason: null, decidedAt: null, result: null,
  }
}

/**
 * Enrol active library strategies that have no program yet, best fitness first,
 * up to MAX_RUNNING running at once. Pure over the store it is given.
 */
function enrol(store, entries = [], { now = Date.now(), maxRunning = MAX_RUNNING } = {}) {
  let running = Object.values(store.programs).filter(p => p.status === 'running').length
  const added = []
  const fresh = entries.filter(e => e && e.id && e.status !== 'retired' && !store.programs[e.id])
    .sort((a, b) => (b.fitness ?? 0) - (a.fitness ?? 0))
  for (const e of fresh) {
    if (running >= maxRunning) break
    store.programs[e.id] = newProgram(e, now)
    added.push(e.id); running += 1
  }
  return added
}

/**
 * Advance one program on today's bars. Pure: returns the updated program.
 * `series` = brain-evolution.toSeries(bars); deps are injectable for tests.
 */
function step(program, series, { costBps = 10, deps = {} } = {}) {
  if (program.status !== 'running') return program
  const signalsFor = deps.signalsFor || require('./strategy-versions').signalsFor
  const simulate   = deps.simulate   || require('../utils/backtest').simulateWithSignals
  const execOptions = deps.execOptions || require('./execution-model').execOptions
  const { timestamps, closes, opens } = series
  const since = new Date(program.startedAt).getTime()
  const k = timestamps.findIndex(t => t * 1000 > since)
  if (k < 0) return program                                  // no bar after enrolment yet

  const signals = signalsFor(program.spec, series)
  const sim = simulate(timestamps.slice(k), closes.slice(k), signals.slice(k), program.capital,
    { costBps, opens: opens.slice(k), ...execOptions(program.spec.params?.exec, series, k) })

  // Append only the days not yet recorded — a recorded day is never rewritten.
  const p = { ...program, days: [...program.days], fills: [...program.fills] }
  const lastDay = p.days.length ? p.days[p.days.length - 1].date : ''
  const held = new Map()
  { let shares = 0, j = 0
    const fills = [...(sim.trades || [])].filter(t => !t.open).sort((a, b) => String(a.date).localeCompare(String(b.date)))
    for (const e of sim.equity || []) {
      while (j < fills.length && String(fills[j].date).slice(0, 10) <= e.date) { shares += fills[j].type === 'buy' ? (fills[j].shares || 1) : -(fills[j].shares || 1); j += 1 }
      held.set(e.date, shares > 0)
    } }
  for (const e of sim.equity || []) {
    if (e.date > lastDay && p.days.length < SESSIONS) p.days.push({ date: e.date, equity: e.value, inPosition: !!held.get(e.date) })
  }
  const lastFill = p.fills.length ? p.fills[p.fills.length - 1].date : ''
  const window = new Set(p.days.map(d => d.date))
  for (const t of sim.trades || []) {
    const date = String(t.date).slice(0, 10)
    if (t.open || date <= lastFill || !window.has(date)) continue
    p.fills.push({ date, type: t.type, price: t.price, shares: t.shares ?? null, pnlPct: t.type === 'sell' ? (t.pnl ?? null) : null })
  }
  if (p.days.length >= SESSIONS) return decide(p, closes.slice(k, k + SESSIONS))
  return p
}

/** The verdict after the last session. Pure. `windowCloses` = the stock's closes over the program's days. */
function decide(program, windowCloses = []) {
  const { maxDrawdownPct } = require('./strategy-evidence')
  const eq = program.days.map(d => d.equity)
  const pnl = eq.length ? eq[eq.length - 1] - program.capital : 0
  const returnPct = +((pnl / program.capital) * 100).toFixed(2)
  const maxDd = maxDrawdownPct([program.capital, ...eq])
  const holdDd = maxDrawdownPct(windowCloses)
  const holdReturnPct = windowCloses.length >= 2 ? +(((windowCloses[windowCloses.length - 1] / windowCloses[0]) - 1) * 100).toFixed(2) : null
  const traded = program.fills.length > 0 || program.days.some(d => d.inPosition)
  const result = { returnPct, pnl: +pnl.toFixed(2), maxDrawdownPct: maxDd, holdMaxDrawdownPct: holdDd, holdReturnPct, fills: program.fills.length, sessions: program.days.length }
  let status, reason
  if (!traded) { status = 'no-trades'; reason = `It never held a position in ${program.days.length} sessions, so there is nothing to judge. (A rule already in a trade when it was enrolled waits for its next entry.)` }
  else if (!(pnl > 0)) { status = 'failed'; reason = `It ended ${returnPct}% after costs.` }
  else if (maxDd > holdDd && maxDd > 0) { status = 'failed'; reason = `It made ${returnPct}%, but its worst fall (${maxDd}%) was deeper than holding the stock (${holdDd}%).` }
  else { status = 'graduated'; reason = `It made ${returnPct}% after costs with a worst fall of ${maxDd}% (holding the stock: ${holdDd}%).` }
  return { ...program, status, reason, result, decidedAt: program.days[program.days.length - 1]?.date ?? null }
}

/** Keep every running program and the newest MAX_KEPT decided ones. */
function prune(store, { maxKept = MAX_KEPT } = {}) {
  const decided = Object.values(store.programs).filter(p => p.status !== 'running').sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt)))
  for (const p of decided.slice(maxKept)) delete store.programs[p.id]
  return store
}

/**
 * The nightly run: enrol, fetch each symbol once, advance every running program.
 * A symbol whose bars cannot be read is reported and its programs wait — a data
 * outage is never a failed strategy.
 */
async function run({ deps = {}, file = STORE_FILE, now = Date.now() } = {}) {
  const library = deps.library || require('./strategy-library')
  const fetchBars = deps.fetchBars || (s => require('./internal-api').fetchDailyBars(s, { range: '5y', headers: { 'x-internal': '1' }, timeoutMs: 25_000 }))
  const toSeries = deps.toSeries || require('./brain-evolution').toSeries
  const costBps = deps.costBps || (s => require('../utils/backtest').costBpsForSymbol(s))
  const store = read(file)
  const enrolled = enrol(store, library.readLibrary(), { now })
  const running = Object.values(store.programs).filter(p => p.status === 'running')
  const bySymbol = new Map()
  for (const p of running) { if (!bySymbol.has(p.symbol)) bySymbol.set(p.symbol, []); bySymbol.get(p.symbol).push(p) }
  const noData = [], decided = []
  let advanced = 0
  for (const [symbol, group] of bySymbol) {
    let bars = []
    try { bars = await fetchBars(symbol) } catch { bars = [] }
    if (!bars || bars.length < 60) { noData.push(symbol); continue }
    const series = toSeries(bars)
    for (const p of group) {
      let next
      try { next = step(p, series, { costBps: costBps(symbol), deps }) } catch (e) { next = { ...p, lastError: e.message }; }
      if (next.days.length > p.days.length) advanced += 1
      if (next.status !== 'running') decided.push({ id: next.id, status: next.status })
      store.programs[p.id] = next
    }
  }
  prune(store)
  store.lastRun = { at: new Date(now).toISOString(), enrolled: enrolled.length, running: running.length, advanced, decided: decided.length, noData }
  write(store, file)
  return store.lastRun
}

/** What the page shows. Pure over a store. */
function summary(store = read()) {
  const all = Object.values(store.programs)
  const by = s => all.filter(p => p.status === s)
  const view = p => ({
    id: p.id, symbol: p.symbol, name: p.name, strategy: p.spec?.strategy ?? null, origin: p.origin, startedAt: p.startedAt,
    status: p.status, reason: p.reason, decidedAt: p.decidedAt, result: p.result,
    sessions: p.days.length, of: SESSIONS,
    returnPct: p.days.length ? +(((p.days[p.days.length - 1].equity / p.capital) - 1) * 100).toFixed(2) : 0,
    inPosition: p.days.length ? !!p.days[p.days.length - 1].inPosition : false,
    curve: p.days.map(d => ({ time: d.date, value: +(((d.equity / p.capital) - 1) * 100).toFixed(2) })),
    fills: p.fills.slice(-6),
  })
  const decided = all.filter(p => p.status !== 'running')
  const judged = decided.filter(p => p.status !== 'no-trades')
  return {
    capital: CAPITAL, sessions: SESSIONS, lastRun: store.lastRun,
    counts: { running: by('running').length, graduated: by('graduated').length, failed: by('failed').length, noTrades: by('no-trades').length },
    // Of the programs that traded: how many graduated. Null until one has been judged.
    graduationRate: judged.length ? +(by('graduated').length / judged.length).toFixed(3) : null,
    running: by('running').sort((a, b) => b.days.length - a.days.length).map(view),
    decided: decided.sort((a, b) => String(b.decidedAt).localeCompare(String(a.decidedAt))).slice(0, 40).map(view),
  }
}

module.exports = { STORE_FILE, CAPITAL, SESSIONS, MAX_RUNNING, read, enrol, step, decide, prune, run, summary, newProgram, dayOf }
