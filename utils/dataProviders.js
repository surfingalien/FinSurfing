/**
 * utils/dataProviders.js
 *
 * Unified data-fetching layer for the AI Agent.
 * Supports three sources (each optional — gracefully degrades):
 *
 *   Yahoo Finance  → OHLCV + real-time quote  (always available via /api/chart & /api/quote)
 *   Alpha Vantage  → News sentiment, earnings calendar  (ALPHA_VANTAGE_API_KEY)
 *   FMP            → Fundamentals, analyst estimates, DCF, institutional flows  (FMP_API_KEY)
 *
 * All functions return plain JS objects safe to JSON.stringify into tool results.
 */

'use strict'

const AV_BASE  = 'https://www.alphavantage.co/query'
const FMP_BASE = 'https://financialmodelingprep.com/api'

// ── Helper: timed fetch with abort ───────────────────────────────────────────
async function timedFetch(url, timeoutMs = 10000) {
  const res  = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url.split('?')[0]}`)
  return res.json()
}

// ── Alpha Vantage ─────────────────────────────────────────────────────────────

/**
 * fetchAVNewsSentiment(symbol)
 * Returns up to 10 recent news articles with AV's sentiment scores.
 */
async function fetchAVNewsSentiment(symbol) {
  const key = process.env.ALPHA_VANTAGE_API_KEY
  if (!key) return { source: 'alpha_vantage', available: false, reason: 'ALPHA_VANTAGE_API_KEY not set' }

  const url  = `${AV_BASE}?function=NEWS_SENTIMENT&tickers=${encodeURIComponent(symbol)}&limit=10&apikey=${key}`
  const data = await timedFetch(url, 12000)

  if (data.Information || data.Note) {
    return { source: 'alpha_vantage', available: false, reason: data.Information || data.Note }
  }

  const feed = data.feed || []
  const articles = feed.slice(0, 10).map(a => {
    const tickerSentiment = (a.ticker_sentiment || []).find(t => t.ticker === symbol)
    return {
      title:          a.title,
      source:         a.source,
      publishedAt:    a.time_published,
      url:            a.url,
      overallSentiment: a.overall_sentiment_label,
      overallScore:   parseFloat(a.overall_sentiment_score || 0),
      tickerSentiment: tickerSentiment?.ticker_sentiment_label,
      tickerScore:    parseFloat(tickerSentiment?.ticker_sentiment_score || 0),
      relevanceScore: parseFloat(tickerSentiment?.relevance_score || 0),
    }
  })

  // Aggregate
  const bullish = articles.filter(a => (a.tickerScore || a.overallScore) > 0.15).length
  const bearish = articles.filter(a => (a.tickerScore || a.overallScore) < -0.15).length
  const avgScore = articles.length
    ? articles.reduce((s, a) => s + (a.tickerScore || a.overallScore), 0) / articles.length
    : 0

  return {
    source:      'alpha_vantage',
    available:   true,
    symbol,
    totalArticles: articles.length,
    bullish, bearish,
    neutral:     articles.length - bullish - bearish,
    avgSentimentScore: +avgScore.toFixed(3),
    sentimentLabel: avgScore > 0.15 ? 'Bullish' : avgScore < -0.15 ? 'Bearish' : 'Neutral',
    articles,
  }
}

// ── FMP (Financial Modeling Prep) ─────────────────────────────────────────────

/**
 * fetchFMPFundamentals(symbol)
 * Returns income statement, key metrics TTM, analyst estimates, DCF value, profile.
 */
async function fetchFMPFundamentals(symbol) {
  const key = process.env.FMP_API_KEY
  if (!key) return { source: 'fmp', available: false, reason: 'FMP_API_KEY not set' }

  const base = `${FMP_BASE}/v3`
  const q    = `apikey=${key}`

  // Fire all requests in parallel
  const [profile, metrics, income, estimates, dcf, peers] = await Promise.allSettled([
    timedFetch(`${base}/profile/${symbol}?${q}`),
    timedFetch(`${base}/key-metrics-ttm/${symbol}?${q}`),
    timedFetch(`${base}/income-statement/${symbol}?limit=4&${q}`),
    timedFetch(`${base}/analyst-estimates/${symbol}?limit=4&${q}`),
    timedFetch(`${base}/discounted-cash-flow/${symbol}?${q}`),
    timedFetch(`${base}/stock_peers?symbol=${symbol}&${q}`),
  ])

  const p  = profile.value?.[0]   || {}
  const m  = metrics.value?.[0]   || {}
  const i0 = income.value?.[0]    || {}
  const e0 = estimates.value?.[0] || {}
  const d  = dcf.value?.[0]       || {}

  if (!p.symbol) {
    return { source: 'fmp', available: false, reason: `No data for ${symbol} — check FMP_API_KEY or symbol` }
  }

  // Extract recent earnings trend
  const earningsTrend = (income.value || []).slice(0, 4).map(r => ({
    period:    r.period,
    revenue:   r.revenue,
    netIncome: r.netIncome,
    eps:       r.eps,
    grossProfitRatio: r.grossProfitRatio,
    operatingIncomeRatio: r.operatingIncomeRatio,
  }))

  // Analyst estimates
  const analystEst = estimates.value?.[0]
    ? {
        estimatedRevenueLow:  e0.estimatedRevenueLow,
        estimatedRevenueHigh: e0.estimatedRevenueHigh,
        estimatedEpsLow:      e0.estimatedEpsLow,
        estimatedEpsHigh:     e0.estimatedEpsHigh,
        estimatedNetIncomeLow:  e0.estimatedNetIncomeLow,
        estimatedNetIncomeHigh: e0.estimatedNetIncomeHigh,
        date: e0.date,
      }
    : null

  // Peers list
  const peersList = peers.value?.peers || []

  return {
    source:    'fmp',
    available: true,
    symbol,
    profile: {
      companyName:   p.companyName,
      sector:        p.sector,
      industry:      p.industry,
      country:       p.country,
      exchange:      p.exchangeShortName,
      employees:     p.fullTimeEmployees,
      description:   p.description?.slice(0, 300),
      website:       p.website,
      ceo:           p.ceo,
      ipoDate:       p.ipoDate,
    },
    valuation: {
      marketCap:      p.mktCap,
      pe:             p.pe,
      priceToBook:    m.priceToBookRatioTTM,
      priceToSales:   m.priceToSalesRatioTTM,
      evToEbitda:     m.enterpriseValueOverEBITDATTM,
      dcfValue:       d.dcf,
      dcfDate:        d.date,
      fairValueVsPrice: d.dcf && p.price ? +((d.dcf - p.price) / p.price * 100).toFixed(2) : null,
    },
    profitability: {
      grossMarginTTM:     m.grossProfitMarginTTM,
      operatingMarginTTM: m.operatingProfitMarginTTM,
      netMarginTTM:       m.netProfitMarginTTM,
      roeTTM:             m.roeTTM,
      roicTTM:            m.roicTTM,
      ebitdaTTM:          m.enterpriseValueTTM,
    },
    growth: {
      revenueGrowthYoY: i0.revenueGrowth,
      netIncomeGrowth:  i0.netIncomeGrowth,
      epsGrowth:        null, // not always available in TTM endpoint
    },
    debt: {
      debtToEquityTTM: m.debtToEquityTTM,
      currentRatioTTM: m.currentRatioTTM,
      interestCoverTTM: m.interestCoverageTTM,
    },
    dividends: {
      dividendYield:    p.lastDiv ? (p.lastDiv / p.price * 100).toFixed(2) : null,
      lastDividend:     p.lastDiv,
    },
    earningsTrend,
    analystEstimates: analystEst,
    peers: peersList.slice(0, 6),
  }
}

/**
 * fetchFMPNews(symbol)
 * Returns latest 8 news articles from FMP with basic sentiment tags.
 */
async function fetchFMPNews(symbol) {
  const key = process.env.FMP_API_KEY
  if (!key) return { source: 'fmp_news', available: false, reason: 'FMP_API_KEY not set' }

  const url  = `${FMP_BASE}/v3/stock_news?tickers=${symbol}&limit=8&apikey=${key}`
  const data = await timedFetch(url, 10000)

  if (!Array.isArray(data)) return { source: 'fmp_news', available: false, reason: 'Unexpected response' }

  const BULL = ['surge', 'soar', 'rally', 'gain', 'beat', 'record', 'strong', 'growth', 'upgrade', 'bullish', 'outperform']
  const BEAR = ['drop', 'fall', 'miss', 'loss', 'weak', 'cut', 'downgrade', 'bearish', 'underperform', 'decline', 'crash', 'risk']

  const articles = data.map(a => {
    const text = (a.title + ' ' + a.text).toLowerCase()
    const bullScore = BULL.filter(w => text.includes(w)).length
    const bearScore = BEAR.filter(w => text.includes(w)).length
    const sentiment = bullScore > bearScore ? 'Bullish' : bearScore > bullScore ? 'Bearish' : 'Neutral'
    return {
      title:       a.title,
      source:      a.site,
      publishedAt: a.publishedDate,
      url:         a.url,
      sentiment,
      summary:     a.text?.slice(0, 200),
    }
  })

  const bullish = articles.filter(a => a.sentiment === 'Bullish').length
  const bearish = articles.filter(a => a.sentiment === 'Bearish').length

  return {
    source: 'fmp_news',
    available: true,
    symbol,
    totalArticles: articles.length,
    bullish, bearish, neutral: articles.length - bullish - bearish,
    articles,
  }
}

/**
 * fetchFMPInsiderActivity(symbol)
 * Returns last 10 insider transactions (buys/sells).
 */
async function fetchFMPInsiderActivity(symbol) {
  const key = process.env.FMP_API_KEY
  if (!key) return { source: 'fmp_insider', available: false, reason: 'FMP_API_KEY not set' }

  const url  = `${FMP_BASE}/v4/insider-trading?symbol=${symbol}&limit=10&apikey=${key}`
  const data = await timedFetch(url, 10000)

  if (!Array.isArray(data)) return { source: 'fmp_insider', available: false, reason: 'Unexpected response' }

  const transactions = data.map(t => ({
    date:        t.transactionDate,
    type:        t.transactionType,
    shares:      t.securitiesTransacted,
    price:       t.price,
    value:       t.securitiesTransacted * t.price,
    name:        t.reportingName,
    role:        t.typeOfOwner,
  }))

  const buys  = transactions.filter(t => t.type?.toLowerCase().includes('purchase') || t.type === 'P-Purchase')
  const sells = transactions.filter(t => t.type?.toLowerCase().includes('sale') || t.type === 'S-Sale')

  return {
    source: 'fmp_insider',
    available: true,
    symbol,
    totalTransactions: transactions.length,
    recentBuys:  buys.length,
    recentSells: sells.length,
    insiderSentiment: buys.length > sells.length ? 'Bullish' : sells.length > buys.length ? 'Bearish' : 'Neutral',
    transactions,
  }
}

// ── Orchestrated "get_fundamentals" tool handler ──────────────────────────────

/**
 * fetchAllFundamentals(symbol)
 * Calls FMP fundamentals + FMP news + AV sentiment in parallel.
 * Falls back gracefully if any source is unavailable.
 */
async function fetchAllFundamentals(symbol) {
  const ticker = symbol.toUpperCase().trim()

  const [fundamentals, fmpNews, avSentiment, insider] = await Promise.allSettled([
    fetchFMPFundamentals(ticker),
    fetchFMPNews(ticker),
    fetchAVNewsSentiment(ticker),
    fetchFMPInsiderActivity(ticker),
  ])

  return {
    symbol: ticker,
    timestamp: new Date().toISOString(),
    fundamentals:  fundamentals.value  || { available: false, error: fundamentals.reason?.message },
    news:          avSentiment.value?.available ? avSentiment.value : fmpNews.value || { available: false },
    insiderActivity: insider.value   || { available: false, error: insider.reason?.message },
    dataSources: {
      fmp:          !!process.env.FMP_API_KEY,
      alphaVantage: !!process.env.ALPHA_VANTAGE_API_KEY,
    },
  }
}

module.exports = { fetchAllFundamentals, fetchAVNewsSentiment, fetchFMPFundamentals, fetchFMPNews }
