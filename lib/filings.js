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

// company_tickers.json is ~13k rows and changes rarely; cache it for a day.
const TICKER_CACHE_TTL = 24 * 60 * 60_000
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
 * End-to-end: resolve the latest narrative filing for a symbol and return the
 * extracted text plus metadata, ready to hand to the AI router. Throws on
 * unknown ticker or fetch failure so the route can translate to HTTP status.
 */
async function getLatestFiling(symbol, { forms = NARRATIVE_FORMS, fetchImpl = fetch, maxChars = 12000 } = {}) {
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
  const text = extractSections(stripHtml(html), maxChars)

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
  // pure helpers
  padCik,
  buildDocUrl,
  pickLatestFiling,
  stripHtml,
  extractSections,
  // network
  resolveCik,
  getLatestFiling,
}
