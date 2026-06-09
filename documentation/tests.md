# Test Coverage Map — FinSurfing

**Status: Zero automated tests exist in this repository.** No test runner is configured (`package.json` has no test script). Every rule below is unverified.

---

## Existing Coverage

*None.* No `.test.*`, `.spec.*`, or `__tests__/` files found anywhere in the project.

---

## Proposed Tests (Highest Priority First)

### Auth

| Use-case | Rule | Expected behavior (incl. deny case) | Source | Status |
|---|---|---|---|---|
| Login — valid credentials | User with correct password gets access + refresh tokens | 200 with `accessToken`; cookie `finsurf_rt` set | flows.md, auth.js:430 | **None** |
| Login — wrong password | bcrypt mismatch returns 401 | 401; failed_attempts incremented | flows.md | **None** |
| Login — account lockout | 5 failed attempts → locked 15 min | 429 on 6th attempt | auth.js:493 | **None** |
| Token refresh — rotation | Old refresh token is revoked on use | Second use of same refresh token → 401 | auth.js:553 | **None** |
| JWT fallback secret | `JWT_SECRET` unset → startup should fail | `process.exit(1)` in production mode | architecture.md (known risk) | **None** |
| OTP expiry | Code past 10 min → 400 | auth.js:383 | flows.md | **None** |

### Portfolio Authorization

| Use-case | Rule | Expected behavior | Source | Status |
|---|---|---|---|---|
| Own portfolio access | `user_id` filter scopes to requesting user | 200 with correct data | portfolios.js:231 | **None** |
| Cross-user portfolio access | Another user's private portfolio → denied | 403 or 404 | permissions.md | **None** |
| Guest access to portfolio API | No token → 401 | portfolios.js:16 (`requireAuth`) | permissions.md | **None** |

### Security — Critical Findings

| Use-case | Rule | Expected behavior | Source | Status |
|---|---|---|---|---|
| Copilot `providerState.baseUrl` rejection | Only known providers' base URLs are allowed | 400 if `baseUrl` is not in allowlist | security audit finding 1 | **None** |
| JWT signed with fallback secret rejected | Production server must reject tokens from the demo fallback | 401 on forged token | security audit finding 2 | **None** |
| Scheduler trigger requires auth | `POST /api/scheduler/jobs/:id/trigger` → 401 without token | 401 | security audit finding 3 | **None** |
| `x-internal` from external client ignored | Rate limit NOT bypassed when `x-internal:1` comes from outside loopback | 429 after limit exceeded | security audit finding 4 | **None** |

### AI Pipeline

| Use-case | Rule | Expected behavior | Source | Status |
|---|---|---|---|---|
| `analyze_symbol` with valid symbol | Returns `{ signal, confidence, entry, stopLoss }` | 200 with structured JSON | trading-analysis.js:828 | **None** |
| `analyze_symbol` with no symbol | 400 error | `{ error: 'symbol is required' }` | trading-analysis.js:835 | **None** |
| Copilot symbol dispatch → trading-analysis body | Symbol sent in request body not query param | Route receives `req.body.symbol` | PR #85 fix | **None** |

### Data Correctness

| Use-case | Rule | Expected behavior | Source | Status |
|---|---|---|---|---|
| P&L calculation | `mktValue = shares × price`; `gainLoss = mktValue - costBasis` | Matches manual calculation | usePortfolio.js:287 | **None** |
| `avg_cost_basis` column name | Analytics route uses `avg_cost_basis` not `avg_cost` | Returns correct cost basis, not NULL | analytics.js:156 (bug) | **None** |

---

## Gaps — Documented Rules With No Verification

Every documented security and authorization rule is currently unverified. The highest-risk gaps (where crossing the rule exposes another user's data, paid infrastructure, or admin privilege):

| Rule | What crossing it exposes | Verification today |
|---|---|---|
| JWT_SECRET must be set in production | Full auth bypass + admin privilege escalation | None — no startup guard, no test |
| Copilot `baseUrl` must be allowlisted | Server API key theft (GROQ, OPENAI), SSRF | None |
| Scheduler trigger requires admin auth | Unlimited paid API calls by any attacker | None |
| Portfolio queries scoped to `user_id` | Another user's holdings and P&L data | None — no integration test |
| OTP code never returned in production API response | Account takeover if attacker can observe API response | None — no environment check test |
| `x-internal` not trusted from external clients | AI Brain rate limit bypass → denial-of-wallet | None |

---

## CI Gates

None configured. No checks gate merges to `main`.
