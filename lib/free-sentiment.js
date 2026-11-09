'use strict'
/**
 * lib/free-sentiment.js — social and news sentiment from free, keyless sources.
 *
 * Reddit's own API answers cloud servers with HTTP 403, so the AI Brain's
 * Reddit lane had been silently empty in production, and the Sentiment page
 * depended on a paid key (Adanos). Three free sources instead, each reported
 * on its own — no blended score with hand-set weights:
 *
 *   StockTwits   the last 30 messages on the symbol's stream; the share of
 *                messages their AUTHORS tagged Bullish vs Bearish (a count of
 *                self-labels, no model), how many carried a tag, and how fast
 *                messages arrive (messages per hour over the span covered)
 *   ApeWisdom    Reddit mention counts aggregated across the investing
 *                subreddits (rank, mentions, upvotes, and the rank a day
 *                earlier) — attention, not direction. Its `mentions_24h_ago`
 *                is NOT the same window as `mentions` (live: +400–800% for
 *                almost every ticker), so no mention-change % is reported;
 *                the change is in RANK, which is comparable
 *   Google News  distinct stories in the RSS search (syndicated copies
 *                collapsed by lib/source-independence.js), classified by the
 *                existing keyword rule (social-sentiment.classifyTitle)
 *
 * `lean` is only a count of which way the directional sources point (bullish /
 * bearish / mixed / quiet); nothing here has been shown to predict returns.
 *
 * Fetchers are best-effort (null on any failure, a short in-memory cache);
 * summarise / describeLine are pure. Tests: tests/free-sentiment.test.js
 */

const UA = { 'User-Agent': 'FinSurfing/2.0 (sentiment)', Accept: 'application/json' }
const TIMEOUT_MS = 8_000
const STOCKTWITS_TTL = 10 * 60_000
const APE_TTL = 15 * 60_000
const APE_PAGES = 3          // ~300 most-mentioned tickers
const MIN_TAGGED = 5         // fewer self-tagged messages than this → no StockTwits lean

const clean = s => String(s || '').toUpperCase().replace(/-USD$/, '').replace(/[^A-Z0-9.]/g, '')
const isCrypto = s => /-USD$/i.test(String(s || ''))

// ── StockTwits ───────────────────────────────────────────────────────────────

/** Fold a StockTwits stream payload. Pure. */
function foldStockTwits(payload) {
  const msgs = Array.isArray(payload?.messages) ? payload.messages : null
  if (!msgs) return null
  let bull = 0, bear = 0
  for (const m of msgs) {
    const t = m?.entities?.sentiment?.basic
    if (t === 'Bullish') bull++
    else if (t === 'Bearish') bear++
  }
  const times = msgs.map(m => Date.parse(m?.created_at)).filter(Number.isFinite).sort((a, b) => a - b)
  const spanHours = times.length > 1 ? (times.at(-1) - times[0]) / 3_600_000 : null
  const tagged = bull + bear
  return {
    messages: msgs.length,
    tagged, bullish: bull, bearish: bear,
    bullShare: tagged >= MIN_TAGGED ? +(bull / tagged).toFixed(2) : null,
    perHour: spanHours > 0 ? +(msgs.length / spanHours).toFixed(1) : null,
    watchers: Number.isFinite(payload?.symbol?.watchlist_count) ? payload.symbol.watchlist_count : null,
    newest: times.length ? new Date(times.at(-1)).toISOString() : null,
  }
}

const _twits = new Map()
async function stockTwits(symbol, { fetchImpl = fetch, now = Date.now() } = {}) {
  const sym = isCrypto(symbol) ? `${clean(symbol)}.X` : clean(symbol)
  const hit = _twits.get(sym)
  if (hit && now - hit.t < STOCKTWITS_TTL) return hit.v
  try {
    const r = await fetchImpl(`https://api.stocktwits.com/api/2/streams/symbol/${encodeURIComponent(sym)}.json`, { headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS) })
    const v = r.ok ? foldStockTwits(await r.json()) : null
    _twits.set(sym, { t: now, v })
    if (_twits.size > 300) _twits.delete(_twits.keys().next().value)
    return v
  } catch { return null }
}

// ── ApeWisdom (Reddit mentions) ──────────────────────────────────────────────

/** Map ticker → mention stats from ApeWisdom result pages. Pure. */
function foldApe(pages) {
  const out = new Map()
  for (const p of pages || []) {
    for (const r of p?.results || []) {
      const t = clean(r.ticker)
      if (!t || out.has(t)) continue
      const n = Number(r.mentions), n24 = Number(r.mentions_24h_ago)
      out.set(t, {
        rank: Number(r.rank) || null,
        rank24hAgo: Number(r.rank_24h_ago) || null,
        mentions: Number.isFinite(n) ? n : null,
        mentions24hAgo: Number.isFinite(n24) ? n24 : null,
        upvotes: Number(r.upvotes) || 0,
        of: Number(p.count) || null,
      })
    }
  }
  return out
}

const _ape = new Map()   // filter → { t, map }
async function apeWisdom(symbol, { fetchImpl = fetch, now = Date.now() } = {}) {
  const filter = isCrypto(symbol) ? 'all-crypto' : 'all-stocks'
  let hit = _ape.get(filter)
  if (!hit || now - hit.t >= APE_TTL) {
    try {
      const pages = []
      for (let page = 1; page <= APE_PAGES; page++) {
        const r = await fetchImpl(`https://apewisdom.io/api/v1.0/filter/${filter}/page/${page}`, { headers: UA, signal: AbortSignal.timeout(TIMEOUT_MS) })
        if (!r.ok) break
        const j = await r.json()
        pages.push(j)
        if (!j?.pages || page >= j.pages) break
      }
      hit = { t: now, map: pages.length ? foldApe(pages) : null }
      _ape.set(filter, hit)
    } catch { hit = { t: now, map: null }; _ape.set(filter, hit) }
  }
  if (!hit.map) return null
  return hit.map.get(clean(symbol)) || { rank: null, mentions: 0, notRanked: true }
}

// ── Combined ─────────────────────────────────────────────────────────────────

/** Per-symbol summary from the three sources. Pure. */
function summarise(symbol, { twits = null, reddit = null, news = null } = {}) {
  const leans = []
  if (twits?.bullShare != null) leans.push(twits.bullShare >= 0.6 ? 1 : twits.bullShare <= 0.4 ? -1 : 0)
  if (news?.total >= 3) leans.push(news.bullCount > news.bearCount ? 1 : news.bearCount > news.bullCount ? -1 : 0)
  const up = leans.filter(x => x > 0).length, down = leans.filter(x => x < 0).length
  const lean = !leans.length ? 'quiet' : up && !down ? 'bullish' : down && !up ? 'bearish' : up || down ? 'mixed' : 'neutral'
  return {
    symbol: String(symbol).toUpperCase(),
    stocktwits: twits,
    reddit: reddit && {
      ...reddit,
      // Positive = climbed the ranking since yesterday (rank 20 → 3 is +17).
      rankChange: reddit.rank != null && reddit.rank24hAgo != null ? reddit.rank24hAgo - reddit.rank : null,
    },
    news: news && { stories: news.total, articles: news.rawTotal, bullish: news.bullCount, bearish: news.bearCount, syndicated: news.syndicated, headlines: (news.headlines || []).slice(0, 5).map(h => ({ title: h.title, cls: h.cls, link: h.link, pubDate: h.pubDate })) },
    lean,
    sourcesAnswered: [twits, reddit, news].filter(Boolean).length,
  }
}

/** One prompt/evidence line for a symbol (counts only — no message text reaches a model). Pure. */
function describeLine(s) {
  const parts = []
  const t = s.stocktwits
  if (t) parts.push(`StockTwits: ${t.tagged} of the last ${t.messages} messages self-tagged${t.bullShare != null ? ` (${Math.round(t.bullShare * 100)}% bullish)` : ' (too few to read)'}${t.perHour != null ? `, ${t.perHour} msgs/hour` : ''}`)
  const r = s.reddit
  if (r) parts.push(r.notRanked ? 'Reddit: not among the most-mentioned tickers' : `Reddit (ApeWisdom): rank ${r.rank}${r.of ? ` of ${r.of}` : ''}, ${r.mentions} mentions in 24h${r.rankChange ? ` (${r.rankChange > 0 ? 'up' : 'down'} ${Math.abs(r.rankChange)} places since yesterday)` : ''}`)
  const n = s.news
  if (n) parts.push(`News: ${n.stories} distinct stories${n.syndicated ? ` (${n.articles} articles)` : ''}, ${n.bullish} bullish / ${n.bearish} bearish by keyword`)
  return parts.length ? `${s.symbol} — ${parts.join(' · ')} → lean ${s.lean}` : null
}

/** All three sources for a list of symbols (≤ 15), in parallel. */
async function sentimentFor(symbols, { fetchImpl = fetch } = {}) {
  const { fetchGoogleNews } = require('./social-sentiment')
  const syms = [...new Set((symbols || []).map(s => String(s).toUpperCase()))].slice(0, 15)
  return Promise.all(syms.map(async s => {
    const [twits, reddit, news] = await Promise.all([
      stockTwits(s, { fetchImpl }).catch(() => null),
      apeWisdom(s, { fetchImpl }).catch(() => null),
      fetchGoogleNews(s).catch(() => null),
    ])
    return summarise(s, { twits, reddit, news })
  }))
}

function _resetForTests() { _twits.clear(); _ape.clear() }

module.exports = { MIN_TAGGED, foldStockTwits, foldApe, summarise, describeLine, stockTwits, apeWisdom, sentimentFor, _resetForTests }
