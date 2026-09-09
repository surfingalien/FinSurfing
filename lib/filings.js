'use strict'
/**
 * lib/filings.js
 *
 * SEC EDGAR filings reader — keyless, no API key required.
 *
 * Fetches the latest 10-K / 10-Q / 8-K for a US ticker and extracts the
 * narrative sections (MD&A, Risk Factors) for AI summarisation. This is the
 * one piece of "deep research" FinSurfing didn't already cover:
 *   - routes/fundamentals.js  → the financial NUMBERS (FMP)
 *   - routes/earnings-call.js → earnings-call TRANSCRIPTS (FMP + Claude)
 *   - routes/market-intel.js  → Form 4 insider filings (EDGAR)
 *   - lib/filings.js (this)   → the 10-K/10-Q/8-K NARRATIVE (EDGAR)
 *
 * Network functions accept an injectable `fetchImpl` so the pure parsing
 * helpers can be unit-tested offline.
 *
 * EDGAR requires a descriptive User-Agent or it returns 403 — matches the
 * convention already used in routes/market-intel.js.
 */

const EDGAR_UA = 'FinSurfing/1.0 (contact@finsurfing.app)'

const TICKER_MAP_URL = 'https://www.sec.gov/files/company_tickers.json'
const SUBMISSIONS_URL = cik => `https://data.sec.gov/submissions/CIK${padCik(cik)}.json`

const NARRATIVE_FORMS = ['10-K', '10-Q', '8-K']

// Foreign private issuers (TSM, ASML, and most ADRs) never file a 10-K — they
// file 20-F annually and 6-K for interim events. Asking EDGAR for a 10-K from
// one of them returns nothing, which reads as "no filing" rather than "wrong
// form". Callers wanting full coverage of a mixed watchlist pass ALL_FORMS.
const FOREIGN_FORMS = ['20-F', '40-F', '6-K']
const ALL_FORMS     = [...NARRATIVE_FORMS, ...FOREIGN_FORMS]

// Token-saving: compact filing boilerplate/whitespace before the excerpt is
// sliced and sent to the model — more real signal per character, fewer tokens.
const { compactProse } = require('./compress')

// company_tickers.json is ~13k rows and changes rarely; cache it for a day.
const TICKER_CACHE_TTL = 24 * 60 * 60_000
let _cikIndex = { at: 0, map: null }
let _tickerCache = { at: 0, map: null }

// ── Pure helpers (unit-tested) ────────────────────────────────────────────────

/** Zero-pad a CIK to the 10-digit form EDGAR's submissions API expects. */
function padCik(cik) {
  return String(parseInt(cik, 10)).padStart(10, '0')
}

/**
 * Build the canonical archive URL for a filing's primary document.
 * EDGAR's Archives path uses the un-padded integer CIK and the accession
 * number with dashes stripped.
 */
function buildDocUrl(cik, accessionNumber, primaryDocument) {
  const cikInt = parseInt(cik, 10)
  const accNoDashes = String(accessionNumber).replace(/-/g, '')
  return `https://www.sec.gov/Archives/edgar/data/${cikInt}/${accNoDashes}/${primaryDocument}`
}

/**
 * Given the `filings.recent` object from the submissions API (parallel arrays,
 * newest first) pick the most recent filing whose form is in `forms`.
 * Returns null if none match.
 */
function pickLatestFiling(recent, forms = NARRATIVE_FORMS) {
  if (!recent || !Array.isArray(recent.form)) return null
  const want = new Set(forms)
  for (let i = 0; i < recent.form.length; i++) {
    if (want.has(recent.form[i])) {
      return {
        form: recent.form[i],
        filingDate: recent.filingDate?.[i] || null,
        reportDate: recent.reportDate?.[i] || null,
        accessionNumber: recent.accessionNumber?.[i] || null,
        primaryDocument: recent.primaryDocument?.[i] || null,
      }
    }
  }
  return null
}

/** Strip HTML/XBRL down to readable plain text. Pure, deterministic. */
function stripHtml(html) {
  if (!html) return ''
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#8217;|&rsquo;|&#39;/gi, "'")
    .replace(/&#8220;|&#8221;|&ldquo;|&rdquo;|&quot;/gi, '"')
    .replace(/&#8212;|&mdash;/gi, '—')
    .replace(/&[a-z0-9#]+;/gi, ' ')
    .replace(/[ \t ]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * Pull the narrative sections most useful for analysis out of full filing text.
 * 10-K/10-Q: "Risk Factors" (Item 1A) and "Management's Discussion" (Item 7 / 2).
 * 8-K and anything unmatched: return a leading excerpt of the whole document.
 * Always returns a non-empty string when given non-empty input.
 */
function extractSections(text, maxChars = 12000) {
  if (!text) return ''
  const anchors = [
    /item\s+1a[.\s]*risk\s+factors/i,
    /management['’]s\s+discussion\s+and\s+analysis/i,
  ]
  const chunks = []
  for (const re of anchors) {
    const m = text.match(re)
    if (m && m.index != null) {
      // grab a window starting at the heading
      chunks.push(text.slice(m.index, m.index + Math.floor(maxChars / anchors.length)))
    }
  }
  const joined = chunks.join('\n\n---\n\n').trim()
  if (joined.length >= 200) return joined.slice(0, maxChars)
  // No recognisable headings (common for 8-K) — fall back to a leading excerpt.
  return text.slice(0, maxChars).trim()
}

/**
 * Windows of text around each occurrence of `term`.
 *
 * extractSections() above anchors on Item 1A / MD&A, which is the right choice
 * for "what does this filing say about itself". It is the WRONG choice for
 * "does this filing name company X": customers, suppliers and partners are
 * named in Item 1 Business and the concentration notes, which those anchors
 * skip entirely.
 *
 * So this cuts around the term instead of around a heading. Two properties
 * matter downstream: the windows are small (cheap to classify) and each one is
 * literally quotable, so a claim made about it can be checked back against it
 * character-for-character.
 *
 * Overlapping hits are merged so a term repeated in one paragraph yields one
 * window rather than three near-identical ones.
 *
 * @returns {Array<{start:number, end:number, text:string, hits:number}>}
 */
function extractTermWindows(text, term, { radius = 600, maxWindows = 6 } = {}) {
  if (!text || !term) return []
  const needle = String(term).toLowerCase()
  const hay = text.toLowerCase()
  const spans = []

  let from = 0
  while (spans.length < 500) {
    const i = hay.indexOf(needle, from)
    if (i === -1) break
    spans.push([Math.max(0, i - radius), Math.min(text.length, i + needle.length + radius)])
    from = i + needle.length
  }
  if (!spans.length) return []

  const merged = []
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1]
    if (last && a <= last[1]) { last[1] = Math.max(last[1], b); last[2]++ }
    else merged.push([a, b, 1])
  }

  // Densest windows first: a passage naming the term repeatedly is more likely
  // to be a real relationship disclosure than a single passing mention.
  return merged
    .sort((x, y) => y[2] - x[2] || x[0] - y[0])
    .slice(0, maxWindows)
    .map(([start, end, hits]) => ({ start, end, hits, text: text.slice(start, end) }))
}

// ── Network functions (injectable fetch for tests) ────────────────────────────

async function edgarGet(url, { json = true, fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  const ctrl = new AbortController()
  const tid = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const r = await fetchImpl(url, {
      signal: ctrl.signal,
      headers: { 'User-Agent': EDGAR_UA, 'Accept': json ? 'application/json' : 'text/html' },
    })
    if (!r.ok) throw new Error(`EDGAR HTTP ${r.status}`)
    return json ? r.json() : r.text()
  } finally {
    clearTimeout(tid)
  }
}

/** Resolve a ticker to a zero-padded CIK via EDGAR's ticker map (cached 24h). */
async function resolveCik(symbol, { fetchImpl = fetch } = {}) {
  const sym = String(symbol || '').toUpperCase().trim()
  if (!sym) return null

  if (!_tickerCache.map || Date.now() - _tickerCache.at > TICKER_CACHE_TTL) {
    const raw = await edgarGet(TICKER_MAP_URL, { fetchImpl })
    const map = new Map()
    for (const k of Object.keys(raw || {})) {
      const row = raw[k]
      if (row?.ticker && row?.cik_str != null) map.set(String(row.ticker).toUpperCase(), row.cik_str)
    }
    _tickerCache = { at: Date.now(), map }
  }

  const cik = _tickerCache.map.get(sym)
  return cik != null ? padCik(cik) : null
}

/**
 * Reverse of resolveCik: padded CIK -> { symbol, name }.
 *
 * EDGAR search returns CIKs, not tickers, so every discovered company arrives
 * as a number that means nothing to the rest of the app. This closes the round
 * trip. `name` is the LEGAL entity name ("Meta Platforms, Inc."), which is also
 * what an exact-phrase filing search has to match on — a bare ticker like META
 * matches boilerplate everywhere.
 */
async function loadCikIndex({ fetchImpl = fetch } = {}) {
  if (_cikIndex.map && Date.now() - _cikIndex.at < TICKER_CACHE_TTL) return _cikIndex.map
  const raw = await edgarGet(TICKER_MAP_URL, { fetchImpl })
  const map = new Map()
  for (const k of Object.keys(raw || {})) {
    const row = raw[k]
    if (row?.cik_str == null || !row?.ticker) continue
    const padded = padCik(row.cik_str)
    // company_tickers.json lists one row per ticker, so a multi-class issuer
    // appears more than once. First wins — they share a CIK and a legal name.
    if (!map.has(padded)) map.set(padded, { symbol: String(row.ticker).toUpperCase(), name: row.title || null })
  }
  _cikIndex = { at: Date.now(), map }
  return map
}

/** Company metadata incl. SIC — the industry key peer discovery runs on. */
async function getCompanyMeta(symbol, { fetchImpl = fetch } = {}) {
  const cik = await resolveCik(symbol, { fetchImpl })
  if (!cik) return null
  const subs = await edgarGet(SUBMISSIONS_URL(cik), { fetchImpl })
  if (!subs) return null
  return {
    cik,
    symbol:         String(symbol).toUpperCase(),
    name:           subs.name || null,
    sic:            subs.sic || null,
    sicDescription: subs.sicDescription || null,
    // Derived, not guessed: if the company has ever filed a 20-F/40-F it is a
    // foreign private issuer and will never have a 10-K. Callers use this to
    // pick the right form list instead of getting an empty result and reading
    // it as "no filings".
    foreignIssuer:  (subs.filings?.recent?.form || []).some(f => f === '20-F' || f === '40-F'),
  }
}

/**
 * End-to-end: resolve the latest narrative filing for a symbol and return the
 * extracted text plus metadata, ready to hand to the AI router. Throws on
 * unknown ticker or fetch failure so the route can translate to HTTP status.
 */
/**
 * @param {object}  [o]
 * @param {boolean} [o.sections=true] Narrow the text to Item 1A / MD&A.
 *   Set FALSE when searching the filing for a term: those anchors deliberately
 *   skip Item 1 Business and the concentration notes, which is exactly where
 *   named customers, suppliers and partners appear. Section-narrowed text will
 *   silently omit the mention you are looking for.
 */
async function getLatestFiling(symbol, { forms = NARRATIVE_FORMS, fetchImpl = fetch, maxChars = 12000, sections = true } = {}) {
  const cik = await resolveCik(symbol, { fetchImpl })
  if (!cik) {
    const err = new Error(`No SEC CIK found for ${symbol} — EDGAR covers US-listed companies only`)
    err.status = 404
    throw err
  }

  const subs = await edgarGet(SUBMISSIONS_URL(cik), { fetchImpl })
  const filing = pickLatestFiling(subs?.filings?.recent, forms)
  if (!filing || !filing.primaryDocument) {
    const err = new Error(`No ${forms.join('/')} filing found for ${symbol}`)
    err.status = 404
    throw err
  }

  const url = buildDocUrl(cik, filing.accessionNumber, filing.primaryDocument)
  const html = await edgarGet(url, { json: false, fetchImpl, timeoutMs: 20_000 })
  const compacted = compactProse(stripHtml(html))
  const text = sections ? extractSections(compacted, maxChars) : compacted.slice(0, maxChars)

  return {
    symbol: symbol.toUpperCase(),
    cik,
    company: subs?.name || null,
    form: filing.form,
    filingDate: filing.filingDate,
    reportDate: filing.reportDate,
    accessionNumber: filing.accessionNumber,
    url,
    excerpt: text,
  }
}

module.exports = {
  EDGAR_UA,
  NARRATIVE_FORMS,
  FOREIGN_FORMS,
  ALL_FORMS,
  // pure helpers
  padCik,
  buildDocUrl,
  pickLatestFiling,
  stripHtml,
  extractSections,
  extractTermWindows,
  // network
  resolveCik,
  loadCikIndex,
  getCompanyMeta,
  getLatestFiling,
}
