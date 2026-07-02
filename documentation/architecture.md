# Architecture — FinSurfing

## Product Overview

FinSurfing is a real-time US equity and crypto trading intelligence platform. It combines live market data, AI-powered analysis (Claude + Groq), portfolio tracking, and a streaming copilot chat. Target user: self-directed retail investor.

**Key assumptions:**
- All auth tokens are short-lived (15 min access, 7-day refresh); sessions are stateless on the access-token side.
- All market prices are fetched from third-party APIs; FinSurfing does not store historical OHLCV data locally.
- The app operates in two modes: DB mode (PostgreSQL via `DATABASE_URL`) and in-memory mode (no persistence across restarts).

## Tech Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + Vite, SPA served from `dist/` |
| API server | Node.js / Express, single process |
| Database | PostgreSQL (optional) → in-memory fallback |
| Auth | JWT HS256 (access 15 min) + HTTP-only refresh cookie (7 days) |
| AI | Anthropic Claude (primary), Groq llama-3.3-70b (fallback) |
| Email | Resend API (primary), SMTP/nodemailer (fallback), console.log (demo) |
| Deploy | Railway — auto-deploys `main` branch |
| Build | `npm run dev` (Vite :5173 + Express :3001), `npm run build` → dist/ |

## Request Flow

```
Browser
  ↓ HTTP/SSE
Express (:3001 prod / :3001 dev)
  ├── /api/auth/*           JWT auth (register, login, refresh, OTP)
  ├── /api/portfolios/*     Portfolio CRUD (requireAuth)
  ├── /api/quote,/chart     Market data cascade (unauthenticated, rate-limited)
  ├── /api/trading-analysis AI technical analysis (requireAuth)
  ├── /api/copilot/*        Streaming agentic chat (requireAuth, rate-limited)
  ├── /api/ai-brain/*       Multi-agent market scanner (requireAuth on /analyze, rate-limited)
  ├── /api/market-focus/*   Intraday session focus (GET public cache; POST /refresh requireAuth)
  ├── /api/recommendations  Persona-based picks (requireAuth)
  ├── /api/macro/*          FRED macroeconomic data (unauthenticated)
  ├── /api/scheduler/*      Job management — requireAuth + requireAdmin on write routes
  └── /* (SPA fallback)     dist/index.html
```

## Auth / Session Flow

1. `POST /api/auth/register` → bcrypt hash, store user, send 6-digit OTP via email
2. `POST /api/auth/verify-email` → verify OTP → issue access token (Bearer) + refresh token (HTTP-only cookie `finsurf_rt`)
3. Client stores `accessToken` in memory; attaches as `Authorization: Bearer <token>` on API calls
4. Access token expires in 15 min → client calls `POST /api/auth/refresh` → rotate refresh token, issue new access token
5. `POST /api/auth/logout` → revoke refresh token

**JWT secret**: `process.env.JWT_SECRET` — server calls `process.exit(1)` on startup if unset in production. No fallback secret is used in production.

## Trust Boundaries

| Boundary | Trust level | Notes |
|---|---|---|
| Browser → Express | Untrusted | All user input validated server-side |
| Express → Postgres | Trusted (same Railway project) | Parameterized queries only |
| Express → External APIs | Semi-trusted (HTTPS) | API keys from env vars |
| Express → Claude/Groq | Semi-trusted | User-controlled content reaches LLM prompts |
| Internal loopback calls (auth bypass) | Trusted by loopback socket address **AND** a per-process secret | `requireAuth` bypass (`lib/internal-secret.js`) requires BOTH `req.socket.remoteAddress` on loopback AND `x-internal-secret` matching a secret generated fresh at boot — a forged header alone (or a topology where remoteAddress is unexpectedly loopback) can no longer bypass auth |
| Internal loopback calls (rate-limit skip) | Trusted by loopback socket address (127.0.0.1 / ::1) | AI Brain rate limiter skip checks `req.socket.remoteAddress` only — lower stakes than an auth bypass, so no secret required |
| Scheduler → Internal API | Trusted | Same process loopback; write routes require admin auth |

## Market Data Pipeline

```
Symbol request
  → KNOWN_CRYPTO?    → Binance → CoinGecko
  → KNOWN_MUTUAL?    → FMP only
  → Else:            → Finnhub → AISA → FMP → AlphaVantage → Nasdaq → TwelveData → cache
```

Cache TTLs: quotes 5 s (market hours) / 10 min (off-hours); charts 15 min; prev-close 24 h.

## Known Risks / Assumptions

- **In-memory mode**: All user data (portfolios, holdings, sessions) lost on server restart. Railway ephemeral containers make this the default without `DATABASE_URL`.
- **No DB-level RLS**: Portfolio ownership enforced in application code only (`user_id` filter in queries). A missing filter in a new route would expose all users' data. No PostgreSQL row-level security.
- **CORS dev bypass**: `origin: PROD ? ALLOWED_ORIGINS : true` — if `NODE_ENV` is not `'production'` on Railway, CORS accepts all origins.
- **No per-user AI spend cap**: Rate limits are IP-based only; authenticated users can exhaust AI API budget within the limit window.

*Previously documented risks now fixed (as of June 2026):*
- ~~`x-internal` header forgeable~~ → loopback IP check
- ~~Scheduler routes unauthenticated~~ → `requireAuth + requireAdmin`
- ~~JWT fallback secret~~ → `process.exit(1)` if `JWT_SECRET` unset in production
- ~~SSRF via `providerState.baseUrl`~~ → `baseUrl` always taken from `PROVIDER_DEFAULTS`
- ~~Demo mode OTP returned in production~~ → suppressed when `NODE_ENV=production`

*Previously documented risks now fixed (as of July 2026):*
- ~~Loopback-IP-only auth bypass~~ → `lib/internal-secret.js` requires loopback **and** a per-process secret (defense-in-depth against a topology change ever making external traffic appear to originate from 127.0.0.1)
- ~~`GET /api/filings/:symbol` and `GET /api/earnings-call` unauthenticated~~ → both now `requireAuth`; every other AI route already was
- ~~AI-generated/tool-fetched text rendered via `dangerouslySetInnerHTML` without escaping~~ → `MessageBubble.jsx` and `SynthesisPanel.jsx` now HTML-escape before the markdown-lite regexes run, closing an XSS path via the `read_url` copilot tool
- ~~Password-reset link (with token) logged to console when SMTP unset~~ → logs only that a reset was issued, never the link/token
- ~~`verify-email` distinguished "no such account" from "bad code"~~ → both return the same generic message, matching login/forgot-password
- ~~`req.ip` unreliable behind Railway's edge (no `trust proxy`)~~ → `app.set('trust proxy', 1)`, so rate limiters and audit-log IPs reflect the real client
- ~~`xlsx` (SheetJS 0.18.5, known CVEs, no npm-published fix)~~ → replaced with `exceljs` for `.xlsx` + a small hand-rolled CSV parser for `.csv`; legacy `.xls` (unsupported by exceljs) is no longer accepted — users are prompted to re-save as `.xlsx`/`.csv`

## Related Documents

- `flows.md` — auth and data flows with authorization checks
- `permissions.md` — role matrix
- `variables.md` — secrets and configuration
- `emails.md` — transactional email inventory
- `cron.md` — scheduled job inventory
- `automation.md` — AI agent surfaces
