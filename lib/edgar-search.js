'use strict'
/**
 * lib/edgar-search.js — finding companies that NAME a given company.
 *
 * lib/filings.js answers "what does ticker X's filing say". This answers the
 * question pointed the other way: "which filers mention X at all". That
 * inversion is the whole basis of supply-chain discovery, because a company
 * with material revenue from a customer is REQUIRED to disclose it — so the
 * relationship is written down, in a document with legal liability attached,
 * rather than inferred.
 *
 * Three discovery paths, deliberately separate because their evidence quality
 * differs by an order of magnitude:
 *
 *   fullTextSearch()  EDGAR full-text search. The primary path for suppliers,
 *                     customers and partners. Returns filings that literally
 *                     contain the anchor's legal name.
 *   findPeers()       Industry classification from lib/symbol-db. Deterministic,
 *                     local, no network, no model. Peers are a fact about
 *                     classification, not a discovered relationship.
 *   fundHolders()     N-PORT/N-CSR search — listed funds and BDCs holding an
 *                     anchor's equity. The only route to a PRIVATE anchor like
 *                     SpaceX or OpenAI, whose shares you otherwise cannot buy.
 *
 * NETWORK CAVEAT. efts.sec.gov (full-text search) is a different host from the
 * www.sec.gov / data.sec.gov endpoints lib/filings.js already uses in
 * production, and it was NOT reachable from the sandbox this was written in.
 * Every network function therefore takes an injectable `fetchImpl` and is unit
 * tested against recorded shapes, response parsing is tolerant of field
 * variation, and `searchAvailable()` probes the endpoint so callers can degrade
 * to the peer path instead of failing. Verify against the live endpoint before
 * relying on the supplier path.
 *
 * Tests: tests/edgar-search.test.js
 */

const { EDGAR_UA, padCik, loadCikIndex } = require('./filings')
const symbolDb = require('./symbol-db')

const FTS_URL = 'https://efts.sec.gov/LATEST/search-index'

/**
 * Private companies worth anchoring on, with the phrasings that actually
 * appear in filings.
 *
 * Aliases matter more than they look. A bare ticker is a terrible search term
 * — "META" matches document metadata, "INTC"/"Intel" matches "intelligence" —
 * so searches run on the LEGAL ENTITY NAME as an exact phrase. For public
 * anchors that name comes from EDGAR's own company_tickers.json; for private
 * ones there is no such record, so they are listed here.
 */
const PRIVATE_ANCHORS = {
  SPACEX:    { label: 'SpaceX',           aliases: ['SpaceX', 'Space Exploration Technologies'] },
  OPENAI:    { label: 'OpenAI',           aliases: ['OpenAI'] },
  ANDURIL:   { label: 'Anduril',          aliases: ['Anduril Industries', 'Anduril'] },
  STRIPE:    { label: 'Stripe',           aliases: ['Stripe, Inc.', 'Stripe'] },
  XAI:       { label: 'xAI',              aliases: ['xAI Corp', 'X.AI'] },
  DATABRICKS:{ label: 'Databricks',       aliases: ['Databricks'] },
  BLUEORIGIN:{ label: 'Blue Origin',      aliases: ['Blue Origin'] },
}

/** Aliases too generic to search on their own without swamping the results. */
const AMBIGUOUS_ALIASES = new Set(['meta', 'intel', 'stripe', 'block', 'oracle', 'arm', 'target'])

/**
 * Resolve an anchor (ticker OR private-company key) to its search identity.
 *
 * Public anchors resolve through EDGAR's own ticker->legal-name index, so the
 * phrase searched is the name the company files under rather than a guess.
 */
async function resolveAnchor(anchor, { fetchImpl = fetch } = {}) {
  const key = String(anchor || '').toUpperCase().trim().replace(/[^A-Z0-9.\-]/g, '')
  if (!key) return null

  const priv = PRIVATE_ANCHORS[key]
  if (priv) return { key, label: priv.label, aliases: priv.aliases, listed: false, cik: null }

  // Public: use the legal name EDGAR knows it by.
  try {
    const index = await loadCikIndex({ fetchImpl })
    for (const [cik, rec] of index.entries()) {
      if (rec.symbol === key) {
        const aliases = [rec.name, key].filter(Boolean)
        return { key, label: rec.name || key, aliases: dedupeAliases(aliases), listed: true, cik }
      }
    }
  } catch { /* fall through — an unresolvable anchor is not fatal */ }

  return { key, label: key, aliases: [key], listed: true, cik: null }
}

/**
 * Drop aliases that would return mostly noise.
 *
 * A single generic word ("Intel", "Meta") appears in filings that have nothing
 * to do with the company. Multi-word names are kept because the phrase itself
 * disambiguates. If filtering would leave nothing, the original list is kept —
 * a noisy search still beats no search, and downstream scoring will cull it.
 */
function dedupeAliases(aliases) {
  const seen = new Set()
  const out = []
  for (const a of aliases) {
    const t = String(a || '').trim()
    if (!t) continue
    const lower = t.toLowerCase()
    if (seen.has(lower)) continue
    seen.add(lower)
    if (t.split(/\s+/).length === 1 && AMBIGUOUS_ALIASES.has(lower)) continue
    out.push(t)
  }
  return out.length ? out : aliases.filter(Boolean).slice(0, 1)
}

// ── EDGAR full-text search ───────────────────────────────────────────────────

async function ftsGet(url, { fetchImpl = fetch, timeoutMs = 15_000 } = {}) {
  const res = await fetchImpl(url, {
    headers: { 'User-Agent': EDGAR_UA, 'Accept': 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  })
  if (!res.ok) {
    const err = new Error(`EDGAR full-text search returned HTTP ${res.status}`)
    err.status = res.status
    throw err
  }
  return res.json()
}

/**
 * Parse an EDGAR full-text search response into flat hits.
 *
 * Written tolerantly on purpose: the response is an Elasticsearch envelope
 * whose field names have moved before, and a discovery feature that hard-fails
 * on one renamed key is worse than one that returns fewer rows. Anything a hit
 * is missing comes back null and is scored down rather than throwing.
 */
function parseFtsHits(payload) {
  const hits = payload?.hits?.hits
  if (!Array.isArray(hits)) return []
  const out = []
  for (const h of hits) {
    const src = h?._source || {}
    const ciks = Array.isArray(src.ciks) ? src.ciks : (src.cik ? [src.cik] : [])
    if (!ciks.length) continue
    // _id is "<accession>:<document>" — the accession is what builds a URL.
    const accession = String(h._id || '').split(':')[0] || null
    const displayName = Array.isArray(src.display_names) ? src.display_names[0] : src.display_names
    out.push({
      cik:        padCik(ciks[0]),
      company:    typeof displayName === 'string' ? displayName.replace(/\s*\([^)]*\)\s*$/, '').trim() : null,
      form:       src.root_form || src.file_type || src.form || null,
      filedAt:    src.file_date || src.filed_at || null,
      accession,
    })
  }
  return out
}

/**
 * Search EDGAR full text for an exact phrase.
 * @returns {Promise<Array>} flat hits; [] when the endpoint is unavailable.
 */
async function fullTextSearch(phrase, { forms = ['10-K'], limit = 50, fetchImpl = fetch } = {}) {
  const q = String(phrase || '').trim()
  if (!q) return []
  const params = new URLSearchParams({ q: `"${q}"` })
  if (forms?.length) params.set('forms', forms.join(','))
  const payload = await ftsGet(`${FTS_URL}?${params}`, { fetchImpl })
  return parseFtsHits(payload).slice(0, limit)
}

/** Probe whether full-text search is reachable, so callers can degrade. */
async function searchAvailable({ fetchImpl = fetch } = {}) {
  try {
    await fullTextSearch('Apple Inc.', { forms: ['10-K'], limit: 1, fetchImpl })
    return true
  } catch {
    return false
  }
}

/**
 * Candidate filers mentioning an anchor, de-duplicated by CIK and mapped to
 * tickers. A CIK with no ticker is dropped: an unlisted filer is not something
 * anyone can act on, which is the entire point of the exercise.
 */
async function findMentions(anchorInfo, { forms = ['10-K', '20-F'], limitPerAlias = 40, fetchImpl = fetch } = {}) {
  const index = await loadCikIndex({ fetchImpl }).catch(() => new Map())
  const byCik = new Map()

  for (const alias of anchorInfo.aliases) {
    let hits = []
    try {
      hits = await fullTextSearch(alias, { forms, limit: limitPerAlias, fetchImpl })
    } catch { continue }  // one bad alias must not sink the others

    for (const h of hits) {
      if (anchorInfo.cik && h.cik === anchorInfo.cik) continue   // the anchor itself
      const listed = index.get(h.cik)
      if (!listed?.symbol) continue
      const prev = byCik.get(h.cik)
      if (prev) { prev.mentions++; continue }
      byCik.set(h.cik, {
        cik: h.cik, symbol: listed.symbol, company: h.company || listed.name,
        form: h.form, filedAt: h.filedAt, accession: h.accession,
        matchedAlias: alias, mentions: 1, discovery: 'filing_search',
      })
    }
  }
  return [...byCik.values()]
}

// ── Peer discovery (deterministic, local) ────────────────────────────────────

/**
 * Same-industry listed companies, from the local symbol database.
 *
 * No network, no model, no filing text: this is the SEC/FinanceDatabase
 * industry classification, and a peer edge claims nothing more than "these are
 * classified the same way". That is genuinely useful and genuinely weaker than
 * a disclosed supply relationship, which is why exposure-map scores it lower.
 */
function findPeers(symbol, { limit = 20, minCap = 'Small Cap' } = {}) {
  const sym = String(symbol || '').toUpperCase()
  const self = symbolDb.classify(sym)
  if (!self?.industry && !self?.sector) return { basis: null, peers: [] }

  const CAP_RANK = { 'Mega Cap': 6, 'Large Cap': 5, 'Mid Cap': 4, 'Small Cap': 3, 'Micro Cap': 2, 'Nano Cap': 1 }
  const minRank = CAP_RANK[minCap] ?? 3
  const basis = self.industry ? 'industry' : 'sector'
  const want = (self.industry || self.sector).toLowerCase()

  const all = symbolDb.stats()?.loaded === false ? [] : (symbolDb.sectorUniverse(self.sector, { size: 400, minCap }) || [])
  const peers = all
    .filter(s => s !== sym)
    .map(s => ({ symbol: s, rec: symbolDb.classify(s) }))
    .filter(({ rec }) => rec && (CAP_RANK[rec.marketCap] || 0) >= minRank)
    .filter(({ rec }) => basis === 'sector' || String(rec.industry || '').toLowerCase() === want)
    .slice(0, limit)
    .map(({ symbol: s, rec }) => ({
      symbol: s, company: rec.name || null, cik: null,
      relation: 'peer', discovery: `peer_${basis}`,
      form: 'peer_sic', filedAt: new Date().toISOString().slice(0, 10),
      quote: `Classified in the same ${basis} as ${sym}: ${rec.industry || rec.sector}.`,
    }))

  return { basis, self: { sector: self.sector, industry: self.industry }, peers }
}

module.exports = {
  FTS_URL, PRIVATE_ANCHORS, AMBIGUOUS_ALIASES,
  dedupeAliases, resolveAnchor,
  parseFtsHits, fullTextSearch, searchAvailable, findMentions,
  findPeers,
}
