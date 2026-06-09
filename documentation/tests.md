# Test Coverage Map — FinSurfing

**Status: 45 automated tests passing.** Jest + Supertest. Run: `npm test`  
CI: GitHub Actions (`.github/workflows/ci.yml`) runs on every PR targeting `main`.

---

## Existing Coverage

Tests live in `tests/`. Each file maps to the area it covers:

| File | Tests | Coverage |
|---|---|---|
| `tests/auth.test.js` | 15 | Registration, OTP, login, lockout, token refresh rotation, `/me` |
| `tests/security.test.js` | 6 | Scheduler auth (401/403), JWT tamper/wrong-secret → 401, portfolio auth |
| `tests/trading-analysis.test.js` | 4 | Symbol validation, auth gate, body vs query param |
| `tests/pnl.test.js` | 14 | P&L enrichment (mktValue, gainLoss, todayGL) + portfolioSummary edge cases |
| `tests/portfolio-isolation.test.js` | 5 | Cross-user portfolio isolation, unauthenticated rejection |

---

## Proposed Tests (Highest Priority First)

### Auth

| Use-case | Rule | Expected behavior (incl. deny case) | Source | Status |
|---|---|---|---|---|
| Login — valid credentials | User with correct password gets access + refresh tokens | 200 with `accessToken`; cookie `finsurf_rt` set | flows.md, auth.js:430 | **Covered** (`auth.test.js`) |
| Login — wrong password | bcrypt mismatch returns 401 | 401; failed_attempts incremented | flows.md | **Covered** (`auth.test.js`) |
| Login — account lockout | 5 failed attempts → locked 15 min | 429 on 6th attempt | auth.js:493 | **Covered** (`auth.test.js`) |
| Token refresh — rotation | Old refresh token is revoked on use | Second use of same refresh token → 401 | auth.js:553 | **Covered** (`auth.test.js`) |
| JWT fallback secret | `JWT_SECRET` unset → startup should fail | `process.exit(1)` in production mode | architecture.md (known risk) | **Fixed** (middleware/auth.js) + **Covered** (security.test.js wrong-secret test) |
| OTP expiry | Code past 10 min → 400 | auth.js:383 | flows.md | ✅ `auth.test.js` — time-travel via `Date.now` mock |

### Portfolio Authorization

| Use-case | Rule | Expected behavior | Source | Status |
|---|---|---|---|---|
| Own portfolio access | `user_id` filter scopes to requesting user | 200 with correct data | portfolios.js:231 | **Covered** (`portfolio-isolation.test.js`) |
| Cross-user portfolio access | Another user's private portfolio → denied | 403 or 404 | permissions.md | **Covered** (`portfolio-isolation.test.js` — no ID overlap) |
| Guest access to portfolio API | No token → 401 | portfolios.js:16 (`requireAuth`) | permissions.md | **Covered** (`security.test.js`, `portfolio-isolation.test.js`) |

### Security — Critical Findings

| Use-case | Rule | Expected behavior | Source | Status |
|---|---|---|---|---|
| Copilot `providerState.baseUrl` rejection | Only known providers' base URLs are allowed | `baseUrl` ignored from request body | security audit finding 1 | **Fixed** (copilot.js) |
| JWT signed with fallback secret rejected | Production server must reject tokens from the demo fallback | 401 on forged token | security audit finding 2 | **Covered** (`security.test.js`) |
| Scheduler trigger requires auth | `POST /api/scheduler/jobs/:id/trigger` → 401 without token | 401 | security audit finding 3 | **Covered** (`security.test.js`) |
| `x-internal` from external client ignored | Rate limit NOT bypassed when `x-internal:1` comes from outside loopback | Loopback IP check replaces header trust | security audit finding 4 | **Fixed** (ai-brain.js) |

### AI Pipeline

| Use-case | Rule | Expected behavior | Source | Status |
|---|---|---|---|---|
| `analyze_symbol` with valid symbol | Returns `{ signal, confidence, entry, stopLoss }` | 200 with structured JSON | trading-analysis.js:828 | **None** (requires live API keys) |
| `analyze_symbol` with no symbol | 400 error | `{ error: 'symbol is required' }` | trading-analysis.js:835 | **Covered** (`trading-analysis.test.js`) |
| `analyze_symbol` requires auth | Unauthenticated → 401 | trading-analysis.js:828 | security gate | **Covered** (`trading-analysis.test.js`) |
| Copilot symbol dispatch → trading-analysis body | Symbol sent in request body not query param | Route receives `req.body.symbol` | PR #85 fix | **Covered** (`trading-analysis.test.js`) |

### Data Correctness

| Use-case | Rule | Expected behavior | Source | Status |
|---|---|---|---|---|
| P&L calculation | `mktValue = shares × price`; `gainLoss = mktValue - costBasis` | Matches manual calculation | usePortfolio.js:287 | **Covered** (`pnl.test.js`) |
| `avg_cost_basis` column name | Analytics route uses `avg_cost_basis` not `avg_cost` | Returns correct cost basis, not NULL | analytics.js:156 (bug) | **Fixed** (analytics.js) |

---

## Gaps — Remaining Unverified Rules

| Rule | What crossing it exposes | Verification today |
|---|---|---|
| OTP code never returned in production API response | Account takeover if attacker can observe API response | Fixed in code (NODE_ENV check); no expiry-specific test |
| Portfolio queries scoped to `user_id` (DB mode) | Another user's holdings and P&L data | In-memory test only; no Postgres integration test |
| `analyze_symbol` full response schema | Broken AI output silently returned | Requires live API keys — no test |

---

## CI Gates

GitHub Actions (`ci.yml`) — runs `npm test` on every push and PR targeting `main`.  
Branch protection rules not yet configured — merges are not blocked by failing tests.
