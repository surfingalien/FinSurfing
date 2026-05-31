# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev       # Vite (5173) + Express (3001) concurrently
npm run build     # Vite production build → dist/
node server.js    # Production server only (serves dist/ + API on 3001)
```

No test suite. Lint is not configured.

## Architecture

React 18 + Vite SPA talking to an Express API proxy on the same host. In dev, Vite proxies `/api/*` to `localhost:3001`. In prod, Express serves the built `dist/` and handles all routes from a single process on port 3001.

**Route files** (`routes/`):
- `auth.js` — JWT (access token in memory, refresh via HTTP-only cookie)
- `market.js` — quote/search/chart endpoints; multi-provider fallback chain
- `portfolio.js` — CRUD for holdings backed by PostgreSQL (falls back to in-memory memstore)
- `ai-brain.js` — market scanner with Claude primary + Groq `llama-3.3-70b-versatile` fallback; circuit breaker pattern via `getBreaker()`
- `trading-analysis.js` — per-symbol AI analysis (Claude `claude-sonnet-4-6`)
- `recommendations.js` — AI Advisory Engine (Claude primary, Groq fallback)

**Database**: PostgreSQL via `DATABASE_URL`; no `DATABASE_URL` → in-memory memstore. Schema in `db/schema.sql`.

**Client state**: `localStorage` for watchlist, alerts, AI watchlist, and user API keys (`finsurf_api_keys`). Portfolio backed by DB when authenticated.

## Market Data Pipeline

Symbol routing in `server.js`:

- `KNOWN_CRYPTO` (~80 tokens) → Binance first, CoinGecko fallback (`COINGECKO_IDS` map)
- `KNOWN_MUTUAL_FUNDS` (~120 tickers) → FMP direct (only API supporting NAV quotes)
- Everything else → Finnhub → AISA → FMP → Alpha Vantage → Nasdaq → TwelveData → cache

**ETF detection** (`isEtfLike(summary)`): `summary != null && summary.pe == null && summary.revenueGrowth == null && summary.earningsGrowth == null` — ETFs naturally return null for those stock fundamentals.

**Search providers**: `getFMPSearch` detects ETFs by brand-name keywords (vanguard, ishares, spdr, invesco, etc.) without a leading space. `getTwelveDataSearch` allows AMEX, CBOE, BATS exchanges and always passes `instrument_type === 'ETF'`.

## User-Supplied API Keys

`extractKeys(req)` in server.js reads from request headers (`x-aisa-key`, `x-finnhub-key`, `x-fmp-key`, `x-td-key`, `x-av-key`), falling back to env vars. The client stores keys in `localStorage` as `finsurf_api_keys` and injects them as headers via `src/services/api.js`.

## AI Brain Scan Universes

Defined in `routes/ai-brain.js` as `SCAN_UNIVERSES`. Parent categories:
- `broad` — mixed stocks
- `stocks` + 11 GICS sector sub-modes (`stocks_tech`, `stocks_health`, etc.)
- 8 ETF categories (`etfs_broad`, `etfs_sector`, `etfs_bond`, `etfs_commodity`, `etfs_intl`, `etfs_leveraged`, `etfs_thematic`, `etfs_real_estate`)
- 8 crypto categories (`crypto_l1`, `crypto_l2`, `crypto_defi`, `crypto_ai`, `crypto_meme`, `crypto_infra`, `crypto_exchange`, `crypto_stable`)
- 8 mutual fund categories (`mutualfunds`, `mutualfunds_index`, `mutualfunds_bond`, etc.)

## Design System

Dark `#060810` bg, mint `#00ffcc` accent, glassmorphism via `.glass` Tailwind class. No `tailwind.config.js` — design tokens are CSS custom properties. Component structure: `src/components/<Feature>/<Feature>View.jsx` + sub-components.

## TradingView Chart

Uses `window.TradingView.widget()` via `tv.js` CDN. Symbol normalisation in `normalise()` inside `TradingViewView.jsx` maps Yahoo-style tickers to `EXCHANGE:SYMBOL` format. Crypto tickers use a `cryptoMap` covering 100+ tokens (USD and USDT pairs). Studies: RSI, Volume, MACD.

## AI Analysis Schema (trading-analysis.js)

Claude returns JSON with these fields — use exact names when reading on frontend:
```json
{
  "entry": number, "entryZoneLow": number, "entryZoneHigh": number,
  "target": number, "stopLoss": number,
  "signal": "BUY|SELL|HOLD",
  "confidence": number,
  "risks": ["..."],
  "contradictions": ["..."],
  "summary": "..."
}
```

## Deploy

Railway auto-deploys from `main` branch (`railway.toml` + `Procfile`). Push to `main` to trigger production deploy.
