# CLAUDE.md

Guide Claude Code (claude.ai/code) for this repo.

## Commands
`npm run dev` — Vite:5173 + Express:3001 concurrently | `npm run build` → dist/ | `node server.js` — prod only | `npm test` — Jest unit tests in `tests/` (also run by CI on every PR). No lint.

## Stack
React18+Vite SPA → Express API proxy. Dev: Vite proxies `/api/*` → :3001. Prod: single process :3001 serves dist/+API.

## Routes (`routes/`)
- `auth.js` — JWT in-memory + HTTP-only refresh cookie
- `market.js` — quote/search/chart, multi-provider fallback
- `portfolio.js` — CRUD holdings; Postgres → in-memory memstore fallback
- `ai-brain.js` — market scanner; Claude primary + Groq `llama-3.3-70b-versatile` fallback; circuit breaker `getBreaker()`; when `GROQ_API_KEY` set, both models scan independently in parallel — per-pick `ensemble` agreement annotated in response + `ensembleConfirmed` logged for calibration; scans inject COMPUTED TECHNICALS via `lib/technical-indicators.js`
- `trading-analysis.js` — per-symbol AI; Claude `claude-sonnet-4-6`
- `recommendations.js` — AI Advisory; Claude primary + Groq fallback; accepts `persona` (see `lib/investor-personas.js`) + `includeMacro` body params; GET `/personas` returns persona list
- `macro.js` — FRED macro indicators (14 series); requires `FRED_API_KEY` env var; 1h cache; `getIndicators()` exported for prompt injection
- `symbols.js` — symbol classification/search/universes from `lib/symbol-db.js` (FinanceDatabase weekly snapshot → `data/symbol-db.json`; lazy boot load + Monday refresh job); POST `/refresh` requireAuth
- `market-focus.js` — intraday session focus; GET returns cached AI analysis of top items to watch (holdings + watchlist + macro); POST `/refresh` triggers fresh run (`requireAuth`); refreshes every 30 min during market hours via `lib/scheduled-jobs.js:intradayFocusHandler`
- `copilot.js` — streaming agentic chat (`requireAuth`); multi-provider (Claude native stream → Groq/OpenAI-compat fallback); SSRF-safe: `baseUrl` always from server-side `PROVIDER_DEFAULTS`, never from request body; `TOOLS` registry: scan/recommendations/analyze/sentiment/macro/earnings/options + `classify_symbol` `sector_universe` (symbol-db), `portfolio_risk` (analytics), `get_calibration` (brain-learnings incl. baseline)

- `mcp.js` — Model Context Protocol endpoint (`POST /api/mcp`, streamable HTTP, stateless, JSON responses, `requireAuth` Bearer JWT); exposes the copilot `TOOLS` registry + `dispatchTool` (exported from `copilot.js`) to any MCP client; tests `tests/mcp.test.js` use the official SDK client

**DB**: `DATABASE_URL` → Postgres; missing → memstore. Schema: `db/schema.sql`.
**Client state**: localStorage: watchlist, alerts, AI watchlist, `finsurf_api_keys`. Portfolio → DB when authed.

## Market Data Pipeline (`server.js`)
- `KNOWN_CRYPTO` (~80) → Binance → CoinGecko (`COINGECKO_IDS` map) — classifiers in `lib/crypto-classify.js` (`isCryptoSymbol`, `toBinancePair`, `cgId`; tests in `tests/crypto-classify.test.js`)
- `KNOWN_MUTUAL_FUNDS` (~120) → FMP only (NAV quotes)
- Else → Finnhub → AISA → FMP → AlphaVantage → Nasdaq → TwelveData → Tiingo → Polygon → `lib/stooq.js` (keyless CSV, delayed, price-only) → cache → `lib/last-quotes.js` (disk-persisted last-known quote, served with `stale: true`; survives deploys)
- `GET /api/health/providers` live-probes every provider (`?useEnvKeys=1` ignores browser keys); NOTE browser-saved keys (`finsurf_api_keys` headers) override env keys in `extractKeys`

**ETF detection** `isEtfLike(s)`: `s!=null && s.pe==null && s.revenueGrowth==null && s.earningsGrowth==null`
**FMP search** ETF keywords (no leading space): vanguard, ishares, spdr, invesco, schwab, fidelity, blackrock, direxion, proshares, wisdomtree, etf, fund, trust
**TwelveData search**: allows AMEX/CBOE/BATS exchanges; ETF instrument_type always passes

## API Keys
`extractKeys(req)` in server.js: headers `x-aisa-key` `x-finnhub-key` `x-fmp-key` `x-td-key` `x-av-key` → env fallback. Client inject via `src/services/api.js` (30s cache).

## AI Brain Scan Universes (`routes/ai-brain.js` → `SCAN_UNIVERSES`)
`broad` | `stocks` + 11 GICS (`stocks_tech` … `stocks_real_estate`) | 8 ETF (`etfs_broad` `etfs_sector` `etfs_bond` `etfs_commodity` `etfs_intl` `etfs_leveraged` `etfs_thematic` `etfs_real_estate`) | 8 crypto (`crypto_l1` `crypto_l2` `crypto_defi` `crypto_ai` `crypto_meme` `crypto_infra` `crypto_exchange` `crypto_stable`) | 8 mutual fund (`mutualfunds` `mutualfunds_index` `mutualfunds_bond` …)

## Design
`#060810` bg · `#00ffcc` accent · `.glass` glassmorphism · CSS vars (no tailwind.config.js) · `src/components/<Feature>/<Feature>View.jsx`. Large views keep sub-components in per-view subdirs: `Research/notes/` `AgenticOS/tabs/` `AIBrain/scan/` `Research/advisory/` `Dashboard/widgets/` `Backtest/parts/`

## Frontend Routing & Nav
Hash routes `#/<tab>[/<param>]` (e.g. `#/analyze/NVDA`) via `src/hooks/useHashRoute.js`; unknown tabs → dashboard. All views `React.lazy` (one Vite chunk each) behind a single `Suspense` in `App.jsx`. `src/navigation.js` is the single source of truth for nav groups/tabs, shared by `Sidebar`, `CommandPalette` (⌘K / Ctrl+K: view search + ticker jump), and route validation.

## Frontend Data Layer (`src/hooks/useQuery.js`)
Zero-dep shared fetch cache: module-level cache keyed by string, in-flight dedupe, stale-while-revalidate (`staleMs`), optional polling (`refetchMs`), `invalidateQuery(key)`. Prefer `useQuery(key, () => fetchJson(url), { staleMs })` over hand-rolled `data/loading/error` state for GET-on-mount views (adopted: `MacroPanel`, `TrackRecordPanel`). Keys are global — embed params (and user id for authed endpoints) in the key.

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
Nightly loop: `resolveOutcomes()` resolves predictions logged 7d/30d ago against the historical daily bar at exactly +7/+30d (not run-time price), records entry-zone fill (`entered`) and benchmark return (SPY equities / BTC crypto) → writes back to `data/ai-brain-predictions.jsonl`. `computeStats()` derives win rates, alpha win rates, target-hit rates and per-confidence calibration deterministically in code. `runMetaAnalysis()` has Claude interpret (not compute) those stats and write structured learnings to `data/brain-learnings.json`. `getLearningsBlock()` returns a prompt-injection string injected into the AI Brain system prompt. Reads from disk JSONL only — no user input reaches the file path. `lib/ml-baseline.js`: transparent logistic TA model logged per pick (`baselineDir/Prob/Features`) as a mechanical benchmark; `computeStats()` reports AI-vs-baseline; nightly cycle refits weights (≥100 resolved rows) → `data/ml-baseline-weights.json`.

## Technical Indicators (`lib/technical-indicators.js`)
Pure TA math (RSI, EMA, MACD, BB, ATR, StochRSI, VWAP, OBV, pivot S/R, patterns, volume) shared by `routes/trading-analysis.js` and `routes/ai-brain.js`. `compactTaLine()` builds one-line per-symbol summaries injected into AI Brain scans as COMPUTED TECHNICALS so technicalScore is grounded in real data. Unit tests: `tests/technical-indicators.test.js`, `tests/brain-learnings.test.js`.

## Deploy
Railway auto-deploy `main` (`railway.toml` + `Procfile`).