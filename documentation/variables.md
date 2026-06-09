# Variables & Secrets — FinSurfing

## Secret / Config Inventory

| Name | Used by | Scope | Source | Rotation | Risk |
|---|---|---|---|---|---|
| `JWT_SECRET` | `middleware/auth.js` | Server only | Railway env var | On compromise | **Critical** — hardcoded fallback exists in source; must be set in production |
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

- [ ] `JWT_SECRET` is set to a random 64-byte hex string (not the hardcoded fallback)
- [ ] `NODE_ENV=production` is set in Railway
- [ ] `ALLOWED_ORIGINS` is set to the production domain (not left unset)
- [ ] `DATABASE_URL` is set (otherwise all data lost on restart)
- [ ] `ANTHROPIC_API_KEY` is set
- [ ] `RESEND_API_KEY` or SMTP vars are configured (otherwise OTP codes appear in API responses)
- [ ] `ADMIN_EMAIL` + `ADMIN_PASSWORD` are set
- [ ] `MORNING_BRIEF_EMAIL` is set if morning briefing is desired
- [ ] All third-party market data API keys are set (at minimum one of: AISA, Finnhub, FMP)
