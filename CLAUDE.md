# CLAUDE.md

Guide Claude Code (claude.ai/code) for this repo.

## Commands
`npm run dev` — Vite:5173 + Express:3001 concurrently | `npm run build` → dist/ | `node server.js` — prod only. No tests/lint.

## Stack
React18+Vite SPA → Express API proxy. Dev: Vite proxies `/api/*` → :3001. Prod: single process :3001 serves dist/+API.

## Routes (`routes/`)
- `auth.js` — JWT in-memory + HTTP-only refresh cookie
- `market.js` — quote/search/chart, multi-provider fallback
- `portfolio.js` — CRUD holdings; Postgres → in-memory memstore fallback
- `ai-brain.js` — market scanner; Claude primary + Groq `llama-3.3-70b-versatile` fallback; circuit breaker `getBreaker()`
- `trading-analysis.js` — per-symbol AI; Claude `claude-sonnet-4-6`
- `recommendations.js` — AI Advisory; Claude primary + Groq fallback; accepts `persona` (see `lib/investor-personas.js`) + `includeMacro` body params; GET `/personas` returns persona list
- `macro.js` — FRED macro indicators (14 series); requires `FRED_API_KEY` env var; 1h cache; `getIndicators()` exported for prompt injection
- `market-focus.js` — intraday session focus; GET returns cached AI analysis of top items to watch (holdings + watchlist + macro); POST `/refresh` triggers fresh run (`requireAuth`); refreshes every 30 min during market hours via `lib/scheduled-jobs.js:intradayFocusHandler`
- `copilot.js` — streaming agentic chat (`requireAuth`); multi-provider (Claude native stream → Groq/OpenAI-compat fallback); SSRF-safe: `baseUrl` always from server-side `PROVIDER_DEFAULTS`, never from request body

**DB**: `DATABASE_URL` → Postgres; missing → memstore. Schema: `db/schema.sql`.
**Client state**: localStorage: watchlist, alerts, AI watchlist, `finsurf_api_keys`. Portfolio → DB when authed.

## Market Data Pipeline (`server.js`)
- `KNOWN_CRYPTO` (~80) → Binance → CoinGecko (`COINGECKO_IDS` map)
- `KNOWN_MUTUAL_FUNDS` (~120) → FMP only (NAV quotes)
- Else → Finnhub → AISA → FMP → AlphaVantage → Nasdaq → TwelveData → cache

**ETF detection** `isEtfLike(s)`: `s!=null && s.pe==null && s.revenueGrowth==null && s.earningsGrowth==null`
**FMP search** ETF keywords (no leading space): vanguard, ishares, spdr, invesco, schwab, fidelity, blackrock, direxion, proshares, wisdomtree, etf, fund, trust
**TwelveData search**: allows AMEX/CBOE/BATS exchanges; ETF instrument_type always passes

## API Keys
`extractKeys(req)` in server.js: headers `x-aisa-key` `x-finnhub-key` `x-fmp-key` `x-td-key` `x-av-key` → env fallback. Client inject via `src/services/api.js` (30s cache).

## AI Brain Scan Universes (`routes/ai-brain.js` → `SCAN_UNIVERSES`)
`broad` | `stocks` + 11 GICS (`stocks_tech` … `stocks_real_estate`) | 8 ETF (`etfs_broad` `etfs_sector` `etfs_bond` `etfs_commodity` `etfs_intl` `etfs_leveraged` `etfs_thematic` `etfs_real_estate`) | 8 crypto (`crypto_l1` `crypto_l2` `crypto_defi` `crypto_ai` `crypto_meme` `crypto_infra` `crypto_exchange` `crypto_stable`) | 8 mutual fund (`mutualfunds` `mutualfunds_index` `mutualfunds_bond` …)

## Design
`#060810` bg · `#00ffcc` accent · `.glass` glassmorphism · CSS vars (no tailwind.config.js) · `src/components/<Feature>/<Feature>View.jsx`

## TradingView
`window.TradingView.widget()` via tv.js CDN. `normalise()` in `TradingViewView.jsx`: Yahoo tickers → `EXCHANGE:SYMBOL`. `cryptoMap` 100+ tokens (USD+USDT). Studies: RSI, Volume, MACD.

## AI Analysis Schema (`trading-analysis.js`)
```json
{"entry":n,"entryZoneLow":n,"entryZoneHigh":n,"target":n,"stopLoss":n,"signal":"BUY|SELL|HOLD","confidence":n,"risks":["..."],"contradictions":["..."],"summary":"..."}
```

## Investor Personas (`lib/investor-personas.js`)
10 personas: `default` | `buffett` | `munger` | `lynch` | `dalio` | `burry` | `wood` | `marks` | `soros` | `greenblatt`. Each has `systemPrompt` + `constraints` injected into the recommendations prompt. `assetBias` declares which asset types the persona uses.

## Macro Data (`routes/macro.js`)
14 FRED series (rates, inflation, labor, growth, VIX, credit). `GET /api/macro/indicators` returns full dataset + regime assessment + AI macro summary string. `GET /api/macro/summary` returns compact string for prompt injection. Requires `FRED_API_KEY` env var (free).

## AI Brain Self-Improvement (`lib/brain-learnings.js`)
Nightly loop: `resolveOutcomes()` fetches actual prices for predictions logged 7d/30d ago → writes back to `data/ai-brain-predictions.jsonl`. `runMetaAnalysis()` has Claude read resolved predictions and write structured learnings to `data/brain-learnings.json`. `getLearningsBlock()` returns a prompt-injection string injected into the AI Brain system prompt. Reads from disk JSONL only — no user input reaches the file path.

## Deploy
Railway auto-deploy `main` (`railway.toml` + `Procfile`).