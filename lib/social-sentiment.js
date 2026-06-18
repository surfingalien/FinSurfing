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
 */

const SUBREDDITS = ['wallstreetbets', 'stocks', 'investing', 'options']
const REDDIT_TIMEOUT_MS = 6000
const POLYMARKET_TIMEOUT_MS = 6000
const NEWS_TIMEOUT_MS = 6000

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
      return {
        title:   titleMatch ? titleMatch[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim() : '',
        pubDate: pubMatch ? pubMatch[1] : '',
      }
    }).filter(h => h.title)

    if (!headlines.length) return null

    // Score bullish/bearish using same keyword lists as Reddit
    let bullCount = 0, bearCount = 0
    for (const h of headlines) {
      const cls = classifyTitle(h.title)
      if (cls === 'bullish') bullCount++
      else if (cls === 'bearish') bearCount++
    }

    return { headlines, bullCount, bearCount, total: headlines.length }
  } catch {
    return null
  }
}

// ── Main export ────────────────────────────────────────────────────────────────
async function getSocialSentiment(symbols) {
  if (!symbols?.length) return ''
  const syms = symbols.slice(0, 5)

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
      line += `\n  News (${news.total} headlines): ${newsSignal} ${news.bullCount} bullish / ${news.bearCount} bearish`
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

  return '\n\nSOCIAL SENTIMENT (Reddit upvote-weighted + Google News + Polymarket prediction odds):\n' + lines.join('\n\n')
}

module.exports = { getSocialSentiment }
