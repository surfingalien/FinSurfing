'use strict'
/**
 * routes/sentiment.js
 *
 * GET /api/sentiment/portfolio?symbols=AAPL,MSFT,NVDA
 *
 * Provider priority (best available wins):
 *  1. Benzinga     — pre-scored sentiment + analyst ratings (highest quality)
 *  2. Marketaux    — native per-ticker sentiment scores (-1→+1), no Claude needed
 *  3. AV NEWS_SENTIMENT — Alpha Vantage pre-scored sentiment feed
 *  4. FMP stock_news   — headlines → Claude scores
 *  5. Finnhub company-news — headlines → Claude scores (original fallback)
 *
 * Results cached 25 minutes in-process.
 */

const express         = require('express')
const https           = require('https')
const Anthropic       = require('@anthropic-ai/sdk')
const { requireAuth } = require('../middleware/auth')

const router = express.Router()
router.use(requireAuth)

const sentimentCache = new Map()
const CACHE_TTL = 25 * 60 * 1000

// ── Generic HTTPS GET → parsed JSON ──────────────────────────────────────────
function httpsGet(url) {
  return new Promise((resolve) => {
    https.get(url, { headers: { 'User-Agent': 'FinSurf/2.0' } }, (res) => {
      let data = ''
      res.on('data', c => { data += c })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (parsed?.error || parsed?.Error || parsed?.['Error Message']) {
            console.warn('[sentiment] API error:', parsed.error || parsed.Error || parsed['Error Message'])
            resolve(null)
          } else {
            resolve(parsed)
          }
        } catch { resolve(null) }
      })
    }).on('error', () => resolve(null))
  })
}

// ── 1. Benzinga — pre-scored news sentiment ───────────────────────────────────
async function getBenzingaSentiment(symbols, key) {
  if (!key) return null
  try {
    const tickers = symbols.join(',')
    const url = `https://api.benzinga.com/api/v2/news?token=${key}&tickers=${encodeURIComponent(tickers)}&pageSize=20&displayOutput=full`
    const data = await httpsGet(url)
    if (!Array.isArray(data) || !data.length) return null

    const scoreMap = {}, headlineMap = {}
    for (const article of data) {
      for (const stock of (article.stocks || [])) {
        const sym = stock.name?.toUpperCase()
        if (!sym || !symbols.includes(sym)) continue
        if (!scoreMap[sym]) { scoreMap[sym] = []; headlineMap[sym] = [] }
        // Benzinga sentiment: 'Bullish', 'Bearish', 'Neutral'
        const s = (article.sentiment || stock.sentiment || '').toLowerCase()
        const score = s === 'bullish' ? 0.6 : s === 'bearish' ? -0.6 : 0
        scoreMap[sym].push(score)
        if (article.title) headlineMap[sym].push(article.title)
      }
    }

    const mapped = symbols.map(sym => {
      const scores = scoreMap[sym] || []
      if (!scores.length) return null
      const avg = scores.reduce((a, b) => a + b, 0) / scores.length
      const score10 = Math.round(((avg + 1) / 2) * 9 + 1)
      const sentiment = avg > 0.1 ? 'bullish' : avg < -0.1 ? 'bearish' : 'neutral'
      return { symbol: sym, sentiment, score: score10, summary: (headlineMap[sym][0] || '').slice(0, 80), headline_count: scores.length, source: 'benzinga' }
    })
    const valid = mapped.filter(Boolean)
    return valid.length === symbols.length ? valid : null
  } catch (e) {
    console.warn('[sentiment] Benzinga error:', e.message)
    return null
  }
}

// ── 2. Marketaux — native sentiment scores ────────────────────────────────────
async function getMarketauxSentiment(symbols, key) {
  if (!key) return null
  const tickers = symbols.join(',')
  const url = `https://api.marketaux.com/v1/news/all?symbols=${encodeURIComponent(tickers)}&filter_entities=true&language=en&limit=3&api_token=${key}`
  const data = await httpsGet(url)
  if (!Array.isArray(data?.data) || !data.data.length) return null

  // Build per-symbol score map from entity sentiment
  const scoreMap = {}
  const headlineMap = {}
  for (const article of data.data) {
    for (const entity of (article.entities || [])) {
      const sym = entity.symbol?.toUpperCase()
      if (!sym || !symbols.includes(sym)) continue
      if (!scoreMap[sym]) { scoreMap[sym] = []; headlineMap[sym] = [] }
      if (entity.sentiment_score != null) scoreMap[sym].push(entity.sentiment_score)
      if (article.title) headlineMap[sym].push(article.title)
    }
  }

  return symbols.map(sym => {
    const scores = scoreMap[sym] || []
    const avg    = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
    // Convert -1..+1 → 1..10 scale
    const score10 = Math.round(((avg + 1) / 2) * 9 + 1)
    const sentiment = avg > 0.15 ? 'bullish' : avg < -0.15 ? 'bearish' : 'neutral'
    const headlines = headlineMap[sym] || []
    const summary = headlines.length
      ? headlines[0].slice(0, 80)
      : 'No recent news via Marketaux'
    return { symbol: sym, sentiment, score: score10, summary, headline_count: headlines.length, source: 'marketaux' }
  })
}

// ── 2. Alpha Vantage NEWS_SENTIMENT ──────────────────────────────────────────
async function getAVNewsSentiment(symbols, key) {
  if (!key) return null
  // AV allows up to 50 tickers per call
  const tickers = symbols.join(',')
  const url = `https://www.alphavantage.co/query?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(tickers)}&limit=50&apikey=${key}`
  const data = await httpsGet(url)
  if (!Array.isArray(data?.feed) || !data.feed.length) return null
  if (data?.Note || data?.Information) return null // rate limit hit

  // Build per-symbol aggregate
  const scoreMap = {}
  const headlineMap = {}
  for (const article of data.feed) {
    for (const ts of (article.ticker_sentiment || [])) {
      const sym = ts.ticker?.toUpperCase()
      if (!sym || !symbols.includes(sym)) continue
      const score = parseFloat(ts.ticker_sentiment_score)
      if (!isNaN(score)) {
        if (!scoreMap[sym]) { scoreMap[sym] = []; headlineMap[sym] = [] }
        scoreMap[sym].push(score)
        if (article.title) headlineMap[sym].push(article.title)
      }
    }
  }

  return symbols.map(sym => {
    const scores = scoreMap[sym] || []
    const avg    = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 0
    const score10 = Math.round(((avg + 1) / 2) * 9 + 1)
    const sentiment = avg > 0.15 ? 'bullish' : avg < -0.15 ? 'bearish' : 'neutral'
    const headlines = [...new Set(headlineMap[sym] || [])]
    const summary = headlines.length ? headlines[0].slice(0, 80) : 'No recent news via Alpha Vantage'
    return { symbol: sym, sentiment, score: score10, summary, headline_count: headlines.length, source: 'alphavantage' }
  })
}

// ── 3. FMP stock_news — headlines for Claude to score ────────────────────────
async function getFMPNewsForSentiment(symbols, key, from, to) {
  if (!key) return null
  const tickers = symbols.join(',')
  const url = `https://financialmodelingprep.com/api/v3/stock_news?tickers=${encodeURIComponent(tickers)}&limit=50&apikey=${key}`
  const data = await httpsGet(url)
  if (!Array.isArray(data) || !data.length) return null
  return symbols.map(sym => ({
    sym,
    headlines: data
      .filter(a => a.symbol?.toUpperCase() === sym && new Date(a.publishedDate) >= new Date(from))
      .slice(0, 5)
      .map(a => a.title)
      .filter(Boolean),
  }))
}

// ── 4. Finnhub company-news — batched to avoid rate limits ───────────────────
function finnhubGet(path, key) {
  const sep = path.includes('?') ? '&' : '?'
  return new Promise((resolve) => {
    https.get(
      `https://finnhub.io/api/v1${path}${sep}token=${key}`,
      { headers: { 'User-Agent': 'FinSurf/2.0' } },
      (res) => {
        let data = ''
        res.on('data', c => { data += c })
        res.on('end', () => {
          try {
            const parsed = JSON.parse(data)
            if (parsed?.error) { resolve(null) }
            else { resolve(parsed) }
          } catch { resolve(null) }
        })
      }
    ).on('error', () => resolve(null))
  })
}

async function getFinnhubNewsForSentiment(symbols, key, from, to) {
  if (!key) return null
  const BATCH = 4, DELAY = 400
  const results = []
  for (let i = 0; i < symbols.length; i += BATCH) {
    const batch = symbols.slice(i, i + BATCH)
    const batchResults = await Promise.all(
      batch.map(sym =>
        finnhubGet(`/company-news?symbol=${sym}&from=${from}&to=${to}`, key)
          .then(n => ({
            sym,
            headlines: Array.isArray(n) ? n.slice(0, 5).map(h => h.headline).filter(Boolean) : [],
          }))
      )
    )
    results.push(...batchResults)
    if (i + BATCH < symbols.length) await new Promise(r => setTimeout(r, DELAY))
  }
  return results
}

// ── Claude scoring (used when provider doesn't have native sentiment) ─────────
async function scoreWithClaude(newsData, apiKey) {
  const newsContext = newsData.map(({ sym, headlines }) =>
    headlines.length
      ? `${sym}:\n${headlines.map(h => `  - ${h}`).join('\n')}`
      : `${sym}: no recent news`
  ).join('\n\n')

  const prompt = `You are a financial analyst. Assess the investment sentiment for each stock based on these recent news headlines.

NEWS HEADLINES (last 7 days):
${newsContext}

Respond ONLY with a valid JSON array — one object per ticker, in the same order:
[
  {
    "symbol": "TICKER",
    "sentiment": "bullish" | "neutral" | "bearish",
    "score": 1-10,
    "summary": "one concise sentence max 80 chars",
    "headline_count": N
  }
]

Scoring guide:
- 8-10 = strongly bullish (beat earnings, upgrade, strong guidance, major catalyst)
- 6-7  = mildly bullish
- 5    = neutral or no news
- 3-4  = mildly bearish
- 1-2  = strongly bearish (miss, guidance cut, regulatory issue, lawsuit)

If a symbol has no news, return score 5 and sentiment "neutral".`

  if (require('../lib/ai-pause').claudePaused()) throw require('../lib/ai-pause').pausedError()
  const client = new Anthropic({ apiKey })
  const msg    = await client.messages.create({
    model: 'claude-sonnet-4-6', max_tokens: 2048,
    messages: [{ role: 'user', content: prompt }],
  })
  const text  = msg.content?.[0]?.text || '[]'
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) throw new Error('Failed to parse AI response')
  return JSON.parse(match[0])
}

// ── GET /api/sentiment/portfolio ─────────────────────────────────────────────
router.get('/portfolio', async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) return res.status(503).json({ error: 'AI service not configured' })

  const { symbols: symbolsStr = '', bust } = req.query
  const symbols = symbolsStr.split(',').map(s => s.trim().toUpperCase()).filter(Boolean).slice(0, 15)
  if (!symbols.length) return res.status(400).json({ error: 'symbols query param required' })

  // Extract provider keys from request headers / env
  const benzingaKey = process.env.BENZINGA_API_KEY || null
  const fmpKey      = (req.headers['x-fmp-key']       || '').trim() || process.env.FMP_API_KEY
  const avKey       = (req.headers['x-av-key']        || '').trim() || process.env.ALPHA_VANTAGE_API_KEY || process.env.AV_API_KEY
  const marketauxKey= (req.headers['x-marketaux-key'] || '').trim() || process.env.MARKETAUX_API_KEY
  const finnhubKey  = (req.headers['x-finnhub-key']   || '').trim() || process.env.FINNHUB_API_KEY || process.env.FINNHUB_KEY

  const cacheKey = [...symbols].sort().join(',')
  const cached   = sentimentCache.get(cacheKey)
  if (cached && !bust && (Date.now() - cached.ts) < CACHE_TTL) {
    return res.json({ results: cached.results, cached: true, updatedAt: cached.ts, source: cached.source })
  }

  const today      = new Date()
  const sevenDaysAgo = new Date(today - 7 * 86400000)
  const fmt         = d => d.toISOString().slice(0, 10)

  try {
    // ── Priority 1: Benzinga (pre-scored, highest quality) ───────────────────
    if (benzingaKey) {
      const results = await getBenzingaSentiment(symbols, benzingaKey)
      if (results) {
        const ts = Date.now()
        sentimentCache.set(cacheKey, { results, ts, source: 'Benzinga' })
        return res.json({ results, cached: false, updatedAt: ts, source: 'Benzinga' })
      }
    }

    // ── Priority 2: Marketaux (native sentiment) ──────────────────────────────
    if (marketauxKey) {
      const results = await getMarketauxSentiment(symbols, marketauxKey)
      if (results) {
        const ts = Date.now()
        sentimentCache.set(cacheKey, { results, ts, source: 'Marketaux' })
        return res.json({ results, cached: false, updatedAt: ts, source: 'Marketaux' })
      }
    }

    // ── Priority 3: Alpha Vantage NEWS_SENTIMENT ──────────────────────────────
    if (avKey) {
      const results = await getAVNewsSentiment(symbols, avKey)
      if (results) {
        const ts = Date.now()
        sentimentCache.set(cacheKey, { results, ts, source: 'Alpha Vantage' })
        return res.json({ results, cached: false, updatedAt: ts, source: 'Alpha Vantage' })
      }
    }

    // ── Priority 3: FMP + Claude ──────────────────────────────────────────────
    let newsData = null
    let newsSource = null

    if (fmpKey) {
      const fmpNews = await getFMPNewsForSentiment(symbols, fmpKey, fmt(sevenDaysAgo), fmt(today))
      if (fmpNews) { newsData = fmpNews; newsSource = 'FMP' }
    }

    // ── Priority 4: Finnhub + Claude ─────────────────────────────────────────
    if (!newsData && finnhubKey) {
      const fhNews = await getFinnhubNewsForSentiment(symbols, finnhubKey, fmt(sevenDaysAgo), fmt(today))
      if (fhNews) { newsData = fhNews; newsSource = 'Finnhub' }
    }

    if (!newsData) {
      // No news provider available — return neutral for all with warning
      const results = symbols.map(sym => ({
        symbol: sym, sentiment: 'neutral', score: 5,
        summary: 'No news provider configured', headline_count: 0,
      }))
      return res.json({
        results, cached: false, updatedAt: Date.now(),
        warning: 'No news API keys configured. Add FMP, Finnhub, Alpha Vantage, or Marketaux in API Keys settings.',
      })
    }

    const withNewsCount = newsData.filter(d => d.headlines?.length > 0).length
    const noNewsRatio   = 1 - withNewsCount / newsData.length
    const newsWarning   = noNewsRatio === 1
      ? `No company news found via ${newsSource}. Company news may require a higher plan tier.`
      : null

    const results = await scoreWithClaude(newsData, anthropicKey)

    const ts = Date.now()
    sentimentCache.set(cacheKey, { results, ts, source: newsSource })
    return res.json({ results, cached: false, updatedAt: ts, source: newsSource, warning: newsWarning })

  } catch (err) {
    console.error('[sentiment/portfolio]', err.message)
    return res.status(500).json({ error: err.message })
  }
})

module.exports = router
