# Portfolio Management Skill

FinSurfing's portfolio tracking, analytics, and optimization tools.

## Endpoints

### Holdings (requires auth)
```
GET  /api/portfolio          — list positions
POST /api/portfolio          — add holding { symbol, shares, avgCost }
PUT  /api/portfolio/:id      — update holding
DELETE /api/portfolio/:id    — remove holding
```

### Analytics
```
GET /api/analytics/portfolio       — performance, Sharpe, beta, allocation breakdown
POST /api/backtest                 — backtest a strategy or set of holdings
POST /api/rebalancer/suggest       — suggest rebalancing to target allocation
POST /api/monte-carlo              — Monte Carlo simulation for portfolio projections
```

### Goals & Risk
```
GET/POST /api/goals                — financial goals with progress tracking
GET/POST /api/risk-rules           — custom risk rules (stop-loss alerts, position-size limits)
```

### Live Quotes
```
GET /api/quote?symbols=AAPL,NVDA,BTC-USD   — batch live quotes (multi-provider fallback)
```
Returns: regularMarketPrice, regularMarketChangePercent, marketCap, trailingPE, 52w high/low, volume.

Provider cascade: Finnhub → AISA → FMP → AlphaVantage → Nasdaq → TwelveData → cache.
Crypto: Binance → CoinGecko.
Mutual funds: FMP only (NAV quotes).

## Key Concepts

**Portfolio Schema:**
```json
{ "id": "uuid", "symbol": "NVDA", "shares": 10, "avgCost": 450.00,
  "currentPrice": 900.00, "gainLoss": 4500.00, "gainLossPct": 100.0 }
```

**API Keys (client-supplied via headers):**
- x-finnhub-key, x-fmp-key, x-td-key, x-av-key, x-aisa-key
- Fallback to server env vars if not provided

**Auth:** JWT access token (15min) + HTTP-only refresh cookie (7d).
All portfolio routes require `Authorization: Bearer <token>`.
