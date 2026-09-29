'use strict'
/**
 * lib/symbol-search.js
 *
 * Merge + rank for GET /api/search.
 *
 * The endpoint used to be a first-non-empty-wins cascade:
 *
 *     const fh = await getFinnhubSearch(q, keys)
 *     if (fh?.quotes?.length) return ...        // ← FMP/TD/AV/local never run
 *
 * So ONE result from the first provider silenced every other source, including
 * the 300k-symbol local FinanceDatabase index that costs nothing to query. That
 * is why "search is not happening for all stocks": Finnhub's free search is
 * broad but thin on mutual funds and many ETFs, and FMP — the provider this
 * repo relies on for NAV quotes (`KNOWN_MUTUAL_FUNDS → FMP only`) — was only
 * ever consulted when Finnhub returned literally zero rows.
 *
 * A second, quieter defect: every provider sliced its own list (Finnhub 10,
 * FMP limit=10, TD 8, AV 8) BEFORE `rankSearchQuotes` ran. Ranking after a
 * slice cannot recover an exact ticker match that sat at position 11 — it was
 * already gone. Here the slice happens LAST, after merging and ranking, so the
 * best match across all providers survives by construction.
 *
 * Pure: no I/O, no network. The route owns fetching; this owns the answer.
 * Tests: tests/symbol-search.test.js
 */

/** Provider precedence when the same symbol comes back from several sources. */
const PROVIDER_RANK = ['finnhub', 'fmp', 'twelvedata', 'alphavantage', 'symboldb']

const DEFAULT_LIMIT = 10
const MAX_LIMIT     = 50

/**
 * Match quality, highest first. Deliberately coarse — the tiebreakers below do
 * the fine sorting, and a score with too many levels just moves arbitrary
 * choices somewhere harder to see.
 */
const EXACT_SYMBOL   = 100
const SYMBOL_PREFIX  = 80
const NAME_WORD      = 60
const SYMBOL_INFIX   = 40
const NAME_INFIX     = 20

const str = (v) => (typeof v === 'string' ? v.trim() : '')

/** Escape a user query before it reaches a RegExp — it is arbitrary input. */
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function scoreQuote(quote, needle) {
  const symbol = str(quote?.symbol).toUpperCase()
  const name   = `${str(quote?.shortname)} ${str(quote?.longname)}`.toUpperCase()
  if (!symbol) return 0

  if (symbol === needle) return EXACT_SYMBOL
  if (symbol.startsWith(needle)) return SYMBOL_PREFIX
  // A name match on a WORD boundary ("APPLE" in "Apple Inc") beats a symbol
  // that merely contains the letters ("XAAPLY"), which is almost never wanted.
  if (name && new RegExp(`\\b${escapeRe(needle)}`).test(name)) return NAME_WORD
  if (symbol.includes(needle)) return SYMBOL_INFIX
  if (name.includes(needle)) return NAME_INFIX
  return 0
}

/**
 * Fold a duplicate into the row already held, field by field. The higher-ranked
 * provider wins a field it actually filled; a blank never overwrites a value,
 * so a sparse Finnhub row still picks up FMP's exchange and name.
 */
function foldQuote(into, next) {
  const out = { ...into }
  for (const field of ['symbol', 'shortname', 'longname', 'quoteType', 'exchange']) {
    if (!str(out[field]) && str(next[field])) out[field] = next[field]
  }
  // Track every source that returned the symbol — useful in the response and
  // for spotting a provider that has gone quiet.
  const sources = new Set([...(out.sources || []), ...(next.sources || [])])
  out.sources = [...sources]
  return out
}

/**
 * Merge per-provider result lists into one ranked, deduped list.
 *
 * @param {Array<{provider: string, quotes: object[]}>} lists
 * @param {string} q       the raw user query
 * @param {object} [opts]
 * @param {number} [opts.limit]
 * @returns {object[]}     ranked quotes, at most `limit`
 */
function mergeQuotes(lists, q, { limit = DEFAULT_LIMIT } = {}) {
  const needle = str(q).toUpperCase()
  if (!needle) return []

  const cap = Math.max(1, Math.min(MAX_LIMIT, Number(limit) || DEFAULT_LIMIT))
  const bySymbol = new Map()

  const ordered = (Array.isArray(lists) ? lists : [])
    .filter(l => l && Array.isArray(l.quotes))
    .slice()
    .sort((a, b) => providerRank(a.provider) - providerRank(b.provider))

  for (const { provider, quotes } of ordered) {
    for (const raw of quotes) {
      const symbol = str(raw?.symbol).toUpperCase()
      if (!symbol) continue
      const quote = {
        symbol,
        shortname: str(raw.shortname) || str(raw.longname),
        longname:  str(raw.longname)  || str(raw.shortname),
        quoteType: str(raw.quoteType) || 'EQUITY',
        exchange:  str(raw.exchange),
        sources:   [provider],
      }
      bySymbol.set(symbol, bySymbol.has(symbol) ? foldQuote(bySymbol.get(symbol), quote) : quote)
    }
  }

  return [...bySymbol.values()]
    .map(quote => ({ quote, score: scoreQuote(quote, needle) }))
    .filter(x => x.score > 0)
    .sort((a, b) =>
      b.score - a.score ||
      // Corroboration is a real signal: a symbol two providers both returned is
      // likelier to be the one meant than a single provider's long-tail row.
      b.quote.sources.length - a.quote.sources.length ||
      a.quote.symbol.length - b.quote.symbol.length ||
      a.quote.symbol.localeCompare(b.quote.symbol))
    .slice(0, cap)
    .map(x => x.quote)
}

function providerRank(provider) {
  const i = PROVIDER_RANK.indexOf(str(provider).toLowerCase())
  return i === -1 ? PROVIDER_RANK.length : i
}

/** Map a symbol-db record to the shared quote shape the route returns. */
const DB_CLASS_TO_TYPE = { equity: 'EQUITY', etf: 'ETF', fund: 'FUND', crypto: 'CRYPTO' }

function fromSymbolDb(records) {
  return (Array.isArray(records) ? records : []).map(r => ({
    symbol:    r.symbol,
    shortname: r.name,
    longname:  r.name,
    quoteType: DB_CLASS_TO_TYPE[r.assetClass] || 'EQUITY',
    exchange:  r.exchange || '',
  }))
}

module.exports = {
  PROVIDER_RANK, DEFAULT_LIMIT, MAX_LIMIT,
  EXACT_SYMBOL, SYMBOL_PREFIX, NAME_WORD, SYMBOL_INFIX, NAME_INFIX,
  scoreQuote, foldQuote, mergeQuotes, fromSymbolDb,
}
