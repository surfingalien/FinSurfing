'use strict'
/**
 * lib/social-sentiment.js
 *
 * Multi-source social sentiment aggregator — all free, no API keys.
 * Sources:
 *   1. Reddit — weighted by upvote score, not just mention count
 *   2. Polymarket — prediction market odds for ticker-related events
 *   3. Google News RSS — recent headlines, keyword-scored bullish/bearish
 *
 * Returns a structured snippet for injection into LLM prompts.
 *
 * SYNDICATION. The news lane counted every headline it was handed, and Google
 * News is the worst offender there: one wire story surfaces under a dozen
 * outlet names, each scored independently, so a single press release could
 * report "8 bullish / 1 bearish" from what is really two stories. This snippet
 * is injected into the AI BRAIN scan prompt, so that inflation reached the
 * picks. Headlines now run through lib/source-independence.js first and each
 * distinct STORY is counted once.
 */

const { clusterArticles } = require('./source-independence')

const SUBREDDITS = ['wallstreetbets', 'stocks', 'investing', 'options']
const REDDIT_TIMEOUT_MS = 6000
const POLYMARKET_TIMEOUT_MS = 6000
const NEWS_TIMEOUT_MS = 6000
const FNG_TIMEOUT_MS = 5000

// ── Reddit ─────────────────────────────────────────────────────────────────────
async function fetchSubreddit(subreddit, symbol) {
  const q = encodeURIComponent(symbol)
  const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${q}&sort=hot&limit=8&t=week&restrict_sr=1`
  try {
    const r = await fetch(url, {
      headers: { 'User-Agent': 'FinSurfing/2.0 sentiment-bot' },
      signal: AbortSignal.timeout(REDDIT_TIMEOUT_MS),
    })
    if (!r.ok) return []
    const data = await r.json()
    return (data?.data?.children ?? []).map(c => ({
      title:    c.data?.title ?? '',
      score:    c.data?.score ?? 0,
      comments: c.data?.num_comments ?? 0,
      upvoteRatio: c.data?.upvote_ratio ?? 0.5,
    })).filter(p => p.title && p.score > 0)
  } catch {
    return []
  }
}

const BULLISH_WORDS = ['buy','bull','moon','calls','long','bullish','breakout','soar','rally','beat','growth','upgrade','strong','squeeze','ath','all-time high']
const BEARISH_WORDS = ['sell','bear','puts','short','bearish','crash','dump','miss','weak','downgrade','correction','drop','overvalued','bubble','fraud']

function classifyTitle(title) {
  const t = title.toLowerCase()
  const b = BULLISH_WORDS.filter(w => t.includes(w)).length
  const s = BEARISH_WORDS.filter(w => t.includes(w)).length
  if (b > s) return 'bullish'
  if (s > b) return 'bearish'
  return 'neutral'
}

async function getRedditSentiment(sym) {
  const cleanSym = sym.replace(/-USD$/, '').replace(/[^A-Z0-9]/gi, '')
  const allPosts = (await Promise.all(
    SUBREDDITS.map(sub => fetchSubreddit(sub, cleanSym))
  )).flat()

  if (!allPosts.length) return null

  // Weight by upvote score — high-score posts carry more signal
  const totalScore = allPosts.reduce((s, p) => s + p.score, 0)
  let weightedBull = 0, weightedBear = 0

  for (const p of allPosts) {
    const w = totalScore > 0 ? p.score / totalScore : 1 / allPosts.length
    const cls = classifyTitle(p.title)
    if (cls === 'bullish') weightedBull += w
    else if (cls === 'bearish') weightedBear += w
  }

  const bullPct = Math.round(weightedBull * 100)
  const bearPct = Math.round(weightedBear * 100)
  const totalUpvotes = totalScore
  const topPosts = [...allPosts].sort((a, b) => b.score - a.score).slice(0, 3)

  return { sym, mentions: allPosts.length, totalUpvotes, bullPct, bearPct, topPosts }
}

// ── Polymarket ─────────────────────────────────────────────────────────────────
// Public API — no key needed. Returns prediction market odds for ticker events.
async function getPolymarketOdds(sym) {
  try {
    const cleanSym = sym.replace(/-USD$/, '').toUpperCase()
    const url = `https://gamma-api.polymarket.com/markets?search=${encodeURIComponent(cleanSym)}&closed=false&limit=5`
    const r = await fetch(url, {
      headers: { 'User-Agent': 'FinSurfing/2.0' },
      signal: AbortSignal.timeout(POLYMARKET_TIMEOUT_MS),
    })
    if (!r.ok) return null
    const markets = await r.json()
    if (!Array.isArray(markets) || !markets.length) return null

    // Filter for relevant, active markets with meaningful volume
    const relevant = markets
      .filter(m => m.volume > 1000 && !m.closed && !m.archived)
      .slice(0, 3)
      .map(m => {
        // Polymarket outcomes: outcomePrices are probabilities 0-1
        let yesProb = null
        try {
          const prices = JSON.parse(m.outcomePrices || '[]')
          const outcomes = JSON.parse(m.outcomes || '[]')
          const yesIdx = outcomes.findIndex(o => o.toLowerCase() === 'yes')
          if (yesIdx >= 0 && prices[yesIdx]) yesProb = Math.round(parseFloat(prices[yesIdx]) * 100)
        } catch {}
        return {
          question: m.question,
          yesProb,
          volume: m.volume ? `$${(m.volume / 1000).toFixed(0)}k` : null,
          endDate: m.endDate ? m.endDate.slice(0, 10) : null,
        }
      })

    return relevant.length ? relevant : null
  } catch {
    return null
  }
}

// ── Crypto Fear & Greed Index (alternative.me — free, no auth) ───────────────
async function getCryptoFearGreed() {
  if (_fngCache && Date.now() < _fngCache.expiresAt) return _fngCache.value
  try {
    const r = await fetch('https://api.alternative.me/fng/?limit=2', {
      headers: { 'User-Agent': 'FinSurfing/2.0' },
      signal:  AbortSignal.timeout(FNG_TIMEOUT_MS),
    })
    if (!r.ok) return null
    const data = await r.json()
    const items = data?.data
    if (!Array.isArray(items) || !items.length) return null
    const today = items[0]
    const prev  = items[1]
    const val   = parseInt(today.value)
    const trend = prev
      ? (val > parseInt(prev.value) ? ' ↑ improving' : val < parseInt(prev.value) ? ' ↓ worsening' : ' → flat')
      : ''
    const value = {
      value:          val,
      classification: today.value_classification,
      trend,
      snippet: `Crypto Fear & Greed: ${val}/100 — ${today.value_classification}${trend}`,
    }
    _fngCache = { value, expiresAt: Date.now() + 60 * 60_000 }  // 1-hour TTL
    return value
  } catch {
    return null
  }
}

// ── BTC Dominance (CoinGecko free global API — 1h cache) ─────────────────────
let _btcDomCache = null  // { value, expiresAt }

async function getBtcDominance() {
  if (_btcDomCache && Date.now() < _btcDomCache.expiresAt) return _btcDomCache.value
  try {
    const r = await fetch('https://api.coingecko.com/api/v3/global', {
      headers: { 'User-Agent': 'FinSurfing/2.0', Accept: 'application/json' },
      signal:  AbortSignal.timeout(6000),
    })
    if (!r.ok) return null
    const data = await r.json()
    const dom  = data?.data?.market_cap_percentage?.btc
    if (dom == null) return null
    const pct  = dom.toFixed(1)
    // <50% = altseason territory; >60% = BTC dominance regime
    const regime = dom > 60 ? 'BTC dominance regime (altcoins underperform)'
      : dom > 50 ? 'mixed (BTC leading, altcoin season not confirmed)'
      : 'altseason territory (altcoins historically outperform)'
    const value = {
      dominance: dom,
      snippet: `BTC Dominance: ${pct}% — ${regime}`,
    }
    _btcDomCache = { value, expiresAt: Date.now() + 60 * 60_000 }  // 1-hour TTL
    return value
  } catch {
    return null
  }
}

// ── Google News RSS ────────────────────────────────────────────────────────────
async function fetchGoogleNews(symbol) {
  try {
    const cleanSym = symbol.replace(/-USD$/, '').replace(/[^A-Z0-9]/gi, '')
    const q   = encodeURIComponent(`${cleanSym} stock`)
    const url = `https://news.google.com/rss/search?q=${q}&hl=en-US&gl=US&ceid=US:en`
    const r   = await fetch(url, {
      headers: { 'User-Agent': 'FinSurfing/2.0 news-bot' },
      signal:  AbortSignal.timeout(NEWS_TIMEOUT_MS),
    })
    if (!r.ok) return null
    const xml = await r.text()

    // Extract <item> blocks and pull <title> from each
    const items = [...xml.matchAll(/<item>[\s\S]*?<\/item>/g)].slice(0, 10)
    if (!items.length) return null

    const headlines = items.map(m => {
      const titleMatch = m[0].match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ||
                         m[0].match(/<title>(.*?)<\/title>/)
      const pubMatch   = m[0].match(/<pubDate>(.*?)<\/pubDate>/)
      const linkMatch  = m[0].match(/<link>(.*?)<\/link>/)
      return {
        title:   titleMatch ? titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '',
        pubDate: pubMatch ? pubMatch[1] : '',
        link:    linkMatch ? linkMatch[1].trim() : '',
      }
    }).filter(h => h.title)

    if (!headlines.length) return null

    // Classify first: the direction is what lets the clusterer refuse to merge
    // a "beats" headline with a "misses" one that shares most of its words.
    const scored = headlines.map(h => {
      const cls = classifyTitle(h.title)
      return { ...h, cls, polarity: cls === 'bullish' ? 1 : cls === 'bearish' ? -1 : 0 }
    })

    // Collapse syndicated copies. Google News RSS links are per-item redirect
    // URLs that never collide, so the title carries the signal here — outlet
    // suffixes ("… - Reuters") are stripped by normalizeTitle, which is exactly
    // the shape this feed produces.
    const { clusters } = clusterArticles(scored.map(h => ({
      title: h.title, url: h.link, publishedAt: h.pubDate, polarity: h.polarity,
    })))
    const suppressed = new Set(clusters.flatMap(c => c.members))
    const distinct = scored.filter((_, i) => !suppressed.has(i))

    let bullCount = 0, bearCount = 0
    for (const h of distinct) {
      if (h.cls === 'bullish') bullCount++
      else if (h.cls === 'bearish') bearCount++
    }

    return {
      headlines: distinct,
      bullCount, bearCount,
      total: distinct.length,          // distinct stories — what the counts mean
      rawTotal: headlines.length,      // articles seen before collapsing
      syndicated: headlines.length > distinct.length,
    }
  } catch {
    return null
  }
}

// ── Simple TTL cache — avoids hammering Reddit/News/Polymarket on concurrent calls ─
const SENTIMENT_CACHE = new Map()   // key → { result, expiresAt }
const SENTIMENT_TTL_MS = 5 * 60_000  // 5 minutes

// ── F&G cache — index only updates once daily ──────────────────────────────────
let _fngCache = null  // { value, expiresAt }

// ── Main export ────────────────────────────────────────────────────────────────
async function getSocialSentiment(symbols) {
  if (!symbols?.length) return ''
  const syms = symbols.slice(0, 8)
  const cacheKey = [...syms].sort().join(',')
  const cached = SENTIMENT_CACHE.get(cacheKey)
  if (cached && Date.now() < cached.expiresAt) return cached.result

  // Fetch Reddit + Polymarket + Google News in parallel for all symbols
  const [redditResults, polyResults, newsResults] = await Promise.all([
    Promise.all(syms.map(getRedditSentiment)),
    Promise.all(syms.map(getPolymarketOdds)),
    Promise.all(syms.map(fetchGoogleNews)),
  ])

  const lines = []

  for (let i = 0; i < syms.length; i++) {
    const reddit = redditResults[i]
    const poly   = polyResults[i]
    const news   = newsResults[i]
    const sym    = syms[i]

    if (!reddit && !poly && !news) continue

    let line = `**${sym}**`

    if (reddit) {
      const signal = reddit.bullPct > 55 ? '🟢 bullish' : reddit.bearPct > 55 ? '🔴 bearish' : '⚪ mixed'
      line += ` — Reddit: ${reddit.mentions} posts · ${reddit.totalUpvotes.toLocaleString()} upvotes · ${signal} (${reddit.bullPct}% bull / ${reddit.bearPct}% bear)`
      if (reddit.topPosts.length) {
        const top = reddit.topPosts[0]
        line += `\n  Top post (${top.score.toLocaleString()} upvotes): "${top.title.slice(0, 90)}"`
      }
    }

    if (news) {
      const newsSignal = news.bullCount > news.bearCount ? '🟢' : news.bearCount > news.bullCount ? '🔴' : '⚪'
      const collapsed = news.syndicated ? ` — ${news.rawTotal} articles collapsed to ${news.total} distinct stories` : ''
      line += `\n  News (${news.total} distinct ${news.total === 1 ? 'story' : 'stories'}${collapsed}): ${newsSignal} ${news.bullCount} bullish / ${news.bearCount} bearish`
      // Show top 2 headlines
      news.headlines.slice(0, 2).forEach(h => {
        line += `\n    • "${h.title.slice(0, 100)}"`
      })
    }

    if (poly) {
      line += `\n  Polymarket:`
      poly.forEach(m => {
        const prob = m.yesProb != null ? ` — ${m.yesProb}% YES` : ''
        const vol  = m.volume ? ` (vol ${m.volume})` : ''
        line += `\n    • ${m.question}${prob}${vol}`
      })
    }

    lines.push(line)
  }

  if (!lines.length) return ''

  const result = '\n\nSOCIAL SENTIMENT (Reddit upvote-weighted + Google News + Polymarket prediction odds):\n' + lines.join('\n\n')
  SENTIMENT_CACHE.set(cacheKey, { result, expiresAt: Date.now() + SENTIMENT_TTL_MS })
  return result
}

module.exports = { getSocialSentiment, getCryptoFearGreed, getBtcDominance }
// Exported for unit tests — the news lane is where syndication inflates counts.
module.exports.fetchGoogleNews = fetchGoogleNews
module.exports.classifyTitle   = classifyTitle
