# Variables & Secrets — FinSurfing

## Secret / Config Inventory

| Name | Used by | Scope | Source | Rotation | Risk |
|---|---|---|---|---|---|
| `JWT_SECRET` | `middleware/auth.js` | Server only | Railway env var | On compromise | **Critical** — server calls `process.exit(1)` on startup if unset in production |
| `DATABASE_URL` | `db/db.js` | Server only | Railway env var | On compromise | High — full DB access |
| `ANTHROPIC_API_KEY` | `routes/trading-analysis.js`, `routes/copilot.js`, `routes/ai-brain.js`, `lib/scheduled-jobs.js` | Server only | Railway env var | On compromise | High — paid API; unauthenticated routes can trigger usage |
| `GROQ_API_KEY` | `routes/copilot.js`, `routes/ai-brain.js` | Server only | Railway env var | On compromise | Medium — paid fallback AI |
| `OPENAI_API_KEY` | `routes/copilot.js` (codex provider) | Server only | Railway env var | On compromise | Medium |
| `RESEND_API_KEY` | `lib/email.js` | Server only | Railway env var | On compromise | Medium — email sending |
| `FRED_API_KEY` | `routes/macro.js` | Server only | Railway env var | On compromise | Low — free public API |
| `FINNHUB_API_KEY` | `server.js` (market data) | Server only | Railway env var | On rotate | Medium — paid tier |
| `FMP_API_KEY` | `server.js` | Server only | Railway env var | On rotate | Medium |
| `AISA_API_KEY` | `server.js` | Server only | Railway env var | On rotate | Medium |
| `TWELVEDATA_API_KEY` | `server.js` | Server only | Railway env var | On rotate | Low |
| `ALPHAVANTAGE_API_KEY` | `server.js` | Server only | Railway env var | On rotate | Low |
| `ADMIN_EMAIL` | `routes/auth.js` | Server only | Railway env var | N/A | Medium — designates admin account |
| `ADMIN_PASSWORD` | `routes/auth.js` | Server only | Railway env var | On compromise | High — admin credentials |
| `MORNING_BRIEF_EMAIL` | `lib/scheduled-jobs.js` | Server only | Railway env var | N/A | Low — email recipient |
| `SMTP_HOST/USER/PASS` | `lib/email.js` | Server only | Railway env var | On compromise | Medium |
| `RESEND_FROM` | `lib/email.js` | Server only | Railway env var | N/A | Low |
| `APP_URL` | `routes/auth.js` (password reset links) | Server only | Railway env var | N/A | Low |
| `ALLOWED_ORIGINS` | `server.js` CORS config | Server only | Railway env var | N/A | Medium — gates cross-origin access in production |
| `PORT` | `server.js` | Server only | Railway (auto) | N/A | N/A |
| `NODE_ENV` | `server.js`, `middleware/auth.js` | Server only | Railway env var | N/A | **Important** — must be `production` for CORS restriction and HTTPS cookies |

## Client-Side API Keys (User-Supplied)

Users may supply their own API keys via the Settings UI. These are stored in `localStorage` under `finsurf_api_keys` and injected as request headers (`x-aisa-key`, `x-finnhub-key`, `x-fmp-key`, `x-td-key`, `x-av-key`). They are forwarded server-side to the relevant provider. **These keys transit the user's own browser only — they are not stored server-side.**

## No Secrets Client-Side Confirmation

Server-side secrets are never sent to the browser. The frontend receives:
- `accessToken` (JWT, short-lived — 15 min) — intentional; needed for API calls
- Portfolio holdings, quotes — user's own data

No API keys for external providers (Finnhub, FMP, etc.) are included in the SPA bundle or in API responses.

## Pre-Go-Live Checklist

**Code-level fixes shipped (no env var needed):**
- [x] JWT fallback secret removed — `process.exit(1)` if `JWT_SECRET` unset in production
- [x] Scheduler write routes require `requireAuth + requireAdmin`
- [x] `x-internal` header replaced by loopback IP check in AI Brain rate limiter
- [x] `providerState.baseUrl` from request body ignored (SSRF fix)
- [x] `demoCode` OTP suppressed in production responses
- [x] `avg_cost_basis` column name fixed in analytics query

**Env vars to set in Railway:**
- [ ] `JWT_SECRET` — random 64-byte hex (`openssl rand -hex 32`); server won't start without it in production
- [ ] `NODE_ENV=production` — enables CORS restriction, HSTS, HTTPS cookies, OTP suppression
- [ ] `ALLOWED_ORIGINS` — production domain (e.g. `https://finsurf.app`); startup warning logged if missing
- [ ] `APP_URL` — production URL for password reset links; startup warning logged if missing
- [ ] `DATABASE_URL` — Postgres connection string; without it all data is lost on restart
- [ ] `ANTHROPIC_API_KEY` — required for all AI features
- [ ] `RESEND_API_KEY` or SMTP vars — required for email delivery (OTP, password reset, morning brief)
- [ ] `ADMIN_EMAIL` + `ADMIN_PASSWORD` — admin account credentials
- [ ] `MORNING_BRIEF_EMAIL` — recipient for daily morning brief; startup warning logged if missing
- [ ] At minimum one market data key: `AISA_API_KEY`, `FINNHUB_API_KEY`, or `FMP_API_KEY`
