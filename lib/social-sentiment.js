'use strict'
/**
 * lib/social-sentiment.js
 *
 * Fetches real-time social sentiment for a list of symbols from:
 *  - Reddit (r/wallstreetbets, r/stocks, r/investing) via free JSON API
 *
 * Inspired by last30days-skill and Agent-Reach patterns — zero API fees,
 * no auth needed, runs in-process. Injects a structured snippet into AI prompts
 * so Claude sees live community sentiment rather than estimating from training data.
 */

const SUBREDDITS = ['wallstreetbets', 'stocks', 'investing']
const REDDIT_TIMEOUT_MS = 6000

/**
 * Fetch Reddit posts mentioning a symbol from a single subreddit.
 * Returns array of { title, score, comments } or []
 */
async function fetchSubreddit(subreddit, symbol) {
  const q = encodeURIComponent(symbol)
  const url = `https://www.reddit.com/r/${subreddit}/search.json?q=${q}&sort=hot&limit=5&t=week&restrict_sr=1`
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
    })).filter(p => p.title && p.score > 0)
  } catch {
    return []
  }
}

/**
 * Compute a simple bullish/bearish signal from post titles.
 * Counts keyword presence — rough but fast.
 */
const BULLISH_WORDS = ['buy','bull','moon','calls','long','bullish','breakout','soar','rally','beat','growth','upgrade','strong']
const BEARISH_WORDS = ['sell','bear','puts','short','bearish','crash','dump','miss','weak','downgrade','correction','drop']

function classifyTitle(title) {
  const t = title.toLowerCase()
  const b = BULLISH_WORDS.filter(w => t.includes(w)).length
  const s = BEARISH_WORDS.filter(w => t.includes(w)).length
  if (b > s) return 'bullish'
  if (s > b) return 'bearish'
  return 'neutral'
}

/**
 * Fetch social sentiment for up to 5 symbols concurrently.
 * Returns a formatted snippet string ready to inject into an LLM prompt.
 */
async function getSocialSentiment(symbols) {
  if (!symbols?.length) return ''
  const syms = symbols.slice(0, 5) // cap to avoid rate-limiting

  // Parallel fetch all subreddits for all symbols
  const results = await Promise.all(
    syms.map(async (sym) => {
      const cleanSym = sym.replace(/-USD$/, '').replace(/[^A-Z0-9]/gi, '')
      const posts = (await Promise.all(
        SUBREDDITS.map(sub => fetchSubreddit(sub, cleanSym))
      )).flat().sort((a, b) => b.score - a.score).slice(0, 6)

      if (!posts.length) return null

      const totalMentions = posts.length
      const bullish  = posts.filter(p => classifyTitle(p.title) === 'bullish').length
      const bearish  = posts.filter(p => classifyTitle(p.title) === 'bearish').length
      const bullPct  = Math.round((bullish / totalMentions) * 100)
      const topTitles = posts.slice(0, 3).map(p => `"${p.title.slice(0, 80)}"`)

      return { sym, totalMentions, bullPct, bearishPct: 100 - bullPct, topTitles }
    })
  )

  const valid = results.filter(Boolean)
  if (!valid.length) return ''

  const lines = valid.map(({ sym, totalMentions, bullPct, bearishPct, topTitles }) =>
    `${sym}: ${totalMentions} Reddit posts · ${bullPct}% bullish/${bearishPct}% bearish` +
    (topTitles.length ? `\n  Top: ${topTitles.join(' | ')}` : '')
  )

  return '\n\nSOCIAL SENTIMENT — Reddit (last 7 days, use to calibrate sentimentScore):\n' + lines.join('\n')
}

module.exports = { getSocialSentiment }
