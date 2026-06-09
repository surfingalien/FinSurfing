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
  ├── /api/trading-analysis AI technical analysis (optionalAuth)
  ├── /api/copilot/*        Streaming agentic chat (unauthenticated, rate-limited)
  ├── /api/ai-brain/*       Multi-agent market scanner (unauthenticated)
  ├── /api/recommendations  Persona-based picks (unauthenticated)
  ├── /api/macro/*          FRED macroeconomic data (unauthenticated)
  ├── /api/scheduler/*      Job management — NO auth (see security notes)
  └── /* (SPA fallback)     dist/index.html
```

## Auth / Session Flow

1. `POST /api/auth/register` → bcrypt hash, store user, send 6-digit OTP via email
2. `POST /api/auth/verify-email` → verify OTP → issue access token (Bearer) + refresh token (HTTP-only cookie `finsurf_rt`)
3. Client stores `accessToken` in memory; attaches as `Authorization: Bearer <token>` on API calls
4. Access token expires in 15 min → client calls `POST /api/auth/refresh` → rotate refresh token, issue new access token
5. `POST /api/auth/logout` → revoke refresh token

**JWT secret**: `process.env.JWT_SECRET` — if unset, falls back to hardcoded string in `middleware/auth.js`. **This fallback must not be used in production.**

## Trust Boundaries

| Boundary | Trust level | Notes |
|---|---|---|
| Browser → Express | Untrusted | All user input validated server-side |
| Express → Postgres | Trusted (same Railway project) | Parameterized queries only |
| Express → External APIs | Semi-trusted (HTTPS) | API keys from env vars |
| Express → Claude/Groq | Semi-trusted | User-controlled content reaches LLM prompts |
| Internal loopback calls | Trusted by `x-internal: '1'` header | **Forgeable** — see security notes |
| Scheduler → Internal API | Trusted | Same process loopback; no auth enforced on scheduler trigger route |

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
- **`x-internal` header**: Used to skip rate limits and trust scheduler calls; forgeable from outside — any caller can set it.
- **Scheduler routes unauthenticated**: `POST /api/scheduler/jobs/:id/trigger` requires no auth — anyone can trigger AI Brain scans (paid Claude calls) or morning-brief emails.
- **JWT fallback secret**: Hardcoded in `middleware/auth.js:6`; tokens signed with it are forgeable by anyone who reads the source.
- **CORS dev bypass**: `origin: PROD ? ALLOWED_ORIGINS : true` — if `NODE_ENV` is not `'production'` on Railway, CORS accepts all origins.
- **Demo mode OTP exposure**: When no SMTP is configured, `demoCode` is returned in the register/verify-email API response body — intended for local dev, risk if accidentally active in production.

## Related Documents

- `flows.md` — auth and data flows with authorization checks
- `permissions.md` — role matrix
- `variables.md` — secrets and configuration
- `emails.md` — transactional email inventory
- `cron.md` — scheduled job inventory
- `automation.md` — AI agent surfaces
