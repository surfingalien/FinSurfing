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
- `recommendations.js` — AI Advisory; Claude primary + Groq fallback; accepts `persona` (see `lib/investor-personas.js`) + `includeMacro` + `includeFilings` (injects compact SEC filing narrative for focus stocks via `routes/filings.js`) body params; each pick gets a Kelly `sizing` field (`lib/kelly.js`) + a `sources` array (source-grounded citations: the prompt requires each pick to cite the SPECIFIC injected evidence — technicals/macro/filings/analyst/earnings/flow — never invented; coerced to a clean ≤4 string array server-side, persisted in the journal); GET `/personas` returns persona list; GET `/journal` (requireAuth) returns the user's versioned, diffable recommendation history (`lib/rec-journal.js`)
- `macro.js` — FRED macro indicators (14 series); requires `FRED_API_KEY` env var; 1h cache; `getIndicators()` exported for prompt injection
- `filings.js` — `GET /api/filings/:symbol?form=10-K|10-Q|8-K` (`requireAuth`); SEC EDGAR filing-narrative reader (keyless) via `lib/filings.js` → AI router summary card (summary/keyChanges/riskFactors/managementTone/redFlags/analystTakeaway); 6h cache. Covers the 10-K/10-Q/8-K MD&A + Risk Factors narrative — distinct from `fundamentals.js` (numbers) and `earnings-call.js` (transcript, also `requireAuth`). EDGAR needs a descriptive User-Agent (see `lib/filings.js:EDGAR_UA`)
- `symbols.js` — symbol classification/search/universes from `lib/symbol-db.js` (FinanceDatabase weekly snapshot → `data/symbol-db.json`; lazy boot load + Monday refresh job); POST `/refresh` requireAuth
- `market-focus.js` — intraday session focus; GET returns cached AI analysis of top items to watch (holdings + watchlist + macro); POST `/refresh` triggers fresh run (`requireAuth`); refreshes every 30 min during market hours via `lib/scheduled-jobs.js:intradayFocusHandler`
- `copilot.js` — streaming agentic chat (`requireAuth`); multi-provider (Claude native stream → Groq/OpenAI-compat fallback); SSRF-safe: `baseUrl` always from server-side `PROVIDER_DEFAULTS`, never from request body; `TOOLS` registry: scan/recommendations/analyze/sentiment/macro/earnings/options + `classify_symbol` `sector_universe` (symbol-db), `portfolio_risk` (analytics), `get_calibration` (brain-learnings incl. baseline), `analyze_filing` (SEC EDGAR 10-K/10-Q/8-K via `routes/filings.js`), `propose_strategies` (strategy-lab), `read_url` (user-pointed web page → clean text via Firecrawl `/scrape`; requires `FIRECRAWL_API_KEY`; Firecrawl fetches server-side so SSRF stays off our infra; result run through `compactProse`; user-initiated only, not a crawler)

- `strategy-lab.js` — `POST /api/strategy-lab/propose` (`requireAuth`); LLM proposes rule-based strategy configs (type + exact params strictly from `lib/strategy-lab.js:STRATEGY_CATALOG` = the 4 `utils/backtest.js` strategies) grounded in the symbol's `compactTaLine` technicals, then EVERY proposal is validated by `simulate()` on real daily bars (full range + recent-window robustness re-run) → deterministic verdict (`validated`/`mixed`/`rejected`/`insufficient_trades`), sorted best-first. All metrics come from the engine, never the LLM (it's told its claims will be backtested and to state no numbers). Params clamped/swapped/deduped server-side (`parseProposals`). Also a copilot tool `propose_strategies`. Pure parts tested (`tests/strategy-lab.test.js`)

- `mcp.js` — Model Context Protocol endpoint (`POST /api/mcp`, streamable HTTP, stateless, JSON responses, `requireAuth` Bearer JWT); exposes the copilot `TOOLS` registry + `dispatchTool` (exported from `copilot.js`) to any MCP client; tests `tests/mcp.test.js` use the official SDK client

**DB**: `DATABASE_URL` → Postgres; missing → memstore. Schema: `db/schema.sql`. Set `DATABASE_CA_CERT` (PEM, literal or `\n`-escaped newlines) to pin the Postgres TLS cert chain (`rejectUnauthorized: true`); unset in production → encrypted-but-unverified TLS + startup warning.
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
**Finnhub key pool** (`lib/finnhub-keys.js`): set `FINNHUB_API_KEYS` (comma-separated) to round-robin across several keys and stay under the ~60/min per-key rate limit; `FH_KEY()` draws from the pool and the quote/chart paths cool a key for 60s on 429/403. Single `FINNHUB_API_KEY` still works (folded into the pool → identical to prior behaviour). Server-side, in-memory — no redeploy, no UI involvement. A user's browser `x-finnhub-key` still overrides the pool.

## AI Brain Scan Universes (`routes/ai-brain.js` → `SCAN_UNIVERSES`)
`broad` | `stocks` + 11 GICS (`stocks_tech` … `stocks_real_estate`) | 8 ETF (`etfs_broad` `etfs_sector` `etfs_bond` `etfs_commodity` `etfs_intl` `etfs_leveraged` `etfs_thematic` `etfs_real_estate`) | 8 crypto (`crypto_l1` `crypto_l2` `crypto_defi` `crypto_ai` `crypto_meme` `crypto_infra` `crypto_exchange` `crypto_stable`) | 8 mutual fund (`mutualfunds` `mutualfunds_index` `mutualfunds_bond` …)

## Design
`#060810` bg · `#00ffcc` accent · `.glass` glassmorphism · color palette in `tailwind.config.cjs` (mint/indigo/surface scales) + CSS vars in `src/index.css` · `src/components/<Feature>/<Feature>View.jsx`. Large views keep sub-components in per-view subdirs: `Research/notes/` `AgenticOS/tabs/` `AIBrain/scan/` `Research/advisory/` `Dashboard/widgets/` `Backtest/parts/`.
**Themes**: two additive overlays toggle a class on `<html>`, persisted in localStorage, mutually exclusive (Header toggles): `pro-mode` (`ProModeContext`, industrial terminal) and `apple-mode` (`AppleModeContext`, light Apple-style: #f5f5f7 surface, #1d1d1f ink, #0071e3 accent, white cards + soft shadows). Both are pure CSS overrides in `index.css` on the shared classes (`.glass`, `.btn-*`, text/bg utilities) — components are theme-unaware.

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

## Kelly position sizing (`lib/kelly.js`)
Advisory position sizing (suggests, never executes). `fullKelly(p,W,L)` = asymmetric-payoff Kelly `(pW−qL)/(WL)` clamped ≥0; `suggestedSize({winProb,winFrac,lossFrac,fraction=0.5,maxFraction=0.2})` applies fractional Kelly + a hard cap (full Kelly can exceed 100% leverage under a tight stop). Win-probability comes from EMPIRICAL calibration via `winProbFromStats(computeStats(...))` — the resolved-pick win rate (per-confidence bucket when available, else overall, else conservative default) — NOT a raw confidence score. Wired into `routes/recommendations.js`: each pick gets a `sizing` field (suggestedPct/fullKellyPct/edgePerUnit/winProbSource) from its targetReturn/stopLoss. Pure, tested (`tests/kelly.test.js`).

## Recommendation journal (`lib/rec-journal.js`)
"Decisions as commits" — each Advisory run is appended to `data/rec-journal.jsonl` (gitignored) as a content-hashed, versioned entry (8-char `id`, timestamp, rationale = market outlook, normalized picks, persona/params). `hashEntry`/`buildEntry`/`diffEntries` are pure; `diffEntries(prev,next)` reports added/removed/changed picks by symbol. `routes/recommendations.js` appends on each generation (best-effort) and exposes `GET /api/recommendations/journal` (requireAuth) → user's history newest-first, each entry annotated with a `diff` vs the previous run. Advisory/audit only, no execution. Pure parts tested (`tests/rec-journal.test.js`).

## Prompt token compaction (`lib/compress.js`)
`compactProse(text)` strips non-informative structure (whitespace runs, separator/page-number lines, repeated lines, ToC/boilerplate) from prose-heavy context BEFORE it's sliced into a prompt — fewer tokens, same meaning, so the same char budget carries more signal. NEVER alters numbers/tickers/currency/% (financial precision preserved). `compactWhitespace(text)` is the whitespace-only, line-preserving variant. Pure, tested (`tests/compress.test.js`). Applied at the heavy injection points: SEC filing narrative (`lib/filings.js` → before `extractSections`) and earnings-call transcript (`routes/earnings-call.js` → before the 6k slice). Typical ~30-50% shrink on filing/transcript boilerplate.

## Data-driven risk visualizations
`Probability Lattice` (`src/components/Lattice/ProbabilityLatticeView.jsx`, route `probability-lattice`) — Galton-board canvas over resolved AI Brain predictions (`GET /api/ai-brain/activity`); bins real +7/+30d outcome returns, never placeholder data. `Tail Probability Ridge` (`src/components/Ridge/TailProbabilityRidgeView.jsx`, route `tail-ridge`) — stacked KDE ridges (portfolio vs SPY) of real historical daily returns from `GET /api/analytics/portfolio` (`riskMetrics.returnSeries.{portfolio,benchmark}`, added alongside existing `var95`/`cvar95`); shades the left tail beyond the empirical 95% VaR. `Relationship Graph` (`src/components/Graph/RelationshipGraphView.jsx`, route `relationship-graph`) — force-directed canvas over the pairwise Pearson correlations from the same analytics endpoint; correlated holdings cluster (spring rest length shrinks with r), β>1.3 nodes flagged; deterministic seeding (no Math.random) so replays are stable. All three require ≥ their data floor (5 resolved picks / 20 trading days / 2 symbols respectively) before rendering, else show an explicit "not enough data" state.

## Internal loopback auth (`lib/internal-secret.js`)
Server-to-server calls (scheduled jobs, route-to-route proxying via `/api/...` over `127.0.0.1`) bypass `requireAuth` only when BOTH the socket is loopback AND a per-process secret (`isInternalRequest()`, regenerated fresh on every boot — never persisted, never leaves the process) is sent as `x-internal-secret`. Defense-in-depth over the old loopback-IP-only check: a forged header alone can never grant access, even if the deployment topology ever changed such that `req.socket.remoteAddress` could appear loopback for external traffic. All internal callers (`routes/alerts.js`, `routes/copilot.js`'s `dispatchTool`, `routes/market-focus.js`, `routes/options-flow.js`, `lib/backtest-queue.js`, `lib/scheduled-jobs.js`) send it alongside the legacy `x-internal: '1'` marker.

## Pausing Claude (`lib/ai-pause.js`)
Set `CLAUDE_PAUSE_UNTIL` to an ISO date (e.g. `2026-07-01`) to stop all Anthropic/Claude usage until that date — e.g. to preserve quota until a limit resets. While paused, `claudePaused()` is true: `lib/ai-router.js` routes its features to Groq (works only if `GROQ_API_KEY` set), the copilot's default Claude provider is transparently served by Groq, and direct Claude callers (`quantmind` `rebalancer` `sentiment` `agent` `research-notes` `brain-learnings` nightly) skip the call and 503/no-op. Auto-resumes after the date — no redeploy. Unset/blank/invalid → never paused.