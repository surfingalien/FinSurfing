'use strict'

/**
 * lib/filing-change.js — how much of a 10-K / 10-Q is new text.
 *
 * "Lazy Prices" (Cohen, Malloy & Nguyen, JF 2020): firms that substantially
 * rewrite their periodic filings, against a history of copy-pasting the last
 * one, go on to underperform firms that leave them unchanged — the market is
 * slow to read the change. The text is free (EDGAR) and the measure needs no
 * model: each filing's primary document, stripped of markup and of every
 * number (figures change every quarter by design), is reduced to the set of
 * its 5-word phrases, summarised as a 128-value MinHash signature. The share
 * of matching signature values estimates the Jaccard overlap of two filings'
 * phrase sets — how much of the text was carried over.
 *
 * Each filing is compared with the SAME form about a year earlier (10-K with
 * the previous 10-K, a 10-Q with the same quarter's 10-Q last year), so
 * seasonal differences between quarters are not counted as change. Only the
 * signature is stored, so each document is downloaded once. The backfill is
 * time-budgeted per run and fills oldest-first.
 *
 * Measured, not assumed: the similarity enters lib/factor-mining.js as one
 * more candidate (`filing_sim`, point-in-time by FILING date), facing the
 * same holdout and deflated-Sharpe gate as every other factor, and the
 * Research Desk shows a stock's latest value. Tests: tests/filing-change.test.js
 */

const path = require('path')

const SHINGLE = 5
const HASHES = 128
const FORMS = ['10-K', '10-Q']
const YEARS = 5
const PAIR_TOLERANCE_DAYS = 45
const DAY = 86_400_000

// Fixed multipliers/offsets for the MinHash family (deterministic across runs —
// a stored signature must stay comparable to one computed next year).
const A = Array.from({ length: HASHES }, (_, i) => ((Math.imul(i + 1, 0x9E3779B1) | 1) >>> 0))
const B = Array.from({ length: HASHES }, (_, i) => (Math.imul(i + 7, 0x85EBCA77) >>> 0))

function fnv1a(s) {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return h >>> 0
}

/** Words of a filing's text: lower-case letters only — every number and symbol is dropped. Pure. */
function words(text) {
  return String(text || '').toLowerCase().replace(/[^a-z\s]+/g, ' ').split(/\s+/).filter(w => w.length > 1)
}

/** MinHash signature of the text's 5-word phrases, or null for a text too short to judge. Pure. */
function signature(text, { k = SHINGLE } = {}) {
  const w = words(text)
  if (w.length < 200) return null
  const mins = new Array(HASHES).fill(0xffffffff)
  const seen = new Set()
  for (let i = 0; i + k <= w.length; i++) {
    const h0 = fnv1a(w.slice(i, i + k).join(' '))
    if (seen.has(h0)) continue
    seen.add(h0)
    for (let j = 0; j < HASHES; j++) {
      const v = (Math.imul(A[j], h0) + B[j]) >>> 0
      if (v < mins[j]) mins[j] = v
    }
  }
  return mins
}

/** Estimated phrase overlap of two signatures, 0–1. Pure. */
function similarity(a, b) {
  if (!a || !b || a.length !== b.length) return null
  let eq = 0
  for (let i = 0; i < a.length; i++) if (a[i] === b[i]) eq++
  return +(eq / a.length).toFixed(4)
}

/** The submissions `recent` arrays → this form family's filings, oldest first. Pure. */
function listFilings(recent, { forms = FORMS, since = null } = {}) {
  if (!recent?.form) return []
  const out = []
  for (let i = 0; i < recent.form.length; i++) {
    if (!forms.includes(recent.form[i])) continue
    const filed = recent.filingDate?.[i], period = recent.reportDate?.[i]
    if (!filed || !period || (since && filed < since)) continue
    out.push({ form: recent.form[i], filed, period, accession: recent.accessionNumber[i], doc: recent.primaryDocument[i] })
  }
  return out.sort((a, b) => a.filed.localeCompare(b.filed))
}

/** The same-form filing whose period ended about a year before this one's. Pure. */
function yearAgo(filing, filings) {
  const target = Date.parse(filing.period) - 365 * DAY
  let best = null
  for (const f of filings) {
    if (f.form !== filing.form || f.accession === filing.accession || !f.sig) continue
    const gap = Math.abs(Date.parse(f.period) - target)
    if (gap <= PAIR_TOLERANCE_DAYS * DAY && (!best || gap < best.gap)) best = { f, gap }
  }
  return best?.f || null
}

/** Fill `sim` / `vs` on every filing that has a signed year-ago pair. Mutates and returns the list. */
function scoreAll(filings) {
  for (const f of filings) {
    if (!f.sig || f.sim != null) continue
    const prev = yearAgo(f, filings)
    if (prev) { f.sim = similarity(f.sig, prev.sig); f.vs = prev.accession }
  }
  return filings
}

/** [{filed, form, sim}] oldest first, optionally one form only. Pure. */
const simsOf = (entry, forms = null) => (entry?.filings || [])
  .filter(f => f.sim != null && (!forms || forms.includes(f.form)))
  .map(f => ({ filed: f.filed, form: f.form, sim: f.sim }))

/** The latest similarity filed strictly before `day` and within ~13 months of it, or null. Pure. */
function simAsOf(sims, day) {
  let v = null
  for (const s of sims || []) {
    if (s.filed >= day) break
    v = s
  }
  return v && Date.parse(day) - Date.parse(v.filed) <= 400 * DAY ? v.sim : null
}

// ── Store + refresh ──────────────────────────────────────────────────────────
const STORE_FILE = path.join(require('./data-dir').DATA_DIR, 'filing-change.json')

function readStore(file = STORE_FILE) {
  try { return JSON.parse(require('fs').readFileSync(file, 'utf8')) } catch { return null }
}

function saveStore(store, file = STORE_FILE) {
  require('fs').mkdirSync(path.dirname(file), { recursive: true })
  require('./atomic-write').writeJsonAtomic(file, store, { space: 0 })
}

/**
 * List each symbol's 10-K/10-Q filings of the last YEARS, sign every one not yet
 * signed (oldest first across the whole universe, until `budgetMs` is spent), then
 * score. Network via the injected fetchImpl. Returns { store, signed, pending, errors }.
 */
async function refresh({ universe, fetchImpl = fetch, budgetMs = 20 * 60_000, now = new Date(), pauseMs = 150, save = true } = {}) {
  const filings = require('./filings')
  const store = readStore() || { symbols: {} }
  const since = new Date(now.getTime() - YEARS * 365 * DAY).toISOString().slice(0, 10)
  const errors = []
  for (const sym of universe) {
    try {
      const cik = await filings.resolveCik(sym, { fetchImpl })
      if (!cik) continue
      const subs = await filings.edgarGet(filings.SUBMISSIONS_URL(cik), { fetchImpl })
      // `recent` holds only the newest ~1,000 filings; a heavy filer (a bank's
      // prospectuses) pushes its older 10-K/10-Qs onto the paged files.
      const pages = [subs?.filings?.recent]
      for (const page of subs?.filings?.files || []) {
        if (page.filingTo && page.filingTo < since) continue
        pages.push(await filings.edgarGet(`https://data.sec.gov/submissions/${page.name}`, { fetchImpl }))
      }
      const seen = new Set()
      const listed = pages.flatMap(pg => listFilings(pg, { since }))
        .filter(f => (seen.has(f.accession) ? false : seen.add(f.accession)))
        .sort((a, b) => a.filed.localeCompare(b.filed))
      const entry = store.symbols[sym] || { cik, filings: [] }
      const known = new Map(entry.filings.map(f => [f.accession, f]))
      entry.cik = cik
      entry.filings = listed.map(f => known.get(f.accession) || f)
      store.symbols[sym] = entry
    } catch (e) { errors.push(`${sym}: ${e.message}`) }
    if (pauseMs) await new Promise(r => setTimeout(r, pauseMs))
  }
  const todo = Object.entries(store.symbols)
    .flatMap(([sym, e]) => e.filings.filter(f => !f.sig && !f.unreadable).map(f => ({ sym, cik: e.cik, f })))
    .sort((a, b) => a.f.filed.localeCompare(b.f.filed))
  const started = Date.now()
  let signed = 0
  for (const { sym, cik, f } of todo) {
    if (Date.now() - started > budgetMs) break
    try {
      const html = await filings.edgarGet(filings.buildDocUrl(cik, f.accession, f.doc), { json: false, fetchImpl, timeoutMs: 30_000 })
      const sig = signature(filings.stripHtml(html))
      if (sig) { f.sig = sig; signed++ } else f.unreadable = true
    } catch (e) { errors.push(`${sym} ${f.accession}: ${e.message}`) }
    if (pauseMs) await new Promise(r => setTimeout(r, pauseMs))
  }
  for (const e of Object.values(store.symbols)) scoreAll(e.filings)
  store.updatedAt = now.toISOString()
  const pending = Object.values(store.symbols).reduce((a, e) => a + e.filings.filter(f => !f.sig && !f.unreadable).length, 0)
  store.pending = pending
  if (save) saveStore(store)
  return { store, signed, pending, errors: errors.slice(0, 10) }
}

/**
 * { symbol → [{filed, form, sim}] } for factor mining — 10-K pairs only by default:
 * a 10-Q carries over less text than a 10-K, so mixing them would rank a stock
 * whose latest filing happens to be a 10-Q as a rewriter.
 */
function simsBySymbol(store = readStore(), { forms = ['10-K'] } = {}) {
  return Object.fromEntries(Object.entries(store?.symbols || {}).map(([s, e]) => [s, simsOf(e, forms)]).filter(([, v]) => v.length))
}

const MIN_PEERS = 10

/**
 * One stock's latest filing change vs the universe's latest values — for the
 * Research Desk dossier. Null when nothing is scored for it.
 */
function describeFor(symbol, store = readStore()) {
  const entry = store?.symbols?.[String(symbol || '').toUpperCase()]
  const { ordinal } = require('./price-regime')
  const parts = FORMS.map(form => {
    const last = simsOf(entry, [form]).at(-1)
    if (!last) return null
    // Compared with the same form only — a 10-Q carries over less text than a 10-K.
    const latest = Object.values(store.symbols).map(e => simsOf(e, [form]).at(-1)?.sim).filter(Number.isFinite).sort((a, b) => a - b)
    const pct = latest.length >= MIN_PEERS ? Math.round((latest.filter(v => v < last.sim).length / (latest.length - 1)) * 100) : null
    return `the ${form} filed ${last.filed} repeats about ${Math.round(last.sim * 100)}% of the ${form} a year earlier` +
      (pct != null ? ` (${ordinal(pct)} percentile of ${latest.length} tracked companies' latest ${form}s, median ${Math.round(latest[Math.floor(latest.length / 2)] * 100)}%)` : '')
  }).filter(Boolean)
  if (!parts.length) return null
  return `Filing change (Lazy Prices): ${parts.join('; ')}. Low = a substantial rewrite; numbers are excluded, so this measures carried-over wording. Whether it predicts returns here is decided by the factor test (10-K pairs), not assumed.`
}

module.exports = {
  SHINGLE, HASHES, FORMS, STORE_FILE,
  words, signature, similarity, listFilings, yearAgo, scoreAll, simsOf, simAsOf, readStore, saveStore, refresh, simsBySymbol, describeFor,
}
