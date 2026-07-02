'use strict'
/**
 * routes/copilot.js
 *
 * POST /api/copilot/chat  — streaming agentic copilot chat (SSE)
 *
 * Multi-provider agentic copilot inspired by claudian (YishenTu/claudian)
 * Conversation.providerId + providerState architecture — one conversation
 * model that routes to the right LLM backend cleanly.
 *
 * Supported providers:
 *   claude  — Anthropic claude-sonnet-4-6 (tool_use, native streaming)
 *   groq    — Groq llama-3.3-70b (OpenAI-compat function calling)
 *   codex   — OpenAI GPT-4o (OpenAI-compat function calling)
 *
 * Body: { messages, portfolio, watchlist, providerId?, providerState? }
 *   providerId:   'claude' | 'groq' | 'codex'  (default: 'claude')
 *   providerState: { model?, baseUrl? }         (optional overrides)
 *
 * Streams back SSE events:
 *   data: { type: "text", delta: "..." }
 *   data: { type: "tool_start", tools: [{name, input}] }
 *   data: { type: "tool_results", results: [{tool, preview}] }
 *   data: { type: "done" }
 *   data: { type: "error", message: "..." }
 */

const express = require('express')
const rateLimit = require('express-rate-limit')
const Anthropic = require('@anthropic-ai/sdk')
const { requireAuth } = require('../middleware/auth')
const { getSocialSentiment } = require('../lib/social-sentiment')
const { getAltDataSnippet }  = require('../lib/alt-data')
const symbolDb = require('../lib/symbol-db')
const { computeStats, readPredictions } = require('../lib/brain-learnings')
const { computeEdgeReport, edgeBlock } = require('../lib/edge-report')
const { claudePaused, pauseMessage } = require('../lib/ai-pause')
const { INTERNAL_SECRET } = require('../lib/internal-secret')

// Use warm cache from scheduled-jobs if available, fall back to live fetch
async function getAltData(symbol) {
  try {
    const jobs = require('../lib/scheduled-jobs')
    const cached = jobs.getCachedAltData(symbol)
    if (cached) return cached
  } catch {}
  return getAltDataSnippet(symbol).catch(() => null)
}

const router = express.Router()
const anthropic = new Anthropic()

const chatLimit = rateLimit({
  windowMs: 60 * 1000, max: 30,
  message: { error: 'Too many copilot requests — wait a minute' },
})

const COPILOT_SYSTEM = `You are MarketPulse, an autonomous financial intelligence agent embedded in FinSurfing — a real-time US equity and crypto trading platform.

Your mission: deliver timely, verified, and structured financial intelligence that helps users understand market dynamics, identify opportunities, and make informed decisions. Prioritize accuracy over speed, transparency over hype, and education over speculation.

## Live Tools Available
- scan_market: Run the 5-agent AI Brain to rank investment opportunities across stocks, ETFs, crypto (30+ scan universes, 3/6/12m horizons)
- get_recommendations: Get personalized buy signals using a named investor persona (Buffett, Dalio, Lynch, Burry, Wood, Marks, Soros, Greenblatt, Munger)
- analyze_symbol: Deep technical + AI analysis — RSI, MACD, EMA9/21/50/200, Bollinger, VWAP, OBV, patterns, entry/stop/target zones
- get_social_sentiment: Real-time multi-source sentiment (Reddit r/wallstreetbets + r/stocks, Google News headlines, Polymarket odds) for up to 8 tickers
- get_macro: Current macroeconomic indicators (14 FRED series), regime assessment, rates/inflation/VIX/credit spreads
- get_earnings_catalyst: Upcoming earnings date, EPS estimate, beat rate, and last 4 quarters of EPS surprise history — flag imminent binary events
- get_options_flow: Put/Call ratio, ATM implied volatility, and unusual options activity — smart-money directional conviction signal
- get_analyst_consensus: Wall Street analyst price target (median), analyst count, consensus rating (Strong Buy→Sell), forward P/E, forward EPS — compare institutional vs AI view
- get_insider_activity: OpenInsider insider buy/sell transactions (last 90d) + FINRA short interest for US stocks — net insider buying is a high-conviction bullish signal; not applicable to crypto/ETFs
- classify_symbol: Classify a ticker as equity/ETF/fund/crypto with sector, industry, market-cap bucket
- sector_universe: List top US equities in a GICS sector by market cap
- portfolio_risk: Sharpe, Sortino, VaR/CVaR, max drawdown, beta for the user's portfolio
- get_calibration: AI Brain track record — win rates, alpha, confidence calibration, vs mechanical TA baseline
- get_fundamentals: Investment-grade fundamentals — 4-quarter income statement, balance sheet, cash flow, valuation ratios (P/E, P/S, PEG, EV/EBITDA, FCF yield, ROE, ROIC), analyst buy/hold/sell distribution, EPS beat/miss history. US equities only (requires FMP key)
- get_price_performance: Price return vs S&P 500 over 1M, 3M, 6M, 1Y, YTD + 52-week high/low
- compare_stocks: Side-by-side fundamental comparison table for 2–5 stocks (margins, valuation, FCF, debt, ROE)

## Tool Routing Rules
- User asks about a specific ticker → call analyze_symbol first; ALWAYS add get_earnings_catalyst (imminent catalyst check); add get_analyst_consensus (institutional view); add get_options_flow for directional conviction; add get_insider_activity for US stocks (insider buy/sell signal); add get_social_sentiment if sentiment relevant
- User asks for institutional/fundamental analysis, forensic audit, "full report", or "analyze like a professional" → call get_fundamentals + analyze_symbol + get_earnings_catalyst + get_analyst_consensus + get_insider_activity + get_price_performance
- User asks "top picks", "what to buy", "scan the market" → call scan_market
- User asks for strategy recommendations by persona → call get_recommendations
- User asks about macro, rates, inflation, VIX, regime → call get_macro
- User asks about sentiment on a ticker → call get_social_sentiment
- User asks "what do analysts think of X" or "analyst target" → call get_analyst_consensus
- User asks about insider buying/selling, "are insiders buying?", short interest, short squeeze → call get_insider_activity
- User asks about earnings, EPS, next report date → call get_earnings_catalyst
- User asks about options, IV, put/call ratio → call get_options_flow
- User asks about portfolio risk, Sharpe, drawdown → call portfolio_risk
- User asks how reliable the AI is / track record → call get_calibration
- User asks about fundamentals, margins, FCF, balance sheet, valuation multiples → call get_fundamentals
- User asks about relative performance, "how has X done vs S&P", historical returns → call get_price_performance
- User asks to compare 2+ stocks side by side → call compare_stocks
- Combine tools freely — a full stock analysis warrants analyze_symbol + get_earnings_catalyst + get_analyst_consensus + get_options_flow

## Institutional Research Modes
When a user asks for a "full institutional report", "deep dive", "forensic audit", or "compare these stocks", follow these structured frameworks:

**Equity Intelligence Report** (triggered by: "institutional analysis", "full report", "analyze like a hedge fund"):
Call: get_fundamentals + analyze_symbol + get_earnings_catalyst + get_analyst_consensus + get_insider_activity + get_price_performance
Format: Business Overview → Revenue Architecture → Core Financials (table) → Equity Performance vs S&P → Analyst Sentiment → Technical Picture → Risks

**Financial Forensic Audit** (triggered by: "forensic audit", "balance sheet deep dive", "financial health check"):
Call: get_fundamentals
Format: Income Statement Diagnostics (4Q revenue, margins, margin trajectory) → Balance Sheet Strength (liquidity, debt, goodwill) → Cash Flow Validation (OCF, capex, FCF trend, capital allocation) → Risk Indicators (flag if: revenue growth diverges from FCF, debt growing faster than revenue, goodwill >30%)

**Earnings Intelligence** (triggered by: "earnings analysis", "decode the earnings", "earnings quality"):
Call: get_fundamentals + get_earnings_catalyst
Format: EPS Beat/Miss History → Trend Assessment → Guidance Context → Quality of earnings (structural vs cosmetic based on FCF vs GAAP earnings)

**Sector Comparison** (triggered by: "compare X vs Y", "sector matrix", "which is better"):
Call: compare_stocks + get_price_performance for each
Format: Quantitative table → Margin leaders → Valuation leaders → Strongest balance sheet → Overall ranking with justification

## Output Formats — Use These Templates

**Breaking News / Single Alert:**
🚨 [Headline] | ⏱️ [Time] | 📊 Impact: [price action] | 📝 [2-3 sentence summary] | ⚡ Why this matters: [context]

**Daily Brief (when asked for market overview):**
🌍 GLOBAL SNAPSHOT — [SPY/QQQ/crypto/macro one-liners]
📰 TOP STORIES — numbered list with source and impact
🔥 TRENDING TICKERS — symbol: why moving | Sentiment: Bullish/Neutral/Bearish
📅 EVENTS TODAY — earnings + macro releases
⚠️ RISK WATCH — emerging tail risk

**Deep Dive (when asked for full analysis):**
Executive Summary → Fundamental Analysis → Technical Picture → Sentiment & Flows → Valuation → Bull/Base/Bear cases → Risk/Reward

**Social Sentiment Report (when asked about social buzz):**
Platform breakdown → Sentiment score + trend → Narrative analysis → Manipulation risk flag

## Interaction Modes
- **Quick query**: direct answer with sources, concise
- **Research project**: multi-section report with methodology
- **Strategy evaluation**: classify risk level + time horizon + pro/con/risk + safer alternatives
- **Portfolio review**: monitor relevant news, flag concentration risks
- **Educational**: explain clearly with examples, no jargon gatekeeping

## Investment Strategy Classification
When evaluating strategies, always classify: risk level (Low/Medium/High/Very High/Extreme), time horizon, and data backing. Flag: recency bias, leverage risks, tail risk scenarios. Present bull and bear cases with equal rigor.

## Technical Analysis Protocol
- Multi-timeframe confirmation: check 1H, 4H, 1D, 1W for confluence
- Key levels: support/resistance, MA20/50/200, Fibonacci 38.2%/50%/61.8%
- Momentum: RSI overbought/oversold/divergence, MACD crossovers, volume confirmation
- Trend strength: ADX(14) ≥25 = strong trend (follow-trend signals more reliable); <20 = ranging/choppy (mean-reversion and counter-trend setups preferred)
- Bridge TA with fundamentals: breakout + earnings catalyst = higher conviction

## Source & Data Transparency
Tools provide live data from: internal AI Brain (5 agents), Reddit APIs, FRED macro series, Yahoo/Finnhub/FMP market data, FMP financial statements (income/balance/cash flow, 4 quarters), OpenInsider (insider transactions), and FINRA (short interest). SEC 13F institutional holdings, satellite data, and real-time options tape are not available — state this clearly rather than speculating.

## Guardrails (Non-Negotiable)
- Never provide personalized investment advice or tell users what to buy/sell
- Never guarantee returns or predict specific prices with certainty
- Never share unverified information as fact — label speculation explicitly
- Always end high-conviction outputs with: "Not financial advice — consult a qualified professional. Past performance does not guarantee future results."
- Present both bull and bear cases; surface contradictions and risks
- Format numbers: prices in $, percentages with %, scores /100
- Respect the user's portfolio — avoid suggesting stocks they already hold

## CRITICAL — Real-Time Data Rules
- NEVER quote a stock price, support level, resistance level, or price target from your training data
- ALL price references MUST come from the analyze_symbol tool result — the tool fetches live market data
- If a user asks about a specific ticker, you MUST call analyze_symbol FIRST before saying anything about price levels
- The tool result includes "Current Price" — always use that exact figure, never a memorized price
- Your training data prices are months or years out of date — using them will mislead users`

const TOOLS = [
  {
    name: 'scan_market',
    description: 'Scan the market using the 5-agent AI Brain and rank top investment opportunities. Returns ranked picks with composite scores, entry zones, and thesis.',
    input_schema: {
      type: 'object',
      properties: {
        scanMode: {
          type: 'string',
          description: 'Scan universe. Stocks: broad | stocks | stocks_tech | stocks_finance | stocks_healthcare | stocks_energy | stocks_consumer_disc | stocks_consumer_stap | stocks_industrials | stocks_materials | stocks_utilities | stocks_realestate | stocks_comms. ETFs: etfs_broad | etfs_sector | etfs_bond | etfs_intl | etfs_commodity | etfs_thematic | etfs_dividend | etfs_bitcoin. Crypto: crypto | crypto_defi | crypto_ai | crypto_meme | crypto_infra | crypto_exchange. Funds: mutualfunds | mutualfunds_index | mutualfunds_growth | mutualfunds_value | mutualfunds_bond | mutualfunds_intl | mutualfunds_balanced.',
          default: 'broad',
        },
        horizon: {
          type: 'string',
          enum: ['3m', '6m', '12m'],
          description: 'Investment time horizon',
          default: '6m',
        },
      },
    },
  },
  {
    name: 'get_recommendations',
    description: 'Get AI buy signal recommendations styled by a named investor persona. Returns 20 picks with entry, target, stop, and thesis.',
    input_schema: {
      type: 'object',
      properties: {
        persona: {
          type: 'string',
          enum: ['default', 'buffett', 'munger', 'lynch', 'dalio', 'burry', 'wood', 'marks', 'soros', 'greenblatt'],
          description: 'Investor persona to channel',
          default: 'default',
        },
        focusSymbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: specific symbols to focus on (e.g. ["NVDA", "TSLA"])',
        },
      },
    },
  },
  {
    name: 'analyze_symbol',
    description: 'Deep technical and AI analysis for a specific ticker. Returns signal (BUY/SELL/HOLD), entry zone, stop loss, take profit, and reasoning.',
    input_schema: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: {
          type: 'string',
          description: 'Ticker symbol (e.g. AAPL, BTC-USD, SPY)',
        },
        interval: {
          type: 'string',
          enum: ['1h', '4h', '1d', '1wk'],
          description: 'Chart interval for technical analysis',
          default: '1d',
        },
      },
    },
  },
  {
    name: 'get_social_sentiment',
    description: 'Fetch real-time multi-source sentiment for up to 8 tickers: Reddit (upvote-weighted bull/bear, top posts), Google News headlines (bullish/bearish keyword-scored), and Polymarket prediction-market odds for ticker events.',
    input_schema: {
      type: 'object',
      required: ['symbols'],
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of ticker symbols (max 5)',
        },
      },
    },
  },
  {
    name: 'get_macro',
    description: 'Get current macroeconomic indicators: interest rates, inflation, labor market, GDP, VIX, credit spreads, and AI-generated regime assessment.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_earnings_catalyst',
    description: 'Get upcoming earnings date, EPS estimate, analyst consensus, and last 4 quarters of EPS surprise history for a ticker. Use this before analyzing any stock to check if an earnings catalyst is imminent.',
    input_schema: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL, NVDA)' },
      },
    },
  },
  {
    name: 'get_options_flow',
    description: 'Get real-time options market data: put/call ratio, implied volatility, and unusual options activity (large bets vs open interest). Strong signal for smart-money positioning 1–3 weeks ahead.',
    input_schema: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL, TSLA)' },
      },
    },
  },
  {
    name: 'classify_symbol',
    description: 'Look up a symbol in the 300k-entry FinanceDatabase catalog: asset class (equity/etf/fund/crypto), GICS-style sector and industry, country, market-cap bucket, or ETF/fund category and family. Use when unsure what kind of instrument a ticker is.',
    input_schema: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL, VTSAX, BTC-USD)' },
      },
    },
  },
  {
    name: 'sector_universe',
    description: 'List the top US equities in a GICS sector, largest market-cap buckets first. Use to find comparable companies or build a sector watchlist.',
    input_schema: {
      type: 'object',
      required: ['sector'],
      properties: {
        sector: { type: 'string', description: 'Sector name, e.g. Information Technology, Energy, Health Care, Financials' },
        size:   { type: 'number', description: 'How many symbols to return (default 25, max 50)' },
      },
    },
  },
  {
    name: 'portfolio_risk',
    description: 'Measured portfolio risk vs SPY: Sharpe, Sortino, annualized volatility, max drawdown, 95% VaR/CVaR, weighted beta, and per-holding metrics — computed from real 1y price history. Uses the authenticated portfolio when no symbols are given.',
    input_schema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: analyze these symbols equal-weighted instead of the saved portfolio (max 20)',
        },
      },
    },
  },
  {
    name: 'critique_risk',
    description: "AI risk-officer critique of the measured portfolio risk report: overall assessment, up to 3 risk reductions and 2 return enhancers — each grounded in a cited computed figure (Sharpe, VaR, beta, drawdown, sector concentration, correlations), never invented numbers. Use when asked how to reduce portfolio risk, improve risk-adjusted returns, or review the portfolio's risk posture.",
    input_schema: {
      type: 'object',
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional: critique these symbols equal-weighted instead of the saved portfolio (max 20)',
        },
      },
    },
  },
  {
    name: 'get_calibration',
    description: "The AI Brain's measured track record: win rates and benchmark-beating alpha at 7d/30d, calibration by stated confidence, cross-model ensemble lift, how the AI compares to a mechanical TA baseline on identical picks, and a ranked edge report showing which segments (confidence, ensemble, asset, sector, pattern, score band) beat or drag the overall alpha win rate. Use when asked how reliable the AI's signals are or where its edge is concentrated.",
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_analyst_consensus',
    description: 'Get Wall Street analyst consensus for a stock: median price target, analyst count, recommendation mean (1=Strong Buy → 5=Strong Sell), forward P/E, and EPS estimates. Use to validate or challenge an AI thesis with institutional opinion.',
    input_schema: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL, NVDA, MSFT)' },
      },
    },
  },
  {
    name: 'get_insider_activity',
    description: 'Get insider buying/selling activity (OpenInsider, last 90 days) and short interest (FINRA) for a US stock. Net insider buying is a high-conviction bullish signal. High short interest (>15% float) signals squeeze risk or strong bearish conviction. Not available for crypto or ETFs.',
    input_schema: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'US stock ticker (e.g. AAPL, NVDA). Not applicable to crypto or ETFs.' },
      },
    },
  },
  {
    name: 'get_fundamentals',
    description: 'Investment-grade fundamentals for a US equity: 4-quarter income statement (revenue, gross/operating/net margins, EPS), balance sheet health (current ratio, quick ratio, debt/equity, goodwill %), TTM cash flow (OCF, capex, FCF, FCF margin, buybacks), valuation ratios (P/E, P/S, PEG, EV/EBITDA, FCF yield, ROE, ROIC), analyst buy/hold/sell distribution, and EPS beat/miss history. Use for institutional-quality analysis or when a user asks about fundamentals, financial statements, valuation, or earnings history.',
    input_schema: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'US stock ticker (e.g. AAPL, NVDA, MSFT). Not available for crypto or most ETFs.' },
      },
    },
  },
  {
    name: 'analyze_filing',
    description: "AI summary of a US company's latest SEC filing narrative (10-K, 10-Q, or 8-K) pulled directly from EDGAR: plain-English summary, notable changes vs prior periods, material risk factors, management tone, red flags, and an analyst takeaway grounded in the filing text. Distinct from get_fundamentals (the numbers) and earnings calls (the transcript) — this reads the MD&A and Risk Factors sections of the filing itself. Use when asked about a company's 10-K/10-Q/8-K, risk factors, MD&A, regulatory disclosures, or what a recent filing said.",
    input_schema: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'US stock ticker (e.g. AAPL, NVDA). EDGAR covers US-listed companies only; not crypto.' },
        form: { type: 'string', enum: ['10-K', '10-Q', '8-K'], description: 'Optional specific form type. Omit to use the most recent of any of these.' },
      },
    },
  },
  {
    name: 'get_price_performance',
    description: 'Price performance of a symbol vs the S&P 500 (SPY) over 1M, 3M, 6M, 1Y, and YTD — plus 52-week high/low. Use when asked about relative performance, "how has X done vs S&P", or historical returns.',
    input_schema: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL, TSLA, BTC-USD)' },
      },
    },
  },
  {
    name: 'compare_stocks',
    description: 'Side-by-side fundamental comparison table for 2–5 stocks: market cap, TTM revenue, YoY growth, gross/net margins, P/E, P/S, PEG, EV/EBITDA, FCF margin, debt/equity, current ratio, ROE. Use when asked to compare companies or build a competitive landscape.',
    input_schema: {
      type: 'object',
      required: ['symbols'],
      properties: {
        symbols: {
          type: 'array',
          items: { type: 'string' },
          description: 'List of 2–5 ticker symbols to compare (e.g. ["AAPL","MSFT","GOOGL"])',
        },
      },
    },
  },
  {
    name: 'propose_strategies',
    description: 'Strategy Lab: propose rule-based trading strategies (SMA crossover, RSI threshold, MACD signal, Bollinger reversion) tailored to a symbol\'s computed technicals — each proposal is then VALIDATED by a real backtest over historical daily bars. Returns per-proposal verified metrics (total return, Sharpe, max drawdown, win rate, alpha vs buy & hold) and a validated/mixed/rejected verdict. All numbers come from the backtest engine, never the AI. Use when asked for a trading strategy, system, or rules for a symbol.',
    input_schema: {
      type: 'object',
      required: ['symbol'],
      properties: {
        symbol: { type: 'string', description: 'Ticker symbol (e.g. AAPL, BTC-USD, SPY)' },
        range:  { type: 'string', enum: ['1y', '2y', '5y'], description: 'Historical range to design for and validate against (default 2y)' },
      },
    },
  },
  {
    name: 'read_url',
    description: "Fetch and read a SPECIFIC web page the user provides — e.g. an investor-relations page, press release, regulatory notice, or a news/analyst article not covered by the other tools — and return its main content as clean text for analysis. Use ONLY when the user gives (or clearly points at) a particular URL. This is NOT a web search and NOT for crawling — one page the user named.",
    input_schema: {
      type: 'object',
      required: ['url'],
      properties: {
        url: { type: 'string', description: 'The full http(s) URL of the page to read.' },
      },
    },
  },
]

// ── Internal tool dispatcher ──────────────────────────────────────────────────

async function dispatchTool(name, input, req) {
  const port = process.env.PORT || 3001
  const fwdHeaders = { 'Content-Type': 'application/json', 'x-internal': '1', 'x-internal-secret': INTERNAL_SECRET }
  // Forward auth token so internal loopback calls to protected routes pass requireAuth
  if (req.headers.authorization) fwdHeaders['authorization'] = req.headers.authorization
  for (const k of ['x-aisa-key', 'x-finnhub-key', 'x-fmp-key', 'x-td-key', 'x-av-key']) {
    if (req.headers[k]) fwdHeaders[k] = req.headers[k]
  }

  switch (name) {
    case 'scan_market': {
      const r = await fetch(`http://127.0.0.1:${port}/api/ai-brain/analyze`, {
        method: 'POST', headers: fwdHeaders,
        body: JSON.stringify({ scanMode: input.scanMode || 'broad', horizon: input.horizon || '6m' }),
        signal: AbortSignal.timeout(120_000),
      })
      const data = await r.json()
      if (!data.rankedStocks) return `Scan failed: ${data.error || 'unknown error'}`
      const top = data.rankedStocks.slice(0, 8)
      return (
        `Market Regime: ${data.marketRegime} · ${data.macroOutlook}\n\n` +
        top.map((s, i) =>
          `${i + 1}. **${s.symbol}** — ${s.agentVerdict} (score ${s.compositeScore}/100)${s.highConviction ? ' ⭐ HIGH CONVICTION' : ''}\n` +
          `   Entry $${s.entryZoneLow}–$${s.entryZoneHigh} · Target $${s.targetZoneLow}–$${s.targetZoneHigh} · Stop $${s.stopZoneLow}–$${s.stopZoneHigh}\n` +
          (s.catalyst ? `   ⚡ Catalyst: ${s.catalyst}\n` : '') +
          `   ${s.supervisorSynthesis}\n` +
          (s.agentConflict?.exists ? `   ⚠️ Conflict: ${s.agentConflict.meaning}` : '')
        ).join('\n')
      )
    }

    case 'get_recommendations': {
      const holdings = Array.isArray(req.body?.portfolio) ? req.body.portfolio : []
      const r = await fetch(`http://127.0.0.1:${port}/api/recommendations`, {
        method: 'POST', headers: fwdHeaders,
        body: JSON.stringify({ persona: input.persona || 'default', focusSymbols: input.focusSymbols || [], holdings }),
        signal: AbortSignal.timeout(60_000),
      })
      const data = await r.json()
      if (!data.recommendations) return `Failed: ${data.error || 'unknown error'}`
      const top = data.recommendations.slice(0, 6)
      return (
        `**${data.persona?.name || 'AI'} Recommendations** · ${data.marketOutlook}\n\n` +
        top.map((rec, i) =>
          `${i + 1}. **${rec.symbol}** (${rec.type}, ${rec.period}) — ${rec.risk} risk\n` +
          `   Entry $${rec.entryPrice} · Target $${rec.takeProfitPrice} (+${rec.targetReturn}%) · Stop $${rec.stopLossPrice} (-${rec.stopLoss}%)\n` +
          `   ${rec.thesis}\n` +
          `   Catalyst: ${rec.catalyst}`
        ).join('\n\n')
      )
    }

    case 'analyze_symbol': {
      const rawSym  = input.symbol || ''
      // Convert schema-friendly names to TradingView interval keys
      const TV_INTERVAL = { '1h': '60', '4h': '240', '1d': 'D', '1wk': 'W', 'D': 'D', 'W': 'W' }
      const interval = TV_INTERVAL[input.interval] || 'D'

      // Pre-fetch live quote so trading-analysis uses current price, not stale bar close
      let livePrice = null
      try {
        const qr = await fetch(
          `http://127.0.0.1:${port}/api/quote?symbols=${encodeURIComponent(rawSym)}`,
          { headers: fwdHeaders, signal: AbortSignal.timeout(5000) }
        )
        const qd = await qr.json()
        const lp = qd?.quoteResponse?.result?.[0]?.regularMarketPrice
        if (lp && lp > 0) livePrice = lp
      } catch { /* proceed without live price */ }

      const [r, altSnippet] = await Promise.all([
        fetch(`http://127.0.0.1:${port}/api/trading-analysis/analyze`, {
          method: 'POST', headers: fwdHeaders,
          body: JSON.stringify({ symbol: rawSym, interval, livePrice }),
          signal: AbortSignal.timeout(30_000),
        }),
        getAltData(rawSym),
      ])
      const data = await r.json()
      const a = data.analysis
      if (!a?.signal) return `Analysis failed for ${input.symbol}: ${data.error || 'unknown error'}`
      const displayPrice = livePrice || a.entry || data.price
      return (
        `**${input.symbol}** [LIVE PRICE: $${displayPrice}] — Signal: **${a.signal}** (${a.confidence}% confidence)\n` +
        `Current Price: $${displayPrice} (use THIS price — do not use any other price)\n` +
        `Entry $${a.entry} (zone $${a.entryZoneLow}–$${a.entryZoneHigh})\n` +
        `Stop $${a.stopLoss} · Target $${a.target}\n\n` +
        `${a.summary}\n\n` +
        (a.contradictions?.length ? `⚠️ Contradictions: ${a.contradictions.join('; ')}\n` : '') +
        (a.risks?.length ? `Risks: ${a.risks.join(' | ')}` : '') +
        (altSnippet ? `\n${altSnippet}` : '')
      )
    }

    case 'get_social_sentiment': {
      const symbols = (input.symbols || []).slice(0, 8)
      const snippet = await getSocialSentiment(symbols)
      return snippet || 'No Reddit data available for these symbols right now.'
    }

    case 'get_macro': {
      const r = await fetch(`http://127.0.0.1:${port}/api/macro/summary`, {
        headers: fwdHeaders,
        signal: AbortSignal.timeout(15_000),
      })
      const data = await r.json()
      return typeof data === 'string' ? data : (data.macroSummary || JSON.stringify(data))
    }

    case 'get_earnings_catalyst': {
      const sym = (input.symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '')
      if (!sym) return 'No symbol provided.'

      const [dateRes, surpriseRes] = await Promise.allSettled([
        fetch(`http://127.0.0.1:${port}/api/earnings/date?symbol=${sym}`, {
          headers: fwdHeaders, signal: AbortSignal.timeout(10_000),
        }).then(r => r.json()),
        fetch(`http://127.0.0.1:${port}/api/earnings/positioning?symbols=${sym}`, {
          headers: fwdHeaders, signal: AbortSignal.timeout(12_000),
        }).then(r => r.json()),
      ])

      const dateData     = dateRes.status === 'fulfilled'     ? dateRes.value     : null
      const surpriseData = surpriseRes.status === 'fulfilled' ? surpriseRes.value : null
      const surprise     = surpriseData?.[0] || null

      const daysUntil = dateData?.nextEarningsDate
        ? Math.round((new Date(dateData.nextEarningsDate) - Date.now()) / 86400000)
        : null

      let lines = [`**${sym} Earnings Catalyst**`]

      if (dateData?.nextEarningsDate) {
        lines.push(`📅 Next Earnings: ${dateData.nextEarningsDate} (in ${daysUntil} days)`)
        if (daysUntil <= 14) lines.push(`⚠️ IMMINENT — earnings in ≤14 days; elevated volatility risk`)
      } else {
        lines.push('📅 Next Earnings: Date not yet confirmed')
      }

      if (dateData?.epsEstimate) lines.push(`EPS Estimate: $${dateData.epsEstimate}`)
      if (dateData?.revenueEstimate) lines.push(`Revenue Estimate: ${dateData.revenueEstimate}`)

      if (surprise) {
        const beatRate = surprise.beat_rate != null
          ? `${Math.round(surprise.beat_rate * 100)}% (${surprise.beat_count}/${surprise.total_quarters} quarters)`
          : 'N/A'
        const avgSurprise = surprise.avg_eps_surprise_pct != null
          ? `${surprise.avg_eps_surprise_pct > 0 ? '+' : ''}${surprise.avg_eps_surprise_pct.toFixed(1)}%`
          : 'N/A'
        lines.push(`\nEPS Beat Rate (last ${surprise.total_quarters}q): ${beatRate}`)
        lines.push(`Avg EPS Surprise: ${avgSurprise}`)
        if (surprise.recent_quarters?.length) {
          lines.push('\nRecent EPS History:')
          surprise.recent_quarters.slice(0, 4).forEach(q => {
            if (!q.period) return
            const sp = q.surprise_pct != null ? ` (${q.surprise_pct > 0 ? '+' : ''}${q.surprise_pct.toFixed(1)}% surprise)` : ''
            lines.push(`  ${q.period}: actual $${q.actual ?? '?'} vs est $${q.estimate ?? '?'}${sp}`)
          })
        }
      }

      if (daysUntil != null && daysUntil <= 21 && surprise?.avg_eps_surprise_pct > 5)
        lines.push('\n📊 Signal: Strong historical beat rate + imminent earnings = high-probability catalyst.')
      else if (daysUntil != null && daysUntil <= 7)
        lines.push('\n📊 Signal: Earnings very close — options IV typically elevated. High binary risk event.')

      return lines.join('\n') || `No earnings data available for ${sym}.`
    }

    case 'get_options_flow': {
      const sym = (input.symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '')
      if (!sym) return 'No symbol provided.'
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/options/flow?symbol=${sym}`, {
          headers: fwdHeaders, signal: AbortSignal.timeout(12_000),
        })
        if (!r.ok) return `Options data unavailable for ${sym} (HTTP ${r.status})`
        const data = await r.json()
        return data.snippet || JSON.stringify(data)
      } catch (e) {
        return `Options flow fetch failed for ${sym}: ${e.message}`
      }
    }

    case 'classify_symbol': {
      const sym = (input.symbol || '').toUpperCase().replace(/[^A-Z0-9.\-=]/g, '')
      if (!sym) return 'No symbol provided.'
      if (!symbolDb.stats().loaded) return 'Symbol catalog not loaded yet — it populates shortly after server start and refreshes weekly.'
      const rec = symbolDb.classify(sym)
      if (!rec) return `${sym} not found in the symbol catalog (covers US equities + global ETFs/funds/crypto).`
      if (rec.assetClass === 'equity')
        return `${rec.symbol} — ${rec.name} | equity | Sector: ${rec.sector || '?'} | Industry: ${rec.industry || '?'} | ${rec.country || '?'} | ${rec.marketCap || '?'}`
      if (rec.assetClass === 'crypto')
        return `${rec.symbol} — ${rec.name} | cryptocurrency (base: ${rec.base})`
      return `${rec.symbol} — ${rec.name} | ${rec.assetClass} | Category: ${rec.categoryGroup || '?'} / ${rec.category || '?'} | Family: ${rec.family || '?'}`
    }

    case 'sector_universe': {
      if (!symbolDb.stats().loaded) return 'Symbol catalog not loaded yet — it populates shortly after server start and refreshes weekly.'
      const size = Math.min(Math.max(parseInt(input.size) || 25, 1), 50)
      const syms = symbolDb.sectorUniverse(input.sector || '', { size })
      if (syms.length) return `Top ${syms.length} US ${input.sector} equities by cap bucket: ${syms.join(', ')}`
      const sectors = symbolDb.listSectors().map(s => s.sector).filter(Boolean)
      return `No equities found for sector "${input.sector}". Available sectors: ${sectors.join(', ')}`
    }

    case 'portfolio_risk': {
      const qs = Array.isArray(input.symbols) && input.symbols.length
        ? `?symbols=${input.symbols.slice(0, 20).map(s => String(s).toUpperCase()).join(',')}`
        : ''
      const r = await fetch(`http://127.0.0.1:${port}/api/analytics/portfolio${qs}`, {
        headers: fwdHeaders, signal: AbortSignal.timeout(45_000),
      })
      if (!r.ok) return `Portfolio analytics unavailable (HTTP ${r.status}).`
      const d = await r.json()
      if (!d.symbols?.length) return 'No holdings found — add positions to your portfolio or pass symbols explicitly.'
      const p = d.riskMetrics?.portfolio, b = d.riskMetrics?.benchmark
      const lines = [`**Portfolio Risk** (${d.symbols.length} holdings vs ${d.benchmark}, 1y daily, ${p?.weighting || 'equal'}-weighted)`]
      if (p) lines.push(
        `Sharpe ${p.sharpe ?? 'N/A'} | Sortino ${p.sortino ?? 'N/A'} | Vol ${p.volatility ?? 'N/A'}% | MaxDD ${p.maxDrawdown ?? 'N/A'}% | AnnRet ${p.annualReturn ?? 'N/A'}%`,
        `1-day VaR(95) ${p.var95 ?? 'N/A'}% | CVaR(95) ${p.cvar95 ?? 'N/A'}% | Portfolio beta ${d.portfolioBeta ?? 'N/A'}`)
      if (b) lines.push(`${d.benchmark} benchmark: Sharpe ${b.sharpe ?? 'N/A'} | Vol ${b.volatility ?? 'N/A'}% | MaxDD ${b.maxDrawdown ?? 'N/A'}% | AnnRet ${b.annualReturn ?? 'N/A'}%`)
      const hr = d.riskMetrics?.holdings || {}
      const rows = Object.entries(hr).slice(0, 20).map(([s, h]) =>
        `  ${s}: Sharpe ${h.sharpe ?? 'N/A'}, MaxDD ${h.maxDrawdown ?? 'N/A'}%, AnnRet ${h.annualReturn ?? 'N/A'}%, beta ${d.betas?.[s] ?? 'N/A'}`)
      if (rows.length) lines.push('Per holding:', ...rows)
      if (d.sectors?.length) lines.push(`Sector weights: ${d.sectors.map(s => `${s.name} ${s.weight}%`).join(', ')}`)
      return lines.join('\n')
    }

    case 'critique_risk': {
      const body = Array.isArray(input.symbols) && input.symbols.length
        ? { symbols: input.symbols.slice(0, 20) }
        : {}
      const r = await fetch(`http://127.0.0.1:${port}/api/analytics/portfolio/critique`, {
        method: 'POST', headers: fwdHeaders,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(90_000),
      })
      const data = await r.json()
      if (!data.critique) return `Risk critique failed: ${data.error || 'unknown error'}`
      const c = data.critique
      const item = (x, i) => `${i + 1}. ${x.action}\n   Evidence: ${x.evidence}`
      const lines = [`**Portfolio Risk Critique** (${data.symbols.length} holdings — grounded in measured 1y metrics)`, c.assessment]
      if (c.riskReductions.length) lines.push('\n**Reduce risk:**', ...c.riskReductions.map(item))
      if (c.returnEnhancers.length) lines.push('\n**Enhance return (risk-neutral):**', ...c.returnEnhancers.map(item))
      if (c.watchItems.length) lines.push('\n**Watch:** ' + c.watchItems.join(' · '))
      lines.push('\n_Advisory only — nothing is executed. Figures cited come from computed portfolio analytics._')
      return lines.join('\n')
    }

    case 'get_calibration': {
      const stats = computeStats(readPredictions())
      if (!stats.totalResolved) return 'No resolved predictions yet — the track record builds as AI Brain picks age past 7 and 30 days.'
      const pc = v => v == null ? 'N/A' : `${Math.round(v * 100)}%`
      const lines = [`**AI Brain Track Record** (${stats.totalResolved} resolved predictions)`]
      const hz = (label, h) => h && lines.push(
        `${label}: win ${pc(h.winRate)} | beats benchmark ${pc(h.alphaWinRate)} | avg ${h.avgReturn ?? 'N/A'}% (alpha ${h.avgAlpha ?? 'N/A'}%) | target hit ${pc(h.targetHitRate)} | n=${h.nTradeable} tradeable (${h.neverEntered} never filled)`)
      hz('7d', stats.h7); hz('30d', stats.h30)
      if (stats.h90) hz('90d', stats.h90)
      const cal = Object.entries(stats.calibration || {})
      if (cal.length) lines.push('Confidence calibration: ' + cal.map(([k, c]) => `${k} ${pc(c.alphaWinRate ?? c.winRate)} (n=${c.n})`).join(' | '))
      if (stats.ensemble) lines.push('Cross-model ensemble: ' + Object.entries(stats.ensemble).map(([k, c]) => `${k} ${pc(c.alphaWinRate ?? c.winRate)} (n=${c.n})`).join(' | '))
      if (stats.baseline) lines.push(
        `Vs mechanical TA baseline (n=${stats.baseline.n}, 7d): AI win ${pc(stats.baseline.aiWinRate7d)} vs baseline accuracy ${pc(stats.baseline.baselineAccuracy7d)}; AI wins ${pc(stats.baseline.aiWinWhenBaselineAgrees)} when baseline agrees, ${pc(stats.baseline.aiWinWhenBaselineDisagrees)} when it disagrees`)
      if (stats.byCompositeScore) {
        const bands = { low: '<40', mid: '40-69', high: '70-79', elite: '≥80' }
        lines.push('Composite score calibration: ' + Object.entries(stats.byCompositeScore).map(([k, c]) => `score ${bands[k] ?? k} → ${pc(c.alphaWinRate ?? c.winRate)} alpha (n=${c.n})`).join(' | '))
      }
      if (stats.byHighConviction?.['true'] && stats.byHighConviction?.['false']) {
        const hc  = stats.byHighConviction['true']
        const std = stats.byHighConviction['false']
        lines.push(`High-conviction picks: ${pc(hc.alphaWinRate ?? hc.winRate)} alpha (n=${hc.n}) vs standard ${pc(std.alphaWinRate ?? std.winRate)} (n=${std.n})`)
      }
      if (stats.byRsRank) {
        const order = ['strong', 'mid', 'weak']
        const labels = { strong: 'RS 71-100', mid: 'RS 31-70', weak: 'RS 0-30' }
        const parts = order.filter(k => stats.byRsRank[k]).map(k => `${labels[k]} ${pc(stats.byRsRank[k].alphaWinRate ?? stats.byRsRank[k].winRate)} (n=${stats.byRsRank[k].n})`)
        if (parts.length) lines.push('RS rank calibration: ' + parts.join(' | '))
      }
      if (stats.byVolumeSignal) {
        const parts = Object.entries(stats.byVolumeSignal).map(([k, c]) => `${k} ${pc(c.alphaWinRate ?? c.winRate)} (n=${c.n})`)
        if (parts.length) lines.push('Volume signal calibration: ' + parts.join(' | '))
      }
      if (stats.earningsWindowImpact) {
        const order = ['imminent', 'upcoming', 'distant']
        const labels = { imminent: '≤7d', upcoming: '8-21d', distant: '>21d' }
        const parts = order.filter(k => stats.earningsWindowImpact[k]).map(k => `earnings ${labels[k]} ${pc(stats.earningsWindowImpact[k].alphaWinRate ?? stats.earningsWindowImpact[k].winRate)} (n=${stats.earningsWindowImpact[k].n})`)
        if (parts.length) lines.push('Earnings window impact: ' + parts.join(' | '))
      }
      if (stats.optionsFlowImpact) {
        const order = ['bullish', 'neutral', 'bearish']
        const parts = order.filter(k => stats.optionsFlowImpact[k]).map(k => `P/C ${k} ${pc(stats.optionsFlowImpact[k].alphaWinRate ?? stats.optionsFlowImpact[k].winRate)} (n=${stats.optionsFlowImpact[k].n})`)
        if (parts.length) lines.push('Options flow impact: ' + parts.join(' | '))
      }
      if (stats.conflictImpact?.conflict && stats.conflictImpact?.noConflict) {
        const c = stats.conflictImpact.conflict, nc = stats.conflictImpact.noConflict
        lines.push(`Agent conflict impact: no-conflict ${pc(nc.alphaWinRate ?? nc.winRate)} alpha (n=${nc.n}) vs conflict ${pc(c.alphaWinRate ?? c.winRate)} (n=${c.n})`)
      }
      if (stats.byPattern) {
        const sorted = Object.entries(stats.byPattern).sort((a, b) => (b[1].alphaWinRate ?? 0) - (a[1].alphaWinRate ?? 0)).slice(0, 6)
        if (sorted.length) lines.push('Top TA patterns (alpha win): ' + sorted.map(([k, c]) => `${k} ${pc(c.alphaWinRate ?? c.winRate)} (n=${c.n})`).join(' | '))
      }
      if (stats.bySector) {
        const sorted = Object.entries(stats.bySector).sort((a, b) => b[1].n - a[1].n).slice(0, 6)
        if (sorted.length) lines.push('By sector (top picks): ' + sorted.map(([k, c]) => `${k} ${pc(c.alphaWinRate ?? c.winRate)} alpha (n=${c.n})`).join(' | '))
      }
      // Cross-segment edge mining: rank every calibration segment by measured
      // edge vs the overall alpha win rate (lib/edge-report.js)
      const edgeText = edgeBlock(computeEdgeReport(stats))
      if (edgeText) lines.push(edgeText)
      return lines.join('\n')
    }

    case 'get_analyst_consensus': {
      const sym = (input.symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '')
      if (!sym) return 'No symbol provided.'
      try {
        // /api/summary returns FMP fundamentals (PE, margins, DCF target, sector)
        // /api/quote returns live price
        const [sumR, qR] = await Promise.all([
          fetch(`http://127.0.0.1:${port}/api/summary?symbol=${encodeURIComponent(sym)}`,
            { headers: fwdHeaders, signal: AbortSignal.timeout(12_000) }),
          fetch(`http://127.0.0.1:${port}/api/quote?symbols=${encodeURIComponent(sym)}`,
            { headers: fwdHeaders, signal: AbortSignal.timeout(8_000) }),
        ])
        const [sumD, qD] = await Promise.all([sumR.json(), qR.json()])

        const qs = qD?.quoteResponse?.result?.[0]
        const price = qs?.regularMarketPrice ?? null

        const r0 = sumD?.quoteSummary?.result?.[0]
        const fd  = r0?.financialData     || {}
        const sd  = r0?.summaryDetail     || {}
        const ks  = r0?.defaultKeyStatistics || {}
        const ap  = r0?.assetProfile      || {}

        // DCF intrinsic value from FMP (serves as a price target proxy)
        const dcfTarget   = fd.targetMeanPrice  ?? null
        const recKey      = fd.recommendationKey ?? null
        const trailPE     = sd.trailingPE       ?? null
        const mktCap      = sd.marketCap        ?? null
        const roe         = fd.returnOnEquity   ?? null
        const margins     = fd.profitMargins    ?? null
        const revenueGrow = fd.revenueGrowth    ?? null
        const trailEps    = ks.trailingEps      ?? null
        const sector      = ap.sector           ?? null
        const country     = ap.country          ?? null

        if (!r0) return `No fundamental data available for ${sym} — not covered by FMP (common for crypto, ETFs, non-US equities).`

        const upside = (dcfTarget != null && price != null && price > 0)
          ? ((dcfTarget - price) / price * 100).toFixed(1)
          : null

        const lines = [`**${sym} — Fundamentals & Valuation**`]
        if (sector)    lines.push(`Sector: ${sector}${country ? ` · ${country}` : ''}`)
        if (price)     lines.push(`Price: $${price.toFixed(2)}`)
        if (dcfTarget != null) lines.push(`📊 DCF Intrinsic Value: $${dcfTarget.toFixed(2)}${upside != null ? ` (${upside > 0 ? '+' : ''}${upside}% vs current)` : ''}`)
        if (recKey)    lines.push(`🎯 FMP Signal: ${recKey.toUpperCase()} (based on DCF vs market price)`)
        if (trailPE != null) lines.push(`📈 Trailing P/E: ${trailPE.toFixed(1)}`)
        if (trailEps != null) lines.push(`💵 Trailing EPS: $${trailEps.toFixed(2)}`)
        if (mktCap != null)  lines.push(`Market Cap: $${(mktCap / 1e9).toFixed(1)}B`)
        if (roe != null)     lines.push(`Return on Equity: ${(roe * 100).toFixed(1)}%`)
        if (margins != null) lines.push(`Net Margin: ${(margins * 100).toFixed(1)}%`)
        if (revenueGrow != null) lines.push(`Revenue Growth (TTM): ${(revenueGrow * 100).toFixed(1)}%`)

        if (upside != null) {
          if (parseFloat(upside) > 20)  lines.push(`\n✅ Trading below DCF intrinsic value — value upside signal.`)
          else if (parseFloat(upside) < -10) lines.push(`\n⚠️ Trading above DCF intrinsic value — elevated valuation vs fundamentals.`)
        }
        lines.push(`\n_Note: Price target derived from FMP DCF model, not sell-side analyst estimates._`)
        return lines.join('\n')
      } catch (e) {
        return `Analyst consensus fetch failed for ${sym}: ${e.message}`
      }
    }

    case 'get_insider_activity': {
      const sym = (input.symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '')
      if (!sym) return 'No symbol provided.'
      if (sym.includes('-USD')) return `${sym} is a crypto asset — insider activity data is not applicable.`
      try {
        const snippet = await getAltData(sym)
        if (!snippet) return `No insider or short interest data found for ${sym} in the last 90 days (OpenInsider + FINRA).`
        return snippet
      } catch (e) {
        return `Insider activity fetch failed for ${sym}: ${e.message}`
      }
    }

    case 'get_fundamentals': {
      const sym = (input.symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '')
      if (!sym) return 'No symbol provided.'
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/fundamentals/${sym}`, {
          headers: fwdHeaders, signal: AbortSignal.timeout(20_000),
        })
        if (!r.ok) {
          const e = await r.json().catch(() => ({}))
          return e.error || `Fundamentals unavailable for ${sym} (HTTP ${r.status})`
        }
        const d = await r.json()

        const lines = []
        if (d.company) {
          lines.push(`**${d.company.name || sym} (${sym}) — Investment-Grade Fundamentals**`)
          const meta = [d.company.sector, d.company.industry, d.company.country].filter(Boolean).join(' · ')
          if (meta) lines.push(meta)
          if (d.company.mkt_cap_fmt) lines.push(`Market Cap: ${d.company.mkt_cap_fmt}${d.company.beta != null ? ` · Beta: ${d.company.beta.toFixed(2)}` : ''}`)
          if (d.company.description) lines.push(`\n${d.company.description}`)
        } else {
          lines.push(`**${sym} — Investment-Grade Fundamentals**`)
        }

        if (d.quarters?.length) {
          lines.push('\n**📊 Revenue & Margins (last 4 quarters)**')
          lines.push('| Quarter | Revenue | Gross % | Oper % | Net % | EPS (dil) |')
          lines.push('|---------|---------|---------|--------|-------|-----------|')
          for (const q of d.quarters) {
            lines.push(`| ${q.date?.slice(0, 7) || q.period || '—'} | ${q.revenue_fmt || '—'} | ${q.gross_margin != null ? q.gross_margin + '%' : '—'} | ${q.operating_margin != null ? q.operating_margin + '%' : '—'} | ${q.net_margin != null ? q.net_margin + '%' : '—'} | ${q.eps_diluted != null ? '$' + q.eps_diluted.toFixed(2) : '—'} |`)
          }
          lines.push(`**TTM Revenue: ${d.ttm_revenue_fmt || '—'}**${d.yoy_rev_growth != null ? ` · YoY: ${d.yoy_rev_growth > 0 ? '+' : ''}${d.yoy_rev_growth}%` : ''}`)
          const latQ = d.quarters[0]
          if (latQ?.rd_pct_rev != null) lines.push(`R&D as % of revenue (latest Q): ${latQ.rd_pct_rev}%`)
        }

        if (d.balance?.date) {
          lines.push('\n**🏦 Balance Sheet**')
          const b = d.balance
          const liquidCash = (b.cash ?? 0) + (b.short_term_inv ?? 0)
          if (liquidCash) lines.push(`Cash + ST Investments: ${ ((v) => v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : `$${(v/1e6).toFixed(0)}M`)(liquidCash) }`)
          if (b.total_debt != null) lines.push(`Total Debt: ${ ((v) => v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : `$${(v/1e6).toFixed(0)}M`)(b.total_debt) }`)
          if (b.current_ratio != null) lines.push(`Current Ratio: ${b.current_ratio}x${b.quick_ratio != null ? ` · Quick Ratio: ${b.quick_ratio}x` : ''}`)
          if (b.debt_to_equity != null) lines.push(`Debt/Equity: ${b.debt_to_equity}x`)
          if (b.goodwill_pct != null) {
            const flag = b.goodwill_pct > 30 ? ' ⚠️ >30% — review for impairment risk' : ''
            lines.push(`Goodwill: ${b.goodwill_pct}% of total assets${flag}`)
          }
        }

        if (d.cashflow) {
          lines.push('\n**💵 Cash Flow (TTM)**')
          const c = d.cashflow
          const fmtB = v => v == null ? '—' : (v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : `$${(v/1e6).toFixed(0)}M`)
          if (c.ttm_operating_cf != null) lines.push(`Operating CF: ${fmtB(c.ttm_operating_cf)}`)
          if (c.ttm_capex != null) lines.push(`CapEx: ${fmtB(c.ttm_capex)}`)
          if (c.ttm_fcf != null) lines.push(`Free Cash Flow: ${fmtB(c.ttm_fcf)}${c.fcf_margin != null ? ` (FCF margin: ${c.fcf_margin}%)` : ''}`)
          const alloc = []
          if (c.ttm_buybacks) alloc.push(`Buybacks: ${fmtB(c.ttm_buybacks)}`)
          if (c.ttm_dividends) alloc.push(`Dividends: ${fmtB(c.ttm_dividends)}`)
          if (alloc.length) lines.push(`Capital Allocation: ${alloc.join(' · ')}`)
        }

        if (d.valuation) {
          lines.push('\n**📈 Valuation (TTM)**')
          const v = d.valuation
          const parts = []
          if (v.pe_ttm   != null) parts.push(`P/E: ${v.pe_ttm.toFixed(1)}x`)
          if (v.ps_ttm   != null) parts.push(`P/S: ${v.ps_ttm.toFixed(1)}x`)
          if (v.pb_ttm   != null) parts.push(`P/B: ${v.pb_ttm.toFixed(1)}x`)
          if (v.peg_ttm  != null) parts.push(`PEG: ${v.peg_ttm.toFixed(2)}`)
          if (v.ev_ebitda != null) parts.push(`EV/EBITDA: ${v.ev_ebitda.toFixed(1)}x`)
          if (v.fcf_yield != null) parts.push(`FCF Yield: ${v.fcf_yield}%`)
          if (v.roe != null)  parts.push(`ROE: ${v.roe}%`)
          if (v.roic != null) parts.push(`ROIC: ${v.roic}%`)
          if (parts.length) lines.push(parts.join(' · '))
        }

        if (d.analyst_dist?.total) {
          lines.push('\n**🎯 Analyst Distribution**')
          const a = d.analyst_dist
          lines.push(`${a.total} analysts — Buy: ${a.buy_pct ?? '?'}% · Hold: ${a.hold_pct ?? '?'}% · Sell: ${a.sell_pct ?? '?'}%`)
        }

        if (d.eps_surprises?.length) {
          lines.push('\n**📅 EPS Beat/Miss History**')
          lines.push('| Period | Estimate | Actual | Surprise |')
          lines.push('|--------|----------|--------|----------|')
          for (const s of d.eps_surprises) {
            const surStr = s.surprise_pct != null ? `${s.surprise_pct > 0 ? '+' : ''}${s.surprise_pct}%` : '—'
            lines.push(`| ${s.date?.slice(0, 7) || '—'} | ${s.estimate != null ? '$' + s.estimate.toFixed(2) : '—'} | ${s.actual != null ? '$' + s.actual.toFixed(2) : '—'} | ${surStr} |`)
          }
        }

        lines.push(`\n_Source: FMP · ${d.generated_at?.slice(0, 10)} · Not financial advice_`)
        return lines.join('\n')
      } catch (e) {
        return `Fundamentals fetch failed for ${sym}: ${e.message}`
      }
    }

    case 'analyze_filing': {
      const sym = (input.symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '')
      if (!sym) return 'No symbol provided.'
      const qs = input.form ? `?form=${encodeURIComponent(input.form)}` : ''
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/filings/${sym}${qs}`, {
          headers: fwdHeaders, signal: AbortSignal.timeout(45_000),
        })
        if (!r.ok) {
          const e = await r.json().catch(() => ({}))
          return e.error || `Filing analysis unavailable for ${sym} (HTTP ${r.status})`
        }
        const d = await r.json()
        const lines = [`**${d.company || sym} (${sym}) — SEC ${d.form} (filed ${d.filingDate || '—'})**`]
        if (d.summary) lines.push(`\n${d.summary}`)
        if (d.managementTone) lines.push(`\n**Management tone:** ${d.managementTone}`)
        if (d.keyChanges?.length) lines.push('\n**Notable changes**\n' + d.keyChanges.map(x => `- ${x}`).join('\n'))
        if (d.riskFactors?.length) lines.push('\n**Material risks**\n' + d.riskFactors.map(x => `- ${x}`).join('\n'))
        if (d.redFlags?.length) lines.push('\n**🚩 Red flags**\n' + d.redFlags.map(x => `- ${x}`).join('\n'))
        if (d.analystTakeaway) lines.push(`\n**Takeaway:** ${d.analystTakeaway}`)
        lines.push(`\n_Source: SEC EDGAR ${d.form} · ${d.source || ''} · Not financial advice_`)
        return lines.join('\n')
      } catch (e) {
        return `Filing analysis failed for ${sym}: ${e.message}`
      }
    }

    case 'get_price_performance': {
      const sym = (input.symbol || '').toUpperCase().replace(/[^A-Z0-9.-]/g, '')
      if (!sym) return 'No symbol provided.'
      try {
        const [symR, spyR] = await Promise.all([
          fetch(`http://127.0.0.1:${port}/api/chart?symbol=${encodeURIComponent(sym)}&interval=1d&range=1y`,
            { headers: fwdHeaders, signal: AbortSignal.timeout(15_000) }),
          fetch(`http://127.0.0.1:${port}/api/chart?symbol=SPY&interval=1d&range=1y`,
            { headers: fwdHeaders, signal: AbortSignal.timeout(15_000) }),
        ])
        if (!symR.ok) return `Price history unavailable for ${sym}`
        const [symData, spyData] = await Promise.all([symR.json(), spyR.json()])

        function normBars(data) {
          const result = data?.chart?.result?.[0]
          if (!result) return []
          const timestamps = result.timestamp || []
          const quote  = result.indicators?.quote?.[0] || {}
          const closes = quote.close || []
          const highs  = quote.high  || []
          const lows   = quote.low   || []
          return timestamps.map((t, i) => ({
            ts:    t * 1000,
            close: closes[i] ?? null,
            high:  highs[i]  ?? null,
            low:   lows[i]   ?? null,
          })).filter(b => b.ts && b.close != null)
        }

        const symBars = normBars(symData)
        const spyBars = normBars(spyData)
        if (!symBars.length) return `No price history found for ${sym}`

        function retAt(bars, daysAgo) {
          const cutoff = Date.now() - daysAgo * 86400000
          const base = bars.find(b => b.ts >= cutoff)
          const last = bars[bars.length - 1]
          if (!base?.close || !last?.close) return null
          return parseFloat(((last.close - base.close) / base.close * 100).toFixed(2))
        }

        function ytdRet(bars) {
          const jan1 = new Date(new Date().getFullYear(), 0, 1).getTime()
          const base = bars.find(b => b.ts >= jan1)
          const last = bars[bars.length - 1]
          if (!base?.close || !last?.close) return null
          return parseFloat(((last.close - base.close) / base.close * 100).toFixed(2))
        }

        const lastPrice  = symBars[symBars.length - 1]?.close
        const last52High = Math.max(...symBars.map(b => b.high ?? b.close))
        const last52Low  = Math.min(...symBars.map(b => b.low  ?? b.close))
        const fmtR = r => r == null ? '—' : `${r > 0 ? '+' : ''}${r}%`

        const lines = [`**${sym} Price Performance vs S&P 500**`]
        if (lastPrice) lines.push(`Current: $${lastPrice.toFixed(2)} · 52W High: $${last52High.toFixed(2)} · 52W Low: $${last52Low.toFixed(2)}`)

        lines.push('\n| Period | ' + sym + ' | SPY | vs S&P 500 |')
        lines.push('|--------|' + '-'.repeat(sym.length + 2) + '|-----|------------|')

        for (const [label, days] of [['1M', 30], ['3M', 90], ['6M', 182], ['1Y', 365]]) {
          const sr  = retAt(symBars, days)
          const br  = spyBars.length ? retAt(spyBars, days) : null
          const rel = (sr != null && br != null) ? parseFloat((sr - br).toFixed(2)) : null
          lines.push(`| ${label} | ${fmtR(sr)} | ${fmtR(br)} | ${rel == null ? '—' : fmtR(rel)} |`)
        }

        const ytdS = ytdRet(symBars)
        const ytdB = spyBars.length ? ytdRet(spyBars) : null
        const ytdRel = (ytdS != null && ytdB != null) ? parseFloat((ytdS - ytdB).toFixed(2)) : null
        lines.push(`| YTD | ${fmtR(ytdS)} | ${fmtR(ytdB)} | ${fmtR(ytdRel)} |`)

        lines.push('\n_Source: FMP historical prices_')
        return lines.join('\n')
      } catch (e) {
        return `Price performance fetch failed for ${sym}: ${e.message}`
      }
    }

    case 'compare_stocks': {
      const rawSyms = Array.isArray(input.symbols) ? input.symbols : String(input.symbols || '').split(',')
      const syms = rawSyms.map(s => String(s).toUpperCase().replace(/[^A-Z0-9.-]/g, '')).filter(Boolean).slice(0, 5)
      if (syms.length < 2) return 'Provide at least 2 symbols to compare (max 5).'
      try {
        const results = await Promise.all(syms.map(sym =>
          fetch(`http://127.0.0.1:${port}/api/fundamentals/${sym}`, {
            headers: fwdHeaders, signal: AbortSignal.timeout(20_000),
          }).then(r => r.json()).catch(() => null)
        ))

        const valid = results.filter(d => d && !d.error && d.quarters?.length)
        if (!valid.length) return `No fundamental data available for: ${syms.join(', ')} — FMP coverage required (US equities only)`

        const lines = [`**Competitive Comparison: ${syms.join(' vs ')}**`]
        const sectors = [...new Set(results.map(d => d?.company?.sector).filter(Boolean))]
        if (sectors.length) lines.push(`Sector: ${sectors.join(' / ')}`)

        const header = `| Metric | ${syms.join(' | ')} |`
        const divider = `|--------|${syms.map(() => '------').join('|')}|`
        lines.push('', header, divider)

        function row(label, fn) {
          const vals = results.map(d => {
            if (!d || d.error) return 'N/A'
            try { return fn(d) ?? '—' } catch { return '—' }
          })
          lines.push(`| ${label} | ${vals.join(' | ')} |`)
        }

        const fmtB = v => v == null ? null : (v >= 1e9 ? `$${(v/1e9).toFixed(1)}B` : `$${(v/1e6).toFixed(0)}M`)

        row('Market Cap',     d => d.company?.mkt_cap_fmt)
        row('TTM Revenue',    d => d.ttm_revenue_fmt)
        row('Rev YoY',        d => d.yoy_rev_growth != null ? `${d.yoy_rev_growth > 0 ? '+' : ''}${d.yoy_rev_growth}%` : null)
        row('Gross Margin',   d => d.quarters?.[0]?.gross_margin != null ? `${d.quarters[0].gross_margin}%` : null)
        row('Oper Margin',    d => d.quarters?.[0]?.operating_margin != null ? `${d.quarters[0].operating_margin}%` : null)
        row('Net Margin',     d => d.quarters?.[0]?.net_margin != null ? `${d.quarters[0].net_margin}%` : null)
        row('P/E (TTM)',      d => d.valuation?.pe_ttm != null ? `${d.valuation.pe_ttm.toFixed(1)}x` : null)
        row('P/S (TTM)',      d => d.valuation?.ps_ttm != null ? `${d.valuation.ps_ttm.toFixed(1)}x` : null)
        row('PEG',            d => d.valuation?.peg_ttm != null ? d.valuation.peg_ttm.toFixed(2) : null)
        row('EV/EBITDA',      d => d.valuation?.ev_ebitda != null ? `${d.valuation.ev_ebitda.toFixed(1)}x` : null)
        row('FCF Margin',     d => d.cashflow?.fcf_margin != null ? `${d.cashflow.fcf_margin}%` : null)
        row('FCF (TTM)',      d => fmtB(d.cashflow?.ttm_fcf))
        row('Debt/Equity',    d => d.balance?.debt_to_equity != null ? `${d.balance.debt_to_equity}x` : null)
        row('Current Ratio',  d => d.balance?.current_ratio != null ? `${d.balance.current_ratio}x` : null)
        row('ROE',            d => d.valuation?.roe != null ? `${d.valuation.roe}%` : null)
        row('ROIC',           d => d.valuation?.roic != null ? `${d.valuation.roic}%` : null)

        // Analyst sentiment row
        row('Analyst Mix',    d => {
          const a = d.analyst_dist
          if (!a?.total) return null
          return `${a.buy_pct ?? '?'}% Buy`
        })

        lines.push('\n_Source: FMP · Not financial advice_')
        return lines.join('\n')
      } catch (e) {
        return `Comparison failed: ${e.message}`
      }
    }

    case 'propose_strategies': {
      const r = await fetch(`http://127.0.0.1:${port}/api/strategy-lab/propose`, {
        method: 'POST', headers: fwdHeaders,
        body: JSON.stringify({ symbol: input.symbol, range: input.range || '2y' }),
        signal: AbortSignal.timeout(90_000),
      })
      const data = await r.json()
      if (!data.proposals) return `Strategy Lab failed: ${data.error || 'unknown error'}`
      const VERDICT_ICON = { validated: '✅', mixed: '🟡', insufficient_trades: '⚪', rejected: '❌' }
      return (
        `**Strategy Lab — ${data.symbol}** (${data.range}, ${data.dataPoints} daily bars, backtest-verified)\n` +
        (data.taLine ? `Technicals: ${data.taLine}\n` : '') + '\n' +
        data.proposals.map((p, i) => {
          const m = p.metrics
          return (
            `${i + 1}. ${VERDICT_ICON[p.verdict] || ''} **${p.name}** — ${p.strategy} ${JSON.stringify(p.params)} · verdict: ${p.verdict}\n` +
            (m ? `   Return ${m.totalReturn}% vs buy&hold ${m.buyHoldReturn}% (alpha ${m.alpha}%) · Sharpe ${m.sharpeRatio} · MaxDD ${m.maxDrawdown}% · ${m.totalTrades} trades, ${m.winRate}% win\n` : '') +
            (p.recent ? `   Recent window: return ${p.recent.totalReturn}% (alpha ${p.recent.alpha}%), ${p.recent.totalTrades} trades\n` : '') +
            `   ${p.rationale}${p.marketFit ? `\n   Best in: ${p.marketFit}` : ''}`
          )
        }).join('\n\n') +
        '\n\n_All metrics computed by the backtest engine on real historical bars — the AI only proposed the rules. Past performance ≠ future results._'
      )
    }

    case 'read_url': {
      const url = String(input.url || '').trim()
      if (!/^https?:\/\/.+/i.test(url)) return 'Please provide a valid http(s) URL to read.'
      if (!process.env.FIRECRAWL_API_KEY) return 'Web-page reading is not configured on the server (FIRECRAWL_API_KEY missing).'
      try {
        // Firecrawl fetches the page server-side (SSRF stays on their infra, not
        // ours) and returns clean markdown; we compact it to keep tokens down.
        const r = await fetch('https://api.firecrawl.dev/v1/scrape', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.FIRECRAWL_API_KEY}` },
          body: JSON.stringify({ url, formats: ['markdown'], onlyMainContent: true }),
          signal: AbortSignal.timeout(45_000),
        })
        if (!r.ok) {
          const e = await r.json().catch(() => ({}))
          return `Could not read ${url}: ${e.error || `Firecrawl HTTP ${r.status}`}`
        }
        const d  = await r.json()
        const md = d?.data?.markdown || d?.markdown || ''
        if (!md.trim()) return `No readable content could be extracted from ${url}.`
        const { compactProse } = require('../lib/compress')
        const clean = compactProse(md)
        const body  = clean.slice(0, 12000)
        const title = d?.data?.metadata?.title || d?.metadata?.title || url
        return `**${title}**\n${url}\n\n${body}${clean.length > 12000 ? '\n\n…(truncated)' : ''}\n\n_Source: ${url} · not financial advice_`
      } catch (e) {
        return `Failed to read ${url}: ${e.message}`
      }
    }

    default:
      return `Unknown tool: ${name}`
  }
}

// ── Planner: detect ticker deep-analysis queries ──────────────────────────────
// Returns the ticker symbol if the last user message is a deep-analysis request,
// null otherwise. Used to trigger the parallel pre-fetch fast path.
const DEEP_ANALYSIS_RE = /\b(analyz[ei]|analysis|check|look at|deep dive|research|breakdown|full report|what do you think of|should i buy|should i sell|tell me about|thesis on|outlook for|price target)\b/i
const TICKER_RE = /\b([A-Z]{1,5}(?:-USD)?)\b/g

function detectTickerQuery(messages) {
  const lastUser = [...messages].reverse().find(m => m.role === 'user')
  if (!lastUser) return null
  const text = typeof lastUser.content === 'string' ? lastUser.content : ''
  if (!DEEP_ANALYSIS_RE.test(text)) return null
  const tickers = [...text.matchAll(TICKER_RE)].map(m => m[1])
  // Filter out common English words that look like tickers
  const SKIP = new Set(['A','I','AM','AN','AT','BE','BY','DO','GO','IF','IN','IS','IT','ME','MY','NO','OF','ON','OR','SO','TO','UP','US','WE','AND','ARE','FOR','HAS','NOT','THE','WAS'])
  const valid = tickers.filter(t => !SKIP.has(t))
  return valid.length === 1 ? valid[0] : null
}

// Run all analysis tools in parallel for a ticker — DeerFlow-style Planner step
async function runPlannerPrefetch(ticker, req, send) {
  const isCrypto = ticker.includes('-USD')
  const tools = [
    { name: 'analyze_symbol',         input: { symbol: ticker } },
    { name: 'get_earnings_catalyst',  input: { symbol: ticker } },
    { name: 'get_options_flow',       input: { symbol: ticker } },
    { name: 'get_social_sentiment',   input: { symbols: [ticker] } },
    { name: 'get_analyst_consensus',  input: { symbol: ticker } },
  ]
  if (!isCrypto) tools.push({ name: 'get_insider_activity', input: { symbol: ticker } })
  send({ type: 'tool_start', tools })

  const [technical, earnings, options, social, analyst, insider] = await Promise.allSettled([
    dispatchTool('analyze_symbol',        { symbol: ticker },       req),
    dispatchTool('get_earnings_catalyst', { symbol: ticker },       req),
    dispatchTool('get_options_flow',      { symbol: ticker },       req),
    dispatchTool('get_social_sentiment',  { symbols: [ticker] },    req),
    dispatchTool('get_analyst_consensus', { symbol: ticker },       req),
    isCrypto ? Promise.resolve(null) : dispatchTool('get_insider_activity', { symbol: ticker }, req),
  ])

  send({ type: 'tool_results', results: [
    { tool: 'analyze_symbol',        preview: technical.value?.slice?.(0, 100) },
    { tool: 'get_earnings_catalyst', preview: earnings.value?.slice?.(0, 100) },
    { tool: 'get_options_flow',      preview: options.value?.slice?.(0, 100) },
    { tool: 'get_social_sentiment',  preview: social.value?.slice?.(0, 100) },
    { tool: 'get_analyst_consensus', preview: analyst.value?.slice?.(0, 100) },
    ...(isCrypto ? [] : [{ tool: 'get_insider_activity', preview: insider.value?.slice?.(0, 100) }]),
  ]})

  return {
    technical:  technical.status  === 'fulfilled' ? technical.value  : null,
    earnings:   earnings.status   === 'fulfilled' ? earnings.value   : null,
    options:    options.status    === 'fulfilled' ? options.value    : null,
    social:     social.status     === 'fulfilled' ? social.value     : null,
    analyst:    analyst.status    === 'fulfilled' ? analyst.value    : null,
    insider:    (!isCrypto && insider.status === 'fulfilled') ? insider.value : null,
  }
}

const REPORTER_SYSTEM = `You are a senior equity analyst synthesising pre-fetched live data into a structured investment report.

You have been given live tool results. Do NOT call any tools — all data is already provided in the user message.

Produce a concise structured report using this format:

## [TICKER] — [BUY/SELL/HOLD] Signal

**Current Price:** $X · **Confidence:** X%

### Technical Picture
[3-4 sentences from the technical analysis data — include RSI level, MACD trend, ADX trend strength (≥25=trending/follow-trend, <20=ranging/mean-reversion), EMA stack, and volume signal]

### Earnings Catalyst
[Next earnings date, EPS estimate, surprise history — flag if imminent]

### Options Flow
[P/C ratio interpretation, ATM IV, any unusual activity and what it implies]

### Social Sentiment
[Reddit upvote-weighted signal + Google News headlines + Polymarket odds if available]

### Analyst Consensus
[Median price target, upside %, consensus rating, forward P/E — flag if AI and analysts diverge significantly]

### Insider Activity & Short Interest
[Net insider buying/selling signal, notable transactions, FINRA short ratio — skip section if data unavailable]

### Verdict
[2-3 sentences: bull case, bear case, risk/reward. Entry zone and stop. Note any AI vs analyst divergence or insider signal.]

---
*Not financial advice. All data is live as of analysis time.*`

// ── Provider registry (claudian-style providerId + providerState) ─────────────

const PROVIDER_DEFAULTS = {
  claude: { model: 'claude-sonnet-4-6' },
  groq:   { model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' },
  codex:  { model: 'gpt-4o',                  baseUrl: 'https://api.openai.com/v1' },
}

// Convert Anthropic tool format → OpenAI function calling format
function toOpenAITools(tools) {
  return tools.map(t => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema },
  }))
}

// Convert messages to OpenAI format (flatten Anthropic content blocks)
function toOpenAIMessages(system, messages) {
  const out = system ? [{ role: 'system', content: system }] : []
  for (const m of messages) {
    if (typeof m.content === 'string') {
      out.push({ role: m.role, content: m.content })
    } else if (Array.isArray(m.content)) {
      // Anthropic content blocks → OpenAI
      const textParts = m.content.filter(b => b.type === 'text').map(b => b.text).join('')
      const toolResults = m.content.filter(b => b.type === 'tool_result')
      if (toolResults.length) {
        for (const tr of toolResults) {
          out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: typeof tr.content === 'string' ? tr.content : JSON.stringify(tr.content) })
        }
      } else if (m.role === 'assistant') {
        // Check for tool_use blocks
        const toolUses = m.content.filter(b => b.type === 'tool_use')
        if (toolUses.length) {
          out.push({
            role: 'assistant',
            content: textParts || null,
            tool_calls: toolUses.map(tu => ({
              id: tu.id, type: 'function',
              function: { name: tu.name, arguments: JSON.stringify(tu.input) },
            })),
          })
        } else {
          if (textParts) out.push({ role: m.role, content: textParts })
        }
      } else {
        if (textParts) out.push({ role: m.role, content: textParts })
      }
    }
  }
  return out
}

/**
 * Run one agentic turn using an OpenAI-compatible provider (Groq, Codex).
 * Non-streaming for simplicity; we fake-stream the text back word by word.
 */
async function runOpenAITurn({ model, baseUrl, apiKey, system, messages, tools, send, dispatchFn, req, maxIter = 5 }) {
  const oaiTools = toOpenAITools(tools)
  let loopMessages = toOpenAIMessages(system, messages)
  let iterations = 0

  while (iterations < maxIter) {
    iterations++
    const r = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: loopMessages, tools: oaiTools, tool_choice: 'auto', max_tokens: 4096 }),
      signal: AbortSignal.timeout(90_000),
    })
    if (!r.ok) {
      const err = await r.text()
      throw new Error(`Provider error ${r.status}: ${err.slice(0, 200)}`)
    }
    const data = await r.json()
    const choice = data.choices?.[0]
    const msg = choice?.message

    // Stream text back word by word for UX parity with Claude streaming
    if (msg?.content) {
      const words = msg.content.split(/(\s+)/)
      for (const w of words) send({ type: 'text', delta: w })
    }

    // Handle tool calls
    const toolCalls = msg?.tool_calls || []
    if (!toolCalls.length) break

    send({ type: 'tool_start', tools: toolCalls.map(tc => ({ name: tc.function.name, input: JSON.parse(tc.function.arguments || '{}') })) })

    const toolResults = await Promise.all(toolCalls.map(async tc => {
      let parsed = {}
      try { parsed = JSON.parse(tc.function.arguments || '{}') } catch {}
      try {
        const output = await dispatchFn(tc.function.name, parsed, req)
        return { role: 'tool', tool_call_id: tc.id, content: output }
      } catch (err) {
        return { role: 'tool', tool_call_id: tc.id, content: `Error: ${err.message}` }
      }
    }))

    send({ type: 'tool_results', results: toolResults.map(tr => ({ tool: tr.tool_call_id, preview: tr.content?.slice?.(0, 120) })) })

    loopMessages.push({
      role: 'assistant',
      content: msg.content || null,
      tool_calls: toolCalls,
    })
    loopMessages.push(...toolResults)
  }
}

// ── SSE streaming chat handler ─────────────────────────────────────────────────

router.post('/chat', requireAuth, chatLimit, async (req, res) => {
  const { messages = [], portfolio = [], watchlist = [], providerId = 'claude', providerState = {} } = req.body

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders?.()

  const send = (payload) => {
    res.write(`data: ${JSON.stringify(payload)}\n\n`)
  }

  try {
    const contextBlock = (portfolio.length || watchlist.length)
      ? `\nUser context — Portfolio: ${portfolio.join(', ') || 'none'} · Watchlist: ${watchlist.join(', ') || 'none'}`
      : ''

    const systemPrompt = COPILOT_SYSTEM + contextBlock

    // ── Route to the correct provider ──────────────────────────────────────────
    const providerKey = (providerId || 'claude').toLowerCase()
    const defaults = PROVIDER_DEFAULTS[providerKey] || PROVIDER_DEFAULTS.claude
    const model = providerState.model || defaults.model
    // baseUrl is always taken from server-side PROVIDER_DEFAULTS — never from the
    // client-supplied providerState, which would allow SSRF and API key theft.
    const baseUrl = defaults.baseUrl

    // Claude paused for quota preservation: transparently serve the default
    // Claude provider via Groq so chat keeps working. Falls back to a clear
    // message only if Groq isn't configured. Explicit groq/codex pass through.
    if (claudePaused() && providerKey !== 'groq' && providerKey !== 'codex') {
      if (!process.env.GROQ_API_KEY) {
        send({ type: 'error', message: pauseMessage() })
        res.end(); return
      }
      const g = PROVIDER_DEFAULTS.groq
      await runOpenAITurn({
        model: g.model, baseUrl: g.baseUrl, apiKey: process.env.GROQ_API_KEY, system: systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        tools: TOOLS, send, dispatchFn: dispatchTool, req, maxIter: 5,
      })
      send({ type: 'done' })
      res.end(); return
    }

    if (providerKey === 'groq' || providerKey === 'codex') {
      const apiKey = providerKey === 'groq' ? process.env.GROQ_API_KEY : process.env.OPENAI_API_KEY
      if (!apiKey) {
        send({ type: 'error', message: `${providerKey} API key not configured on server` })
        res.end(); return
      }
      await runOpenAITurn({
        model, baseUrl, apiKey, system: systemPrompt,
        messages: messages.map(m => ({ role: m.role, content: m.content })),
        tools: TOOLS, send, dispatchFn: dispatchTool, req, maxIter: 5,
      })
      send({ type: 'done' })
      res.end(); return
    }

    // ── Claude provider (default) — native streaming tool_use ──────────────────

    // Planner fast-path: for single-ticker deep analysis, pre-fetch all tools in
    // parallel (DeerFlow-style), inject results as context so Claude synthesises
    // in one shot rather than 3-4 sequential tool-use rounds.
    let loopMessages = messages.map(m => ({ role: m.role, content: m.content }))
    const plannerTicker = detectTickerQuery(messages)
    if (plannerTicker) {
      const data = await runPlannerPrefetch(plannerTicker, req, send)
      const contextMsg = [
        `LIVE PRE-FETCHED DATA FOR ${plannerTicker} (all tools already executed in parallel):`,
        data.technical  ? `\n=== TECHNICAL ANALYSIS ===\n${data.technical}`        : '',
        data.earnings   ? `\n=== EARNINGS CATALYST ===\n${data.earnings}`          : '',
        data.options    ? `\n=== OPTIONS FLOW ===\n${data.options}`                : '',
        data.social     ? `\n=== SOCIAL SENTIMENT ===\n${data.social}`             : '',
        data.analyst    ? `\n=== ANALYST CONSENSUS ===\n${data.analyst}`           : '',
        data.insider    ? `\n=== INSIDER ACTIVITY & SHORT INTEREST ===\n${data.insider}` : '',
        `\n\nOriginal user question: ${messages.at(-1)?.content || ''}`,
        '\nSynthesize ALL the above into a structured investment report. Do NOT call any tools.',
      ].join('')

      // Use Reporter system prompt for synthesis pass
      const stream = await anthropic.messages.stream({
        model, max_tokens: 4096,
        system: REPORTER_SYSTEM + contextBlock,
        messages: [{ role: 'user', content: contextMsg }],
      })
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          send({ type: 'text', delta: event.delta.text })
        }
      }
      send({ type: 'done' })
      res.end(); return
    }

    let iterations = 0
    const MAX_ITER = 5

    while (iterations < MAX_ITER) {
      iterations++

      const stream = await anthropic.messages.stream({
        model,
        max_tokens: 4096,
        system: systemPrompt,
        tools: TOOLS,
        messages: loopMessages,
      })

      let assistantContent = []
      let currentText = ''
      let toolUseBlocks = []

      for await (const event of stream) {
        if (event.type === 'content_block_start') {
          if (event.content_block.type === 'text') {
            currentText = ''
          } else if (event.content_block.type === 'tool_use') {
            toolUseBlocks.push({ id: event.content_block.id, name: event.content_block.name, input: '' })
          }
        } else if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            currentText += event.delta.text
            send({ type: 'text', delta: event.delta.text })
          } else if (event.delta.type === 'input_json_delta' && toolUseBlocks.length) {
            toolUseBlocks[toolUseBlocks.length - 1].input += event.delta.partial_json
          }
        } else if (event.type === 'content_block_stop') {
          if (currentText) {
            assistantContent.push({ type: 'text', text: currentText })
            currentText = ''
          }
        } else if (event.type === 'message_delta') {
          if (event.delta.stop_reason === 'end_turn' || event.delta.stop_reason === 'tool_use') {
            for (const tb of toolUseBlocks) {
              let parsed = {}
              try { parsed = JSON.parse(tb.input || '{}') } catch {}
              assistantContent.push({ type: 'tool_use', id: tb.id, name: tb.name, input: parsed })
            }
          }
        }
      }

      loopMessages.push({ role: 'assistant', content: assistantContent })

      // Check if we need tool execution
      const toolUses = assistantContent.filter(b => b.type === 'tool_use')
      if (!toolUses.length) break // no more tools — done

      // Execute all tools in parallel
      send({ type: 'tool_start', tools: toolUses.map(t => ({ name: t.name, input: t.input })) })

      const toolResults = await Promise.all(
        toolUses.map(async (tu) => {
          try {
            const output = await dispatchTool(tu.name, tu.input, req)
            return { type: 'tool_result', tool_use_id: tu.id, content: output }
          } catch (err) {
            return { type: 'tool_result', tool_use_id: tu.id, content: `Error: ${err.message}`, is_error: true }
          }
        })
      )

      send({ type: 'tool_results', results: toolResults.map(r => ({ tool: r.tool_use_id, preview: r.content?.slice?.(0, 120) })) })
      loopMessages.push({ role: 'user', content: toolResults })
    }

    send({ type: 'done' })
  } catch (err) {
    console.error('[copilot]', err.message)
    send({ type: 'error', message: err.message })
  } finally {
    res.end()
  }
})

module.exports = router
// Shared with routes/mcp.js so the MCP endpoint exposes the same registry
module.exports.TOOLS = TOOLS
module.exports.dispatchTool = dispatchTool
