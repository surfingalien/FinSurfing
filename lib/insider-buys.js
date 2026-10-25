'use strict'

/**
 * lib/insider-buys.js — which insider purchases carry information, measured.
 *
 * Cohen, Malloy & Pomorski ("Decoding Inside Information", JF 2012) split
 * insider trades into ROUTINE ones — an insider who trades in the same
 * calendar month year after year (bonus timing, stock plans) — and
 * OPPORTUNISTIC ones (everyone else). The opportunistic trades held all the
 * predictive power (~82bp/month abnormal); routine ones earned about zero.
 * A later line of work finds that several insiders buying at once (a
 * CLUSTER) adds information. The app fetched insider trades only as prompt
 * text and never tested them.
 *
 * Source: SEC's quarterly Form 3/4/5 data sets (keyless, every filer). Only
 * open-market purchases (code P) are kept. Excluded as uninformative by
 * construction: trades flagged as made under a 10b5-1 plan (AFF10B5ONE, in
 * filings since 2025) and plan-like batches — PLAN_BATCH or more insiders
 * buying one stock on one day at one price (an employee stock plan, not a
 * decision). Our adaptation of the routine test, buy side only: an insider is
 * routine for a purchase when they bought the same stock in the same calendar
 * month in each of the three prior years; a purchase is classifiable only
 * when the stored data covers those three years.
 *
 * Event = the FILING date (when it became public); entry the open of the
 * next session, exit HOLD sessions later, net of COST_BPS (insider buying is
 * mostly small caps, so a wider cost than the large-cap studies), minus IWM
 * over the same sessions. Month-clustered t; a strategy is `validated` only
 * when positive on the older 70% AND the newest 30% of events with t ≥ 2.
 * Routine and plan buys are the controls. Tests: tests/insider-buys.test.js
 */

const path = require('path')
const { summarize, welchT, eventReturn } = require('./pead')

const HOLD = 20
const COST_BPS = 30
const BENCH = 'IWM'
const QUARTERS = 24
const MIN_VALUE = 10_000
const MIN_PRICE = 5
const PLAN_BATCH = 5
const CLUSTER_MIN = 3
const CLUSTER_DAYS = 30
const DEDUP_DAYS = 30
const MAX_SYMBOLS = 200
const MIN_EVENTS = 30
const TRAIN_FRAC = 0.7
const DAY = 86_400_000

const MONTHS = { JAN: '01', FEB: '02', MAR: '03', APR: '04', MAY: '05', JUN: '06', JUL: '07', AUG: '08', SEP: '09', OCT: '10', NOV: '11', DEC: '12' }

/** "31-JUL-2026" → "2026-07-31"; ISO passes through; anything else → null. */
function isoDate(s) {
  const t = String(s || '').trim()
  if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10)
  const m = t.match(/^(\d{1,2})-([A-Z]{3})-(\d{4})$/i)
  return m && MONTHS[m[2].toUpperCase()] ? `${m[3]}-${MONTHS[m[2].toUpperCase()]}-${m[1].padStart(2, '0')}` : null
}

function parseTsv(text) {
  const lines = String(text).split(/\r?\n/)
  const head = lines[0].split('\t')
  const out = []
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue
    const c = lines[i].split('\t'), o = {}
    for (let j = 0; j < head.length; j++) o[head[j]] = c[j] ?? ''
    out.push(o)
  }
  return out
}

function roleOf(rel) {
  const r = String(rel || '')
  return /Officer/i.test(r) ? 'officer' : /Director/i.test(r) ? 'director' : /TenPercent/i.test(r) ? '10%' : 'other'
}

/**
 * One quarter's open-market purchases, one row per filing:
 * [filed, traded, symbol, ownerCik, role, title, shares, price, plan, accession].
 * Amendments (4/A) are skipped — they restate an original already counted.
 */
function purchasesFromFiles({ submission, owners, trans }) {
  const sub = new Map(parseTsv(submission).map(r => [r.ACCESSION_NUMBER, r]))
  const own = new Map()
  for (const r of parseTsv(owners)) if (!own.has(r.ACCESSION_NUMBER)) own.set(r.ACCESSION_NUMBER, r)   // first reporting owner of a joint filing
  const acc = new Map()
  for (const t of parseTsv(trans)) {
    if (t.TRANS_CODE !== 'P' || t.TRANS_ACQUIRED_DISP_CD !== 'A') continue
    const s = sub.get(t.ACCESSION_NUMBER)
    if (!s || s.DOCUMENT_TYPE !== '4') continue
    const shares = Number(t.TRANS_SHARES), price = Number(t.TRANS_PRICEPERSHARE)
    if (!(shares > 0 && price > 0)) continue
    const a = acc.get(t.ACCESSION_NUMBER) || { shares: 0, cost: 0, traded: null }
    a.shares += shares; a.cost += shares * price
    const d = isoDate(t.TRANS_DATE)
    if (d && (!a.traded || d < a.traded)) a.traded = d
    acc.set(t.ACCESSION_NUMBER, a)
  }
  const rows = []
  for (const [id, a] of acc) {
    const s = sub.get(id), o = own.get(id)
    const symbol = String(s.ISSUERTRADINGSYMBOL || '').trim().toUpperCase()
    const filed = isoDate(s.FILING_DATE)
    if (!symbol || !/^[A-Z.\-]{1,6}$/.test(symbol) || !filed || !o) continue
    const plan = /^(1|true)$/i.test(String(s.AFF10B5ONE || '').trim()) ? 1 : 0
    rows.push([filed, a.traded || filed, symbol, String(o.RPTOWNERCIK || '').replace(/^0+/, ''), roleOf(o.RPTOWNER_RELATIONSHIP),
      String(o.RPTOWNER_TITLE || '').slice(0, 30), Math.round(a.shares), +(a.cost / a.shares).toFixed(4), plan, id])
  }
  return rows
}

const asObj = r => ({ filed: r[0], traded: r[1], symbol: r[2], owner: r[3], role: r[4], title: r[5], shares: r[6], price: r[7], plan: !!r[8], accession: r[9], value: r[6] * r[7] })

/**
 * Label every purchase: plan / routine / opportunistic / unclassified. `coverageStart`
 * is the first day the stored data covers (a routine test needs three prior years). Pure.
 */
function classify(rows, { coverageStart }) {
  const buys = rows.map(asObj).filter(b => b.price >= MIN_PRICE && b.value >= MIN_VALUE)
  // Plan-like batches: many insiders, one stock, one day, one price.
  const batch = new Map()
  for (const b of buys) {
    const k = `${b.symbol}|${b.traded}`
    if (!batch.has(k)) batch.set(k, [])
    batch.get(k).push(b)
  }
  const planLike = new Set()
  for (const list of batch.values()) {
    const owners = new Set(list.map(b => b.owner))
    if (owners.size < PLAN_BATCH) continue
    const prices = list.map(b => b.price).sort((a, b) => a - b), mid = prices[Math.floor(prices.length / 2)]
    const same = list.filter(b => Math.abs(b.price / mid - 1) <= 0.005)
    if (new Set(same.map(b => b.owner)).size >= PLAN_BATCH) for (const b of same) planLike.add(b)
  }
  const months = new Set(buys.map(b => `${b.owner}|${b.symbol}|${b.traded.slice(0, 7)}`))
  for (const b of buys) {
    const y = Number(b.traded.slice(0, 4)), m = b.traded.slice(5, 7)
    if (b.plan || planLike.has(b)) b.cls = 'plan'
    else if (!coverageStart || coverageStart > `${y - 3}-01-01`) b.cls = 'unclassified'
    else b.cls = [1, 2, 3].every(k => months.has(`${b.owner}|${b.symbol}|${y - k}-${m}`)) ? 'routine' : 'opportunistic'
  }
  return buys.sort((a, b) => a.filed.localeCompare(b.filed))
}

/**
 * Events per stock: one per group per DEDUP_DAYS, dated by filing. Groups:
 * opportunistic, routine, plan, and cluster (≥ CLUSTER_MIN insiders with
 * non-plan buys traded inside CLUSTER_DAYS — needs no trading history). Pure.
 */
function buildEvents(classified) {
  const bySym = new Map()
  for (const b of classified) {
    if (!bySym.has(b.symbol)) bySym.set(b.symbol, [])
    bySym.get(b.symbol).push(b)
  }
  const events = []
  for (const [symbol, list] of bySym) {
    const last = {}
    const emit = (group, b, extra = {}) => {
      if (last[group] && Date.parse(b.filed) - Date.parse(last[group]) < DEDUP_DAYS * DAY) return
      last[group] = b.filed
      events.push({ symbol, date: b.filed, group, role: b.role, value: Math.round(b.value), ...extra })
    }
    for (let i = 0; i < list.length; i++) {
      const b = list[i]
      if (b.cls === 'opportunistic' || b.cls === 'routine' || b.cls === 'plan') emit(b.cls, b)
      if (b.cls === 'plan') continue
      const from = Date.parse(b.traded) - CLUSTER_DAYS * DAY
      const owners = new Set(list.slice(0, i + 1).filter(x => x.cls !== 'plan' && Date.parse(x.traded) >= from && x.filed <= b.filed).map(x => x.owner))
      if (owners.size >= CLUSTER_MIN) emit('cluster', b, { insiders: owners.size })
    }
  }
  return events.sort((a, b) => a.date.localeCompare(b.date))
}

/** Walk-forward verdict for going long one group. Pure. */
function verdictFor(events, { trainFrac = TRAIN_FRAC, minEvents = MIN_EVENTS } = {}) {
  const ev = events.filter(e => Number.isFinite(e.abn)).sort((a, b) => a.entryDate.localeCompare(b.entryDate))
  const cut = Math.floor(ev.length * trainFrac)
  const train = summarize(ev.slice(0, cut)), holdout = summarize(ev.slice(cut)), all = summarize(ev)
  let verdict, reason
  if (ev.length < minEvents || holdout.n < 10) {
    verdict = 'insufficient'; reason = `${ev.length} events with a measured outcome (need ${minEvents}, with 10 in the newest 30%)`
  } else if (train.meanAbn > 0 && holdout.meanAbn > 0 && all.t != null && all.t >= 2) {
    verdict = 'validated'; reason = `beat ${BENCH} after costs on both the older and the newest events (month-clustered t=${all.t})`
  } else if (train.meanAbn > 0 || holdout.meanAbn > 0) {
    verdict = 'mixed'; reason = `positive on only ${train.meanAbn > 0 ? 'the older' : 'the newest'} events, or not beyond chance (t=${all.t})`
  } else {
    verdict = 'rejected'; reason = `did not beat ${BENCH} after costs`
  }
  return { train, holdout, all, verdict, reason }
}

/** The study over priced events. Pure. */
function study(events) {
  const g = name => events.filter(e => e.group === name && Number.isFinite(e.abn))
  const opp = g('opportunistic'), rou = g('routine'), plan = g('plan'), clu = g('cluster')
  return {
    params: { holdDays: HOLD, costBps: COST_BPS, benchmark: BENCH, minValue: MIN_VALUE, minPrice: MIN_PRICE, clusterMin: CLUSTER_MIN, clusterDays: CLUSTER_DAYS, entry: 'open after the Form 4 filing date' },
    events: events.filter(e => Number.isFinite(e.abn)).length,
    groups: { opportunistic: summarize(opp), routine: summarize(rou), plan: summarize(plan), cluster: summarize(clu) },
    strategies: { opportunistic: verdictFor(opp), cluster: verdictFor(clu) },
    // The paper's comparison: does opportunistic beat routine?
    oppVsRoutine: { spread: opp.length && rou.length ? +(summarize(opp).meanAbn - summarize(rou).meanAbn).toFixed(2) : null, t: welchT(opp, rou) },
  }
}

// ── Store ────────────────────────────────────────────────────────────────────
const DATA_DIR = require('./data-dir').DATA_DIR
const STORE_FILE = path.join(DATA_DIR, 'insider-buys.json')
const STUDY_FILE = path.join(DATA_DIR, 'insider-study.json')

// The purchase store is several MB and every dossier reads it: parse once per file version.
const _reads = new Map()
const readJson = (f, { fresh = false } = {}) => {
  try {
    const m = require('fs').statSync(f).mtimeMs, hit = _reads.get(f)
    if (!fresh && hit?.m === m) return hit.v
    const v = JSON.parse(require('fs').readFileSync(f, 'utf8'))
    if (!fresh) _reads.set(f, { m, v })
    return v
  } catch { return null }
}
const writeJson = (f, v) => { require('fs').mkdirSync(path.dirname(f), { recursive: true }); require('./atomic-write').writeJsonAtomic(f, v, { space: 0 }) }
const readStore = (f = STORE_FILE) => readJson(f)
const readStudy = (f = STUDY_FILE) => readJson(f)

/** Quarter keys from newest-possible back: ['2026q3', '2026q2', …]. */
function quarterKeys(now, n) {
  let y = now.getUTCFullYear(), q = Math.floor(now.getUTCMonth() / 3) + 1
  const out = []
  for (let k = 0; k < n + 1; k++) {           // +1: the current quarter is never published yet
    q -= 1; if (q === 0) { q = 4; y -= 1 }
    out.push(`${y}q${q}`)
  }
  return out
}

const quarterStart = key => `${key.slice(0, 4)}-${String((Number(key.slice(5)) - 1) * 3 + 1).padStart(2, '0')}-01`

async function downloadQuarter(key, { fetchImpl = fetch } = {}) {
  const { EDGAR_UA } = require('./filings')
  for (const dir of ['datastandardsinnovation', 'structureddata']) {
    const r = await fetchImpl(`https://www.sec.gov/files/${dir}/data/insider-transactions-data-sets/${key}_form345.zip`, {
      headers: { 'User-Agent': EDGAR_UA }, signal: AbortSignal.timeout(120_000),
    })
    if (r.status === 404) continue
    if (!r.ok) throw new Error(`${key}: HTTP ${r.status}`)
    const files = require('./zip-read').readZip(Buffer.from(await r.arrayBuffer()), n => /^(SUBMISSION|REPORTINGOWNER|NONDERIV_TRANS)\.tsv$/.test(n))
    if (!files['SUBMISSION.tsv'] || !files['NONDERIV_TRANS.tsv']) throw new Error(`${key}: zip lacks the expected tables`)
    return purchasesFromFiles({ submission: files['SUBMISSION.tsv'].toString('utf8'), owners: files['REPORTINGOWNER.tsv']?.toString('utf8') || '', trans: files['NONDERIV_TRANS.tsv'].toString('utf8') })
  }
  return null   // not published yet
}

const prevQuarter = key => (key.endsWith('q1') ? `${Number(key.slice(0, 4)) - 1}q4` : `${key.slice(0, 5)}${Number(key.slice(5)) - 1}`)

/**
 * Add any missing published quarters (each is downloaded once), keep the newest
 * `quarters`. Coverage starts at the oldest quarter of the newest UNBROKEN run:
 * a quarter that failed to download would otherwise hide a routine buyer's
 * history and make them look opportunistic.
 */
async function refreshStore({ fetchImpl = fetch, quarters = QUARTERS, now = new Date(), save = true } = {}) {
  const store = readJson(STORE_FILE, { fresh: true }) || { quarters: {} }   // mutated below: never the shared cached copy
  const added = [], errors = []
  let have = 0
  for (const k of quarterKeys(now, quarters)) {   // newest first; the newest may not be published yet
    if (have >= quarters) break
    if (store.quarters[k]) { have++; continue }
    try {
      const rows = await downloadQuarter(k, { fetchImpl })
      if (rows) { store.quarters[k] = rows; added.push(k); have++ }
    } catch (e) { errors.push(e.message) }
  }
  const keep = Object.keys(store.quarters).sort().slice(-quarters)
  store.quarters = Object.fromEntries(keep.map(k => [k, store.quarters[k]]))
  store.updatedAt = now.toISOString()
  let first = keep.at(-1)
  while (first && store.quarters[prevQuarter(first)]) first = prevQuarter(first)
  store.coverageStart = first ? quarterStart(first) : null
  if (save && added.length) writeJson(STORE_FILE, store)
  return { store, added, errors }
}

let _cache = null
/** Classified purchases of the stored quarters (memoised per store version). */
function classifiedFrom(store) {
  if (!store?.quarters) return []
  const key = `${store.updatedAt}|${store.coverageStart}|${Object.keys(store.quarters).length}`
  if (_cache?.at === key) return _cache.rows
  const rows = classify(Object.values(store.quarters).flat(), { coverageStart: store.coverageStart })
  _cache = { at: key, rows }
  return rows
}

/**
 * Weekly job: refresh the quarters, build events, price the most-bought names
 * (MAX_SYMBOLS by event count — chosen by activity, never by outcome), run the
 * study, persist. A run that prices too few names keeps the stored study.
 */
async function runStudy({ fetchBars, fetchImpl = fetch, concurrency = 3, maxSymbols = MAX_SYMBOLS, minUniverse = 20, save = true, now = new Date() } = {}) {
  const { store, added, errors } = await refreshStore({ fetchImpl, now, save })
  const classified = classifiedFrom(store)
  const events = buildEvents(classified)
  const counts = new Map()
  for (const e of events) if (e.group === 'opportunistic' || e.group === 'cluster') counts.set(e.symbol, (counts.get(e.symbol) || 0) + 1)
  const universe = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, maxSymbols).map(([s]) => s)
  const benchBars = await fetchBars(BENCH)
  if (!benchBars?.length) throw new Error(`no ${BENCH} bars — cannot measure abnormal returns`)
  const benchByDay = new Map(benchBars.map(b => [new Date(b.t).toISOString().slice(0, 10), b]))
  const bars = new Map(), queue = [...universe], missing = []
  await Promise.all(Array.from({ length: concurrency }, async () => {
    while (queue.length) {
      const s = queue.shift()
      try { const b = await fetchBars(s); if (b?.length) bars.set(s, b); else missing.push(s) } catch { missing.push(s) }
    }
  }))
  if (bars.size < Math.min(minUniverse, universe.length)) throw new Error(`only ${bars.size} of ${universe.length} names had price history — the stored study is kept`)
  const priced = events.filter(e => bars.has(e.symbol))
    .map(e => ({ ...e, ...(eventReturn(bars.get(e.symbol), e.date, { hold: HOLD, benchByDay, costBps: COST_BPS }) || {}) }))
  const out = {
    ranAt: now.toISOString(), quarters: Object.keys(store.quarters).length, coverageStart: store.coverageStart,
    added, errors: errors.slice(0, 5), purchases: classified.length,
    classes: classified.reduce((a, b) => ((a[b.cls] = (a[b.cls] || 0) + 1), a), {}),
    universe: bars.size, requested: universe.length, missing: missing.slice(0, 20),
    ...study(priced),
    caveats: [
      'Routine is our buy-side adaptation of Cohen-Malloy-Pomorski: same stock, same calendar month, each of the three prior years.',
      `The priced list is the ${maxSymbols} stocks with the most opportunistic or cluster buys — chosen by activity, not outcome — so it leans to small caps that insiders buy often.`,
      'Entry is the open after the filing date because the time of filing is not known.',
      'Today\'s tickers are used; a stock that was delisted is missing (survivorship).',
    ],
  }
  if (save) writeJson(STUDY_FILE, out)
  return out
}

/**
 * Recent purchases in one stock, classified, plus the study's verdicts — for the
 * Research Desk dossier. Null when the stock has none in `days`.
 */
function recentFor(symbol, { store = readStore(), studyOut = readStudy(), days = 90, now = new Date() } = {}) {
  const sym = String(symbol || '').toUpperCase()
  const since = new Date(now.getTime() - days * DAY).toISOString().slice(0, 10)
  const list = classifiedFrom(store).filter(b => b.symbol === sym && b.filed >= since)
  if (!list.length) return null
  const cluster = new Set(list.filter(b => b.cls !== 'plan' && b.traded >= new Date(now.getTime() - CLUSTER_DAYS * DAY).toISOString().slice(0, 10)).map(b => b.owner)).size >= CLUSTER_MIN
  const by = c => list.filter(b => b.cls === c)
  return {
    days, purchases: list.length,
    opportunistic: by('opportunistic').length, routine: by('routine').length, plan: by('plan').length, unclassified: by('unclassified').length,
    cluster,
    value: Math.round(list.filter(b => b.cls !== 'plan').reduce((a, b) => a + b.value, 0)),
    latest: list.slice(-3).reverse().map(b => ({ filed: b.filed, role: b.role, title: b.title, value: Math.round(b.value), cls: b.cls })),
    verdicts: studyOut?.strategies ? { opportunistic: studyOut.strategies.opportunistic.verdict, cluster: studyOut.strategies.cluster.verdict, ranAt: studyOut.ranAt } : null,
  }
}

const VERDICT_WORDS = { validated: 'beat IWM after costs on older and newer events', mixed: 'mixed — not beyond chance', rejected: 'did not beat IWM after costs', insufficient: 'not enough events yet' }

/** One dossier sentence from recentFor(). Pure. */
function describeRecent(r) {
  if (!r) return null
  const parts = []
  if (r.opportunistic) parts.push(`${r.opportunistic} opportunistic`)
  if (r.routine) parts.push(`${r.routine} routine`)
  if (r.plan) parts.push(`${r.plan} plan/stock-plan`)
  if (r.unclassified) parts.push(`${r.unclassified} without enough history to classify`)
  const latest = r.latest.map(b => `${b.filed} ${b.title || b.role} $${Math.round(b.value / 1000)}k (${b.cls})`).join('; ')
  const v = r.verdicts
  return `Insider open-market purchases in the last ${r.days} days (SEC Form 4): ${parts.join(', ')}; $${Math.round(r.value / 1000)}k excluding plan buys${r.cluster ? `; a CLUSTER — ${CLUSTER_MIN}+ insiders bought within ${CLUSTER_DAYS} days` : ''}. Latest: ${latest}.` +
    (v ? ` Measured on this app's study (${HOLD} sessions after filing, vs IWM): opportunistic buys ${VERDICT_WORDS[v.opportunistic] || v.opportunistic}; cluster buys ${VERDICT_WORDS[v.cluster] || v.cluster}.` : ' The weekly study has not run yet, so whether these buys predict anything here is unmeasured.')
}

module.exports = {
  describeRecent,
  HOLD, COST_BPS, BENCH, QUARTERS, MIN_VALUE, MIN_PRICE, PLAN_BATCH, CLUSTER_MIN, MIN_EVENTS, STORE_FILE, STUDY_FILE,
  isoDate, parseTsv, purchasesFromFiles, classify, buildEvents, verdictFor, study, quarterKeys, quarterStart,
  downloadQuarter, refreshStore, classifiedFrom, runStudy, recentFor, readStore, readStudy,
}
