# Flows — FinSurfing

Authorization-bearing flows only. Flows that don't touch permissions, data integrity, external side effects, money, privacy, or operational safety are omitted.

---

## Flow 1: User Registration + Email Verification

**Actor:** Anonymous visitor  
**Precondition:** No existing account for the email  
**Success outcome:** Verified user account created, session issued

| Step | Component | Auth check | Deny case |
|---|---|---|---|
| POST /api/auth/register | `routes/auth.js` | Rate-limited (5/hour/IP) | 429 if over limit; 409 if email exists |
| Validate email + password | auth.js:103–107 | Format + length | 400 Bad Request |
| Hash password (bcrypt 12 rounds) | auth.js:241 | — | — |
| Insert user (unverified) | DB / memstore | — | 500 on DB error |
| Generate 6-digit OTP, store hash | DB / memstore | — | — |
| Send OTP email | `lib/email.js` | — | `demoCode` in response if no email service (**risk in prod**) |
| POST /api/auth/verify-email | routes/auth.js | Rate: 5 OTP attempts then delete | 400 if expired/invalid |
| Issue access + refresh tokens | respondWithTokens() | — | — |

**Trust boundary crossings:** Browser → Express; Express → Postgres; Express → Email provider  
**Side effects:** User row created, portfolio created, OTP sent or exposed in response  

---

## Flow 2: Login

**Actor:** Registered user  
**Precondition:** Account exists and is verified

| Step | Auth check | Deny case |
|---|---|---|
| POST /api/auth/login (rate limited 10/15min/IP) | IP rate limit | 429 |
| bcrypt.compare password | Timing-safe compare; dummy hash if no user | 401 |
| Check account lock | `locked_until` timestamp | 429 if locked |
| Check `is_verified` | boolean | 403 + `requiresVerification` flag |
| Issue tokens | — | — |

**Trust boundary crossing:** Browser → Express  

---

## Flow 3: Portfolio CRUD (Authenticated)

**Actor:** Authenticated user (`requireAuth`)  
**Precondition:** Valid Bearer token

| Step | Auth check | Deny case |
|---|---|---|
| GET /api/portfolios/:id | `requireAuth` → `user_id = req.user.userId` filter on all queries | 401 if no token; 403 if wrong user (returns empty) |
| POST /api/portfolios/:id/holdings | `requireAuth` + `portfolio_id` ownership check | 401/403 |
| DELETE /api/portfolios/:id/holdings/:hid | `requireAuth` + holding.portfolio_id = user's portfolio | 401/403/404 |

**No RLS at DB level** — ownership enforced in code only. A missing filter would expose all users' holdings.  
**Trust boundary:** Browser → Express → Postgres  

---

## Flow 4: Copilot Chat (AI Analysis)

**Actor:** Any user (guest or authenticated)  
**Precondition:** None (unauthenticated allowed)

| Step | Auth check | Deny case |
|---|---|---|
| POST /api/copilot/chat | Rate-limited (30/min/IP) | 429 |
| User message injected into Claude prompt | **No sanitization of message content** | Prompt injection risk |
| Tool dispatch: analyze_symbol | Internal loopback with `x-internal: '1'` | — |
| Claude API call | `ANTHROPIC_API_KEY` server-side | 500 if key missing |
| Stream SSE response | — | — |

**Trust boundary:** Browser → Express → Claude API; Express → Express (internal loopback)  
**Side effects:** Paid Claude API call; user message content reaches LLM  
**Risk:** User-controlled `messages` content reaches Claude system prompt context with no sanitization. Prompt injection is possible.

---

## Flow 5: Scheduler Job Trigger

**Actor:** Anyone (no auth required)  
**Precondition:** None

| Step | Auth check | Deny case |
|---|---|---|
| POST /api/scheduler/jobs/:id/trigger | **None** | 404 if job ID unknown |
| Job handler runs (e.g. morningBriefEmail) | Checks env vars internally | Skips silently |
| AI Brain scan → Claude API call | `ANTHROPIC_API_KEY` | — |

**Risk:** Any internet user can trigger paid Claude API calls (AI Brain, morning brief) with no authentication.

---

## Flow 6: Password Reset

**Actor:** Any visitor claiming an email address  
**Precondition:** None

| Step | Auth check | Deny case |
|---|---|---|
| POST /api/auth/forgot-password | Rate-limited (3/hour/IP) | 429; always returns 200 OK (no user enumeration) |
| Token generated, stored hashed (1h TTL) | — | — |
| Email sent with reset link | lib/email.js | Link logged to console if no SMTP |
| POST /api/auth/reset-password | Token hash lookup + expiry | 400 if invalid/expired/used |
| Password updated, all sessions revoked | — | — |

**Trust boundary:** Browser → Express → Email provider  
**Side effect:** All refresh tokens revoked on success  

---

## Flow 7: Internal Scheduled Jobs

**Actor:** Scheduler (in-process `setInterval`)  
**Precondition:** Server running; correct clock minute

| Step | Auth check | Notes |
|---|---|---|
| Tick every 60s | — | Job due check via `isDue()` |
| `internalPost` loopback to `/api/...` | `x-internal: '1'` + `x-internal-secret` (loopback socket + per-process secret, `lib/internal-secret.js`) | Header alone is no longer sufficient — see `architecture.md` trust boundaries |
| External API calls (FRED, Claude, FMP) | Server-side API keys | Paid usage |
| Email send (morning brief) | `MORNING_BRIEF_EMAIL` env var | Silent skip if missing |

**Trust boundary crossing:** Express → Express (loopback); Express → Claude; Express → Email provider
