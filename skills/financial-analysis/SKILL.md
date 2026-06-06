# Financial Analysis Skill

FinSurfing's AI financial analysis engine. Use this skill to analyze markets, generate trade signals, and scan investment universes.

## Available API Endpoints

### Market Scanner — 5-Agent AI Brain
```
POST /api/ai-brain/analyze
Body: { scanMode, horizon, symbols?, holdings? }
```
Scans 40+ universes (broad, stocks_tech, crypto_l1, etfs_sector, mutualfunds, etc.) using a 5-agent contradiction engine. Returns ranked picks with:
- compositeScore (0-100), agentVerdict (Strong Buy / Buy / Hold / Sell)
- entryZoneLow/High, targetZoneLow/High, stopZoneLow/High
- fundamentalScore, technicalScore, sentimentScore, macroScore, riskScore
- supervisorSynthesis, agentConflict (surfaces 25+ point spreads)
- thesisAssumptions (3 falsifiable conditions), thesisBreaker

### Buy Signals — Persona-Based Recommendations
```
POST /api/recommendations
Body: { holdings?, focusSymbols?, persona, includeMacro }
```
Generates 20 buy recommendations (7 stocks 3m + 5 stocks 6m + 4 ETFs + 3 crypto + 1 high-conviction).
Personas: buffett, munger, lynch, dalio, burry, wood, marks, soros, greenblatt, default.
Returns: entryPrice, takeProfitPrice, stopLossPrice, thesis, catalyst, technicalSignal, bearCase, thesisBreaker.

### Technical Analysis — Per-Symbol AI Signal
```
POST /api/trading-analysis/analyze?symbol=NVDA&interval=1d
```
Computes RSI(14), MACD(12,26,9), EMA(9/21/50/200), Bollinger Bands, ATR, StochRSI, VWAP, OBV, S/R levels.
Returns: signal (BUY/SELL/HOLD), confidence (0-100), entry/stop/target zones, riskReward, contradictions[].

### Social Sentiment — Reddit/X
```
GET /api/social-sentiment/:symbol
```
Fetches live Reddit posts from r/wallstreetbets, r/stocks, r/investing.
Returns: mentionCount, bullishPct, bearishPct, topPosts[].

### Macro Indicators — FRED
```
GET /api/macro/indicators
GET /api/macro/summary
```
14 FRED series: Fed Funds Rate, CPI, Core PCE, Unemployment, GDP, PMI, VIX, Credit Spreads, 10Y/2Y Yield, Housing, M2.
Returns: regime assessment (risk-on/risk-off/stagflation/recession), AI macro summary string.

### Streaming Chat — Agentic Copilot
```
POST /api/copilot/chat   (SSE)
Body: { messages, portfolio, watchlist }
```
Agentic loop with tool dispatch: scan_market, get_recommendations, analyze_symbol, get_social_sentiment, get_macro.
Streams: { type: "text"|"tool_start"|"tool_results"|"done" }

## Scan Universe Codes

| Code | Description |
|------|-------------|
| broad | Top 20 across all asset classes |
| stocks | All-sector top 20 US equities |
| stocks_tech | NVDA, MSFT, AAPL, GOOGL, META… |
| stocks_finance | JPM, GS, V, MA, BRK-B… |
| stocks_healthcare | LLY, UNH, JNJ, ABBV… |
| stocks_energy | XOM, CVX, COP… |
| etfs_broad | SPY, QQQ, VTI, IWM… |
| etfs_sector | XLK, XLE, XLF, XLV… |
| etfs_bond | TLT, AGG, HYG, LQD… |
| etfs_commodity | GLD, SLV, USO, GDX… |
| etfs_thematic | ARKK, BOTZ, HACK, ICLN… |
| crypto | BTC-USD, ETH-USD, SOL-USD… |
| crypto_l1 | Layer 1 chains |
| crypto_defi | DeFi protocols |
| crypto_ai | AI tokens: FET, RNDR, WLD… |
| mutualfunds | Top 20 across categories |
| mutualfunds_growth | FCNTX, FDGRX, AGTHX… |

## AI Model Stack
- Primary: claude-sonnet-4-6 (Anthropic)
- Fallback: llama-3.3-70b-versatile (Groq) on 529 overload
- Circuit breaker: 3 consecutive failures → 60s cooldown
